import { describe, expect, it, vi } from "vite-plus/test";

import { createReportingServiceTest } from "@meltiply/reporting";

const { systemPoolFor } = vi.hoisted(() => ({
  systemPoolFor: vi.fn(() => {
    throw new Error("rejected requests must not reach PostgreSQL");
  }),
}));

// Keep Node pg out of the workerd isolate. Refusals must precede all database access.
vi.mock("../src/database", () => ({ systemPoolFor, withSystemTransactionEffect: vi.fn() }));

import { createApiApp } from "../src/app";
import type { ApiWorkerEnv } from "../src/env";

// Guard precedence remains testable when reporting and the database are unavailable.

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  ENVIRONMENT: "test",
  REQUIRE_EMAIL_VERIFICATION: "false",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} as ApiWorkerEnv;

/** Builds the app with unavailable reporting and the requested actor authority. */
function appFor(role: "admin" | "viewer") {
  return createApiApp({
    verifyJwtToken: async () => ({
      email: "alpha@meltiply.local",
      emailVerified: true,
      subject: "auth_user_local_alpha",
    }),
    reportingServiceLayer: () => createReportingServiceTest(),
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
  it("rejects an answer outside the fixed enumeration", async () => {
    const response = await request(appFor("admin"), "/installation/reporting/feedback", {
      body: { discovery_source: "a blog post" },
    });
    expect(response.status).toBe(400);
  });
});

describe("diagnostic ingestion route", () => {
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
});

describe("onboarding guards", () => {
  it.each([
    { method: "GET", path: "/onboarding" },
    { method: "PATCH", path: "/onboarding" },
    { method: "POST", path: "/onboarding/complete" },
  ])("refuses a non-Owner $method $path before unavailable storage", async ({ method, path }) => {
    const response = await request(appFor("viewer"), path, { method });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "installation_owner_required" },
    });
  });

  it.each([{}, { step: "completed" }, { step: "ready", misuse: true }])(
    "rejects invalid progress %j before unavailable storage",
    async (body) => {
      const response = await request(appFor("admin"), "/onboarding", { body, method: "PATCH" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
    },
  );
});
