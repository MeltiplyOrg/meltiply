import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { createApiApp } from "../src/app";
import type { ApiWorkerEnv } from "../src/env";
import type { OperatorReconciliationService } from "../src/operator-resolution";

const distributionId = "93000000-0000-4000-8000-000000000020";
const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  ENVIRONMENT: "test",
  OPERATOR_HOSTNAME: "ops.example.test",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

const body = {
  confirm: `resolve ${distributionId} as published`,
  provider_post_id: "post-20",
  provider_url: "https://provider.example/posts/20",
  reason: "INC-200 confirmed the remote publication",
  resolution: "published",
};

function setup(replayed = false) {
  const verifiedTokens: string[] = [];
  const resolutions: unknown[][] = [];
  const service: OperatorReconciliationService = {
    resolveDistribution: (...args) => {
      resolutions.push(args);
      return Effect.succeed({
        auditId: "94000000-0000-4000-8000-000000000001",
        distributionId,
        replayed,
        status: "published" as const,
      });
    },
  };
  const app = createApiApp({
    operatorReconciliationService: service,
    verifyAccessToken: async (_env, token) => {
      verifiedTokens.push(token);
      return { email: "operator@example.test", subject: "access-user-1" };
    },
  });
  const request = (
    patch: { body?: unknown; headers?: Record<string, string>; host?: string } = {},
  ) =>
    app.request(
      `https://${patch.host ?? "ops.example.test"}/operator/v1/distributions/${distributionId}/reconciliation`,
      {
        body: JSON.stringify(patch.body ?? body),
        headers: {
          "Cf-Access-Jwt-Assertion": "signed-access-token",
          "Content-Type": "application/json",
          "Idempotency-Key": "operator-resolution-20",
          ...patch.headers,
        },
        method: "POST",
      },
      env,
    );
  return { request, resolutions, verifiedTokens };
}

describe("Access-protected operator reconciliation route", () => {
  it.each([
    ["missing Access assertion", { headers: { "Cf-Access-Jwt-Assertion": "" } }],
    ["public API hostname", { host: "api.example.test" }],
  ])("rejects %s with 403 before verification", async (_example, patch) => {
    const { request, resolutions, verifiedTokens } = setup();

    const response = await request(patch);

    expect(response.status).toEqual(403);
    expect(verifiedTokens).toEqual([]);
    expect(resolutions).toEqual([]);
  });

  it("verifies Access identity, forwards the strict resolution, and maps replay headers", async () => {
    const { request, resolutions, verifiedTokens } = setup(true);

    const response = await request();

    expect(response.status).toEqual(200);
    expect(response.headers.get("Idempotency-Replayed")).toEqual("true");
    expect(verifiedTokens).toEqual(["signed-access-token"]);
    expect(resolutions).toEqual([
      [
        env,
        { email: "operator@example.test", subject: "access-user-1" },
        distributionId,
        {
          failureCode: null,
          providerPostId: "post-20",
          providerUrl: "https://provider.example/posts/20",
          reason: "INC-200 confirmed the remote publication",
          resolution: "published",
          retryable: false,
        },
        "operator-resolution-20",
        expect.any(String),
      ],
    ]);
    expect(await response.json()).toEqual({
      audit_id: "94000000-0000-4000-8000-000000000001",
      distribution_id: distributionId,
      status: "published",
    });
  });

  it.each([
    ["mismatched confirmation", { body: { ...body, confirm: "resolve something else" } }],
    ["short idempotency key", { headers: { "Idempotency-Key": "short" } }],
    [
      "unsafe provider URL with query secret",
      { body: { ...body, provider_url: "https://provider.example/posts/20?token=secret" } },
    ],
    [
      "evidence for a different terminal state",
      {
        body: {
          ...body,
          confirm: `resolve ${distributionId} as failed`,
          failure_code: "provider_rejected",
          resolution: "failed",
        },
      },
    ],
  ])("rejects %s with 400 before invoking the service", async (_example, patch) => {
    const { request, resolutions } = setup();

    const response = await request(patch);

    expect(response.status).toEqual(400);
    expect(resolutions).toEqual([]);
  });
});
