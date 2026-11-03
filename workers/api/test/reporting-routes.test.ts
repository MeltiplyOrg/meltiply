import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createReportingServiceTest,
  type ReportingFeedbackState,
  type ReportingPolicySnapshot,
} from "@meltiply/reporting";

const { systemPoolFor } = vi.hoisted(() => ({
  systemPoolFor: vi.fn(() => {
    throw new Error("the injected reporting layer must not reach PostgreSQL");
  }),
}));

// The route module imports the Worker database helper at module scope. Mocking it
// keeps the Node pg client out of the workerd pool; the injected reporting layer
// means no query is ever issued from these cases.
vi.mock("../src/database", () => ({ systemPoolFor, withSystemTransactionEffect: vi.fn() }));

import { createApiApp } from "../src/app";
import type { ApiWorkerEnv } from "../src/env";

/**
 * Reporting route contract cases in the workerd pool.
 *
 * The real PostgreSQL suites prove persistence, consent, delivery and Audit. These
 * cases pin the transport-level behavior the browser depends on: member-readable
 * policy shape, Owner-only mutation, strict body validation, the honest feedback
 * labels, and the ingestion decision envelope. The reporting service is injected
 * through the route's documented layer seam, so no database or network is touched.
 */

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  ENVIRONMENT: "test",
  REQUIRE_EMAIL_VERIFICATION: "false",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} as ApiWorkerEnv;

const policy: ReportingPolicySnapshot = {
  categories: {
    diagnostics: {
      decidedAt: null,
      effective: false,
      intervalStartedAt: null,
      reason: "not_requested",
      requested: false,
    },
    usage: {
      decidedAt: "2026-01-02T03:04:05.000Z",
      effective: false,
      intervalStartedAt: "2026-01-02T03:04:05.000Z",
      reason: "operator_disabled",
      requested: true,
    },
  },
  destinationConfigured: true,
  disclosureVersion: 1,
  installationReportingId: "4f1d0f6e-6a1f-4a3f-9d1e-2c1f0f6e6a1f",
  operatorForcedOff: true,
};

const feedback: ReportingFeedbackState = {
  deliveryStatus: "not_shared",
  discoverySource: null,
  shared: false,
  submittedAt: null,
};

/** Builds the app with an injected reporting layer and an installation-Owner actor. */
function appFor(role: "admin" | "viewer") {
  return createApiApp({
    verifyJwtToken: async () => ({
      email: "alpha@meltiply.local",
      emailVerified: true,
      subject: "auth_user_local_alpha",
    }),
    reportingServiceLayer: () =>
      createReportingServiceTest(
        {
          deliverPending: () =>
            Effect.succeed({
              claimed: 0,
              delivered: 0,
              discarded: 0,
              failed: 0,
              skipped: 0,
            }),
          enqueueDiagnostic: () => Effect.succeed("skipped"),
          feedbackState: () => Effect.succeed(feedback),
          policy: () => Effect.succeed(policy),
          setPreferences: () => Effect.succeed({ changed: true, policy }),
          submitFeedback: () => Effect.succeed(feedback),
        },
        { deploymentCategory: "selfhosted", destination: null, forcedOff: true },
      ),
    resolveActor: async () => ({
      authUserId: "auth_user_local_alpha",
      claims: {
        organizationId: "20000000-0000-4000-8000-000000000005",
        organizationRole: role,
        subject: "auth_user_local_alpha",
        userId: "10000000-0000-4000-8000-000000000001",
      },
      displayName: "Alpha Creator",
      email: "alpha@meltiply.local",
      isInstallationOwner: role === "admin",
      role,
      userId: "10000000-0000-4000-8000-000000000001",
      workspace: {
        id: "20000000-0000-4000-8000-000000000005",
        name: "Alpha workspace",
        slug: "alpha-workspace",
      },
    }),
  });
}

/** Sends one authenticated request through the real app. */
function request(
  app: ReturnType<typeof createApiApp>,
  path: string,
  init: { body?: unknown; method?: string } = {},
) {
  return app.request(
    `/api/v1${path}`,
    {
      headers: {
        Authorization: "Bearer test-only.jwt",
        "Content-Type": "application/json",
        "Idempotency-Key": "reporting-route-test-key",
      },
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
  );
}

describe("reporting policy route", () => {
  it("returns requested and effective status to a member", async () => {
    const response = await request(appFor("viewer"), "/installation/reporting");
    expect(response.status).toBe(200);

    const body = await response.json<{
      categories: Record<string, { reason: string; requested: boolean }>;
      owner_can_change: boolean;
      operator_forced_off: boolean;
    }>();
    // The member sees the Owner's stored request and the deployment's real
    // effective state, never a claim that reporting works.
    expect(body.categories.usage).toMatchObject({ reason: "operator_disabled", requested: true });
    expect(body.categories.diagnostics).toMatchObject({ reason: "not_requested" });
    expect(body.operator_forced_off).toBe(true);
    expect(body.owner_can_change).toBe(false);
  });

  it("refuses a non-Owner mutation", async () => {
    const response = await request(appFor("viewer"), "/installation/reporting", {
      body: { diagnostics: false, usage: true },
      method: "PUT",
    });
    expect(response.status).toBe(403);
    const denied = await response.json<{ error: { code: string } }>();
    expect(denied.error.code).toBe("installation_owner_required");
  });

  it("rejects an unknown field and a non-boolean choice", async () => {
    const app = appFor("admin");
    const unknownField = await request(app, "/installation/reporting", {
      body: { diagnostics: false, misuse: true, usage: true },
      method: "PUT",
    });
    expect(unknownField.status).toBe(400);

    const wrongType = await request(app, "/installation/reporting", {
      body: { diagnostics: false, usage: 1 },
      method: "PUT",
    });
    expect(wrongType.status).toBe(400);
  });
});

describe("reporting feedback route", () => {
  it("reports the honest not-shared state", async () => {
    const response = await request(appFor("admin"), "/installation/reporting/feedback");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      delivery_status: "not_shared",
      discovery_source: null,
      shared: false,
      submitted_at: null,
    });
  });

  it("rejects an answer outside the fixed enumeration", async () => {
    const response = await request(appFor("admin"), "/installation/reporting/feedback", {
      body: { discovery_source: "a blog post" },
    });
    expect(response.status).toBe(400);
  });
});

describe("diagnostic ingestion route", () => {
  it("answers with an ingestion decision, not a delivery claim", async () => {
    const response = await request(appFor("admin"), "/installation/reporting/diagnostics", {
      body: { category: "request_failure", error_name: "TypeError", operation: "publish" },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: false, reason: "category_disabled" });
  });

  it("rejects an out-of-vocabulary category, operation, platform or Provider class", async () => {
    const app = appFor("admin");
    const badCategory = await request(app, "/installation/reporting/diagnostics", {
      body: { category: "quiet_failure", operation: "publish" },
    });
    expect(badCategory.status).toBe(400);

    const badOperation = await request(app, "/installation/reporting/diagnostics", {
      body: { category: "request_failure", operation: "do everything" },
    });
    expect(badOperation.status).toBe(400);

    const badPlatform = await request(app, "/installation/reporting/diagnostics", {
      body: { category: "request_failure", operation: "publish", platform: "myspace" },
    });
    expect(badPlatform.status).toBe(400);

    // The Provider class is a fixed roster, not free text: a raw adapter message
    // or an invented class must never become a countable category.
    const badProviderClass = await request(app, "/installation/reporting/diagnostics", {
      body: {
        category: "provider_failure",
        operation: "publish",
        provider_failure_class: "provider said no",
      },
    });
    expect(badProviderClass.status).toBe(400);
  });

  it("accepts an expected Provider condition as its own category", async () => {
    const response = await request(appFor("admin"), "/installation/reporting/diagnostics", {
      body: {
        category: "provider_failure",
        operation: "publish",
        platform: "threads",
        provider_failure_class: "rate_limit",
      },
    });
    // Accepted means the request was well-formed and policy decided the
    // transmission; the injected layer reports the category as disabled here.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: false, reason: "category_disabled" });
  });
});
