import { Effect } from "effect";
import type { Context, Hono } from "hono";

import { CoreApiError } from "./core-types";
import type { ApiWorkerEnvironment } from "./env";
import { type OperatorReconciliationService, parseOperatorResolution } from "./operator-resolution";
import { idempotencyHeaders } from "./idempotent-response";
import { fromPromise } from "./effect/route";
import { runRouteEffect } from "./effect/runtime";
import { jsonResponse } from "./responses";

export interface OperatorRouteDependencies {
  operatorReconciliationService?: OperatorReconciliationService;
}

/**
 * Validates and extracts the `Idempotency-Key` HTTP header from an operator mutation request.
 *
 * Ensures the key contains between 8 and 128 printable ASCII characters.
 *
 * @param c - Hono request context.
 * @returns Validated idempotency key string.
 * @throws {CoreApiError} 400 `idempotency_key_required` if the header is absent or invalid.
 */
function idempotencyKey(c: Context<ApiWorkerEnvironment>): string {
  const key = c.req.header("Idempotency-Key") ?? "";
  if (key.length < 8 || key.length > 128 || !/^[\x20-\x7e]+$/.test(key)) {
    throw new CoreApiError(
      400,
      "idempotency_key_required",
      "Idempotency-Key must contain 8 to 128 printable ASCII characters.",
    );
  }
  return key;
}

/**
 * Validates `application/json` Media Type and parses the JSON request body as an object dictionary.
 *
 * @param c - Hono request context.
 * @returns Parsed JSON body object.
 * @throws {CoreApiError} 415 `unsupported_media_type` if Content-Type is not `application/json`.
 * @throws {CoreApiError} 400 `invalid_operator_resolution` if body is not a JSON object.
 */
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

/**
 * Lazily creates the reconciliation service for production routes.
 *
 * Dynamic loading keeps `pg` outside Worker test isolates while every operator
 * method shares one failure mapping. The returned service preserves the normal
 * Effect error contract: import failures become `internal_error`.
 *
 * @returns An Effect-native reconciliation service backed by the production module.
 */
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

/**
 * Registers operator administrative reconciliation HTTP endpoints onto the Hono application router.
 *
 * Mounts:
 * - `POST /operator/v1/distributions/:id/reconciliation`: Reconciles ambiguous distributions.
 *
 * **Client authentication**: Operator routes are protected by Cloudflare Access. Callers
 * must authenticate with the Access application before making requests:
 * ```sh
 * OPS_ORIGIN=https://<OPERATOR_HOSTNAME>
 * cloudflared access login "$OPS_ORIGIN"
 * CF_TOKEN="$(cloudflared access token -app="$OPS_ORIGIN")"
 * curl --request POST \
 *      --header "cf-access-token: $CF_TOKEN" \
 *      --header "Content-Type: application/json" \
 *      --header "Idempotency-Key: <unique-key>" \
 *      "$OPS_ORIGIN/operator/v1/..."
 * ```
 * The client sends `cf-access-token` to Cloudflare Access. Cloudflare Access verifies the token
 * at the edge and forwards the identity downstream in the `Cf-Access-Jwt-Assertion` header.
 * The Worker middleware in `app.ts` independently verifies this assertion against Cloudflare Access
 * public keys. Do not manufacture or forward `Cf-Access-Jwt-Assertion` directly in client calls.
 * Requests to a non-matching `OPERATOR_HOSTNAME` or with an invalid/missing assertion receive 403.
 *
 * **Idempotent retries**: Use the same `Idempotency-Key` header to safely retry a request.
 * The reconciliation service deduplicates by key, returning the original result on replay.
 *
 * @param app - Target Hono router instance.
 * @param dependencies - Optional service override (defaults to lazily importing `createOperatorReconciliationService`).
 */
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
