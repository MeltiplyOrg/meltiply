import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JwtIdentity } from "@meltiply/auth";
import {
  createPostHogTransport,
  createReportingServiceLive,
  reportingConfiguration,
  ReportingService,
  type DeliverySummary,
  type ReportingServiceOptions,
  type ReportingServiceShape,
} from "@meltiply/reporting";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createApiApp } from "../src/app";
import { systemPoolFor, withSystemTransactionEffect } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";

/**
 * Real acceptance coverage for improvement reporting.
 *
 * The HTTP surface is the production one (`createApiApp`, unmodified), the state
 * is real PostgreSQL, and the destination is a real loopback HTTP receiver that
 * records the bytes the transport actually sent. No module-level mock stands in
 * for the reporting module: a passing reporting path means an outbound request
 * body was observed, or definitively was not.
 */

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

const projectToken = "phc_acceptanceReportingToken";
const workspaceId = "20000000-0000-4000-8000-000000000005";
const ownerUserId = "10000000-0000-4000-8000-000000000001";
const viewerUserId = "10000000-0000-4000-8000-000000000004";

/** One recorded capture request; the assertion surface for every egress case. */
interface CapturedRequest {
  body: Record<string, unknown>;
  url: string;
}

const receiver = {
  mode: {
    kind: "ok",
  } as { kind: "ok" } | { kind: "status"; status: number },
  requests: [] as CapturedRequest[],
  /** How many recorded requests a test has already observed. */
  consumed: 0,
  /** Signalled once per accepted capture request, so no test polls on a clock. */
  listeners: [] as (() => void)[],
};

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.length > 0) {
      receiver.requests.push({
        body: JSON.parse(text) as Record<string, unknown>,
        url: request.url ?? "",
      });
    }
    for (const listener of receiver.listeners.splice(0)) listener();
    const status = receiver.mode.kind === "status" ? receiver.mode.status : 200;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(status === 200 ? '{"status":1}' : '{"status":0}');
  });
});

let receiverOrigin = "";

/** Resolves on the next capture request; rejects if none arrives in time. */
function nextCapture(timeoutMilliseconds = 5_000): Promise<CapturedRequest> {
  // A report can already be on the wire: the diagnostic route delivers on the
  // request's background continuation before the response reaches this test.
  if (receiver.requests.length > receiver.consumed) {
    receiver.consumed += 1;
    return Promise.resolve(receiver.requests[receiver.consumed - 1]!);
  }
  let resolveCapture: (captured: CapturedRequest) => void = () => {};
  let rejectCapture: (cause: Error) => void = () => {};
  const promise = new Promise<CapturedRequest>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  const timer = setTimeout(
    () => rejectCapture(new Error("no capture request reached the controlled receiver")),
    timeoutMilliseconds,
  );
  receiver.listeners.push(() => {
    clearTimeout(timer);
    receiver.consumed += 1;
    resolveCapture(receiver.requests[receiver.consumed - 1]!);
  });
  return promise;
}

const env: ApiWorkerEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  DEPLOYMENT_CATEGORY: "selfhosted",
  ENVIRONMENT: "test",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
};

const identities: Record<string, JwtIdentity> = {
  owner: { email: "alpha@meltiply.local", emailVerified: true, subject: "auth_user_local_alpha" },
  viewer: { email: "delta@meltiply.local", emailVerified: true, subject: "auth_user_local_delta" },
};

const app = createApiApp({
  // Only token verification is a fixture. Memberships, authorization,
  // idempotency, Audit and reporting state all run against the real database.
  verifyJwtToken: async (_env, token) => identities[token]!,
});

/** Sends an authenticated request to the real HTTP surface. */
function request(
  path: string,
  role: keyof typeof identities,
  init: { body?: unknown; idempotencyKey?: string; method?: string } = {},
) {
  return app.request(
    `/api/v1${path}`,
    {
      headers: {
        Authorization: `Bearer ${role}`,
        "Content-Type": "application/json",
        "Idempotency-Key": init.idempotencyKey ?? randomUUID(),
      },
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
  );
}

type CategoryBody = {
  decision_at: string | null;
  effective: boolean;
  interval_started_at: string | null;
  reason: string;
  requested: boolean;
};

interface PolicyBody {
  categories: { diagnostics: CategoryBody; usage: CategoryBody };
  destination_configured: boolean;
  disclosure_version: number;
  installation_reporting_id: string | null;
  operator_forced_off: boolean;
  owner_can_change: boolean;
}

interface FeedbackBody {
  delivery_status: string;
  discovery_source: string | null;
  shared: boolean;
  submitted_at: string | null;
}

/** Reads the reporting policy over real HTTP. */
async function readPolicy(role: keyof typeof identities = "owner"): Promise<PolicyBody> {
  const response = await request("/installation/reporting", role);
  expect(response.status).toBe(200);
  return response.json<PolicyBody>();
}

/** Sets the reporting choices through the Owner-only route. */
function setPreferences(
  usage: boolean,
  diagnostics: boolean,
  role: keyof typeof identities = "owner",
) {
  return request("/installation/reporting", role, {
    body: { diagnostics, usage },
    method: "PUT",
  });
}

/**
 * Restores a clean, unconsented reporting state and the original Owner.
 *
 * The single-owner flag is cleared first: the partial unique index forbids two
 * simultaneous owners, so one statement that flips both rows can transiently
 * violate it depending on row order.
 */
async function resetReportingState() {
  const database = systemPoolFor(env);
  await database.query("DELETE FROM reporting_pending_reports");
  await database.query("DELETE FROM reporting_attribution_responses");
  await database.query("DELETE FROM reporting_preferences");
  // Reporting is the only writer of these actions in this suite, so clearing
  // them keeps the audit count assertion scoped to the current test.
  await database.query("DELETE FROM workspace_audit_entries WHERE action LIKE 'reporting.%'");
  await database.query("UPDATE users SET installation_owner = FALSE WHERE installation_owner");
  await database.query("UPDATE users SET installation_owner = TRUE WHERE email = $1", [
    "alpha@meltiply.local",
  ]);
}

/** Builds the production reporting service for the current bindings. */
function reportingService(
  options: Partial<Pick<ReportingServiceOptions, "now" | "transport">> = {},
) {
  const configuration = reportingConfiguration(env);
  return createReportingServiceLive({
    appVersion: env.VERSION,
    configuration,
    now: options.now,
    transaction: (operation) => withSystemTransactionEffect(env, (client) => operation(client)),
    transport:
      options.transport ??
      (configuration.destination
        ? createPostHogTransport({ destination: configuration.destination })
        : null),
  });
}

/** Runs one service program with the production layer. */
function withReporting<A, E>(
  program: (service: ReportingServiceShape) => Effect.Effect<A, E>,
  options: Partial<Pick<ReportingServiceOptions, "now" | "transport">> = {},
): Promise<A> {
  return Effect.runPromise(
    Effect.provide(Effect.flatMap(ReportingService, program), reportingService(options)),
  );
}

/** Enqueues one aggregate usage summary for the current interval. */
function enqueueUsage(reportDate = "2026-01-02"): Promise<"queued" | "skipped"> {
  return withReporting(
    (reporting) =>
      reporting.enqueueUsageReport({
        channels: { threads: 2 },
        engagement: {
          threads: { comments: 4, distributions: 1, reactions: 7, shares: null, views: 120 },
        },
        engagementAsOf: "2026-01-02T00:00:00.000Z",
        engagementCoverage: { measured: 1, missing: 0 },
        publications: { distributions: { threads: 1 }, posts: 1 },
        reportDate,
      }),
    { transport: null },
  );
}

/** Runs one real delivery pass. */
function runDelivery(limit = 10): Promise<DeliverySummary> {
  return withReporting((reporting) => reporting.deliverPending({ limit }));
}

/** Reads every pending row, including terminal states. */
async function pendingRows() {
  const result = await systemPoolFor(env).query<{
    attempts: number;
    category: string;
    event_timestamp: Date;
    event_uuid: string;
    last_error_code: string | null;
    logical_id: string;
    state: string;
  }>(
    `SELECT category, logical_id, state, attempts, event_uuid, event_timestamp, last_error_code
     FROM reporting_pending_reports ORDER BY created_at`,
  );
  return result.rows;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receiverOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await resetReportingState();
});

beforeEach(async () => {
  receiver.mode = { kind: "ok" };
  receiver.requests = [];
  receiver.consumed = 0;
  receiver.listeners = [];
  env.REPORTING_POSTHOG_HOST = receiverOrigin;
  env.REPORTING_POSTHOG_PROJECT_TOKEN = projectToken;
  env.REPORTING_FORCED_OFF = undefined;
  await resetReportingState();
});

afterEach(async () => {
  await resetReportingState();
});

describe("reporting policy over real HTTP", () => {
  it("defaults both categories to off with no installation identity", async () => {
    const policy = await readPolicy();

    expect(policy).toMatchObject({
      destination_configured: true,
      disclosure_version: 1,
      installation_reporting_id: null,
      operator_forced_off: false,
      owner_can_change: true,
    });
    expect(policy.categories.usage).toMatchObject({
      decision_at: null,
      effective: false,
      interval_started_at: null,
      reason: "not_requested",
      requested: false,
    });
    expect(policy.categories.diagnostics).toMatchObject({
      effective: false,
      reason: "not_requested",
      requested: false,
    });
  });

  it("creates the pseudonymous identity only on the first opt-in and audits the decision", async () => {
    expect((await readPolicy()).installation_reporting_id).toBeNull();

    const response = await setPreferences(true, false);
    expect(response.status).toBe(200);
    const updated = await response.json<PolicyBody>();

    expect(updated.installation_reporting_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(updated.categories.usage).toMatchObject({ effective: true, requested: true });
    expect(updated.categories.diagnostics).toMatchObject({ effective: false, requested: false });

    const audit = await systemPoolFor(env).query<{ action: string; after_state: unknown }>(
      `SELECT action, after_state FROM workspace_audit_entries
       WHERE org_id = $1 AND action = 'reporting.preferences_updated'
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
    expect(audit.rows[0]?.after_state).toMatchObject({ usage: true, usage_effective: true });
    // The trail never carries the pseudonymous identifier.
    expect(JSON.stringify(audit.rows[0]?.after_state)).not.toContain(
      updated.installation_reporting_id!,
    );
  });

  it("keeps usage and diagnostics independent", async () => {
    await setPreferences(false, true);
    const policy = await readPolicy();

    expect(policy.categories.diagnostics.effective).toBe(true);
    expect(policy.categories.usage.effective).toBe(false);
    expect(policy.categories.usage.reason).toBe("not_requested");
  });

  it("rejects an unknown body field and a non-boolean choice", async () => {
    const unknownField = await request("/installation/reporting", "owner", {
      body: { diagnostics: false, tracker: true, usage: false },
      method: "PUT",
    });
    expect(unknownField.status).toBe(400);

    const wrongType = await request("/installation/reporting", "owner", {
      body: { diagnostics: false, usage: "yes" },
      method: "PUT",
    });
    expect(wrongType.status).toBe(400);
  });

  it("lets a member read the disclosure but not change it", async () => {
    expect((await readPolicy("viewer")).owner_can_change).toBe(false);

    const denied = await setPreferences(true, true, "viewer");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      "installation_owner_required",
    );
  });

  it("follows ownership transfer rather than the original setup identity", async () => {
    const database = systemPoolFor(env);
    await database.query("UPDATE users SET installation_owner = FALSE WHERE id = $1", [
      ownerUserId,
    ]);
    await database.query("UPDATE users SET installation_owner = TRUE WHERE id = $1", [
      viewerUserId,
    ]);

    expect((await setPreferences(true, true, "owner")).status).toBe(403);
    expect((await setPreferences(true, true, "viewer")).status).toBe(200);
  });

  it("replays an idempotent preference change without a second audit entry", async () => {
    const key = randomUUID();
    const first = await request("/installation/reporting", "owner", {
      body: { diagnostics: true, usage: true },
      idempotencyKey: key,
      method: "PUT",
    });
    expect(first.status).toBe(200);

    const replay = await request("/installation/reporting", "owner", {
      body: { diagnostics: true, usage: true },
      idempotencyKey: key,
      method: "PUT",
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");

    const audit = await systemPoolFor(env).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_audit_entries
       WHERE org_id = $1 AND action = 'reporting.preferences_updated'`,
      [workspaceId],
    );
    expect(audit.rows[0]?.count).toBe("1");
  });

  it("reports requested but ineffective when the operator forces reporting off", async () => {
    await setPreferences(true, true);
    env.REPORTING_FORCED_OFF = "true";

    const policy = await readPolicy();
    expect(policy.operator_forced_off).toBe(true);
    expect(policy.categories.usage).toMatchObject({
      effective: false,
      reason: "operator_disabled",
      requested: true,
    });
    expect(policy.categories.diagnostics.reason).toBe("operator_disabled");
  });

  it("reports requested but ineffective when the destination is missing", async () => {
    await setPreferences(true, true);
    env.REPORTING_POSTHOG_PROJECT_TOKEN = undefined;

    const policy = await readPolicy();
    expect(policy.destination_configured).toBe(false);
    expect(policy.categories.usage).toMatchObject({
      effective: false,
      reason: "destination_unavailable",
      requested: true,
    });
  });

  it("reports an unreadable stored preference schema as unavailable", async () => {
    await setPreferences(true, true);
    await systemPoolFor(env).query("UPDATE reporting_preferences SET schema_version = 99");

    const policy = await readPolicy();
    expect(policy.categories.usage.reason).toBe("preference_unavailable");
    expect(policy.categories.usage.effective).toBe(false);
  });
});

describe("discovery-source feedback", () => {
  it("records a local choice without sharing and without an attribution event", async () => {
    const response = await request("/installation/reporting/feedback", "owner", {
      body: { discovery_source: "prefer_not_to_say" },
    });
    expect(response.status).toBe(200);
    const recorded = await response.json<FeedbackBody>();
    expect(recorded).toMatchObject({ delivery_status: "not_recorded", shared: false });
    expect(receiver.requests).toHaveLength(0);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("never claims a delivery it has not confirmed", async () => {
    receiver.mode = { kind: "status", status: 503 };
    const response = await request("/installation/reporting/feedback", "owner", {
      body: { discovery_source: "github" },
    });
    expect(response.status).toBe(200);
    expect((await response.json<FeedbackBody>()).delivery_status).toBe("pending");

    const read = await request("/installation/reporting/feedback", "owner");
    expect((await read.json<FeedbackBody>()).delivery_status).toBe("pending");
  });

  it("reports delivered only after the destination accepts the report", async () => {
    await request("/installation/reporting/feedback", "owner", {
      body: { discovery_source: "github" },
    });
    const summary = await runDelivery();

    expect(summary.delivered).toBe(1);
    expect(receiver.requests).toHaveLength(1);
    const read = await request("/installation/reporting/feedback", "owner");
    expect((await read.json<FeedbackBody>()).delivery_status).toBe("delivered");
  });

  it("reuses the recorded logical identity and the frozen event identity on a retry", async () => {
    const first = await request("/installation/reporting/feedback", "owner", {
      body: { discovery_source: "github" },
    });
    const firstBody = await first.json<FeedbackBody>();

    const second = await request("/installation/reporting/feedback", "owner", {
      body: { discovery_source: "search_engine" },
    });
    const secondBody = await second.json<FeedbackBody>();

    expect(secondBody.submitted_at).toBe(firstBody.submitted_at);
    expect(secondBody.discovery_source).toBe("github");
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);

    // The frozen UUID and timestamp are what PostHog de-duplicates on.
    const before = rows[0]!;
    await runDelivery();
    const after = (await pendingRows())[0]!;
    expect(after.event_uuid).toBe(before.event_uuid);
    expect(after.event_timestamp).toEqual(before.event_timestamp);

    const attribution = await systemPoolFor(env).query(
      "SELECT id FROM reporting_attribution_responses",
    );
    expect(attribution.rows).toHaveLength(1);
  });

  it("uses a separate random identity from the installation reporting id", async () => {
    await setPreferences(true, true);
    const policy = await readPolicy();
    await request("/installation/reporting/feedback", "owner", {
      body: { discovery_source: "github" },
    });
    await runDelivery();

    const captured = receiver.requests.at(-1)!;
    expect(captured.body.distinct_id).not.toBe(policy.installation_reporting_id);
    expect(captured.body.event).toBe("meltiply_feedback_discovery_source");
  });

  it("rejects an answer outside the fixed enumeration", async () => {
    const response = await request("/installation/reporting/feedback", "owner", {
      body: { discovery_source: "a blog post I read" },
    });
    expect(response.status).toBe(400);
  });

  it("is Owner-only", async () => {
    const response = await request("/installation/reporting/feedback", "viewer", {
      body: { discovery_source: "github" },
    });
    expect(response.status).toBe(403);
  });

  it("still shares when neither reporting category is enabled", async () => {
    // Feedback has its own consent: enabling reporting is not required, and
    // submitting feedback is not consent for reporting.
    const response = await request("/installation/reporting/feedback", "owner", {
      body: { discovery_source: "ai_assistant" },
    });
    expect(response.status).toBe(200);
    expect((await readPolicy()).categories.usage.effective).toBe(false);
    expect(await runDelivery()).toMatchObject({ delivered: 1 });
    expect(receiver.requests.at(-1)!.body.event).toBe("meltiply_feedback_discovery_source");
  });
});

describe("diagnostic ingestion", () => {
  it("queues nothing before diagnostics consent exists", async () => {
    const response = await request("/installation/reporting/diagnostics", "owner", {
      body: { category: "request_failure", error_name: "TypeError", operation: "publish" },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: false, reason: "category_disabled" });
    expect(receiver.requests).toHaveLength(0);
    expect(await pendingRows()).toHaveLength(0);
  });

  it("saves locally and delivers through the controlled receiver after consent", async () => {
    await setPreferences(false, true);
    const response = await request("/installation/reporting/diagnostics", "owner", {
      body: {
        category: "request_failure",
        error_name: "TypeError",
        error_stack: "    at syncComments (workers/automation/src/provider-sync.ts:88:11)",
        operation: "inbox",
        platform: "threads",
      },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, reason: "queued" });

    const captured = await nextCapture();
    expect(captured.url).toBe("/i/v0/e/");
    expect(captured.body).toMatchObject({ api_key: projectToken, event: "$exception" });
    const properties = captured.body.properties as Record<string, unknown>;
    expect(properties).toMatchObject({
      $exception_level: "error",
      diagnostic_category: "request_failure",
      operation_category: "inbox",
      platform: "threads",
      schema_version: 1,
    });
    expect(properties.$process_person_profile).toBe(false);
  });

  it("rejects a category or operation outside the fixed enums", async () => {
    const rejectedCategory = await request("/installation/reporting/diagnostics", "owner", {
      body: { category: "provider_failure", operation: "publish" },
    });
    expect(rejectedCategory.status).toBe(400);

    const rejectedOperation = await request("/installation/reporting/diagnostics", "owner", {
      body: { category: "request_failure", operation: "do everything" },
    });
    expect(rejectedOperation.status).toBe(400);
  });

  it("keeps a repeated failure within one hour as a single report", async () => {
    await setPreferences(false, true);
    const body = {
      category: "request_failure",
      error_name: "TypeError",
      operation: "publish",
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request("/installation/reporting/diagnostics", "owner", { body });
      expect(response.status).toBe(202);
    }
    expect(await pendingRows()).toHaveLength(1);
  });
});

describe("bounded local delivery", () => {
  it("never enqueues a usage report while the category is off", async () => {
    expect(await enqueueUsage()).toBe("skipped");
    expect(await pendingRows()).toHaveLength(0);
  });

  it("reuses one frozen logical report for a duplicate scheduled run", async () => {
    await setPreferences(true, false);
    expect(await enqueueUsage()).toBe("queued");
    expect(await enqueueUsage()).toBe("skipped");

    const [row] = await pendingRows();
    expect(await pendingRows()).toHaveLength(1);

    await runDelivery();
    const captured = receiver.requests.at(-1)!;
    expect(captured.body.uuid).toBe(row!.event_uuid);
    expect(captured.body.event).toBe("meltiply_usage_daily");
  });

  it("sends the aggregate measurements a maintainer dashboard needs", async () => {
    await setPreferences(true, false);
    await enqueueUsage();
    await runDelivery();

    const properties = receiver.requests.at(-1)!.body.properties as Record<string, unknown>;
    expect(properties).toMatchObject({
      channels: { threads: 2 },
      deployment_category: "selfhosted",
      engagement: { threads: { comments: 4, distributions: 1, reactions: 7, views: 120 } },
      engagement_as_of: "2026-01-02T00:00:00.000Z",
      engagement_coverage: { measured: 1, missing: 0 },
      publications: { distributions: { threads: 1 }, posts: 1 },
      report_date: "2026-01-02",
      schema_version: 1,
    });
  });

  it("starts a new reporting interval when a category is re-enabled", async () => {
    await setPreferences(true, false);
    const enabled = await readPolicy();
    await setPreferences(false, false);
    const withdrawn = await readPolicy();
    await setPreferences(true, false);
    const reenabled = await readPolicy();

    expect(withdrawn.categories.usage.interval_started_at).toBeNull();
    expect(reenabled.categories.usage.interval_started_at).not.toBe(
      enabled.categories.usage.interval_started_at,
    );
    // The installation identity is minted once and never rotated by a toggle.
    expect(reenabled.installation_reporting_id).toBe(enabled.installation_reporting_id);
  });

  it("discards the unsent backlog and stops transmitting after withdrawal", async () => {
    await setPreferences(true, false);
    await enqueueUsage();
    expect(await pendingRows()).toHaveLength(1);

    // Withdraw before the queued report is delivered.
    await setPreferences(false, false);
    const summary = await runDelivery();

    expect(summary.delivered).toBe(0);
    expect(receiver.requests).toHaveLength(0);
    const [row] = await pendingRows();
    expect(row!.state).toBe("discarded");
    expect(row!.last_error_code).toBe("withdrawn");
  });

  it("re-checks policy before a retry and discards once the operator forces off", async () => {
    await setPreferences(true, false);
    await enqueueUsage();

    receiver.mode = { kind: "status", status: 503 };
    const failed = await runDelivery();
    expect(failed.failed).toBe(1);
    expect((await pendingRows())[0]!.state).toBe("pending");

    env.REPORTING_FORCED_OFF = "true";
    // The failed row is inside its backoff window, so this pass claims nothing
    // and therefore sends nothing.
    expect((await runDelivery()).claimed).toBe(0);
    expect(receiver.requests).toHaveLength(1);

    // Make the retry due: the operator override must now discard the row rather
    // than let the retry reach the network.
    await systemPoolFor(env).query(
      "UPDATE reporting_pending_reports SET available_at = now() - INTERVAL '1 second'",
    );
    const discarded = await runDelivery();
    expect(discarded.delivered).toBe(0);
    expect(discarded.discarded).toBe(1);
    expect((await pendingRows())[0]!.state).toBe("discarded");
    expect((await pendingRows())[0]!.last_error_code).toBe("policy_revoked");
    // Only the first (failed) attempt reached the network.
    expect(receiver.requests).toHaveLength(1);
  });

  it("discards a report that outlived the seven-day window instead of sending it late", async () => {
    await setPreferences(true, false);
    await enqueueUsage();
    // Age the row beyond the delivery horizon. Creation moves with it so the
    // seven-day horizon constraint still holds: the row existed eight days and
    // expired one day ago.
    await systemPoolFor(env).query(
      `UPDATE reporting_pending_reports
       SET created_at = now() - INTERVAL '8 days',
           expires_at = now() - INTERVAL '1 day'`,
    );

    const summary = await runDelivery();

    expect(summary.delivered).toBe(0);
    expect(summary.discarded).toBe(1);
    expect(receiver.requests).toHaveLength(0);
    expect((await pendingRows())[0]!.last_error_code).toBe("expired");
  });

  it("records a non-retryable rejection as discarded rather than retrying forever", async () => {
    await setPreferences(true, false);
    await enqueueUsage();
    receiver.mode = { kind: "status", status: 401 };

    const summary = await runDelivery();

    expect(summary.discarded).toBe(1);
    const [row] = await pendingRows();
    expect(row!.state).toBe("discarded");
    expect(row!.last_error_code).toBe("capture_status_401");
  });

  it("keeps domain state untouched when the destination is unreachable", async () => {
    await setPreferences(true, false);
    await enqueueUsage();
    env.REPORTING_POSTHOG_HOST = "http://127.0.0.1:9";

    const summary = await runDelivery();

    // A transport failure is a bounded value, not an exception: the pending row
    // is rescheduled and no domain record changed.
    expect(summary.failed).toBe(1);
    expect(receiver.requests).toHaveLength(0);
  });
});

describe("sensitive canaries never reach the destination", () => {
  it("keeps workspace names, emails, content and credentials out of the payload", async () => {
    await setPreferences(true, true);
    // Deliberate canaries in a diagnostic stack and in the reporting period.
    const canaryStack = [
      "Error: failed to publish 'Quarterly launch teaser' to @acme-channels",
      "    at publish (workers/automation/src/distribution.ts:42:7)",
      "    at fetch (https://graph.facebook.test/v19/posts?access_token=canary-token)",
      "    at auth (workers/api/src/better-auth.ts:12:1) alpha@meltiply.local password=canary-password",
    ].join("\n");
    await request("/installation/reporting/diagnostics", "owner", {
      body: {
        category: "unhandled_exception",
        error_name: "Error",
        error_stack: canaryStack,
        operation: "publish",
      },
    });
    const captured = await nextCapture();
    const serialized = JSON.stringify(captured.body);

    for (const canary of [
      "Quarterly launch teaser",
      "acme-channels",
      "alpha@meltiply.local",
      "canary-token",
      "canary-password",
      "graph.facebook.test",
    ]) {
      expect(serialized, canary).not.toContain(canary);
    }
    // The allowlisted application frame still arrives, so the report is useful.
    expect(serialized).toContain("workers/automation/src/distribution.ts");
  });
});
