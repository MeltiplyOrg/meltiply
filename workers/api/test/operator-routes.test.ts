import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { createApiApp } from "../src/app";
import type { ApiWorkerEnv } from "../src/env";
import type { OperatorReconciliationService } from "../src/operator-resolution";

// The route graph statically reaches ./database via workspace-lifecycle; an
// empty mock keeps the `pg` client out of the workerd unit-test isolate.
vi.mock("../src/database", () => ({}));

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

function operatorApp(
  service: OperatorReconciliationService,
  verifyAccessToken = vi.fn(async () => ({
    email: "operator@example.test",
    subject: "access-user-1",
  })),
) {
  return {
    app: createApiApp({
      operatorReconciliationService: service,
      verifyAccessToken,
    }),
    verifyAccessToken,
  };
}

/**
 * Builds an operator reconciliation service mock whose methods return Effects.
 *
 * The route boundary executes the injected distribution resolution Effect once.
 *
 * @param resolveDistribution - Effect-returning distribution resolution mock.
 * @returns OperatorReconciliationService test double.
 */
function service(
  resolveDistribution = vi.fn(() =>
    Effect.succeed({
      auditId: "94000000-0000-4000-8000-000000000001",
      distributionId,
      replayed: false,
      status: "published" as const,
    }),
  ),
): OperatorReconciliationService {
  return {
    resolveDistribution,
  };
}

function request(
  app: ReturnType<typeof createApiApp>,
  patch: {
    body?: unknown;
    headers?: Record<string, string>;
    host?: string;
  } = {},
) {
  return app.request(
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
}

describe("Access-protected operator reconciliation route", () => {
  it("rejects a missing Access assertion and the public API hostname", async () => {
    const resolveDistribution = vi.fn();
    const { app, verifyAccessToken } = operatorApp(service(resolveDistribution));
    const missing = await request(app, {
      headers: { "Cf-Access-Jwt-Assertion": "" },
    });
    const wrongHost = await request(app, { host: "api.example.test" });

    expect(missing.status).toBe(403);
    expect(wrongHost.status).toBe(403);
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(resolveDistribution).not.toHaveBeenCalled();
  });

  it("verifies Access identity and invokes one strict idempotent resolution", async () => {
    const resolveDistribution = vi.fn(() =>
      Effect.succeed({
        auditId: "94000000-0000-4000-8000-000000000001",
        distributionId,
        replayed: true,
        status: "published" as const,
      }),
    );
    const { app, verifyAccessToken } = operatorApp(service(resolveDistribution));
    const response = await request(app);

    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(verifyAccessToken).toHaveBeenCalledWith(env, "signed-access-token");
    expect(resolveDistribution).toHaveBeenCalledWith(
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
    );
    await expect(response.json()).resolves.toEqual({
      audit_id: "94000000-0000-4000-8000-000000000001",
      distribution_id: distributionId,
      status: "published",
    });
  });

  it("rejects mismatched confirmation and short idempotency keys", async () => {
    const resolveDistribution = vi.fn();
    const { app } = operatorApp(service(resolveDistribution));
    const badConfirmation = await request(app, {
      body: { ...body, confirm: "resolve something else" },
    });
    const badKey = await request(app, {
      headers: { "Idempotency-Key": "short" },
    });

    expect(badConfirmation.status).toBe(400);
    expect(badKey.status).toBe(400);
    expect(resolveDistribution).not.toHaveBeenCalled();
  });

  it("rejects unsafe URLs and evidence for a different terminal state", async () => {
    const resolveDistribution = vi.fn();
    const { app } = operatorApp(service(resolveDistribution));
    const unsafeUrl = await request(app, {
      body: {
        ...body,
        provider_url: "https://provider.example/posts/20?token=secret",
      },
    });
    const mismatchedEvidence = await request(app, {
      body: {
        ...body,
        confirm: `resolve ${distributionId} as failed`,
        failure_code: "provider_rejected",
        resolution: "failed",
      },
    });

    expect(unsafeUrl.status).toBe(400);
    expect(mismatchedEvidence.status).toBe(400);
    expect(resolveDistribution).not.toHaveBeenCalled();
  });
});
