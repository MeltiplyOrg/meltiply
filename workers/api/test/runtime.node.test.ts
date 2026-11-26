import type { EffectTransactionClient } from "@meltiply/database";
import {
  ActiveOrganizationRequiredError,
  DatabaseError,
  NotFoundError,
  RequestContext,
  StorageUnavailableError,
} from "@meltiply/domain";
import { ProviderAdapterError } from "@meltiply/providers";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { CoreApiError, toCoreApiErrorOrRethrow } from "../src/core-types";
import { runWorkerEffect } from "../src/effect/runtime";
import { reserveIdempotencyEffect, type IdempotencyRecord } from "../src/idempotency";
import { fakeHonoContext, fakeTransactionClient } from "../test-support/fakes";

function contextWith(
  options: {
    readonly executionCtx?: { readonly waitUntil?: (p: Promise<unknown>) => void };
    readonly requestId?: string;
    readonly signal?: AbortSignal;
    readonly traceId?: string;
  } = {},
) {
  return fakeHonoContext({
    executionCtx: options.executionCtx,
    requestId: options.requestId ?? "test-req-id",
    session: { organizationId: "org_test", subject: "user_test" },
    signal: options.signal,
    traceId: options.traceId ?? "test-trace-id",
  });
}

describe("runWorkerEffect", () => {
  it("executes a successful effect with RequestContext and sets X-Request-ID", async () => {
    const response = await runWorkerEffect(
      contextWith({ requestId: "req-success-1" }),
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        return { hello: "world", requestId: ctx.requestId };
      }),
    );

    expect(response.status).toEqual(200);
    expect(response.headers.get("X-Request-ID")).toEqual("req-success-1");
    expect(await response.json()).toEqual({ hello: "world", requestId: "req-success-1" });
  });

  it("skips synchronous work when the client signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let executed = false;

    const response = await runWorkerEffect(
      contextWith({ requestId: "req-client-abort", signal: controller.signal }),
      Effect.sync(() => {
        executed = true;
        return { completed: true };
      }),
    );

    expect(executed).toEqual(false);
    expect(response.status).toEqual(499);
    expect(await response.json()).toMatchObject({
      error: { code: "client_aborted", request_id: "req-client-abort" },
    });
  });

  it("prioritizes defects over typed failures in combined Fail + Die causes", async () => {
    const response = await runWorkerEffect(
      contextWith({ requestId: "req-fail-and-die" }),
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.die(new Error("Finalizer crashed")));
          yield* new NotFoundError({ message: "Requested item not found" });
          return null;
        }),
      ),
    );

    expect(response.status).toEqual(500);
    expect(await response.json()).toMatchObject({
      error: {
        code: "internal_error",
        message: "An unexpected error occurred.",
        request_id: "req-fail-and-die",
      },
    });
  });

  it("isolates RequestContext across concurrent interleaved requests", async () => {
    let bothStarted!: () => void;
    let startedCount = 0;
    const gate = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });

    const program = Effect.gen(function* () {
      const initial = (yield* RequestContext).requestId;
      startedCount += 1;
      if (startedCount === 2) bothStarted();
      yield* Effect.promise(() => gate);
      const after = (yield* RequestContext).requestId;
      return { after, initial };
    });

    const [res1, res2] = await Promise.all([
      runWorkerEffect(contextWith({ requestId: "req-1", traceId: "trace-1" }), program),
      runWorkerEffect(contextWith({ requestId: "req-2", traceId: "trace-2" }), program),
    ]);

    expect(await res1.json()).toEqual({ after: "req-1", initial: "req-1" });
    expect(await res2.json()).toEqual({ after: "req-2", initial: "req-2" });
  });

  it("registers span export promises with executionCtx.waitUntil", async () => {
    const waited: Promise<unknown>[] = [];
    const response = await runWorkerEffect(
      contextWith({
        executionCtx: {
          waitUntil: (promise) => {
            waited.push(promise);
          },
        },
        requestId: "req-waituntil-test",
      }),
      Effect.withSpan("worker.with_waituntil")(Effect.succeed("success")),
    );

    expect(response.status).toEqual(200);
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toEqual(undefined);
  });

  it.each<readonly [string, Effect.Effect<never, unknown>, number, string, string]>([
    [
      "ActiveOrganizationRequiredError",
      Effect.fail(
        new ActiveOrganizationRequiredError({
          message: "The authenticated identity is not an active organization member.",
        }),
      ),
      403,
      "active_organization_required",
      "The authenticated identity is not an active organization member.",
    ],
    [
      "NotFoundError",
      Effect.fail(new NotFoundError({ message: "Requested item not found" })),
      404,
      "not_found",
      "Requested item not found",
    ],
    [
      "CoreApiError 500 preserves message",
      Effect.fail(new CoreApiError(500, "internal_error", "Preserved server error message")),
      500,
      "internal_error",
      "Preserved server error message",
    ],
    [
      "CoreApiError 503 preserves message",
      Effect.fail(
        new CoreApiError(503, "dependency_unavailable", "upstream dependency unavailable"),
      ),
      503,
      "dependency_unavailable",
      "upstream dependency unavailable",
    ],
    [
      "DatabaseError is sanitized",
      Effect.fail(
        new DatabaseError({
          cause: new Error("connection to 10.0.0.1:5432 timed out"),
          message: "PostgreSQL pool connection failed: password rejected",
        }),
      ),
      500,
      "internal_error",
      "An unexpected error occurred.",
    ],
    [
      "ProviderAdapterError 502 is sanitized",
      Effect.fail(
        new ProviderAdapterError({
          classification: "transient",
          code: "provider_unavailable",
          message: "upstream endpoint unreachable",
          retryable: false,
        }),
      ),
      502,
      "provider_unavailable",
      "An unexpected error occurred.",
    ],
    [
      "StorageUnavailableError is sanitized",
      Effect.fail(new StorageUnavailableError({ message: "R2 credentials revoked" })),
      503,
      "service_unavailable",
      "An unexpected error occurred.",
    ],
    [
      "Unexpected defect is sanitized",
      Effect.die(new Error("unexpected segfault")),
      500,
      "internal_error",
      "An unexpected error occurred.",
    ],
  ])("maps %s to status %i", async (_label, program, status, code, message) => {
    const response = await runWorkerEffect(contextWith({ requestId: "req-map" }), program);

    expect(response.status).toEqual(status);
    expect(await response.json()).toMatchObject({
      error: { code, message, request_id: "req-map" },
    });
  });

  it("formats Retry-After and sanitized message on provider 429 rate limits", async () => {
    const response = await runWorkerEffect(
      contextWith({ requestId: "req-rate-429" }),
      Effect.fail(
        new ProviderAdapterError({
          classification: "rate_limit",
          code: "provider_rate_limited",
          message: "Upstream rate limit exceeded",
          retryAfterSeconds: 60,
          retryable: true,
        }),
      ),
    );

    expect(response.status).toEqual(429);
    expect(response.headers.get("Retry-After")).toEqual("60");
    expect(await response.json()).toMatchObject({
      error: {
        code: "provider_rate_limited",
        message: "The provider rate limit has been reached.",
        request_id: "req-rate-429",
      },
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
      return Effect.succeed({ rowCount: rows.length, rows });
    });
    return { client, queries };
  }

  it("reserves cleanly after a rolled-back leader leaves no committed row", async () => {
    const { client, queries } = scriptedClient({
      insertRowCounts: [0, 1],
      selectRows: [[]],
    });

    expect(
      await Effect.runPromise(
        reserveIdempotencyEffect(client, organizationId, operation, idempotencyKey, requestHash),
      ),
    ).toEqual(null);
    expect(queries.filter((text) => text.includes("INSERT INTO"))).toHaveLength(2);
  });

  it("fails with idempotency_in_progress after three unsuccessful attempts", async () => {
    const { client, queries } = scriptedClient({
      insertRowCounts: [0, 0, 0],
      selectRows: [[], [], []],
    });

    const error = await Effect.runPromise(
      Effect.flip(
        reserveIdempotencyEffect(client, organizationId, operation, idempotencyKey, requestHash),
      ),
    );

    expect(error).toMatchObject({ code: "idempotency_in_progress", status: 409 });
    expect(queries.filter((text) => text.includes("INSERT INTO"))).toHaveLength(3);
  });

  it("replays a completed record without retrying", async () => {
    const completed: IdempotencyRecord = {
      request_hash: requestHash,
      response_body: { ok: true },
      response_status: 200,
    };
    const { client, queries } = scriptedClient({
      insertRowCounts: [0],
      selectRows: [[completed]],
    });

    expect(
      await Effect.runPromise(
        reserveIdempotencyEffect(client, organizationId, operation, idempotencyKey, requestHash),
      ),
    ).toEqual(completed);
    expect(queries.filter((text) => text.includes("INSERT INTO"))).toHaveLength(1);
  });

  it("rejects a hash conflict without retrying", async () => {
    const { client, queries } = scriptedClient({
      insertRowCounts: [0],
      selectRows: [
        [{ request_hash: "other-hash", response_body: { ok: true }, response_status: 200 }],
      ],
    });

    const error = await Effect.runPromise(
      Effect.flip(
        reserveIdempotencyEffect(client, organizationId, operation, idempotencyKey, requestHash),
      ),
    );

    expect(error).toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(queries.filter((text) => text.includes("INSERT INTO"))).toHaveLength(1);
  });
});

describe("toCoreApiErrorOrRethrow", () => {
  it("returns CoreApiError instances", () => {
    const error = new CoreApiError(422, "validation_error", "Invalid.");

    expect(toCoreApiErrorOrRethrow(error)).toBe(error);
  });

  it("rethrows unexpected defects", () => {
    const defect = new TypeError("programming defect");

    expect(() => toCoreApiErrorOrRethrow(defect)).toThrow(defect);
  });
});
