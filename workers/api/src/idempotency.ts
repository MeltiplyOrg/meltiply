import { Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";

import { CoreApiError } from "./core-types";
import { sha256Hex } from "./crypto";

export interface IdempotencyRecord extends Record<string, unknown> {
  request_hash: string;
  response_body: unknown;
  response_status: number | null;
}

/**
 * Calculates a SHA-256 hexadecimal hash of the serialized request payload via Effect.
 *
 * Used to detect payload mutations across retries using the same idempotency key.
 *
 * @param value - Canonical string representation of the request payload or parameters.
 * @returns Effect resolving to a 64-character lowercase hexadecimal SHA-256 digest string.
 */
export function hashIdempotencyRequestEffect(value: string): Effect.Effect<string> {
  return Effect.promise(() => sha256Hex(value));
}

/**
 * Attempts to reserve an idempotency key slot or retrieve a cached prior result using an Effect client.
 *
 * @param client - Active EffectTransactionClient.
 * @param organizationId - Tenant organization UUID scoping the idempotency key.
 * @param operation - Unique string identifier for the API operation.
 * @param idempotencyKey - Client-provided idempotency header value.
 * @param requestHash - SHA-256 digest of the current request body/parameters.
 * @returns Effect resolving to the cached record or null if newly reserved.
 */
export function reserveIdempotencyEffect(
  client: EffectTransactionClient,
  organizationId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Effect.Effect<IdempotencyRecord | null, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const inserted = yield* client.query(
      `INSERT INTO idempotency_keys
         (org_id, operation, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING idempotency_key`,
      [organizationId, operation, idempotencyKey, requestHash],
    );
    if (inserted.rowCount === 1) return null;

    const existing = yield* client.query<IdempotencyRecord>(
      `SELECT request_hash, response_status, response_body
       FROM idempotency_keys
       WHERE org_id = $1 AND operation = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [organizationId, operation, idempotencyKey],
    );
    const record = existing.rows[0];
    if (!record) {
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "idempotency_in_progress",
          "The idempotent operation is still being recorded.",
        ),
      );
    }
    if (record.request_hash !== requestHash) {
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "idempotency_conflict",
          "The Idempotency-Key was already used with a different request.",
        ),
      );
    }
    if (record.response_status === null) {
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "idempotency_in_progress",
          "The idempotent operation is still in progress.",
        ),
      );
    }
    return record;
  });
}

/**
 * Updates an idempotency record with the final HTTP status code and response payload using an Effect client.
 *
 * @param client - Active EffectTransactionClient.
 * @param organizationId - Tenant organization UUID scoping the idempotency key.
 * @param operation - Unique string identifier for the API operation.
 * @param idempotencyKey - Client-provided idempotency header value.
 * @param status - Completed HTTP response status code.
 * @param body - Serializable response payload body to store and replay.
 * @returns Effect resolving when the idempotency record is updated.
 */
export function completeIdempotencyEffect(
  client: EffectTransactionClient,
  organizationId: string,
  operation: string,
  idempotencyKey: string,
  status: number,
  body: unknown,
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `UPDATE idempotency_keys
       SET response_status = $4, response_body = $5
       WHERE org_id = $1 AND operation = $2 AND idempotency_key = $3`,
      [organizationId, operation, idempotencyKey, status, body ?? null],
    )
    .pipe(Effect.asVoid);
}
