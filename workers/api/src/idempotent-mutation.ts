import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import type { CoreApiError } from "./core-types";
import { completeIdempotencyEffect, reserveIdempotencyEffect } from "./idempotency";

/**
 * Runs one idempotent mutation that also replays the recorded HTTP status.
 *
 * Use for routes whose status code varies with the outcome (for example the
 * 202/204 split on in-flight cancellation); `withIdempotentMutation` covers
 * the fixed-status case.
 *
 * @param client - Active transactional client owning the reservation.
 * @param organizationId - Workspace UUID scoping the idempotency key.
 * @param operation - Operation identifier.
 * @param idempotencyKey - Validated `Idempotency-Key` header value.
 * @param requestHash - SHA-256 digest of the canonical request payload.
 * @param run - Transactional program producing status and body.
 * @returns Effect resolving to the produced or replayed status and body.
 */
export function withIdempotentMutationStatus(
  client: EffectTransactionClient,
  organizationId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  run: (
    client: EffectTransactionClient,
  ) => Effect.Effect<{ body: unknown; status: number }, CoreApiError | DatabaseError>,
): Effect.Effect<
  { body: unknown; replayed: boolean; status: number },
  CoreApiError | DatabaseError
> {
  return Effect.gen(function* () {
    const prior = yield* reserveIdempotencyEffect(
      client,
      organizationId,
      operation,
      idempotencyKey,
      requestHash,
    );
    if (prior) {
      return {
        body: prior.response_body,
        replayed: true,
        status: prior.response_status ?? 200,
      };
    }
    const produced = yield* run(client);
    yield* completeIdempotencyEffect(
      client,
      organizationId,
      operation,
      idempotencyKey,
      produced.status,
      produced.body,
    );
    return { ...produced, replayed: false };
  });
}
