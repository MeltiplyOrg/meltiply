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

export function hashIdempotencyRequestEffect(value: string): Effect.Effect<string> {
  return Effect.promise(() => sha256Hex(value));
}

export function reserveIdempotencyEffect(
  client: EffectTransactionClient,
  organizationId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Effect.Effect<IdempotencyRecord | null, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const maximumReserveAttempts = 3;
    for (let attempt = 0; attempt < maximumReserveAttempts; attempt += 1) {
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
      if (record) {
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
      }
    }
    return yield* Effect.fail(
      new CoreApiError(
        409,
        "idempotency_in_progress",
        "The idempotent operation is still being recorded.",
      ),
    );
  });
}

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
