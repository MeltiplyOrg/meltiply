import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import type { ProviderPublishOptions } from "@meltiply/providers";
import {
  type DatabaseError,
  isoDateTime,
  COMMUNITY_LIMITS,
  maximumDelayedDeliverySeconds,
} from "@meltiply/domain";

import {
  activeBrandProfilePredicate,
  requireActiveBrandProfileEffect,
} from "./brand-profile-guard";
import { CoreApiError, type CoreServiceError, type IdempotentResult } from "./core-types";
import {
  activeOrganizationIdEffect,
  withTenantTransactionEffect,
  type EffectTransactionClient,
} from "./database";
import type { ApiWorkerEnv } from "./env";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  reserveIdempotencyEffect,
} from "./idempotency";

type Schemas = components["schemas"];
type Distribution = Schemas["Distribution"];
type Platform = Schemas["Platform"];
type DistributionStatus = Schemas["DistributionStatus"];

export interface DistributionFilters {
  /** Restricts results to one Brand Profile; omitted returns the workspace-wide aggregate across active profiles. */
  brandProfileId?: string;
  end?: Date;
  limit: number;
  offset: number;
  platform?: Platform;
  /** Restricts results to the publications of one Post. */
  postId?: string;
  start?: Date;
  status?: DistributionStatus;
}

/**
 * Editable fields of one publication. Rescheduling and content overrides are
 * the only Distribution mutations a creator may apply; provider attempt,
 * result, and Reconciliation state stay worker-owned, and a Post's attachment
 * set is edited through the Post surface rather than per target.
 */
export interface DistributionPatch {
  descriptionOverride?: string | null;
  hashtags?: string[];
  scheduledAt?: Date | null;
  titleOverride?: string | null;
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
  publication_snapshot: StoredPublicationSnapshot | null;
  published_at: Date | string | null;
  scheduled_at: Date | string | null;
  status: DistributionStatus;
  title_override: string | null;
  updated_at: Date | string;
}

/**
 * One frozen media entry of `provider_operations.publication_snapshot`, as the
 * automation worker persists it. Storage internals (`object_id`, `object_key`,
 * `rendition_id`, `etag`) exist in the stored JSON but are deliberately absent
 * here: the public read model carries identities and descriptive facts only,
 * never private object locations or capabilities.
 */
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

/**
 * Immutable resolved composition the newest claimed publish attempt froze.
 * Written at claim time and kept immutable by
 * `provider_operations_snapshot_immutable`, so it is the only honest answer to
 * "what did this Channel publish": later Post or target edits never reach it.
 */
interface StoredPublicationSnapshot {
  content: {
    hashtags: string[];
    provider_options?: ProviderPublishOptions;
    text: string;
    title: string;
  };
  media: StoredPublicationMedia[];
  post_id: string;
  version: 1;
}

/**
 * Shared `distributions` column list for every read and mutation projection,
 * so list, detail, Post composition, and RETURNING responses project the same
 * fields. Exported for the Post composition read.
 */
export const distributionColumns = `
  id, org_id, brand_profile_id, post_id, platform_account_id, platform, status,
  scheduled_at, published_at, platform_post_id, platform_url,
  title_override, description_override, hashtags, error_message,
  attempt_count, last_attempt_at, next_attempt_at, failure_code,
  failure_retryable, batch_id, created_at, updated_at`;

/**
 * Projection fragment resolving the newest claimed publish attempt's frozen
 * snapshot as `publication_snapshot` for the outer `distributions` row. The
 * newest claim wins because that is the attempt the current Distribution state
 * belongs to; the subquery runs under the same tenant transaction and RLS
 * policy as the outer read.
 */
export const publicationSnapshotColumn = `(
    SELECT operation.publication_snapshot
    FROM provider_operations AS operation
    WHERE operation.distribution_id = distributions.id
      AND operation.operation = 'publish'
      AND operation.publication_snapshot IS NOT NULL
    ORDER BY operation.created_at DESC, operation.id DESC
    LIMIT 1
  ) AS publication_snapshot`;

/**
 * Reads the newest claimed attempt's frozen snapshot for one Distribution.
 * Mutation responses (`RETURNING` projections) cannot join, so they call this
 * inside their tenant transaction after the update; reads select
 * {@link publicationSnapshotColumn} inline instead.
 *
 * @param client - Active tenant transaction client.
 * @param distributionId - Distribution whose publish snapshot is needed.
 * @returns Effect resolving to the stored snapshot, or null before any claim.
 */
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

/**
 * Converts stored provider options from the provider-domain shape the
 * publishing worker consumes into the contract's wire shape. Target rows and
 * frozen snapshots both store camelCase options while the HTTP contract
 * publishes snake_case; the domain type already guarantees mandatory TikTok
 * music consent.
 *
 * @param options - Stored provider options, or null when nothing was saved.
 * @returns Wire-shaped provider options, or null when there are none to return.
 */
export function toWireProviderOptions(
  options: ProviderPublishOptions | null,
): Schemas["ProviderPublishOptions"] | null {
  if (!options) return null;
  const tiktok = options.tiktok;
  const youtube = options.youtube;
  if (!tiktok && !youtube) return null;
  return {
    ...(tiktok
      ? {
          tiktok: {
            allow_comment: tiktok.allowComment,
            allow_duet: tiktok.allowDuet,
            allow_stitch: tiktok.allowStitch,
            brand_content: tiktok.brandContent,
            brand_organic: tiktok.brandOrganic,
            is_ai_generated: tiktok.isAiGenerated,
            music_usage_confirmed: tiktok.musicUsageConfirmed,
            privacy_level: tiktok.privacyLevel,
          },
        }
      : {}),
    ...(youtube
      ? {
          youtube: {
            made_for_kids: youtube.madeForKids,
            ...(youtube.privacyStatus ? { privacy_status: youtube.privacyStatus } : {}),
          },
        }
      : {}),
  };
}

/**
 * Projects a stored publication snapshot into the public
 * `DistributionPublication` read model. Entries are sorted by their frozen
 * `position` so wire order is the delivered order; storage internals never
 * reach the response, and an attachment with no frozen object keeps its
 * position with null facts.
 *
 * @param snapshot - Snapshot read from `provider_operations.publication_snapshot`.
 * @returns Contract `DistributionPublication` representation.
 */
function mapPublicationSnapshot(
  snapshot: StoredPublicationSnapshot,
): Schemas["DistributionPublication"] {
  return {
    title: snapshot.content.title,
    text: snapshot.content.text,
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

/**
 * Formats an optional date or timestamp string into an ISO 8601 string.
 *
 * @param value - Date object, ISO string, or null.
 * @returns Formatted ISO 8601 string, or `null`.
 */
function optionalDate(value: Date | string | null): string | null {
  return value === null ? null : isoDateTime(value);
}

/**
 * Transforms a raw database distribution row into the schema-compliant `Distribution` object.
 *
 * Formats timestamps, constructs failure error metadata when failure columns
 * are populated, and projects the newest claimed attempt's frozen publication
 * snapshot into `publication` — null before any attempt claims the
 * Distribution.
 *
 * @param row - Database row from `distributions` carrying `publication_snapshot`
 *   as selected by {@link publicationSnapshotColumn} or attached after a mutation.
 * @returns Schema-compliant `Distribution` representation.
 */
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
    last_attempt_at: optionalDate(row.last_attempt_at),
    next_attempt_at: optionalDate(row.next_attempt_at),
    org_id: row.org_id,
    platform: row.platform,
    platform_account_id: row.platform_account_id,
    platform_post_id: row.platform_post_id,
    platform_url: row.platform_url,
    post_id: row.post_id,
    publication: row.publication_snapshot ? mapPublicationSnapshot(row.publication_snapshot) : null,
    published_at: optionalDate(row.published_at),
    scheduled_at: optionalDate(row.scheduled_at),
    status: row.status,
    title_override: row.title_override,
    updated_at: isoDateTime(row.updated_at),
  };
}

/**
 * Validates the per-Channel text overrides shared by Post targets and direct
 * Distribution rescheduling.
 *
 * Title and body lengths plus hashtag count and uniqueness are the limits every
 * provider shares, so enforcing them here keeps a Post target and a pending
 * Distribution consistent before either reaches a provider.
 *
 * @param overrides - Candidate title/description overrides and hashtags; omitted members are unchecked.
 * @throws {CoreApiError} 422 `validation_error` when a title exceeds 200 characters,
 *   a description exceeds 5,000 characters, or hashtags exceed 30 entries or repeat.
 */
export function validateTargetOverrides(overrides: {
  descriptionOverride?: string | null;
  hashtags?: string[];
  titleOverride?: string | null;
}): void {
  if (overrides.titleOverride && overrides.titleOverride.length > 200) {
    throw new CoreApiError(422, "validation_error", "title_override is too long.");
  }
  if (overrides.descriptionOverride && overrides.descriptionOverride.length > 5_000) {
    throw new CoreApiError(422, "validation_error", "description_override is too long.");
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

/**
 * Resolves a Distribution's owner and rejects mutations when its Brand Profile is unavailable.
 *
 * The lookup stays in the caller's tenant transaction, so both update and retry
 * consistently report a missing distribution before enforcing the active profile
 * lifecycle gate that blocks new work after soft deletion.
 *
 * @param client - Tenant transaction client.
 * @param organizationId - Active workspace UUID.
 * @param distributionId - Distribution UUID being mutated.
 * @returns Effect resolving after the owning Brand Profile is verified active.
 * @throws {CoreApiError} 404 when the Distribution or Brand Profile is unavailable.
 */
function requireActiveDistributionProfileEffect(
  client: EffectTransactionClient,
  organizationId: string,
  distributionId: string,
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const current = yield* client.query<{
      brand_profile_id: string;
    }>(
      `SELECT brand_profile_id
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
  });
}

/**
 * Atomically checks and increments monthly distribution usage limits for an organization via Effect.
 *
 * Employs a conditional upsert on `usage_records` where `distributions + increment <= max_distributions`
 * to protect against concurrent quota oversubscription. Callers pass only the
 * count of newly created publications, because rescheduling or editing an
 * existing pending target consumes no additional quota.
 *
 * @param client - Active Effect PostgreSQL transaction client.
 * @param organizationId - Tenant organization UUID.
 * @param increment - Number of newly created distributions.
 * @returns Effect resolving to void or failing with CoreApiError or DatabaseError.
 */
export function usageGuardEffect(
  client: EffectTransactionClient,
  organizationId: string,
  increment: number,
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const limits = COMMUNITY_LIMITS;
    const period = new Date().toISOString().slice(0, 7);
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
        new CoreApiError(
          403,
          "quota_exceeded",
          "The monthly distribution quota has been reached.",
        ),
      );
    }
  });
}

interface OutboxCommand {
  dedupeKey?: string;
  now?: Date;
  requestId?: string;
  scheduledAt?: Date | null;
  topic?: string;
}

/**
 * Resolves the concrete outbox row values one publication command must insert.
 *
 * The dedupe key is what makes an at-least-once relay idempotent, so it must be
 * derived identically for single and batched inserts: a scheduled command
 * carries the target instant so an abandoned schedule cannot be satisfied by a
 * later reschedule, while an immediate command does not. A schedule beyond the
 * relayer's delay horizon emits no row at all and relies on the hourly sweep
 * poller instead, exactly as a single insert does.
 *
 * @param organizationId - Tenant organization UUID.
 * @param id - Target distribution UUID.
 * @param command - Optional outbox configuration including topic, dedupe key, and schedule time.
 * @returns Column values for one `outbox_events` row, or `undefined` when the schedule is too far out.
 */
function outboxCommandRow(
  organizationId: string,
  id: string,
  command: OutboxCommand,
): readonly unknown[] | undefined {
  const topic = command.topic ?? "distribution.publish.requested";
  let dedupeKey = command.dedupeKey ?? `distribution:${id}:${topic}`;
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

/**
 * Inserts a transactional command into the `outbox_events` table for asynchronous relay via Effect.
 *
 * For scheduled publications, calculates the delay seconds and ignores schedules beyond
 * `maximumDelayedDeliverySeconds` (relying on hourly sweep pollers instead).
 *
 * @param client - Active Effect PostgreSQL transaction client.
 * @param organizationId - Tenant organization UUID.
 * @param id - Target distribution UUID.
 * @param command - Optional outbox configuration including topic, deduplication key, and schedule time.
 * @returns Effect resolving to void or failing with DatabaseError.
 */
function insertOutboxEffect(
  client: EffectTransactionClient,
  organizationId: string,
  id: string,
  command: OutboxCommand = {},
): Effect.Effect<void, DatabaseError> {
  const row = outboxCommandRow(organizationId, id, command);
  if (!row) return Effect.void;
  return client
    .query(
      `INSERT INTO outbox_events (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
       VALUES ($1, $2, 'distribution', $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      row,
    )
    .pipe(Effect.asVoid);
}

/**
 * Inserts the publish command for every one of a Post's resolved Distribution
 * rows in a single statement.
 *
 * One Post can target twenty Channels, and Post scheduling materializes all of
 * them together, so issuing one command statement per row would make the write
 * path scale with the target count. The ids are supplied as an array and
 * expanded with `unnest`, keeping the statement count constant while each row
 * still carries its own dedupe key, so replaying a scheduling intent never
 * publishes the same Channel twice.
 *
 * @param client - Active Effect PostgreSQL transaction client.
 * @param organizationId - Tenant organization UUID.
 * @param ids - Distribution UUIDs whose publish command must exist.
 * @param command - Publish command applied to every row; pass `scheduledAt` for scheduled publications.
 * @returns Effect resolving to void or failing with DatabaseError.
 */
export function insertOutboxBatchEffect(
  client: EffectTransactionClient,
  organizationId: string,
  ids: readonly string[],
  command: Omit<OutboxCommand, "dedupeKey"> = {},
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

/**
 * Factory creating distribution domain service methods for publication lifecycle management.
 *
 * Post-owned scheduling creates and edits publication targets, so this factory
 * only keeps the independent per-Distribution operations a creator drives
 * directly: reading, rescheduling, cancelling, retrying, and reconciling one
 * Channel outcome without touching the shared Post identity.
 *
 * @returns Object providing distribution read, reschedule, cancellation, and retry methods.
 */
export function createDistributionMethods() {
  return {
    /**
     * Lists tenant distributions based on optional status, platform, Post, Brand Profile, and date filters via Effect.
     *
     * Queries `distributions` ordered by `event_at DESC` within a tenant-scoped
     * transaction. Rows whose Brand Profile is soft-deleted are excluded so
     * deleted-profile data leaves normal views immediately; an optional
     * `brandProfileId` narrows the result to one profile while omitting it
     * returns the workspace-wide aggregate across active Brand Profiles.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param filters - Pagination (limit/offset) and filtering criteria.
     * @returns Effect resolving to paginated list of distributions with `has_more` cursor indicator.
     */
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
      return withTenantTransactionEffect(env, session, (client) =>
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

    /**
     * Retrieves a single distribution by ID ensuring tenant isolation via Effect.
     *
     * Distributions whose Brand Profile is soft-deleted resolve as not found so
     * deleted-profile data leaves normal views immediately.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param id - Distribution UUID.
     * @returns Effect resolving to the mapped `Distribution` schema object.
     * @throws {CoreApiError} 404 `not_found` if the distribution does not exist, belongs to another tenant, or sits under a deleted Brand Profile.
     */
    getDistribution(
      env: ApiWorkerEnv,
      session: SessionClaims,
      id: string,
    ): Effect.Effect<Distribution, CoreServiceError> {
      return withTenantTransactionEffect(env, session, (client) =>
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

    /**
     * Updates content overrides or reschedule timestamp for a pending scheduled distribution via Effect.
     *
     * Only distributions in `scheduled` status under an active Brand Profile may be
     * updated; a distribution whose profile is soft-deleted rejects with
     * `brand_profile_deleted` because mutations require an active profile. When
     * rescheduled, enqueues a fresh outbox publish command for the new instant
     * (if within the delayed delivery horizon).
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param id - Distribution UUID.
     * @param patch - Partial fields to update (`scheduledAt`, `titleOverride`, `descriptionOverride`, `hashtags`).
     * @param idempotencyKey - Client idempotency key.
     * @returns Effect resolving to updated distribution object and replay flag.
     * @throws {CoreApiError} 404 `not_found` if the distribution does not exist.
     * @throws {CoreApiError} 409 `brand_profile_deleted` if the owning Brand Profile is soft-deleted.
     * @throws {CoreApiError} 409 `distribution_not_scheduled` if the distribution is not in `scheduled` status.
     */
    updateDistribution(
      env: ApiWorkerEnv,
      session: SessionClaims,
      id: string,
      patch: DistributionPatch,
      idempotencyKey: string,
    ): Effect.Effect<IdempotentResult<Distribution>, CoreServiceError> {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify({ id, patch }));
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "update-distribution",
              idempotencyKey,
              requestHash,
            );
            if (replay) {
              return {
                replayed: true,
                value: replay.response_body as Distribution,
              };
            }
            const now = new Date();
            yield* Effect.try({
              try: () => validateTargetOverrides(patch),
              catch: (cause) => cause as CoreApiError,
            });
            yield* requireActiveDistributionProfileEffect(client, organizationId, id);
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
            // RETURNING cannot join, so a second read attaches the snapshot.
            const updated = result.rows[0];
            const value = mapDistribution({
              ...updated,
              publication_snapshot: yield* frozenPublicationEffect(client, updated.id),
            });
            if (patch.scheduledAt) {
              yield* insertOutboxEffect(client, organizationId, value.id, {
                now,
                scheduledAt: patch.scheduledAt,
              });
            }
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "update-distribution",
              idempotencyKey,
              200,
              value,
            );
            return { replayed: false, value };
          }),
        );
      });
    },

    /**
     * Cancels a scheduled or queued distribution, or initiates graceful abort for in-flight jobs via Effect.
     *
     * If queued or scheduled, immediately transitions status to `cancelled`, deletes unleased outbox rows,
     * and returns HTTP 204. If already in flight (`processing`, `awaiting_provider`), transitions status to
     * `cancel_requested` and enqueues a cancellation command for the background consumer (returning HTTP 202).
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param id - Distribution UUID.
     * @param idempotencyKey - Client idempotency key.
     * @param requestId - Optional HTTP request trace ID.
     * @returns Effect resolving to distribution payload, status code (202 for async cancel, 204 for immediate), and replay flag.
     * @throws {CoreApiError} 404 `not_found` if distribution does not exist.
     * @throws {CoreApiError} 409 `invalid_state` if already published, failed, or cancelled.
     */
    cancelDistribution(
      env: ApiWorkerEnv,
      session: SessionClaims,
      id: string,
      idempotencyKey: string,
      requestId?: string,
    ): Effect.Effect<IdempotentResult<Distribution> & { status: 202 | 204 }, CoreServiceError> {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(id);
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "cancel-distribution",
              idempotencyKey,
              requestHash,
            );
            if (replay) {
              return {
                replayed: true,
                value: replay.response_body as Distribution,
                status: replay.response_status === 204 ? (204 as const) : (202 as const),
              };
            }
            const current = yield* client.query<DistributionRow>(
              `SELECT ${distributionColumns},
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
            if (["published", "failed", "cancelled"].includes(row.status)) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "invalid_state",
                  "The distribution cannot be cancelled in its current state.",
                ),
              );
            }
            const inFlight = [
              "processing",
              "awaiting_provider",
              "needs_reconciliation",
              "cancel_requested",
            ].includes(row.status);
            const result = yield* client.query<DistributionRow>(
              `UPDATE distributions SET status = $2, cancel_requested_at = CASE WHEN $2 = 'cancel_requested' THEN now() ELSE cancel_requested_at END, updated_at = now() WHERE id = $1 RETURNING ${distributionColumns}`,
              [id, inFlight ? "cancel_requested" : "cancelled"],
            );
            // The lock read already selected the snapshot; snapshots are
            // immutable, so that value is exactly what the response echoes.
            const updated = result.rows[0]!;
            const value = mapDistribution({
              ...updated,
              publication_snapshot: row.publication_snapshot,
            });
            if (inFlight) {
              yield* insertOutboxEffect(client, organizationId, id, {
                requestId,
                topic: "distribution.cancel.requested",
              });
            } else {
              yield* client.query(
                `DELETE FROM outbox_events
                 WHERE aggregate_id = $1
                   AND topic = 'distribution.publish.requested'
                   AND state IN ('pending', 'failed')`,
                [id],
              );
            }
            const status: 202 | 204 = inFlight ? 202 : 204;
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "cancel-distribution",
              idempotencyKey,
              status,
              inFlight ? value : null,
            );
            return { replayed: false, value, status };
          }),
        );
      });
    },

    /**
     * Retries a failed distribution that was flagged by the system as safely retryable via Effect.
     *
     * Verifies that the distribution is in `failed` status with `failure_retryable = true`
     * under an active Brand Profile, resets status to `queued`, clears failure metadata,
     * and enqueues a fresh outbox publication command. A distribution whose profile is
     * soft-deleted rejects because retries start new publishing work. Retrying reuses the
     * same Post and Platform account row, so a recovered Channel never duplicates a
     * publication that already succeeded on another Channel.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param id - Distribution UUID.
     * @param idempotencyKey - Client idempotency key.
     * @param requestId - Optional request trace ID.
     * @returns Effect resolving to retried distribution in `queued` status and replay flag.
     * @throws {CoreApiError} 404 `not_found` if the distribution does not exist.
     * @throws {CoreApiError} 404 `brand_profile_not_found` or 409 `brand_profile_deleted` if the owning profile is unusable.
     * @throws {CoreApiError} 409 `distribution_not_retryable` if the distribution is not failed or not retryable.
     */
    retryDistribution(
      env: ApiWorkerEnv,
      session: SessionClaims,
      id: string,
      idempotencyKey: string,
      requestId?: string,
    ): Effect.Effect<IdempotentResult<Distribution>, CoreServiceError> {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(id);
        const commandHash = yield* hashIdempotencyRequestEffect(idempotencyKey);
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "retry-distribution",
              idempotencyKey,
              requestHash,
            );
            if (replay) {
              return {
                replayed: true,
                value: replay.response_body as Distribution,
              };
            }
            yield* requireActiveDistributionProfileEffect(client, organizationId, id);
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
            // RETURNING cannot join, so a second read attaches the snapshot.
            const updated = result.rows[0];
            const value = mapDistribution({
              ...updated,
              publication_snapshot: yield* frozenPublicationEffect(client, updated.id),
            });
            yield* insertOutboxEffect(client, organizationId, id, {
              dedupeKey: `distribution:${id}:distribution.publish.requested:retry:${commandHash}`,
              requestId,
            });
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "retry-distribution",
              idempotencyKey,
              202,
              value,
            );
            return { replayed: false, value };
          }),
        );
      });
    },
  };
}
