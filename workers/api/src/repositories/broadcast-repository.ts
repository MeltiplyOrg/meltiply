import type { SessionClaims } from "@meltiply/auth";
import type { DatabaseError, Platform } from "@meltiply/domain";
import { Effect } from "effect";

import { activeBrandProfilePredicate } from "../brand-profile-guard";
import { CoreApiError } from "../core-types";
import { withTenantTransactionEffect } from "../database";
import type { ApiWorkerEnv } from "../env";
import {
  completeIdempotencyEffect,
  reserveIdempotencyEffect,
  type IdempotencyRecord,
} from "../idempotency";

export interface BroadcastRow extends Record<string, unknown> {
  access_token: string;
  connection_status: string;
  org_id: string;
  platform: Platform;
  platform_user_id: string;
  provider_operation_id: string;
  revoked_at: Date | string | null;
  role: string;
  token_expires_at: Date | string | null;
}

export interface BroadcastPublishedUpdate {
  readonly distributionId: string;
  readonly providerPostId: string;
  readonly providerUrl: string | null;
}

export interface BroadcastEndCompletion {
  readonly distributionId: string;
  readonly operation: string;
  readonly orgId: string;
  readonly providerOperationId: string;
  readonly providerPostId: string | null;
  readonly providerUrl: string | null;
}

export interface BroadcastRepository {
  readonly loadAndReserve: (
    distributionId: string,
    endReservation: { readonly operation: string; readonly requestHash: string } | null,
  ) => Effect.Effect<
    { readonly replay: IdempotencyRecord | null; readonly row: BroadcastRow | null },
    CoreApiError | DatabaseError
  >;
  readonly markPublishedFromRead: (
    update: BroadcastPublishedUpdate,
  ) => Effect.Effect<void, DatabaseError>;
  readonly completeEnd: (completion: BroadcastEndCompletion) => Effect.Effect<void, DatabaseError>;
}

export function createPostgresBroadcastRepository(
  env: ApiWorkerEnv,
  session: SessionClaims,
): BroadcastRepository {
  return {
    loadAndReserve: (distributionId, endReservation) =>
      withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<BroadcastRow>(
            `SELECT distribution.org_id, distribution.platform, distribution.provider_operation_id,
                  account.platform_user_id, account.access_token, account.token_expires_at,
                  account.connection_status, account.revoked_at, public.auth_active_org_role() AS role
             FROM distributions AS distribution
             JOIN platform_accounts AS account ON account.id = distribution.platform_account_id
            WHERE distribution.id = $1
              AND ${activeBrandProfilePredicate("distribution.brand_profile_id")}`,
            [distributionId],
          );
          const row = result.rows[0] ?? null;
          if (!row) return { replay: null, row: null };
          if (!["admin", "editor"].includes(row.role)) {
            return { replay: null, row };
          }
          if (!endReservation) return { replay: null, row };
          const replay = yield* reserveIdempotencyEffect(
            client,
            row.org_id,
            endReservation.operation,
            distributionId,
            endReservation.requestHash,
          );
          return { replay, row };
        }),
      ),

    markPublishedFromRead: (update) =>
      withTenantTransactionEffect(env, session, (client) =>
        Effect.asVoid(
          client.query(
            `UPDATE distributions SET status = 'published', platform_post_id = $2, platform_url = $3,
                  published_at = COALESCE(published_at, now()), next_attempt_at = NULL, updated_at = now()
            WHERE id = $1 AND status IN ('delivered', 'published')`,
            [update.distributionId, update.providerPostId, update.providerUrl],
          ),
        ),
      ),

    completeEnd: (completion) =>
      withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const status = completion.providerPostId ? "published" : "delivered";
          yield* client.query(
            `UPDATE distributions SET status = $4, platform_post_id = $2, platform_url = $3,
                  published_at = CASE WHEN $4 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END,
                  provider_operation_id = $5, next_attempt_at = NULL, updated_at = now()
            WHERE id = $1`,
            [
              completion.distributionId,
              completion.providerPostId,
              completion.providerUrl,
              status,
              completion.providerOperationId,
            ],
          );
          yield* completeIdempotencyEffect(
            client,
            completion.orgId,
            completion.operation,
            completion.distributionId,
            200,
            { ended: true },
          );
        }),
      ),
  };
}

export class FakeBroadcastStore {
  readonly rows = new Map<string, BroadcastRow>();
  readonly idempotency = new Map<string, IdempotencyRecord>();
  readonly readUpdates: BroadcastPublishedUpdate[] = [];
  readonly endCompletions: BroadcastEndCompletion[] = [];
}

export function createFakeBroadcastRepository(store: FakeBroadcastStore): BroadcastRepository {
  return {
    loadAndReserve: (distributionId, endReservation) =>
      Effect.gen(function* () {
        const row = store.rows.get(distributionId) ?? null;
        if (!row) return { replay: null, row: null };
        if (!["admin", "editor"].includes(row.role) || !endReservation) {
          return { replay: null, row: structuredClone(row) };
        }
        const key = `${row.org_id}:${endReservation.operation}:${distributionId}`;
        const existing = store.idempotency.get(key);
        if (existing) {
          if (existing.request_hash !== endReservation.requestHash) {
            return yield* Effect.fail(
              new CoreApiError(
                409,
                "idempotency_conflict",
                "The Idempotency-Key was already used with a different request.",
              ),
            );
          }
          if (existing.response_status === null) {
            return yield* Effect.fail(
              new CoreApiError(
                409,
                "idempotency_in_progress",
                "A request with this Idempotency-Key is already in progress.",
              ),
            );
          }
          return { replay: structuredClone(existing), row: structuredClone(row) };
        }
        store.idempotency.set(key, {
          request_hash: endReservation.requestHash,
          response_body: null,
          response_status: null,
        });
        return { replay: null, row: structuredClone(row) };
      }),

    markPublishedFromRead: (update) =>
      Effect.sync(() => {
        store.readUpdates.push(update);
      }),

    completeEnd: (completion) =>
      Effect.sync(() => {
        store.endCompletions.push(completion);
        const key = `${completion.orgId}:${completion.operation}:${completion.distributionId}`;
        const existing = store.idempotency.get(key);
        store.idempotency.set(key, {
          request_hash: existing?.request_hash ?? "",
          response_body: { ended: true },
          response_status: 200,
        });
      }),
  };
}
