import type { SessionClaims } from "@meltiply/auth";
import { Effect } from "effect";
import { ProviderService, type ProviderBroadcastInfo } from "@meltiply/providers";
import type { DatabaseError, Platform } from "@meltiply/domain";
import { CoreApiError } from "./core-types";
import { activeBrandProfilePredicate } from "./brand-profile-guard";
import { withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import { tokenCipherFor } from "./token-credentials";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  reserveIdempotencyEffect,
} from "./idempotency";

interface BroadcastRow extends Record<string, unknown> {
  org_id: string;
  platform: Platform;
  platform_user_id: string;
  provider_operation_id: string;
  access_token: string;
  token_expires_at: Date | string | null;
  connection_status: string;
  revoked_at: Date | string | null;
  role: string;
}

/**
 * Reads encoder credentials or ends one existing broadcast for a content writer.
 * RLS scopes the Distribution and Channel; a database-derived role check also
 * protects the secret GET from Viewers. Secrets are decrypted only after access
 * checks, never persisted or returned by general Post/Distribution reads.
 * Ending reserves a durable per-Distribution key before the remote write, so
 * concurrent clients cannot bypass it by choosing different HTTP keys. Unknown
 * outcomes stay fenced until inspected; completed requests replay after ending.
 */
export function broadcastControlEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  distributionId: string,
  requestId: string,
  action: { kind: "read" } | { kind: "end"; key: string },
): Effect.Effect<
  ProviderBroadcastInfo | { ended: true },
  CoreApiError | DatabaseError,
  ProviderService
> {
  return Effect.gen(function* () {
    const requestHash =
      action.kind === "end" ? yield* hashIdempotencyRequestEffect(distributionId) : "";
    const operation = "broadcast.end";
    const selected = yield* withTenantTransactionEffect(env, session, (client) =>
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
        const row = result.rows[0];
        if (!row)
          return yield* Effect.fail(
            new CoreApiError(404, "not_found", "The broadcast was not found."),
          );
        if (!["admin", "editor"].includes(row.role))
          return yield* Effect.fail(
            new CoreApiError(
              403,
              "forbidden_role",
              "Your Workspace role cannot access encoder credentials.",
            ),
          );
        if (action.kind === "end") {
          const replay = yield* reserveIdempotencyEffect(
            client,
            row.org_id,
            operation,
            distributionId,
            requestHash,
          );
          if (replay) return { row, replayed: true };
        }
        if (!row.provider_operation_id?.startsWith("live:"))
          return yield* Effect.fail(
            new CoreApiError(422, "invalid_state", "This Distribution is not a live broadcast."),
          );
        if (
          row.revoked_at ||
          !["connected", "expiring"].includes(row.connection_status) ||
          (row.token_expires_at && new Date(row.token_expires_at) <= new Date())
        ) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "Reconnect this Channel before controlling the broadcast.",
            ),
          );
        }
        return { row, replayed: false };
      }),
    );
    if (selected.replayed) return { ended: true as const };
    const row = selected.row;
    const accessToken = yield* Effect.tryPromise({
      catch: () =>
        new CoreApiError(
          503,
          "dependency_unavailable",
          "Platform credentials are temporarily unavailable.",
        ),
      try: () => tokenCipherFor(env).decrypt(row.access_token),
    });
    const provider = yield* ProviderService;
    const credentials = { accessToken, accountId: row.platform_user_id };
    const context = { requestId, operationId: `broadcast:${distributionId}` };
    const lookup = { providerOperationId: row.provider_operation_id };
    if (action.kind === "read") {
      const info = yield* provider
        .getBroadcastInfo(row.platform, context, credentials, lookup)
        .pipe(
          Effect.mapError(
            () =>
              new CoreApiError(
                502,
                "provider_unavailable",
                "The broadcast details could not be retrieved.",
              ),
          ),
        );
      if (info.providerPostId) {
        yield* withTenantTransactionEffect(env, session, (client) =>
          client.query(
            `UPDATE distributions SET status = 'published', platform_post_id = $2, platform_url = $3,
                  published_at = COALESCE(published_at, now()), next_attempt_at = NULL, updated_at = now()
            WHERE id = $1 AND status IN ('delivered', 'published')`,
            [distributionId, info.providerPostId, info.providerUrl ?? null],
          ),
        );
      }
      return info;
    }
    const ended = yield* provider
      .endBroadcast(row.platform, context, credentials, lookup)
      .pipe(
        Effect.mapError(
          () =>
            new CoreApiError(
              502,
              "provider_unavailable",
              "The end request could not be confirmed. Refresh the broadcast state before trying again.",
            ),
        ),
      );
    if (ended.outcome !== "confirmed_success")
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "needs_reconciliation",
          "The end request is uncertain. Refresh the broadcast state.",
        ),
      );
    yield* withTenantTransactionEffect(env, session, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `UPDATE distributions SET status = $4, platform_post_id = $2, platform_url = $3,
                published_at = CASE WHEN $4 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END,
                provider_operation_id = $5, next_attempt_at = NULL, updated_at = now()
          WHERE id = $1`,
          [
            distributionId,
            ended.providerPostId ?? null,
            ended.providerUrl ?? null,
            ended.providerPostId ? "published" : "delivered",
            ended.providerOperationId ?? row.provider_operation_id,
          ],
        );
        yield* completeIdempotencyEffect(client, row.org_id, operation, distributionId, 200, {
          ended: true,
        });
      }),
    );
    return { ended: true as const };
  });
}
