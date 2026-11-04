import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import { deliverImprovementReports } from "../src/improvement-reporting";
import { recordDiagnostic } from "../src/diagnostic-reporting";
import { runSystemTransaction } from "./system-transaction";

// Production delivery and diagnostic enqueueing against PostgreSQL and real capture HTTP.

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

const projectToken = "phc_automationReportingToken";
const installationReportingId = "3a5b7c1d-0e22-4f4b-8f11-2a5b7c1d0e22";

interface CapturedRequest {
  body: Record<string, unknown>;
}

const receiver = {
  mode: { kind: "ok" } as { kind: "ok" } | { kind: "status"; status: number },
  requests: [] as CapturedRequest[],
};

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.length > 0)
      receiver.requests.push({ body: JSON.parse(text) as Record<string, unknown> });
    const status = receiver.mode.kind === "status" ? receiver.mode.status : 200;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(status === 200 ? '{"status":1}' : '{"status":0}');
  });
});

let receiverOrigin = "";

const env: AutomationEnv = {
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  DEPLOYMENT_CATEGORY: "selfhosted",
  ENVIRONMENT: "test",
  REPORTING_FORCED_OFF: undefined,
  REPORTING_POSTHOG_HOST: "",
  REPORTING_POSTHOG_PROJECT_TOKEN: projectToken,
  VERSION: "1.0.0-target.0",
};

/** Runs one production delivery pass. */
function runDelivery() {
  return Effect.runPromise(deliverImprovementReports(env));
}

/** Seeds one enabled category with a queued report owned by a fixed identity. */
async function seedPendingReport(input: {
  category: "diagnostics" | "usage";
  eventName: string;
  expiresInDays?: number;
  payload: Record<string, unknown>;
  state?: "pending" | "discarded";
}) {
  await runSystemTransaction(env, async (client) => {
    await client.query(
      `INSERT INTO reporting_preferences (
         id, schema_version,
         usage_requested, usage_disclosure_version, usage_decided_at, usage_interval_started_at,
         diagnostics_requested, diagnostics_disclosure_version, diagnostics_decided_at,
         diagnostics_interval_started_at, installation_reporting_id
       ) VALUES (TRUE, 1, $1, 1, now(), now(), $2, 1, now(), now(), $3)
       ON CONFLICT (id) DO UPDATE SET
         usage_requested = EXCLUDED.usage_requested,
         usage_disclosure_version = EXCLUDED.usage_disclosure_version,
         usage_interval_started_at = EXCLUDED.usage_interval_started_at,
         diagnostics_requested = EXCLUDED.diagnostics_requested,
         diagnostics_disclosure_version = EXCLUDED.diagnostics_disclosure_version,
         diagnostics_interval_started_at = EXCLUDED.diagnostics_interval_started_at,
         installation_reporting_id = EXCLUDED.installation_reporting_id`,
      [input.category === "usage", input.category === "diagnostics", installationReportingId],
    );
    await client.query(
      `INSERT INTO reporting_pending_reports (
         category, logical_id, event_name, schema_version, event_uuid, event_timestamp,
         distinct_id, payload, state, interval_started_at, expires_at
       ) VALUES ($1, $2, $3, 1, $4, now(), $5, $6::jsonb, $7, now(),
                 now() + ($8 * INTERVAL '1 day'))`,
      [
        input.category,
        randomUUID(),
        input.eventName,
        randomUUID(),
        installationReportingId,
        JSON.stringify(input.payload),
        input.state ?? "pending",
        input.expiresInDays ?? 5,
      ],
    );
  });
}

/** Reads the delivery row state for the seeded report. */
async function reportState() {
  const result = await runSystemTransaction(env, (client) =>
    client.query<{ last_error_code: string | null; state: string }>(
      "SELECT state, last_error_code FROM reporting_pending_reports ORDER BY created_at",
    ),
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
});

beforeEach(async () => {
  receiver.mode = { kind: "ok" };
  receiver.requests = [];
  env.REPORTING_FORCED_OFF = undefined;
  env.REPORTING_POSTHOG_HOST = receiverOrigin;
  await runSystemTransaction(env, async (client) => {
    await client.query("DELETE FROM reporting_pending_reports");
    await client.query("DELETE FROM reporting_preferences");
  });
});

describe("scheduled improvement reporting with PostgreSQL", () => {
  it("delivers a consented report and marks it sent", async () => {
    await seedPendingReport({
      category: "usage",
      eventName: "meltiply_usage_daily",
      payload: { channels: { threads: 1 }, schema_version: 1 },
    });

    await runDelivery();

    expect(receiver.requests).toHaveLength(1);
    expect(receiver.requests[0]!.body).toMatchObject({
      api_key: projectToken,
      distinct_id: installationReportingId,
      event: "meltiply_usage_daily",
    });
    expect(await reportState()).toEqual([{ last_error_code: null, state: "sent" }]);
  });

  it("keeps capture traffic off the diagnostic producer until scheduled delivery", async () => {
    await seedPendingReport({
      category: "diagnostics",
      eventName: "$exception",
      payload: { diagnostic_category: "unhandled_exception", schema_version: 1 },
    });
    receiver.mode = { kind: "status", status: 503 };

    expect(
      await Effect.runPromise(
        recordDiagnostic(env, {
          category: "request_failure",
          error: { name: "TypeError" },
          handled: true,
          occurredAt: new Date().toISOString(),
          operation: "publish",
        }),
      ),
    ).toBe(true);
    expect(receiver.requests).toEqual([]);
    expect(await reportState()).toEqual([
      { last_error_code: null, state: "pending" },
      { last_error_code: null, state: "pending" },
    ]);

    receiver.mode = { kind: "ok" };
    expect(await runDelivery()).toMatchObject({ delivered: 2 });
    expect(receiver.requests.map((request) => request.body.event)).toEqual([
      "$exception",
      "$exception",
    ]);
  });

  it("discards rather than sends when the operator forces reporting off", async () => {
    await seedPendingReport({
      category: "diagnostics",
      eventName: "$exception",
      payload: { diagnostic_category: "unhandled_exception", schema_version: 1 },
    });
    env.REPORTING_FORCED_OFF = "true";

    await runDelivery();

    expect(receiver.requests).toHaveLength(0);
    expect(await reportState()).toEqual([
      { last_error_code: "policy_revoked", state: "discarded" },
    ]);
  });

  it("discards rather than sends when the category was withdrawn", async () => {
    await seedPendingReport({
      category: "diagnostics",
      eventName: "$exception",
      payload: { diagnostic_category: "unhandled_exception", schema_version: 1 },
    });
    // Withdrawal records the new choice; the queued row must not be delivered.
    await runSystemTransaction(env, (client) =>
      client.query("UPDATE reporting_preferences SET diagnostics_requested = FALSE"),
    );

    await runDelivery();

    expect(receiver.requests).toHaveLength(0);
    expect((await reportState())[0]!.state).toBe("discarded");
  });

  it("reschedules a transient failure without failing the scheduled invocation", async () => {
    await seedPendingReport({
      category: "usage",
      eventName: "meltiply_usage_daily",
      payload: { schema_version: 1 },
    });
    receiver.mode = { kind: "status", status: 503 };

    await expect(runDelivery()).resolves.toMatchObject({ failed: 1 });

    const [row] = await reportState();
    expect(row!.state).toBe("pending");
    expect(row!.last_error_code).toBe("capture_status_503");
  });

  it("discards a rejected token instead of retrying it forever", async () => {
    await seedPendingReport({
      category: "usage",
      eventName: "meltiply_usage_daily",
      payload: { schema_version: 1 },
    });
    receiver.mode = { kind: "status", status: 401 };

    await runDelivery();

    expect(await reportState()).toEqual([
      { last_error_code: "capture_status_401", state: "discarded" },
    ]);
  });

  it("discards an expired report so nothing is delivered beyond the horizon", async () => {
    await seedPendingReport({
      category: "usage",
      eventName: "meltiply_usage_daily",
      payload: { schema_version: 1 },
    });
    // Move creation with expiry so the seven-day horizon constraint still holds.
    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE reporting_pending_reports
         SET created_at = now() - INTERVAL '8 days',
             expires_at = now() - INTERVAL '1 day'`,
      ),
    );

    await runDelivery();

    expect(receiver.requests).toHaveLength(0);
    expect(await reportState()).toEqual([{ last_error_code: "expired", state: "discarded" }]);
  });

  it("keeps a duplicate scheduled pass from sending the same frozen report twice", async () => {
    await seedPendingReport({
      category: "usage",
      eventName: "meltiply_usage_daily",
      payload: { schema_version: 1 },
    });

    await runDelivery();
    await runDelivery();

    expect(receiver.requests).toHaveLength(1);
    expect(await reportState()).toEqual([{ last_error_code: null, state: "sent" }]);
  });

  it("does not transmit when the destination is unconfigured", async () => {
    await seedPendingReport({
      category: "usage",
      eventName: "meltiply_usage_daily",
      payload: { schema_version: 1 },
    });
    env.REPORTING_POSTHOG_HOST = "";

    await runDelivery();

    expect(receiver.requests).toHaveLength(0);
    // Fail-closed: the row is discarded, never delivered later by surprise.
    expect((await reportState())[0]!.state).toBe("discarded");
  });
});
