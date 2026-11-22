import { Effect } from "effect";
import type { Context, Hono } from "hono";

import { CoreApiError } from "./core-types";
import type { ApiWorkerEnvironment } from "./env";
import { type OperatorReconciliationService, parseOperatorResolution } from "./operator-resolution";
import { idempotencyHeaders } from "./idempotent-response";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import { jsonResponse } from "./responses";

const printableAsciiPattern = /^[\x20-\x7e]+$/;

export interface OperatorRouteDependencies {
  operatorReconciliationService?: OperatorReconciliationService;
}

function idempotencyKey(c: Context<ApiWorkerEnvironment>): string {
  const key = c.req.header("Idempotency-Key") ?? "";
  if (key.length < 8 || key.length > 128 || !printableAsciiPattern.test(key)) {
    throw new CoreApiError(
      400,
      "idempotency_key_required",
      "Idempotency-Key must contain 8 to 128 printable ASCII characters.",
    );
  }
  return key;
}

async function jsonBody(c: Context<ApiWorkerEnvironment>): Promise<Record<string, unknown>> {
  if (c.req.header("Content-Type")?.split(";", 1)[0] !== "application/json") {
    throw new CoreApiError(
      415,
      "unsupported_media_type",
      "Operator mutations require application/json.",
    );
  }
  try {
    const value: unknown = await c.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("body is not an object");
    }
    return value as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof CoreApiError) throw cause;
    throw new CoreApiError(400, "invalid_operator_resolution", "A JSON object is required.");
  }
}

function lazyOperatorReconciliationService(): OperatorReconciliationService {
  const load = (): Effect.Effect<OperatorReconciliationService, CoreApiError> =>
    Effect.tryPromise({
      catch: (cause) =>
        cause instanceof CoreApiError
          ? cause
          : new CoreApiError(
              500,
              "internal_error",
              cause instanceof Error
                ? cause.message
                : "The reconciliation service could not be loaded.",
            ),
      try: async () =>
        (await import("./operator-reconciliation")).createOperatorReconciliationService(),
    });

  return {
    resolveDistribution(...arguments_) {
      return Effect.flatMap(load(), (service) => service.resolveDistribution(...arguments_));
    },
  };
}

export function registerOperatorRoutes(
  app: Hono<ApiWorkerEnvironment>,
  dependencies: OperatorRouteDependencies = {},
): void {
  const service = dependencies.operatorReconciliationService ?? lazyOperatorReconciliationService();

  app.post("/operator/v1/distributions/:id/reconciliation", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = c.req.param("id");
        const input = yield* fromPromise(async () =>
          parseOperatorResolution(distributionId, await jsonBody(c)),
        );
        const result = yield* service.resolveDistribution(
          c.env,
          c.get("operator"),
          distributionId,
          input,
          yield* fromPromise(() => idempotencyKey(c)),
          c.get("requestId"),
        );
        return jsonResponse(
          {
            audit_id: result.auditId,
            distribution_id: result.distributionId,
            status: result.status,
          },
          200,
          c.get("requestId"),
          idempotencyHeaders(result.replayed),
        );
      }),
    ),
  );
}
