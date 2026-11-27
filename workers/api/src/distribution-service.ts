import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { toWireProviderOptions, type ProviderPublishOptions } from "@meltiply/providers";
import {
  type DatabaseError,
  isoDateTime,
  isoDateTimeOrNull,
  isoPeriodKey,
  COMMUNITY_LIMITS,
  maximumDelayedDeliverySeconds,
} from "@meltiply/domain";

import { CoreApiError, toCoreApiErrorOrRethrow } from "./api-errors";
import {
  activeBrandProfilePredicate,
  requireActiveBrandProfileEffect,
} from "./brand-profile-guard";
import type {
  CoreServiceError,
  DistributionFilters,
  DistributionPatch,
  IdempotentResult,
} from "./core-types";
import {
  activeOrganizationIdEffect,
  withTenantTransactionEffect,
  type EffectTransactionClient,
} from "./database";
import type { ApiWorkerEnv } from "./env";
import { hashIdempotencyRequestEffect } from "./idempotency";
import { withIdempotentMutationStatus, withTenantIdempotentMutation } from "./idempotent-mutation";
import { lockOrganizationEffect } from "./organization-lock";
import { requireNoQueueMembershipEffect } from "./publishing-queue-store";

type Schemas = components["schemas"];
type Distribution = Schemas["Distribution"];
type Platform = Schemas["Platform"];
type DistributionStatus = Schemas["DistributionStatus"];

const distributionPhase = {
  scheduled: "pending",
  queued: "pending",
  processing: "inFlight",
  awaiting_provider: "inFlight",
  needs_reconciliation: "inFlight",
  cancel_requested: "inFlight",
  delivered: "settled",
  published: "settled",
  failed: "settled",
  cancelled: "settled",
} as const satisfies Record<DistributionStatus, "pending" | "inFlight" | "settled">;

function statusesInPhase(phase: "pending" | "inFlight" | "settled"): DistributionStatus[] {
  return (Object.keys(distributionPhase) as DistributionStatus[]).filter(
    (status) => distributionPhase[status] === phase,
  );
}

export const settledDistributionStatuses = statusesInPhase("settled");
export const providerReachedDistributionStatuses: DistributionStatus[] = [
  ...statusesInPhase("inFlight"),
  "delivered",
  "published",
];

export function isPendingDistribution(status: DistributionStatus): boolean {
  return distributionPhase[status] === "pending";
}

export function providerOwnedDistributionSql(alias: string, includeLeasedOutbox = false): string {
  const leasedCheck = includeLeasedOutbox
    ? ` OR EXISTS (
        SELECT 1 FROM outbox_events e
         WHERE e.aggregate_id = ${alias}.id
           AND e.topic = 'distribution.publish.requested'
           AND e.state = 'leased'
      )`
    : "";
  return `(${alias}.attempt_count > 0
    OR ${alias}.last_attempt_at IS NOT NULL
    OR ${alias}.provider_operation_id IS NOT NULL
    OR ${alias}.published_at IS NOT NULL
    OR ${alias}.platform_post_id IS NOT NULL
    OR ${alias}.cancel_requested_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM provider_operations AS operation
       WHERE operation.distribution_id = ${alias}.id
    )${leasedCheck})`;
}

export function deletePendingDistributionOutboxEffect(
  client: EffectTransactionClient,
  distributionIds: readonly string[],
): Effect.Effect<void, DatabaseError> {
  if (distributionIds.length === 0) return Effect.void;
  return client
    .query(
      `DELETE FROM outbox_events
        WHERE aggregate_id = ANY($1::uuid[])
          AND topic = 'distribution.publish.requested'
          AND state IN ('pending', 'failed')`,
      [distributionIds],
    )
    .pipe(Effect.asVoid);
}

interface DistributionRow extends Record<string, unknown> {
  attempt_count: number | string;
  batch_id: string | null;
  brand_profile_id: string;
  created_at: Date | string;
  description_override: string | null;
  error_message: string | null;
  failure_code: string | null;
  failure_retryable: boolean | null;
  hashtags: string[] | null;
  id: string;
  last_attempt_at: Date | string | null;
  next_attempt_at: Date | string | null;
  org_id: string;
  platform: Platform;
  platform_account_id: string | null;
  platform_post_id: string | null;
  platform_url: string | null;
  post_id: string;
  provider_operation_id: string | null;
  provider_warnings?: Schemas["Distribution"]["provider_warnings"];
  publication_snapshot: StoredPublicationSnapshot | null;
  published_at: Date | string | null;
  scheduled_at: Date | string | null;
  status: DistributionStatus;
  title_override: string | null;
  updated_at: Date | string;
}

interface StoredPublicationMedia {
  asset_id: string;
  asset_type: "image" | "video";
  content_type: string | null;
  duration_sec: number | null;
  file_size: number | null;
  height: number | null;
  position: number;
  width: number | null;
}

interface StoredPublicationSnapshot {
  content: {
    hashtags: string[];
    provider_options?: ProviderPublishOptions;
    signature?: string | null;
    text: string;
    title: string;
  };
  media: StoredPublicationMedia[];
  post_id: string;
  version: 1;
}

export const distributionColumns = `
  id, org_id, brand_profile_id, post_id, platform_account_id, platform, status,
  scheduled_at, published_at, platform_post_id, platform_url, provider_operation_id,
  provider_warnings,
  title_override, description_override, hashtags, error_message,
  attempt_count, last_attempt_at, next_attempt_at, failure_code,
  failure_retryable, batch_id, created_at, updated_at`;

export const publicationSnapshotColumn = `(
    SELECT operation.publication_snapshot
    FROM provider_operations AS operation
    WHERE operation.distribution_id = distributions.id
      AND operation.operation = 'publish'
      AND operation.publication_snapshot IS NOT NULL
    ORDER BY operation.created_at DESC, operation.id DESC
    LIMIT 1
  ) AS publication_snapshot`;

function frozenPublicationEffect(
  client: EffectTransactionClient,
  distributionId: string,
): Effect.Effect<StoredPublicationSnapshot | null, DatabaseError> {
  return client
    .query<{ publication_snapshot: StoredPublicationSnapshot | null }>(
      `SELECT ${publicationSnapshotColumn}
       FROM distributions
       WHERE distributions.id = $1`,
      [distributionId],
    )
    .pipe(Effect.map((result) => result.rows[0]?.publication_snapshot ?? null));
}

function mapPublicationSnapshot(
  snapshot: StoredPublicationSnapshot,
): Schemas["DistributionPublication"] {
  return {
    title: snapshot.content.title,
    text: snapshot.content.text,
    signature: snapshot.content.signature ?? null,
    hashtags: snapshot.content.hashtags,
    provider_options: toWireProviderOptions(snapshot.content.provider_options ?? null),
    media: [...snapshot.media]
      .sort((a, b) => a.position - b.position)
      .map((item) => ({
        asset_id: item.asset_id,
        asset_type: item.asset_type,
        content_type: item.content_type,
        duration_sec: item.duration_sec,
        file_size: item.file_size,
        height: item.height,
        position: item.position,
        width: item.width,
      })),
  };
}

export function mapDistribution(row: DistributionRow): Distribution {
  return {
    attempt_count: Number(row.attempt_count),
    brand_profile_id: row.brand_profile_id,
    created_at: isoDateTime(row.created_at),
    description_override: row.description_override,
    failure: row.error_message
      ? {
          code: row.failure_code ?? "distribution_failed",
          last_occurred_at: isoDateTime(row.last_attempt_at ?? row.updated_at),
          message: row.error_message,
          retryable: row.failure_retryable ?? false,
        }
      : null,
    hashtags: row.hashtags ?? [],
    id: row.id,
    last_attempt_at: isoDateTimeOrNull(row.last_attempt_at),
    next_attempt_at: isoDateTimeOrNull(row.next_attempt_at),
    org_id: row.org_id,
    platform: row.platform,
    platform_account_id: row.platform_account_id,
    platform_post_id: row.platform_post_id,
    platform_url: row.platform_url,
    post_id: row.post_id,
    ...((row.status === "delivered" || row.provider_operation_id?.startsWith("live:")) &&
    row.provider_operation_id
      ? { provider_reference: row.provider_operation_id }
      : {}),
    ...(row.provider_warnings?.length ? { provider_warnings: row.provider_warnings } : {}),
    publication: row.publication_snapshot ? mapPublicationSnapshot(row.publication_snapshot) : null,
    published_at: isoDateTimeOrNull(row.published_at),
    scheduled_at: isoDateTimeOrNull(row.scheduled_at),
    status: row.status,
    title_override: row.title_override,
    updated_at: isoDateTime(row.updated_at),
  };
}

export function validateTargetOverrides(overrides: {
  descriptionOverride?: string | null;
  hashtags?: string[];
  signature?: string | null;
  titleOverride?: string | null;
}): void {
  if (overrides.titleOverride && overrides.titleOverride.length > 200) {
    throw new CoreApiError(422, "validation_error", "title_override is too long.");
  }
  if (overrides.descriptionOverride && overrides.descriptionOverride.length > 5_000) {
    throw new CoreApiError(422, "validation_error", "description_override is too long.");
  }
  if (overrides.signature && overrides.signature.length > 1_000) {
    throw new CoreApiError(422, "validation_error", "signature is too long.");
  }
  const hashtags = overrides.hashtags ?? [];
  if (hashtags.length > 30 || new Set(hashtags).size !== hashtags.length) {
    throw new CoreApiError(
      422,
      "validation_error",
      "hashtags must contain at most 30 unique values.",
    );
  }
}

function requireActiveDistributionProfileEffect(
  client: EffectTransactionClient,
  organizationId: string,
  distributionId: string,
): Effect.Effect<{ postActive: boolean; postId: string }, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const current = yield* client.query<{
      brand_profile_id: string;
      post_active: boolean;
      post_id: string;
    }>(
      `SELECT brand_profile_id, post_id,
              EXISTS (
                SELECT 1 FROM posts
                 WHERE posts.id = distributions.post_id AND posts.deleted_at IS NULL
              ) AS post_active
       FROM distributions
       WHERE id = $1 AND org_id = $2`,
      [distributionId, organizationId],
    );
    const existing = current.rows[0];
    if (!existing) {
      return yield* Effect.fail(
        new CoreApiError(404, "not_found", "The distribution was not found."),
      );
    }
    yield* requireActiveBrandProfileEffect(client, organizationId, existing.brand_profile_id);
    return { postActive: existing.post_active, postId: existing.post_id };
  });
}

export function usageGuardEffect(
  client: EffectTransactionClient,
  organizationId: string,
  increment: number,
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const limits = COMMUNITY_LIMITS;
    const period = isoPeriodKey(new Date());
    const usage = yield* client.query<{ distributions: number | string }>(
      `WITH candidate AS (
         SELECT $1::uuid AS org_id, $2::text AS period, $3::integer AS increment
         WHERE $4::integer IS NULL OR $3::integer <= $4::integer
       )
       INSERT INTO usage_records (org_id, period, distributions)
       SELECT org_id, period, increment FROM candidate
       ON CONFLICT (org_id, period) DO UPDATE
         SET distributions = usage_records.distributions + EXCLUDED.distributions,
             updated_at = now()
         WHERE $4::integer IS NULL
            OR usage_records.distributions + EXCLUDED.distributions <= $4::integer
       RETURNING distributions`,
      [organizationId, period, increment, limits.max_distributions],
    );
    if (usage.rowCount !== 1) {
      return yield* Effect.fail(
        new CoreApiError(403, "quota_exceeded", "The monthly distribution quota has been reached."),
      );
    }
  });
}

interface OutboxCommand {
  now?: Date;
  requestId?: string;
  retryToken?: string;
  scheduledAt?: Date | null;
  topic?: string;
}

function outboxCommandRow(
  organizationId: string,
  id: string,
  command: OutboxCommand,
): readonly unknown[] | undefined {
  const topic = command.topic ?? "distribution.publish.requested";
  let dedupeKey = `distribution:${id}:${topic}`;
  if (command.retryToken) dedupeKey = `${dedupeKey}:retry:${command.retryToken}`;
  if (command.scheduledAt) {
    const now = command.now ?? new Date();
    const delaySeconds = Math.ceil((command.scheduledAt.getTime() - now.getTime()) / 1000);
    if (delaySeconds > maximumDelayedDeliverySeconds) return undefined;
    dedupeKey = `${dedupeKey}:at:${command.scheduledAt.getTime()}`;
  }
  return [
    organizationId,
    topic,
    id,
    dedupeKey,
    JSON.stringify({
      distribution_id: id,
      ...(command.requestId ? { request_id: command.requestId } : {}),
      version: 1,
    }),
  ];
}

export function insertOutboxBatchEffect(
  client: EffectTransactionClient,
  organizationId: string,
  ids: readonly string[],
  command: OutboxCommand = {},
): Effect.Effect<void, DatabaseError> {
  const rows = ids
    .map((id) => outboxCommandRow(organizationId, id, command))
    .filter((row): row is readonly unknown[] => row !== undefined);
  if (rows.length === 0) return Effect.void;
  return client
    .query(
      `INSERT INTO outbox_events
         (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
       SELECT command.org_id, command.topic, 'distribution',
              command.aggregate_id, command.dedupe_key, command.payload
         FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::jsonb[])
           AS command(org_id, topic, aggregate_id, dedupe_key, payload)
       ON CONFLICT DO NOTHING`,
      [
        rows.map((row) => row[0]),
        rows.map((row) => row[1]),
        rows.map((row) => row[2]),
        rows.map((row) => row[3]),
        rows.map((row) => row[4]),
      ],
    )
    .pipe(Effect.asVoid);
}

interface CalendarRow extends Record<string, unknown> {
  brand_profile_id: string;
  id: string;
  platform: Platform;
  platform_account_id: string | null;
  post_id: string;
  post_title: string;
  published_at: Date | string | null;
  scheduled_at: Date | string | null;
  status: Schemas["DistributionStatus"];
  updated_at: Date | string;
}

export function createDistributionMethods(
  withTenantTransactionEffectOverride = withTenantTransactionEffect,
) {
  return {
    calendar(
      env: ApiWorkerEnv,
      session: SessionClaims,
      start: Date,
      end: Date,
      limit = 500,
      brandProfileId?: string,
    ): Effect.Effect<Schemas["CalendarEvent"][], CoreServiceError> {
      return withTenantTransactionEffectOverride(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<CalendarRow>(
            `SELECT
               d.id, d.post_id, p.title AS post_title, d.platform,
               d.platform_account_id, d.status, d.scheduled_at, d.published_at,
               d.updated_at, d.brand_profile_id
             FROM distributions d
             JOIN posts p ON p.id = d.post_id AND p.org_id = d.org_id
             WHERE d.event_at >= $1 AND d.event_at <= $2
               AND p.deleted_at IS NULL
               AND ($4::uuid IS NULL OR d.brand_profile_id = $4)
               AND ${activeBrandProfilePredicate("d.brand_profile_id")}
             ORDER BY d.event_at ASC, d.id ASC
             LIMIT $3`,
            [start, end, limit, brandProfileId ?? null],
          );
          return result.rows.map((row) => ({
            post_id: row.post_id,
            post_title: row.post_title,
            brand_profile_id: row.brand_profile_id,
            id: row.id,
            platform: row.platform,
            platform_account_id: row.platform_account_id,
            published_at: isoDateTimeOrNull(row.published_at),
            scheduled_at: isoDateTimeOrNull(row.scheduled_at),
            status: row.status,
            updated_at: isoDateTime(row.updated_at),
          }));
        }),
      );
    },
    listDistributions(
      env: ApiWorkerEnv,
      session: SessionClaims,
      filters: DistributionFilters,
    ): Effect.Effect<
      {
        distributions: Distribution[];
        has_more: boolean;
        limit: number;
        offset: number;
      },
      CoreServiceError
    > {
      return withTenantTransactionEffectOverride(env, session, (client) =>
        Effect.gen(function* () {
          const values: unknown[] = [];
          const conditions: string[] = [
            activeBrandProfilePredicate("distributions.brand_profile_id"),
          ];
          const parameter = (value: unknown) => {
            values.push(value);
            return `$${values.length}`;
          };
          if (filters.brandProfileId) {
            conditions.push(`brand_profile_id = ${parameter(filters.brandProfileId)}`);
          }
          if (filters.status) {
            conditions.push(`status = ${parameter(filters.status)}`);
          }
          if (filters.platform) {
            conditions.push(`platform = ${parameter(filters.platform)}`);
          }
          if (filters.postId) {
            conditions.push(`post_id = ${parameter(filters.postId)}`);
          }
          if (filters.start) {
            conditions.push(`event_at >= ${parameter(filters.start)}`);
          }
          if (filters.end) {
            conditions.push(`event_at <= ${parameter(filters.end)}`);
          }
          const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
          values.push(filters.limit + 1, filters.offset);
          const result = yield* client.query<DistributionRow>(
            `SELECT ${distributionColumns},
                    ${publicationSnapshotColumn}
               FROM distributions
               ${where}
             ORDER BY event_at DESC, id DESC
             LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values,
          );
          return {
            distributions: result.rows.slice(0, filters.limit).map(mapDistribution),
            has_more: result.rows.length > filters.limit,
            limit: filters.limit,
            offset: filters.offset,
          };
        }),
      );
    },

    getDistribution(
      env: ApiWorkerEnv,
      session: SessionClaims,
      id: string,
    ): Effect.Effect<Distribution, CoreServiceError> {
      return withTenantTransactionEffectOverride(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<DistributionRow>(
            `SELECT ${distributionColumns},
                    ${publicationSnapshotColumn}
               FROM distributions
             WHERE id = $1 AND ${activeBrandProfilePredicate("distributions.brand_profile_id")}`,
            [id],
          );
          if (!result.rows[0]) {
            return yield* Effect.fail(
              new CoreApiError(404, "not_found", "The distribution was not found."),
            );
          }
          return mapDistribution(result.rows[0]);
        }),
      );
    },

    updateDistribution(
      env: ApiWorkerEnv,
      session: SessionClaims,
      id: string,
      patch: DistributionPatch,
      idempotencyKey: string,
    ): Effect.Effect<IdempotentResult<Distribution>, CoreServiceError> {
      return withTenantIdempotentMutation<Distribution, CoreServiceError>(
        env,
        session,
        "update-distribution",
        idempotencyKey,
        JSON.stringify({ id, patch }),
        200,
        (client, organizationId) =>
          Effect.gen(function* () {
            const now = new Date();
            yield* Effect.try({
              try: () => validateTargetOverrides(patch),
              catch: toCoreApiErrorOrRethrow,
            });
            const owner = yield* requireActiveDistributionProfileEffect(client, organizationId, id);
            if (patch.scheduledAt !== undefined) {
              yield* lockOrganizationEffect(client, organizationId);
              yield* requireNoQueueMembershipEffect(client, owner.postId);
            }
            const result = yield* client.query<DistributionRow>(
              `UPDATE distributions SET
                 scheduled_at = COALESCE($3, scheduled_at),
                 title_override = CASE WHEN $4::boolean THEN $5 ELSE title_override END,
                 description_override = CASE WHEN $6::boolean THEN $7 ELSE description_override END,
                 hashtags = CASE WHEN $8::boolean THEN $9 ELSE hashtags END,
                 updated_at = now()
               WHERE id = $1 AND org_id = $2 AND status = 'scheduled'
               RETURNING ${distributionColumns}`,
              [
                id,
                organizationId,
                patch.scheduledAt ?? null,
                patch.titleOverride !== undefined,
                patch.titleOverride ?? null,
                patch.descriptionOverride !== undefined,
                patch.descriptionOverride ?? null,
                patch.hashtags !== undefined,
                patch.hashtags ?? [],
              ],
            );
            if (!result.rows[0]) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "distribution_not_scheduled",
                  "Only scheduled distributions can be updated.",
                ),
              );
            }
            const updated = result.rows[0];
            const value = mapDistribution({
              ...updated,
              publication_snapshot: yield* frozenPublicationEffect(client, updated.id),
            });
            if (patch.scheduledAt) {
              yield* insertOutboxBatchEffect(client, organizationId, [value.id], {
                now,
                scheduledAt: patch.scheduledAt,
              });
            }
            return value;
          }),
        withTenantTransactionEffectOverride,
      );
    },

    cancelDistribution(
      env: ApiWorkerEnv,
      session: SessionClaims,
      id: string,
      idempotencyKey: string,
      requestId?: string,
    ): Effect.Effect<IdempotentResult<Distribution> & { status: 202 | 204 }, CoreServiceError> {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(id);
        const outcome = yield* withTenantTransactionEffectOverride(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            return yield* withIdempotentMutationStatus(
              client,
              organizationId,
              "cancel-distribution",
              idempotencyKey,
              requestHash,
              (tx) =>
                Effect.gen(function* () {
                  const current = yield* tx.query<
                    Pick<DistributionRow, "status" | "publication_snapshot">
                  >(
                    `SELECT status,
                            ${publicationSnapshotColumn}
                     FROM distributions WHERE id = $1 FOR UPDATE`,
                    [id],
                  );
                  const row = current.rows[0];
                  if (!row) {
                    return yield* Effect.fail(
                      new CoreApiError(404, "not_found", "The distribution was not found."),
                    );
                  }
                  if (distributionPhase[row.status] === "settled") {
                    return yield* Effect.fail(
                      new CoreApiError(
                        409,
                        "invalid_state",
                        "The distribution cannot be cancelled in its current state.",
                      ),
                    );
                  }
                  const inFlight = distributionPhase[row.status] === "inFlight";
                  const result = yield* tx.query<DistributionRow>(
                    `UPDATE distributions SET status = $2, cancel_requested_at = CASE WHEN $2 = 'cancel_requested' THEN now() ELSE cancel_requested_at END, updated_at = now() WHERE id = $1 RETURNING ${distributionColumns}`,
                    [id, inFlight ? "cancel_requested" : "cancelled"],
                  );
                  const updated = result.rows[0]!;
                  const value = mapDistribution({
                    ...updated,
                    publication_snapshot: row.publication_snapshot,
                  });
                  if (inFlight) {
                    yield* insertOutboxBatchEffect(tx, organizationId, [id], {
                      requestId,
                      topic: "distribution.cancel.requested",
                    });
                  } else {
                    yield* deletePendingDistributionOutboxEffect(tx, [id]);
                  }
                  const status: 202 | 204 = inFlight ? 202 : 204;
                  return { body: inFlight ? value : null, status };
                }),
            );
          }),
        );
        return {
          replayed: outcome.replayed,
          status: outcome.status === 204 ? (204 as const) : (202 as const),
          value: outcome.body as Distribution,
        };
      });
    },

    retryDistribution(
      env: ApiWorkerEnv,
      session: SessionClaims,
      id: string,
      idempotencyKey: string,
      requestId?: string,
    ): Effect.Effect<IdempotentResult<Distribution>, CoreServiceError> {
      return Effect.gen(function* () {
        const commandHash = yield* hashIdempotencyRequestEffect(idempotencyKey);
        return yield* withTenantIdempotentMutation<Distribution, CoreServiceError>(
          env,
          session,
          "retry-distribution",
          idempotencyKey,
          id,
          202,
          (client, organizationId) =>
            Effect.gen(function* () {
              const owner = yield* requireActiveDistributionProfileEffect(
                client,
                organizationId,
                id,
              );
              if (!owner.postActive) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "distribution_not_retryable",
                    "The distribution is not safely retryable.",
                  ),
                );
              }
              const result = yield* client.query<DistributionRow>(
                `UPDATE distributions SET status = 'queued', next_attempt_at = now(), error_message = NULL, failure_code = NULL, failure_retryable = NULL, updated_at = now()
                 WHERE id = $1 AND status = 'failed' AND failure_retryable = true RETURNING ${distributionColumns}`,
                [id],
              );
              if (!result.rows[0]) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "distribution_not_retryable",
                    "The distribution is not safely retryable.",
                  ),
                );
              }
              const updated = result.rows[0];
              const value = mapDistribution({
                ...updated,
                publication_snapshot: yield* frozenPublicationEffect(client, updated.id),
              });
              yield* insertOutboxBatchEffect(client, organizationId, [id], {
                requestId,
                retryToken: commandHash,
              });
              return value;
            }),
          withTenantTransactionEffectOverride,
        );
      });
    },
  };
}
