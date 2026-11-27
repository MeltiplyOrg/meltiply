import { createReportingServiceTest } from "@meltiply/reporting";
import { describe, expect, it } from "vite-plus/test";

import { createApiApp } from "../src/app";
import type { ApiWorkerEnv } from "../src/env";

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  ENVIRONMENT: "test",
  REQUIRE_EMAIL_VERIFICATION: "false",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

function appFor(role: "admin" | "viewer") {
  return createApiApp({
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
    verifyJwtToken: async () => ({
      email: "alpha@meltiply.local",
      emailVerified: true,
      subject: "auth_user_local_alpha",
    }),
  });
}

function request(
  role: "admin" | "viewer",
  path: string,
  init: { body?: unknown; method?: string } = {},
) {
  return appFor(role).request(
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

describe("reporting route guards", () => {
  it("refuses a non-Owner reporting policy mutation with 403", async () => {
    const response = await request("viewer", "/installation/reporting", {
      body: { diagnostics: false, usage: true },
      method: "PUT",
    });

    expect(response.status).toEqual(403);
    expect(await response.json()).toMatchObject({
      error: { code: "installation_owner_required" },
    });
  });

  it.each([
    ["unknown field", { diagnostics: false, misuse: true, usage: true }],
    ["non-boolean choice", { diagnostics: false, usage: 1 }],
  ])("rejects reporting policy %s with 400", async (_example, body) => {
    const response = await request("admin", "/installation/reporting", { body, method: "PUT" });

    expect(response.status).toEqual(400);
  });

  it("rejects an out-of-vocabulary feedback answer with 400", async () => {
    const response = await request("admin", "/installation/reporting/feedback", {
      body: { discovery_source: "a blog post" },
    });

    expect(response.status).toEqual(400);
  });

  it.each([
    ["unknown category", { category: "quiet_failure", operation: "publish" }],
    ["unknown operation", { category: "request_failure", operation: "do everything" }],
    [
      "unknown platform",
      { category: "request_failure", operation: "publish", platform: "myspace" },
    ],
    [
      "unknown provider failure class",
      {
        category: "provider_failure",
        operation: "publish",
        provider_failure_class: "provider said no",
      },
    ],
  ])("rejects diagnostic ingestion with %s", async (_example, body) => {
    const response = await request("admin", "/installation/reporting/diagnostics", { body });

    expect(response.status).toEqual(400);
  });
});

describe("onboarding route guards", () => {
  it.each([
    { method: "GET", path: "/onboarding" },
    { method: "PATCH", path: "/onboarding" },
    { method: "POST", path: "/onboarding/complete" },
  ])("refuses a non-Owner $method $path with 403", async ({ method, path }) => {
    const response = await request("viewer", path, { method });

    expect(response.status).toEqual(403);
    expect(await response.json()).toMatchObject({
      error: { code: "installation_owner_required" },
    });
  });

  it.each([
    ["empty body", {}],
    ["completed step", { step: "completed" }],
    ["unknown field", { step: "ready", misuse: true }],
  ])("rejects invalid onboarding progress (%s) with 400", async (_example, body) => {
    const response = await request("admin", "/onboarding", { body, method: "PATCH" });

    expect(response.status).toEqual(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation_error" } });
  });
});
