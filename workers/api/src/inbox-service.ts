import { Effect } from "effect";
import type { components } from "@meltiply/contracts/schema";
import type { SessionClaims } from "@meltiply/auth";
import { isAccountUsable, isoDateTime } from "@meltiply/domain";
import type { Context } from "hono";

import { CoreApiError } from "./api-errors";
import { runBackgroundContinuation } from "./background-continuation";
import {
  activeBrandProfilePredicate,
  requireActiveBrandProfileEffect,
} from "./brand-profile-guard";
import type { CoreServiceError, IdempotentResult, InboxFilters } from "./core-types";
import {
  activeOrganizationIdEffect,
  withTenantTransactionEffect as defaultTenantTransaction,
} from "./database";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { withIdempotentMutation } from "./idempotent-mutation";
import { lockOrganizationEffect } from "./organization-lock";

type Schemas = components["schemas"];
type InboxComment = Schemas["InboxComment"];
type InboxResponse = Schemas["InboxResponse"];
type Platform = Schemas["Platform"];
type PlatformCapability = Schemas["PlatformCapability"];
type ReplyStatus = Schemas["ReplyStatus"];

interface InboxRow extends Record<string, unknown> {
  author_avatar: string | null;
  author_name: string | null;
  body: string;
  brand_profile_id: string;
  commented_at: Date | string;
  distribution_id: string;
  post_id: string;
  id: string;
  platform: Platform;
  platform_comment_id: string;
  reply_attempted_at: Date | string | null;
  reply_error: string | null;
  reply_status: string;
  reply_text: string | null;
  synced_at: Date | string;
  updated_at: Date | string;
}

interface ReplyTargetRow extends InboxRow {
  account_connection_status: Schemas["ConnectionStatus"] | null;
  account_revoked_at: Date | string | null;
  account_token_expires_at: Date | string | null;
}

function contractReplyStatus(value: string): ReplyStatus {
  switch (value) {
    case "queued":
      return "queued";
    case "in_progress":
      return "processing";
    case "succeeded":
      return "replied";
    case "failed":
      return "failed";
    case "needs_reconciliation":
      return "needs_reconciliation";
    default:
      return "not_replied";
  }
}

function databaseReplyStatus(value: ReplyStatus | undefined): string | null {
  switch (value) {
    case "not_replied":
      return "none";
    case "queued":
      return "queued";
    case "processing":
      return "in_progress";
    case "replied":
      return "succeeded";
    case "failed":
      return "failed";
    case "needs_reconciliation":
      return "needs_reconciliation";
    default:
      return null;
  }
}

function mapInboxComment(row: InboxRow): InboxComment {
  const attemptedAt = row.reply_attempted_at ?? row.updated_at;
  return {
    author_avatar: row.author_avatar,
    author_name: row.author_name,
    body: row.body,
    brand_profile_id: row.brand_profile_id,
    commented_at: isoDateTime(row.commented_at),
    distribution_id: row.distribution_id,
    failure: row.reply_error
      ? {
          code: "provider_reply_failed",
          last_occurred_at: isoDateTime(attemptedAt),
          message: row.reply_error,
          retryable: true,
        }
      : null,
    id: row.id,
    post_id: row.post_id,
    platform: row.platform,
    platform_comment_id: row.platform_comment_id,
    reply_status: contractReplyStatus(row.reply_status),
    reply_text: row.reply_text,
    synced_at: isoDateTime(row.synced_at),
    updated_at: isoDateTime(row.updated_at),
  };
}

export function scheduleInboxCommentSync(
  c: Context<ApiWorkerEnvironment>,
  organizationId: string,
  distributionId?: string,
): void {
  const automation = c.env.AUTOMATION;
  if (!automation) return;

  runBackgroundContinuation(c, {
    errorCode: "inbox_comment_sync_failed",
    errorRetryClass: "client_retry",
    event: "inbox_comment_sync",
    perform: () => automation.requestCommentsSync(organizationId, distributionId ?? null),
    onSuccess: (enqueued) => ({
      retry_class: "none",
      sync_enqueued: enqueued,
    }),
  });
}

export function createInboxMethods(
  capabilities: ReadonlyMap<Platform, PlatformCapability>,
  withTenantTransactionEffect = defaultTenantTransaction,
) {
  return {
    inbox(
      env: ApiWorkerEnv,
      session: SessionClaims,
      filters: InboxFilters,
    ): Effect.Effect<InboxResponse, CoreServiceError> {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const values: unknown[] = [];
          const conditions: string[] = [activeBrandProfilePredicate("d.brand_profile_id")];
          const parameter = (value: unknown) => {
            values.push(value);
            return `$${values.length}`;
          };
          if (filters.unreplied) {
            conditions.push("c.replied = false");
          }
          if (filters.platform) {
            conditions.push(`d.platform = ${parameter(filters.platform)}`);
          }
          if (filters.distributionId) {
            conditions.push(`c.distribution_id = ${parameter(filters.distributionId)}`);
          }
          if (filters.brandProfileId) {
            conditions.push(`d.brand_profile_id = ${parameter(filters.brandProfileId)}`);
          }
          const replyStatus = databaseReplyStatus(filters.replyStatus);
          if (replyStatus !== null) {
            conditions.push(`c.reply_status = ${parameter(replyStatus)}`);
          }
          const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
          values.push(filters.limit + 1, filters.offset);
          const result = yield* client.query<InboxRow>(
            `SELECT
               c.id, c.distribution_id, d.platform, c.platform_comment_id,
               c.author_name, c.author_avatar, c.body, c.reply_text,
               c.reply_status, c.reply_error, c.reply_attempted_at,
               c.commented_at, c.synced_at, c.updated_at,
               d.brand_profile_id, d.post_id
             FROM comments c
             JOIN distributions d
               ON d.id = c.distribution_id AND d.org_id = c.org_id
             ${where}
             ORDER BY c.commented_at DESC, c.id DESC
             LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values,
          );
          return {
            comments: result.rows.slice(0, filters.limit).map(mapInboxComment),
            has_more: result.rows.length > filters.limit,
            limit: filters.limit,
            offset: filters.offset,
          };
        }),
      );
    },

    replyToComment(
      env: ApiWorkerEnv,
      session: SessionClaims,
      commentId: string,
      brandProfileId: string,
      text: string,
      idempotencyKey: string,
      requestId?: string,
    ): Effect.Effect<IdempotentResult<InboxComment>, CoreServiceError> {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({
            brand_profile_id: brandProfileId,
            comment_id: commentId,
            text,
          }),
        );
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            return yield* withIdempotentMutation<InboxComment, CoreServiceError>(
              client,
              organizationId,
              "reply-to-comment",
              idempotencyKey,
              requestHash,
              202,
              (tx) =>
                Effect.gen(function* () {
                  yield* lockOrganizationEffect(tx, organizationId);
                  yield* requireActiveBrandProfileEffect(tx, organizationId, brandProfileId);

                  const target = yield* tx.query<ReplyTargetRow>(
                    `SELECT
                       c.id, c.distribution_id, d.platform, c.platform_comment_id,
                       c.author_name, c.author_avatar, c.body, c.reply_text,
                       c.reply_status, c.reply_error, c.reply_attempted_at,
                       c.commented_at, c.synced_at, c.updated_at,
                       d.brand_profile_id, d.post_id,
                       pa.connection_status AS account_connection_status,
                       pa.revoked_at AS account_revoked_at,
                       pa.token_expires_at AS account_token_expires_at
                     FROM comments c
                     JOIN distributions d
                       ON d.id = c.distribution_id AND d.org_id = c.org_id
                     LEFT JOIN platform_accounts pa
                       ON pa.id = d.platform_account_id AND pa.org_id = d.org_id
                     WHERE c.id = $1 AND d.brand_profile_id = $2
                     FOR UPDATE OF c`,
                    [commentId, brandProfileId],
                  );
                  const row = target.rows[0];
                  if (!row) {
                    return yield* Effect.fail(
                      new CoreApiError(404, "not_found", "The comment was not found."),
                    );
                  }
                  const capability = capabilities.get(row.platform)!;
                  if (!capability.reply) {
                    return yield* Effect.fail(
                      new CoreApiError(
                        422,
                        "unsupported_capability",
                        `${row.platform} comment replies are not available.`,
                      ),
                    );
                  }
                  if (
                    !isAccountUsable({
                      connection_status: row.account_connection_status,
                      revoked_at: row.account_revoked_at,
                      token_expires_at: row.account_token_expires_at,
                    })
                  ) {
                    return yield* Effect.fail(
                      new CoreApiError(
                        409,
                        "platform_reconnect_required",
                        "Reconnect the platform account before replying.",
                      ),
                    );
                  }
                  if (contractReplyStatus(row.reply_status) === "replied") {
                    return yield* Effect.fail(
                      new CoreApiError(
                        409,
                        "already_replied",
                        "The comment already has a confirmed reply.",
                      ),
                    );
                  }
                  if (row.reply_status === "queued" || row.reply_status === "in_progress") {
                    return yield* Effect.fail(
                      new CoreApiError(
                        409,
                        "reply_in_progress",
                        "A reply is already queued for this comment.",
                      ),
                    );
                  }

                  const updated = yield* tx.query<InboxRow>(
                    `UPDATE comments
                     SET reply_text = $2,
                         reply_status = 'queued',
                         reply_error = NULL,
                         reply_attempted_at = now(),
                         updated_at = now()
                     WHERE id = $1
                     RETURNING
                       id, distribution_id, $3::text AS platform,
                       $4::uuid AS brand_profile_id, $5::uuid AS post_id,
                       platform_comment_id,
                       author_name, author_avatar, body, reply_text, reply_status,
                       reply_error, reply_attempted_at, commented_at, synced_at,
                       updated_at`,
                    [commentId, text, row.platform, brandProfileId, row.post_id],
                  );
                  const comment = mapInboxComment(updated.rows[0]!);
                  yield* tx.query(
                    `INSERT INTO outbox_events
                       (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
                     VALUES ($1, 'comment.reply.requested', 'comment', $2, $3, $4)`,
                    [
                      organizationId,
                      commentId,
                      idempotencyKey,
                      {
                        comment_id: commentId,
                        distribution_id: row.distribution_id,
                        platform: row.platform,
                        ...(requestId ? { request_id: requestId } : {}),
                        text,
                        version: 1,
                      },
                    ],
                  );
                  return comment;
                }),
            );
          }),
        );
      });
    },
  };
}
