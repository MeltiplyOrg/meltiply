import { describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";
import {
  ActiveOrganizationRequiredError,
  DatabaseError,
  NotFoundError,
  ProviderError,
  ProviderRateLimitError,
  RateLimitExceededError,
  RequestContext,
  StorageUnavailable,
  StorageUnavailableError,
  ValidationError,
} from "@meltiply/domain";
import { ProviderAdapterError } from "@meltiply/providers";

import { CoreApiError } from "../src/core-types";
import { runWorkerEffect } from "../src/effect/runtime";

/**
 * Constructs a minimal mock Hono context for testing the Worker Effect runtime boundary.
 *
 * Provides a key-value store simulating Hono environment and request-level context
 * values such as correlation IDs, session claims, Worker executionCtx, and the
 * incoming request signal.
 *
 * @param options - Correlation identifiers, session attributes, execution context, and signal.
 * @returns A mocked HonoContext compatible with runWorkerEffect.
 */
function createMockHonoContext(options: {
  readonly executionCtx?: {
    readonly waitUntil?: (p: Promise<unknown>) => void;
  };
  readonly requestId?: string;
  readonly session?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly traceId?: string;
}) {
  const store = new Map<string, unknown>([
    ["requestId", options.requestId ?? "test-req-id"],
    ["traceId", options.traceId ?? "test-trace-id"],
    ["session", options.session ?? { subject: "user_test", organizationId: "org_test" }],
  ]);

  return {
    env: {
      ENVIRONMENT: "test",
    },
    executionCtx: options.executionCtx,
    get: (key: string) => store.get(key),
    req: { raw: { signal: options.signal } },
    set: (key: string, value: unknown) => store.set(key, value),
  } as unknown as Parameters<typeof runWorkerEffect>[0];
}

describe("runWorkerEffect (Cloudflare/Hono Effect boundary runner)", () => {
  it("executes successful effect and returns canonical jsonResponse", async () => {
    const c = createMockHonoContext({ requestId: "req-success-1" });
    const program = Effect.gen(function* () {
      const ctx = yield* RequestContext;
      return { hello: "world", requestId: ctx.requestId };
    });

    const response = await runWorkerEffect(c, program);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      hello: "world",
      requestId: "req-success-1",
    });
    expect(response.headers.get("X-Request-ID")).toBe("req-success-1");
  });

  it("does not run synchronous work after the client aborts the request", async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = false;

    const response = await runWorkerEffect(
      createMockHonoContext({
        requestId: "req-client-abort",
        signal: controller.signal,
      }),
      Effect.sync(() => {
        executed = true;
        return { completed: true };
      }),
    );

    expect(executed).toBe(false);
    expect(response.status).toBe(499);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "client_aborted", request_id: "req-client-abort" },
    });
  });

  it("maps tagged domain errors to OpenAPI ErrorEnvelope responses", async () => {
    const c = createMockHonoContext({ requestId: "req-error-403" });
    const program = Effect.gen(function* () {
      yield* new ActiveOrganizationRequiredError({
        message: "The authenticated identity is not an active organization member.",
      });
      return { unreachable: true };
    });

    const response = await runWorkerEffect(c, program);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "active_organization_required",
        message: "The authenticated identity is not an active organization member.",
        request_id: "req-error-403",
      },
    });
  });

  it("maps NotFoundError to 404 ErrorEnvelope", async () => {
    const c = createMockHonoContext({ requestId: "req-error-404" });
    const program = Effect.gen(function* () {
      yield* new NotFoundError({
        entityId: "item_999",
        message: "Requested item not found",
      });
      return null;
    });

    const response = await runWorkerEffect(c, program);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "not_found",
        message: "Requested item not found",
      },
    });
  });

  it("maps ValidationError with structured issues to OpenAPI ErrorEnvelope details and issues", async () => {
    const c = createMockHonoContext({ requestId: "req-val-422" });
    const program = Effect.gen(function* () {
      yield* new ValidationError({
        issues: [
          {
            constraint: "email_format",
            field: "email",
            message: "Must be a valid email address",
          },
        ],
        message: "Validation failed for input parameters.",
      });
      return null;
    });

    const response = await runWorkerEffect(c, program);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_error",
        details: [
          expect.objectContaining({
            field: "email",
            message: "Must be a valid email address",
          }),
        ],
        issues: [
          expect.objectContaining({
            field: "email",
            message: "Must be a valid email address",
          }),
        ],
        message: "Validation failed for input parameters.",
        request_id: "req-val-422",
      },
    });
  });

  it("normalizes ValidationError details-shape entries to canonical ErrorDetail records", async () => {
    const c = createMockHonoContext({ requestId: "req-val-details" });
    const program = Effect.gen(function* () {
      yield* new ValidationError({
        details: [
          {
            field: "email",
            limit: "5",
            message: "Required",
          },
        ],
        message: "Invalid",
      });
      return null;
    });

    const response = await runWorkerEffect(c, program);
    expect(response.status).toBe(422);
    const body: {
      error: {
        code: string;
        details: Record<string, unknown>[];
        issues: Record<string, unknown>[];
        message: string;
        request_id: string;
      };
    } = await response.json();
    expect(body.error).toMatchObject({
      code: "validation_error",
      details: [
        {
          code: "invalid",
          field: "email",
          message: "Required",
        },
      ],
      issues: [
        expect.objectContaining({
          constraint: "invalid",
          field: "email",
          message: "Required",
        }),
      ],
      message: "Invalid",
      request_id: "req-val-details",
    });
    expect(body.error.details[0]).not.toHaveProperty("limit");
  });

  it("maps unexpected defects to 500 internal_error", async () => {
    const c = createMockHonoContext({ requestId: "req-defect-500" });
    const program = Effect.gen(function* () {
      yield* Effect.die(new Error("Catastrophic unexpected bug"));
    });

    const response = await runWorkerEffect(c, program);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "internal_error",
        request_id: "req-defect-500",
      },
    });
  });

  it("prioritizes defects over typed recoverable errors in combined Fail + Die causes", async () => {
    const c = createMockHonoContext({ requestId: "req-fail-and-die" });
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.die(new Error("Finalizer crashed unexpectedly")));
        yield* new NotFoundError({
          entityId: "item_999",
          message: "Requested item not found",
        });
        return null;
      }),
    );

    const response = await runWorkerEffect(c, program);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
        request_id: "req-fail-and-die",
      },
    });
  });

  it("provides Effect tracer and supports child spans within request execution", async () => {
    const c = createMockHonoContext({
      requestId: "req-trace-test",
      traceId: "trace-abc-123",
    });

    const program = Effect.gen(function* () {
      const result = yield* Effect.succeed({ processed: true }).pipe(
        Effect.withSpan("worker.process_item", {
          attributes: { "item.id": "42" },
        }),
      );
      return result;
    });

    const response = await runWorkerEffect(c, program);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ processed: true });
  });

  it("ensures request context does not leak between concurrent requests", async () => {
    const c1 = createMockHonoContext({
      requestId: "req-concurrent-1",
      traceId: "trace-1",
    });
    const c2 = createMockHonoContext({
      requestId: "req-concurrent-2",
      traceId: "trace-2",
    });

    const program = Effect.gen(function* () {
      const ctx = yield* RequestContext;
      yield* Effect.sleep("15 millis");
      const ctxAfter = yield* RequestContext;
      return {
        initial: ctx.requestId,
        after: ctxAfter.requestId,
      };
    });

    const [res1, res2] = await Promise.all([
      runWorkerEffect(c1, program),
      runWorkerEffect(c2, program),
    ]);

    await expect(res1.json()).resolves.toEqual({
      after: "req-concurrent-1",
      initial: "req-concurrent-1",
    });
    await expect(res2.json()).resolves.toEqual({
      after: "req-concurrent-2",
      initial: "req-concurrent-2",
    });
  });

  it("registers span export promises with executionCtx.waitUntil", async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });

    const c = createMockHonoContext({
      executionCtx: { waitUntil },
      requestId: "req-waituntil-test",
    });

    const program = Effect.gen(function* () {
      return yield* Effect.withSpan("worker.with_waituntil")(Effect.succeed("success"));
    });

    const response = await runWorkerEffect(c, program);
    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntilPromises.length).toBe(1);
    await expect(waitUntilPromises[0]).resolves.toBeUndefined();
  });

  describe("error sanitization policy", () => {
    it("preserves explicit error messages on CoreApiError 500 and 503", async () => {
      const c500 = createMockHonoContext({ requestId: "req-core-500" });
      const prog500 = Effect.fail(
        new CoreApiError(500, "internal_error", "Preserved server error message"),
      );
      const res500 = await runWorkerEffect(c500, prog500);
      expect(res500.status).toBe(500);
      await expect(res500.json()).resolves.toMatchObject({
        error: {
          code: "internal_error",
          message: "Preserved server error message",
          request_id: "req-core-500",
        },
      });

      const c503 = createMockHonoContext({ requestId: "req-core-503" });
      const prog503 = Effect.fail(
        new CoreApiError(503, "dependency_unavailable", "upstream dependency unavailable"),
      );
      const res503 = await runWorkerEffect(c503, prog503);
      expect(res503.status).toBe(503);
      await expect(res503.json()).resolves.toMatchObject({
        error: {
          code: "dependency_unavailable",
          message: "upstream dependency unavailable",
          request_id: "req-core-503",
        },
      });
    });

    it("sanitizes typed domain DatabaseError 500 message to generic error", async () => {
      const c = createMockHonoContext({ requestId: "req-db-500" });
      const program = Effect.fail(
        new DatabaseError({
          cause: new Error("connection to 10.0.0.1:5432 timed out"),
          message: "PostgreSQL pool connection failed: password rejected",
        }),
      );
      const response = await runWorkerEffect(c, program);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "internal_error",
          message: "An unexpected error occurred.",
          request_id: "req-db-500",
        },
      });
    });

    it("sanitizes provider 502 errors for both ProviderError and ProviderAdapterError", async () => {
      const c1 = createMockHonoContext({ requestId: "req-prov-502-1" });
      const prog1 = Effect.fail(
        new ProviderError({
          message: "upstream tiktok internal 500 response body",
          provider: "tiktok",
        }),
      );
      const res1 = await runWorkerEffect(c1, prog1);
      expect(res1.status).toBe(502);
      await expect(res1.json()).resolves.toMatchObject({
        error: {
          code: "provider_error",
          message: "An unexpected error occurred.",
          request_id: "req-prov-502-1",
        },
      });

      const c2 = createMockHonoContext({ requestId: "req-prov-502-2" });
      const prog2 = Effect.fail(
        new ProviderAdapterError({
          classification: "transient",
          code: "provider_unavailable",
          message: "upstream endpoint unreachable",
          retryable: false,
        }),
      );
      const res2 = await runWorkerEffect(c2, prog2);
      expect(res2.status).toBe(502);
      await expect(res2.json()).resolves.toMatchObject({
        error: {
          code: "provider_unavailable",
          message: "An unexpected error occurred.",
          request_id: "req-prov-502-2",
        },
      });
    });

    it("sanitizes domain StorageUnavailableError 503 while preserving DomainError 503 message", async () => {
      const c1 = createMockHonoContext({ requestId: "req-storage-effect" });
      const prog1 = Effect.fail(
        new StorageUnavailableError({
          message: "R2 bucket credentials revoked or expired",
        }),
      );
      const res1 = await runWorkerEffect(c1, prog1);
      expect(res1.status).toBe(503);
      await expect(res1.json()).resolves.toMatchObject({
        error: {
          code: "service_unavailable",
          message: "An unexpected error occurred.",
          request_id: "req-storage-effect",
        },
      });

      const c2 = createMockHonoContext({ requestId: "req-storage-domain" });
      const prog2 = Effect.fail(new StorageUnavailable("Storage is unavailable."));
      const res2 = await runWorkerEffect(c2, prog2);
      expect(res2.status).toBe(503);
      await expect(res2.json()).resolves.toMatchObject({
        error: {
          code: "service_unavailable",
          message: "Storage is unavailable.",
          request_id: "req-storage-domain",
        },
      });
    });

    it("preserves message and formats Retry-After header on 429 rate limit errors", async () => {
      const cRate = createMockHonoContext({ requestId: "req-rate-429" });
      const progRate = Effect.fail(
        new RateLimitExceededError({
          message: "Rate limit budget exceeded. Try again shortly.",
          retryAfterSeconds: 30,
        }),
      );
      const resRate = await runWorkerEffect(cRate, progRate);
      expect(resRate.status).toBe(429);
      expect(resRate.headers.get("Retry-After")).toBe("30");
      await expect(resRate.json()).resolves.toMatchObject({
        error: {
          code: "rate_limited",
          message: "Rate limit budget exceeded. Try again shortly.",
          request_id: "req-rate-429",
        },
      });

      const cProv = createMockHonoContext({ requestId: "req-prov-rate-429" });
      const progProv = Effect.fail(
        new ProviderRateLimitError({
          message: "TikTok publish rate limit reached.",
          provider: "tiktok",
          retryAfterSeconds: 45,
        }),
      );
      const resProv = await runWorkerEffect(cProv, progProv);
      expect(resProv.status).toBe(429);
      expect(resProv.headers.get("Retry-After")).toBe("45");
      await expect(resProv.json()).resolves.toMatchObject({
        error: {
          code: "provider_rate_limited",
          message: "TikTok publish rate limit reached.",
          request_id: "req-prov-rate-429",
        },
      });

      const cAdapter = createMockHonoContext({
        requestId: "req-adapter-rate-429",
      });
      const progAdapter = Effect.fail(
        new ProviderAdapterError({
          classification: "rate_limit",
          code: "provider_rate_limited",
          message: "Upstream rate limit exceeded",
          retryAfterSeconds: 60,
          retryable: true,
        }),
      );
      const resAdapter = await runWorkerEffect(cAdapter, progAdapter);
      expect(resAdapter.status).toBe(429);
      expect(resAdapter.headers.get("Retry-After")).toBe("60");
      await expect(resAdapter.json()).resolves.toMatchObject({
        error: {
          code: "provider_rate_limited",
          message: "The provider rate limit has been reached.",
          request_id: "req-adapter-rate-429",
        },
      });
    });

    it("sanitizes unexpected defects and exceptions to 500 internal_error", async () => {
      const c = createMockHonoContext({ requestId: "req-die-500" });
      const program = Effect.die(new Error("unexpected segfault or TypeError"));
      const response = await runWorkerEffect(c, program);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "internal_error",
          message: "An unexpected error occurred.",
          request_id: "req-die-500",
        },
      });
    });
  });
});
