import { describe, expect, it, vi } from "vite-plus/test";
import { Effect, Exit } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  ActiveOrganizationRequiredError,
  DatabaseError,
  NotFoundError,
  RequestContext,
  StorageUnavailableError,
} from "@meltiply/domain";
import { ProviderAdapterError } from "@meltiply/providers";

import { CoreApiError, toCoreApiErrorOrRethrow } from "../src/core-types";
import { runWorkerEffect } from "../src/effect/runtime";
import { fakeHonoContext, fakeTransactionClient } from "../test-support/fakes";
import { reserveIdempotencyEffect, type IdempotencyRecord } from "../src/idempotency";

function createMockHonoContext(options: {
  readonly executionCtx?: {
    readonly waitUntil?: (p: Promise<unknown>) => void;
  };
  readonly requestId?: string;
  readonly session?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly traceId?: string;
}) {
  return fakeHonoContext({
    executionCtx: options.executionCtx,
    requestId: options.requestId ?? "test-req-id",
    session: options.session ?? { subject: "user_test", organizationId: "org_test" },
    signal: options.signal,
    traceId: options.traceId ?? "test-trace-id",
  });
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

    it("sanitizes provider 502 errors from ProviderAdapterError", async () => {
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

    it("sanitizes StorageUnavailableError 503 messages", async () => {
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
    });

    it("formats Retry-After and a sanitized message on provider 429 rate limits", async () => {
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

describe("reserveIdempotencyEffect", () => {
  const organizationId = "org-1";
  const operation = "update-post";
  const idempotencyKey = "key-1";
  const requestHash = "hash-1";

  function scriptedClient(script: {
    readonly insertRowCounts: readonly number[];
    readonly selectRows: readonly (readonly IdempotencyRecord[])[];
  }): { client: EffectTransactionClient; queries: string[] } {
    const queries: string[] = [];
    let insertIndex = 0;
    let selectIndex = 0;
    const client = fakeTransactionClient((text) => {
      queries.push(text);
      if (text.includes("INSERT INTO idempotency_keys")) {
        const inserted = (script.insertRowCounts[insertIndex++] ?? 0) === 1;
        return Effect.succeed({
          rowCount: inserted ? 1 : 0,
          rows: inserted ? [{ idempotency_key: idempotencyKey }] : [],
        });
      }
      const rows = script.selectRows[selectIndex++] ?? [];
      return Effect.succeed({
        rowCount: rows.length,
        rows,
      });
    });
    return { client, queries };
  }

  it("reserves cleanly when a rolled-back leader leaves no committed row", async () => {
    const { client, queries } = scriptedClient({
      insertRowCounts: [0, 1],
      selectRows: [[]],
    });
    const result = await Effect.runPromise(
      reserveIdempotencyEffect(client, organizationId, operation, idempotencyKey, requestHash),
    );
    expect(result).toBeNull();
    expect(queries.filter((text) => text.includes("INSERT INTO"))).toHaveLength(2);
  });

  it("fails with idempotency_in_progress after bounded retries find no row", async () => {
    const { client, queries } = scriptedClient({
      insertRowCounts: [0, 0, 0],
      selectRows: [[], [], []],
    });
    const exit = await Effect.runPromiseExit(
      reserveIdempotencyEffect(client, organizationId, operation, idempotencyKey, requestHash),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause;
      expect(JSON.stringify(failure)).toContain("idempotency_in_progress");
    }
    expect(queries.filter((text) => text.includes("INSERT INTO"))).toHaveLength(3);
  });

  it("replays a completed record and rejects a hash conflict without retrying", async () => {
    const completed: IdempotencyRecord = {
      request_hash: requestHash,
      response_body: { ok: true },
      response_status: 200,
    };
    const replayed = scriptedClient({
      insertRowCounts: [0],
      selectRows: [[completed]],
    });
    await expect(
      Effect.runPromise(
        reserveIdempotencyEffect(
          replayed.client,
          organizationId,
          operation,
          idempotencyKey,
          requestHash,
        ),
      ),
    ).resolves.toEqual(completed);
    expect(replayed.queries.filter((text) => text.includes("INSERT INTO"))).toHaveLength(1);

    const conflicted = scriptedClient({
      insertRowCounts: [0],
      selectRows: [[{ ...completed, request_hash: "other-hash" }]],
    });
    const exit = await Effect.runPromiseExit(
      reserveIdempotencyEffect(
        conflicted.client,
        organizationId,
        operation,
        idempotencyKey,
        requestHash,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("idempotency_conflict");
    }
    expect(conflicted.queries.filter((text) => text.includes("INSERT INTO"))).toHaveLength(1);
  });
});

describe("toCoreApiErrorOrRethrow", () => {
  it("returns CoreApiError causes for typed failures", () => {
    const error = new CoreApiError(422, "validation_error", "Invalid.");
    expect(toCoreApiErrorOrRethrow(error)).toBe(error);
  });

  it("rethrows unexpected errors so they surface as defects", () => {
    const defect = new TypeError("programming defect");
    expect(() => toCoreApiErrorOrRethrow(defect)).toThrow(defect);
  });
});
