import { Effect } from "effect";
import { claimJobLease, finishJobLease, jobLeaseOutcome } from "./job-lease";
import {
  cachedProviderRegistryFromEnvironment,
  createProviderServiceLive,
  validatePublishInput,
  type ProviderAdapterError,
  type ProviderOperationResult,
  type ProviderPublishOptions,
  type ProviderRegistry,
} from "@meltiply/providers";
import {
  rateLimitBudgetFreshSeconds,
  type DatabaseError,
  type Platform,
  type PlatformCapability,
} from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";

import { withSystemTransactionEffect } from "./database";
import { classifyJobError, RetryableJobError, type AutomationJobError } from "./effect/index";
import {
  executeProviderCancelEffect,
  executeProviderLookupEffect,
  executeProviderPublishEffect,
  type DistributionLookupExecution,
  type DistributionProviderDependencies,
  type DistributionPublishExecution,
  type PublicationMediaEntry,
} from "./distribution-provider";
import type { AutomationEnv } from "./env";
import { createProviderMediaResolver, providerMediaRetrievalLeaseSeconds } from "./provider-media";
import { decryptStoredToken, tokenCipherFor } from "./provider-credentials";
import { isOutboxMessage, type OutboxMessage } from "./messages";

type DistributionMessage = OutboxMessage;

/**
 * One frozen object an attempt may deliver, as read from `asset_objects` at
 * claim. Renditions and the verified original are both candidates; the
 * capability check decides which one is delivered.
 */
interface DistributionMediaCandidate extends Record<string, unknown> {
  content_type: string | null;
  duration_sec: number | null;
  etag: string | null;
  file_size: number | null;
  height: number | null;
  object_id: string;
  object_key: string;
  rendition_id: string | null;
  width: number | null;
}

/** One ordered attachment of the composition with its ready objects. */
interface DistributionMediaEntry extends Record<string, unknown> {
  asset_id: string;
  asset_type: "image" | "video";
  candidates: DistributionMediaCandidate[];
  content_type: string | null;
  duration_sec: number | null;
  file_size: number | null;
  height: number | null;
  position: number;
  width: number | null;
}

/**
 * Claimed Distribution joined to its Post and resolved composition.
 *
 * `post_title`/`post_default_text` are the Post defaults, while the override
 * columns are the copies resolved at schedule time; both are frozen into the
 * attempt snapshot before any Provider call so later Post edits cannot change
 * what this attempt publishes or what reconciliation replays.
 */
interface DistributionRow extends Record<string, unknown> {
  access_token: string | null;
  attachment_ids: string[] | null;
  brand_profile_id: string;
  connection_status: string | null;
  description_override: string | null;
  hashtags: string[] | null;
  id: string;
  media: DistributionMediaEntry[];
  org_id: string;
  platform: Platform;
  platform_account_id: string | null;
  platform_post_id: string | null;
  platform_user_id: string | null;
  post_default_text: string;
  post_id: string;
  post_title: string;
  provider_operation_id: string | null;
  provider_options: ProviderPublishOptions | null;
  provider_poll_attempts: number;
  reconciliation_attempt_count: number;
  refresh_token: string | null;
  scheduled_at: Date | string | null;
  status: string;
  attempt_count: number;
  title_override: string | null;
  token_expires_at: Date | string | null;
}

/**
 * Claim outcome: a claimed row always carries the composition snapshot that
 * was frozen with its Provider operation, so publish, poll, retry, resume, and
 * reconciliation all work from the same resolved content and media.
 */
type DistributionPreparation =
  | { outcome: "deferred" }
  | { outcome: "ready"; row: DistributionRow; snapshot: PublicationSnapshot }
  | { outcome: "skipped" };

export interface DistributionProcessingDependencies {
  decryptToken?: DistributionProviderDependencies["decryptToken"];
  mediaFor?: DistributionProviderDependencies["mediaFor"];
  now?: () => Date;
  persistRefreshedTokens?: DistributionProviderDependencies["persistRefreshedTokens"];
  providerRegistry?: ProviderRegistry;
  random?: () => number;
  transaction?: typeof withSystemTransactionEffect;
}

export { distributionProcessingGraceSeconds } from "./due-work";
import {
  claimDueOutboxWork,
  distributionProcessingGraceSeconds,
  maximumDelayedDeliverySeconds,
  maximumProviderPollAttempts,
  maximumReconciliationAttempts,
  overdueRecoveryGraceSeconds,
  providerPollIntervalSeconds,
} from "./due-work";
const leaseSeconds = distributionProcessingGraceSeconds;

/**
 * Formats a distributed job lease key for a distribution outbox message.
 *
 * @param message - Outbox message.
 * @returns Formatted lease event key string.
 */
function eventKey(message: DistributionMessage): string {
  return `outbox:${message.event_id}`;
}

type DistributionOperation = "cancel" | "publish" | "reconcile";

/**
 * Resolves the distribution operation type from the outbox message topic.
 *
 * @param message - Outbox message containing the topic.
 * @returns 'cancel', 'publish', or 'reconcile', or undefined if unsupported.
 */
function operation(message: DistributionMessage): DistributionOperation | undefined {
  switch (message.topic) {
    case "distribution.cancel.requested":
      return "cancel";
    case "distribution.publish.requested":
      return "publish";
    case "distribution.reconcile.requested":
      return "reconcile";
    default:
      return undefined;
  }
}

/**
 * Generates an idempotent operation key for provider interactions.
 *
 * @param message - Outbox message.
 * @returns Namespaced idempotency key.
 */
function idempotencyKey(message: DistributionMessage): string {
  return `queue:${message.event_id}`;
}

/**
 * A cached Provider budget parks a publish when it reports fewer than
 * `rateLimitRemainingThreshold` calls left or at least
 * `rateLimitPercentThreshold` of the window used. A budget older than
 * `rateLimitBudgetFreshSeconds` carries no signal, so a stale exhaustion never
 * parks a publish forever.
 */
const rateLimitRemainingThreshold = 5;
const rateLimitPercentThreshold = 90;
const rateLimitMaxParkSeconds = 3_600;
const rateLimitUnknownResetParkSeconds = 60;

/**
 * Seconds to park a publish against the cached `(platform, provider account id)` budget,
 * or `null` when the publish may proceed. Bounded by
 * `rateLimitMaxParkSeconds` so a distant or malformed reset time cannot hold a
 * Distribution past one window.
 *
 * @param client - Transactional database client.
 * @param platform - Social platform identifier.
 * @param accountId - Provider account identifier.
 * @param now - Reference timestamp for measuring reset expiration.
 * @returns Seconds to delay the publish attempt, or null if execution may proceed immediately.
 */
function rateLimitParkSeconds(
  client: EffectTransactionClient,
  platform: string,
  accountId: string,
  now: Date,
): Effect.Effect<number | null, DatabaseError> {
  return Effect.gen(function* () {
    const result = yield* client.query<{
      percent_used: number | null;
      remaining: number | null;
      resets_at: Date | string | null;
    }>(
      `SELECT remaining, percent_used, resets_at
       FROM rate_limit_budgets
      WHERE platform = $1 AND account_id = $2
        AND updated_at > now() - ($3 * INTERVAL '1 second')`,
      [platform, accountId, rateLimitBudgetFreshSeconds],
    );
    const budget = result.rows[0];
    if (!budget) return null;
    if (
      !(
        (budget.remaining !== null && budget.remaining < rateLimitRemainingThreshold) ||
        (budget.percent_used !== null && budget.percent_used >= rateLimitPercentThreshold)
      )
    ) {
      return null;
    }
    const resetsAt = budget.resets_at === null ? Number.NaN : new Date(budget.resets_at).getTime();
    if (!Number.isFinite(resetsAt)) return rateLimitUnknownResetParkSeconds;
    return Math.max(
      1,
      Math.min(rateLimitMaxParkSeconds, Math.ceil((resetsAt - now.getTime()) / 1_000)),
    );
  });
}

/**
 * Cache a confirmed Provider throttle so the next publish for the same account
 * parks before spending a Provider call. `retryAfterSeconds` is the Provider's
 * own wait when it sent one; without it the recorded reset time is kept.
 *
 * @param client - Transactional database client.
 * @param platform - Social platform identifier.
 * @param accountId - Provider account identifier.
 * @param budget - Budget metrics with remaining calls, percent used, and reset seconds.
 */
function recordRateLimitBudget(
  client: EffectTransactionClient,
  platform: string,
  accountId: string,
  budget: {
    percentUsed: number | null;
    remaining: number | null;
    resetsInSeconds: number | null;
  },
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `INSERT INTO rate_limit_budgets
       (platform, account_id, remaining, percent_used, resets_at, updated_at)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::integer IS NULL THEN NULL
                  ELSE now() + ($5 * INTERVAL '1 second') END,
             now())
     ON CONFLICT (platform, account_id) DO UPDATE
       SET remaining = EXCLUDED.remaining,
           percent_used = EXCLUDED.percent_used,
           resets_at = EXCLUDED.resets_at,
           updated_at = now()`,
      [platform, accountId, budget.remaining, budget.percentUsed, budget.resetsInSeconds],
    )
    .pipe(Effect.asVoid);
}

/**
 * Reports whether one claimed object can be delivered to the target Platform.
 *
 * Compatibility is decided by the shared `validatePublishInput` rules rather
 * than a second copy of them, so claim-time selection and the Provider
 * pre-flight check can never disagree about a MIME type, kind, byte ceiling,
 * or video duration. Only issues scoped to the probed attachment count:
 * caption, hashtag, and attachment-set rules describe the whole attempt and
 * are owned by the publish path, so a per-object probe ignores them.
 *
 * @param capability - Target Platform capability the object must satisfy.
 * @param candidate - Claimed ready object with its verified stored facts.
 * @returns True when no per-attachment constraint rejects the object.
 */
function candidateDeliversTo(
  capability: PlatformCapability,
  candidate: DistributionMediaCandidate,
): boolean {
  return !validatePublishInput(capability, {
    caption: "",
    hashtags: [],
    idempotencyKey: "distribution-claim-selection",
    media: [
      {
        // An object that never recorded a media type or a positive byte count
        // cannot be shown to fit, so the probe reports it as incompatible
        // rather than guessing the missing fact from the Asset row.
        contentType: candidate.content_type ?? "",
        fileSize: candidate.file_size ?? 0,
        metadata: {
          ...(candidate.duration_sec === null ? {} : { durationSeconds: candidate.duration_sec }),
          ...(candidate.height === null ? {} : { height: candidate.height }),
          ...(candidate.width === null ? {} : { width: candidate.width }),
        },
        mode: "remote_ingest",
        url: "https://validation.invalid/media",
      },
    ],
  }).some((issue) => issue.field.startsWith("media[0]."));
}

/**
 * Selects the object an attempt freezes for one attachment.
 *
 * The claim query orders ready renditions ahead of the verified original and
 * then by size, so the first *deliverable* candidate is the smallest validated
 * output this Platform actually accepts. Compatibility is part of the choice
 * because the freeze is immutable: an object the Platform would reject has to
 * be skipped here, while a larger approved object that does fit is still
 * selected, rather than freezing an undeliverable object and failing the whole
 * attempt later. An attachment whose Asset has no ready, deliverable object
 * yields `null`, which becomes unavailable media rather than a silently
 * dropped attachment.
 *
 * @param entry - Claimed attachment entry with its ordered ready candidates.
 * @param capability - Target Platform capability, or null when the Platform has
   no registered adapter and therefore cannot accept any object.
 * @returns The candidate to freeze, or null when the attachment has none.
 */
function frozenCandidate(
  entry: DistributionMediaEntry,
  capability: PlatformCapability | null,
): DistributionMediaCandidate | null {
  if (!capability) return null;
  return entry.candidates.find((candidate) => candidateDeliversTo(capability, candidate)) ?? null;
}

/**
 * One frozen media object as persisted on an attempt, in the stored JSONB
 * shape. `object_*` is null when the attachment had no ready object at claim,
 * which keeps the attachment itself in the frozen order instead of silently
 * dropping it from the publication.
 */
interface FrozenMediaItem {
  asset_id: string;
  asset_type: "image" | "video";
  content_type: string | null;
  duration_sec: number | null;
  etag: string | null;
  file_size: number | null;
  height: number | null;
  object_id: string | null;
  object_key: string | null;
  position: number;
  rendition_id: string | null;
  width: number | null;
}

/**
 * Immutable resolved composition persisted on a publish attempt.
 *
 * `content` is what the Provider was asked to publish and `media` the exact
 * ordered objects it was handed, so polling, retry, and reconciliation all
 * reproduce the same publication instead of re-reading live Post state.
 */
interface PublicationSnapshot {
  content: {
    hashtags: string[];
    provider_options?: ProviderPublishOptions;
    text: string;
    title: string;
  };
  media: FrozenMediaItem[];
  post_id: string;
  version: 1;
}

/**
 * Builds the immutable publication snapshot written on a publish attempt.
 *
 * Content is the target's schedule-time overrides falling back to the Post
 * default; media is the ordered attachment list with the object chosen for
 * each. The object for an attachment is picked from the ready candidates this
 * Platform can actually accept, so the freeze records a deliverable delivery
 * rather than the smallest ready object regardless of its media type. Once
 * persisted, nothing but this snapshot governs what the attempt publishes,
 * polls, retries, or reconciles, so later Post edits — text, attachment order,
 * or replaced files — can never rewrite the attempt or the history it
 * produces.
 *
 * @param row - Claimed Distribution joined to its resolved composition.
 * @param capability - Target Platform capability deciding which ready object
   each attachment may deliver; null when the Platform has no registered
   adapter, which leaves every attachment without a frozen object.
 * @returns Snapshot persisted as `provider_operations.publication_snapshot`.
 */
function publicationSnapshot(
  row: DistributionRow,
  capability: PlatformCapability | null,
): PublicationSnapshot {
  return {
    version: 1,
    post_id: row.post_id,
    content: {
      title: row.title_override ?? row.post_title,
      text: row.description_override ?? row.post_default_text,
      hashtags: row.hashtags ?? [],
      ...(row.provider_options ? { provider_options: row.provider_options } : {}),
    },
    media: row.media.map((entry) => {
      const candidate = frozenCandidate(entry, capability);
      return {
        position: entry.position,
        asset_id: entry.asset_id,
        asset_type: entry.asset_type,
        rendition_id: candidate?.rendition_id ?? null,
        object_id: candidate?.object_id ?? null,
        object_key: candidate?.object_key ?? null,
        content_type: candidate?.content_type ?? entry.content_type,
        file_size: candidate?.file_size ?? entry.file_size,
        etag: candidate?.etag ?? null,
        width: candidate?.width ?? entry.width,
        height: candidate?.height ?? entry.height,
        duration_sec: candidate?.duration_sec ?? entry.duration_sec,
      };
    }),
  };
}

/**
 * Presents a frozen snapshot to the Provider path as ordered attachment
 * entries.
 *
 * An attachment whose object could not be frozen keeps its place with no
 * candidate, so publication fails as unavailable media instead of quietly
 * publishing fewer attachments than the creator composed.
 *
 * @param snapshot - Snapshot persisted on the claimed attempt.
 * @returns Frozen media entries in publication order.
 */
function frozenMediaEntries(snapshot: PublicationSnapshot): PublicationMediaEntry[] {
  return snapshot.media.map((item) => ({
    position: item.position,
    assetId: item.asset_id,
    assetType: item.asset_type,
    candidates:
      item.object_key === null || item.object_id === null || item.file_size === null
        ? []
        : [
            {
              contentType: item.content_type,
              fileSize: item.file_size,
              objectId: item.object_id,
              objectKey: item.object_key,
              ...(item.duration_sec === null ? {} : { durationSeconds: item.duration_sec }),
              ...(item.etag === null ? {} : { etag: item.etag }),
              ...(item.height === null ? {} : { height: item.height }),
              ...(item.width === null ? {} : { width: item.width }),
            },
          ],
  }));
}

/**
 * Reads the media a Distribution's publish attempts already froze.
 *
 * Reconcile and cancel resolve media from this instead of the live Post, so a
 * continuation resumes the Provider's own upload and a cancelled publication
 * releases exactly the bytes the attempt used. The newest snapshot wins
 * because that is the attempt the current Distribution state belongs to.
 *
 * @param client - Transactional database client inside the claim transaction.
 * @param distributionId - Distribution whose publish snapshot is needed.
 * @returns Frozen snapshot, or an empty-media snapshot when none was recorded.
 */
function frozenSnapshotFor(
  client: EffectTransactionClient,
  distributionId: string,
): Effect.Effect<PublicationSnapshot, DatabaseError> {
  return client
    .query<{ publication_snapshot: PublicationSnapshot | null }>(
      `SELECT publication_snapshot
       FROM provider_operations
       WHERE distribution_id = $1 AND operation = 'publish'
         AND publication_snapshot IS NOT NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [distributionId],
    )
    .pipe(
      Effect.map(
        (result) =>
          result.rows[0]?.publication_snapshot ?? {
            version: 1,
            post_id: "",
            content: { title: "", text: "", hashtags: [] },
            media: [],
          },
      ),
    );
}

/**
 * Claims a distributed job lease and prepares a distribution record for execution.
 *
 * Acquires a lease in `async_job_events`, checks cached rate limit budgets,
 * validates that every selected attachment identity remains attached before freezing publish snapshots,
 * inserts or updates provider operations intent, and locks the distribution row.
 * Publish triggers on `processing` rows are skipped rather than re-executed — a prior
 * attempt's provider side effect is unknown, so recovery is reconciliation's job (#256).
 * An intent conflict marks the row `needs_reconciliation` and arms an immediate
 * `distribution.reconcile.requested` trigger in the same transaction.
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message.
 * @param operationType - Active distribution operation ('cancel', 'publish', or 'reconcile').
 * @param transaction - Transaction runner for database operations.
 * @param now - Reference timestamp for schedule and lease evaluation.
 * @param capabilityFor - Resolves the capability a Platform publishes under, or
   null when no adapter is registered for it; publish freezes only objects this
 *   capability accepts, so selection happens inside the claim transaction.
 * @returns Preparation result ('deferred', 'ready', or 'skipped').
 */
function prepare(
  env: AutomationEnv,
  message: DistributionMessage,
  operationType: DistributionOperation,
  transaction: typeof withSystemTransactionEffect,
  now: Date,
  capabilityFor: (platform: Platform) => PlatformCapability | null,
): Effect.Effect<DistributionPreparation, DatabaseError> {
  return transaction(env, (client) =>
    Effect.gen(function* () {
      if (
        !(yield* claimJobLease(client, {
          aggregateId: message.aggregate_id,
          aggregateType: "distribution",
          eventKey: eventKey(message),
          jobType: message.topic,
          leaseSeconds,
          orgId: message.organization_id,
        }))
      ) {
        return (yield* jobLeaseOutcome(client, eventKey(message))) === "processing"
          ? { outcome: "deferred" }
          : { outcome: "skipped" };
      }
      // Composition is resolved here, in the same transaction that claims the
      // lease, and frozen into the attempt snapshot below. Content comes from
      // the target's schedule-time overrides falling back to the Post default;
      // media is the ordered attachment subset the target selected, each with
      // the ready objects (renditions first, verified original as fallback) a
      // Provider could legitimately receive. Later Post edits therefore cannot
      // reach this attempt or the history it produces.
      const result = yield* client.query<DistributionRow>(
        `SELECT distribution.id, distribution.org_id, distribution.platform,
                distribution.platform_account_id, distribution.status,
                distribution.scheduled_at, distribution.brand_profile_id,
                distribution.post_id, distribution.attachment_ids,
                distribution.attempt_count,
                distribution.reconciliation_attempt_count,
                distribution.provider_poll_attempts,
                distribution.provider_operation_id,
                distribution.platform_post_id,
                distribution.title_override,
                distribution.description_override,
                distribution.hashtags, distribution.provider_options,
                post.title AS post_title, post.default_text AS post_default_text,
                composition.media,
                account.access_token, account.refresh_token,
                account.connection_status,
                account.token_expires_at, account.platform_user_id
         FROM distributions AS distribution
         JOIN posts AS post ON post.id = distribution.post_id
         JOIN organizations AS organization
           ON organization.id = distribution.org_id
         LEFT JOIN platform_accounts AS account
           ON account.id = distribution.platform_account_id
         CROSS JOIN LATERAL (
           SELECT coalesce(jsonb_agg(entry ORDER BY entry.sort_key),
                          '[]'::jsonb) AS media
           FROM (
             SELECT attachment.asset_id,
                    -- A target's ordered selection is authoritative for that
                    -- Channel; an inheriting target keeps the Post's order.
                    CASE
                      WHEN distribution.attachment_ids IS NULL
                        THEN attachment.position
                      ELSE array_position(
                             distribution.attachment_ids, attachment.asset_id
                           )
                    END AS sort_key,
                    attachment.position, asset.asset_type,
                    asset.mime_type AS content_type,
                    asset.file_size, asset.duration_sec, asset.width,
                    asset.height,
                    coalesce(
                      jsonb_agg(
                        jsonb_build_object(
                          'rendition_id', rendition.id,
                          'object_id', object.id,
                          'object_key', object.r2_key,
                          'content_type', object.content_type,
                          'file_size', object.bytes,
                          'etag', object.etag,
                          'width', object.width,
                          'height', object.height,
                          'duration_sec', object.duration_sec
                        )
                        ORDER BY
                          CASE object.kind
                            WHEN 'rendition' THEN 0 ELSE 1
                          END,
                          object.bytes, object.id
                      )
                      -- A candidate is a ready object a ready rendition
                      -- references, on an Asset processing has approved. The
                      -- asset gate is what keeps a still-processing, failed,
                      -- deleting, or deleted Asset out of a publication: such
                      -- an Asset can still hold ready bytes behind an older
                      -- rendition reference, and delivering one of those would
                      -- publish media nothing ever decoded. It filters
                      -- candidates, not attachments, so the attachment keeps
                      -- its position and fails as unavailable media instead of
                      -- silently shrinking the frozen composition. Any
                      -- attachment detached from the Post after target selection
                      -- is omitted by the post_attachments join below and is
                      -- rejected as unavailable media before freezing.
                      FILTER (
                        WHERE object.id IS NOT NULL
                          AND asset.status = 'ready'
                      ),
                      '[]'::jsonb
                    ) AS candidates
             FROM post_attachments AS attachment
             JOIN assets AS asset ON asset.id = attachment.asset_id
             LEFT JOIN asset_renditions AS rendition
               ON rendition.asset_id = asset.id AND rendition.status = 'ready'
             LEFT JOIN asset_objects AS object
               ON object.id = rendition.object_id AND object.status = 'ready'
             WHERE attachment.post_id = distribution.post_id
               AND (distribution.attachment_ids IS NULL
                    OR attachment.asset_id = ANY (distribution.attachment_ids))
             GROUP BY attachment.position, attachment.asset_id,
                      asset.asset_type, asset.mime_type, asset.file_size,
                      asset.duration_sec, asset.width, asset.height,
                      asset.status, distribution.attachment_ids
           ) AS entry
         ) AS composition
        WHERE distribution.id = $1 AND distribution.org_id = $2
        FOR UPDATE OF distribution`,
        [message.aggregate_id, message.organization_id],
      );
      const distribution = result.rows[0];
      // Delayed delivery makes every publish message only a trigger: the
      // durable row decides. A due `scheduled` row publishes straight from its
      // recorded schedule; a row rescheduled later or cancelled leaves an early
      const dueScheduledPublish =
        distribution !== undefined &&
        distribution.status === "scheduled" &&
        distribution.scheduled_at !== null &&
        new Date(distribution.scheduled_at).getTime() <= now.getTime();
      // A publish trigger on a 'processing' row means a prior attempt is either
      // still in flight or was lost mid-attempt; either way the provider side
      // effect is unknown. Publishing again could duplicate the post, so the
      // delivery no-ops here and the stalled-processing Due scan arms
      // reconciliation once the grace period lapses (#256).
      if (
        !distribution ||
        (operationType === "publish" && distribution.status !== "queued" && !dueScheduledPublish) ||
        (operationType === "cancel" && distribution.status !== "cancel_requested") ||
        (operationType === "reconcile" &&
          distribution.status !== "awaiting_provider" &&
          distribution.status !== "needs_reconciliation")
      ) {
        yield* finishJobLease(client, eventKey(message), "skipped");
        return { outcome: "skipped" };
      }
      // An exhausted or nearly exhausted cached budget skips creating a
      // Provider operation intent, token decryption, and any Provider call. The
      // Distribution remains queued, keeps its attempt count, and gets a new
      // delayed trigger so this internal parking is invisible to retry policy.
      const parkSeconds =
        operationType === "publish" && distribution.platform_user_id !== null
          ? yield* rateLimitParkSeconds(
              client,
              distribution.platform,
              distribution.platform_user_id,
              now,
            )
          : null;
      if (parkSeconds !== null) {
        yield* client.query(
          `UPDATE distributions
         SET status = 'queued', failure_code = NULL,
             failure_retryable = NULL,
             error_message = NULL,
             next_attempt_at = now() + ($2 * INTERVAL '1 second'),
             updated_at = now()
         WHERE id = $1 AND status IN ('queued', 'processing', 'scheduled')`,
          [distribution.id, parkSeconds],
        );
        yield* client.query(
          `INSERT INTO outbox_events
           (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES ($1, 'distribution.publish.requested', 'distribution', $2, $3, $4)
         ON CONFLICT DO NOTHING`,
          [
            distribution.org_id,
            distribution.id,
            `distribution:${distribution.id}:rate-limit-park:${message.event_id}`,
            JSON.stringify({ distribution_id: distribution.id, version: 1 }),
          ],
        );
        yield* finishJobLease(client, eventKey(message), "skipped");
        return { outcome: "skipped" };
      }
      // A target's ordered selection is authoritative for that Channel. When
      // specific attachments were selected (attachment_ids is not null), every
      // selected identity must still be attached to the Post. An attachment-only
      // Post edit that detaches or replaces a selected asset between schedule
      // and execution must not silently drop the missing media, freeze a
      // truncated snapshot, and publish partial content (#284 Decision 3 & 10).
      // The attempt fails immediately with an actionable readiness error and no
      // retries, preserving the selected order and settled history.
      const selectedAttachmentIds = distribution.attachment_ids;
      // `media` is coalesced to an array by the claim query, so every entry is
      // one still-attached selected Asset; missing selected ids fail closed.
      const attachedAssetIds = new Set(distribution.media.map((entry) => entry.asset_id));
      if (
        operationType === "publish" &&
        selectedAttachmentIds !== null &&
        selectedAttachmentIds.some((assetId) => !attachedAssetIds.has(assetId))
      ) {
        yield* client.query(
          `UPDATE distributions
         SET status = 'failed', failure_code = 'provider_media_unavailable',
             failure_retryable = false,
             error_message = 'One or more selected attachments are no longer available on the post.',
             next_attempt_at = NULL,
             updated_at = now()
         WHERE id = $1 AND status IN ('queued', 'scheduled')`,
          [distribution.id],
        );
        yield* finishJobLease(client, eventKey(message), "succeeded");
        return { outcome: "skipped" };
      }
      // A publish attempt freezes its composition here, inside the same
      // transaction that claims the lease: the snapshot is written with the
      // intent, so nothing a creator does to the Post afterwards can change
      // what this attempt publishes, polls, or reconciles. Selection is part of
      // the freeze because it is irreversible: the capability decides which
      // ready object each attachment may deliver while every candidate is still
      // in hand, so an approved compatible object is never passed over for a
      // smaller incompatible one. Publish freezes the composition it just
      // resolved; reconcile and cancel inherit the newest frozen publish
      // snapshot, so they keep acting on the media the published attempt used
      // instead of re-reading live Post state.
      const snapshot =
        operationType === "publish"
          ? publicationSnapshot(distribution, capabilityFor(distribution.platform))
          : yield* frozenSnapshotFor(client, distribution.id);
      // Reconcile re-arms its own idempotency key and keeps the snapshot it
      // already froze; publish and cancel never overwrite an existing
      // operation, because that conflict is exactly what proves a prior attempt
      // reached the Provider boundary without a durable outcome.
      // `media_asset_ids` is the indexed hold set cleanup probes: it lists the
      // Assets this attempt may still be retrieving without parsing JSON.
      const frozenAssetIds = snapshot.media
        .map((item) =>
          item !== null && typeof item === "object" && "asset_id" in item ? item.asset_id : null,
        )
        .filter((assetId): assetId is string => typeof assetId === "string");
      const intent =
        operationType === "reconcile"
          ? yield* client.query<{ id: string }>(
              `INSERT INTO provider_operations
               (org_id, distribution_id, operation, idempotency_key, status,
                publication_snapshot, media_hold_until, media_asset_ids)
             VALUES ($1, $2, 'reconcile', $3, 'started', $4::jsonb,
                     now() + ($5 * INTERVAL '1 second'), $6::uuid[])
             ON CONFLICT (distribution_id, operation, idempotency_key)
             DO UPDATE SET status = 'started',
                 attempt_count = provider_operations.attempt_count + 1,
                 error_class = NULL, last_error = NULL,
                 completed_at = NULL,
                 media_hold_until = now() + ($5 * INTERVAL '1 second'),
                 media_asset_ids = EXCLUDED.media_asset_ids,
                 updated_at = now()
             RETURNING id`,
              [
                distribution.org_id,
                distribution.id,
                idempotencyKey(message),
                JSON.stringify(snapshot),
                providerMediaRetrievalLeaseSeconds,
                frozenAssetIds,
              ],
            )
          : yield* client.query<{ id: string }>(
              `INSERT INTO provider_operations
               (org_id, distribution_id, operation, idempotency_key, status,
                publication_snapshot, media_hold_until, media_asset_ids)
             VALUES ($1, $2, $3, $4, 'started', $5::jsonb,
                     now() + ($6 * INTERVAL '1 second'), $7::uuid[])
             ON CONFLICT (distribution_id, operation, idempotency_key)
             DO NOTHING
             RETURNING id`,
              [
                distribution.org_id,
                distribution.id,
                operationType,
                idempotencyKey(message),
                JSON.stringify(snapshot),
                providerMediaRetrievalLeaseSeconds,
                frozenAssetIds,
              ],
            );
      if (intent.rowCount === 1) {
        // Durable protection evidence for every object this attempt may
        // deliver. The hold lives with the attempt and is released only once
        // the attempt is terminal and its reconciliation is done, so deleting
        // the Post or cancelling a pending target can never pull media out from
        // under live Provider retrieval.
        yield* client.query(
          `INSERT INTO provider_operation_media
             (operation_id, org_id, distribution_id, asset_id, brand_profile_id,
              rendition_id, object_id, object_key, position)
           SELECT $1, $2, $3, item.asset_id, $4, item.rendition_id,
                  item.object_id, item.object_key, item.position
           FROM (
             SELECT (item ->> 'position')::integer AS position,
                   (item ->> 'asset_id')::uuid AS asset_id,
                    (item ->> 'rendition_id')::uuid AS rendition_id,
                    (item ->> 'object_id')::uuid AS object_id,
                    item ->> 'object_key' AS object_key
             FROM jsonb_array_elements($5::jsonb) AS item
             WHERE item ->> 'asset_id' IS NOT NULL
               AND item ->> 'object_key' IS NOT NULL
           ) AS item
           ON CONFLICT DO NOTHING`,
          [
            intent.rows[0]!.id,
            distribution.org_id,
            distribution.id,
            distribution.brand_profile_id,
            JSON.stringify(snapshot.media),
          ],
        );
      }
      if (intent.rowCount !== 1) {
        yield* client.query(
          `UPDATE provider_operations
         SET status = 'needs_reconciliation', error_class = 'ambiguous',
             last_error = 'A prior provider operation did not record a durable outcome.',
             updated_at = now(), completed_at = NULL
         WHERE distribution_id = $1 AND operation = $2 AND idempotency_key = $3
           AND status = 'started'`,
          [distribution.id, operationType, idempotencyKey(message)],
        );
        // The conflicting intent proves a prior attempt reached the provider
        // boundary without a durable outcome. The row becomes actionable
        // immediately: a reconcile event is armed in the same transaction and
        // next_attempt_at marks the row due so the scanner re-arms the trigger
        // if this event is ever lost (#256).
        yield* client.query(
          `UPDATE distributions
         SET status = 'needs_reconciliation',
             failure_code = 'provider_outcome_ambiguous',
             failure_retryable = false,
             error_message = 'The provider outcome requires reconciliation.',
             next_attempt_at = now(),
             updated_at = now()
         WHERE id = $1 AND status NOT IN ('published', 'cancelled')`,
          [distribution.id],
        );
        yield* client.query(
          `INSERT INTO outbox_events
           (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES ($1, 'distribution.reconcile.requested', 'distribution', $2, $3, $4)
         ON CONFLICT DO NOTHING`,
          [
            distribution.org_id,
            distribution.id,
            `distribution:${distribution.id}:reconcile:${distribution.reconciliation_attempt_count + 1}`,
            JSON.stringify({ distribution_id: distribution.id, version: 1 }),
          ],
        );
        yield* finishJobLease(client, eventKey(message), "succeeded");
        return { outcome: "skipped" };
      }
      yield* client.query(
        `UPDATE distributions
       SET status = CASE
             WHEN $2 = 'publish' THEN 'processing'
             WHEN $2 = 'cancel' THEN 'cancel_requested'
             ELSE status
           END,
          attempt_count = attempt_count + CASE WHEN $2 = 'publish' THEN 1 ELSE 0 END,
          reconciliation_attempt_count = reconciliation_attempt_count
            + CASE WHEN $2 = 'reconcile' THEN 1 ELSE 0 END,
          last_attempt_at = now(),
          updated_at = now() WHERE id = $1`,
        [distribution.id, operationType],
      );
      return { outcome: "ready", row: distribution, snapshot };
    }),
  );
}

/**
 * Maps a provider operation result into database lifecycle and operation statuses.
 *
 * Distinguishes confirmed failures, ambiguous unknown results, asynchronous started operations
 * ('awaiting_provider'), and confirmed publications ('published').
 *
 * @param result - Provider operation result.
 * @returns Status descriptors for the distribution and provider operation records.
 */
function failureState(result: ProviderOperationResult): {
  code: string | null;
  errorClass: string | null;
  message: string | null;
  operationStatus: "failed" | "needs_reconciliation" | "started" | "succeeded";
  retryable: boolean | null;
  status: "awaiting_provider" | "failed" | "needs_reconciliation" | "published";
} {
  if (result.outcome === "unknown") {
    return {
      code: result.failure.code,
      errorClass: "ambiguous",
      message: result.failure.message,
      operationStatus: "needs_reconciliation",
      retryable: false,
      status: "needs_reconciliation",
    };
  }
  if (result.outcome === "confirmed_failure") {
    return {
      code: result.failure.code,
      errorClass: result.failure.classification,
      message: result.failure.message,
      operationStatus: "failed",
      retryable: result.failure.retryable,
      status: "failed",
    };
  }
  if (!result.providerPostId) {
    return {
      code: null,
      errorClass: null,
      message: null,
      operationStatus: "started",
      retryable: null,
      status: "awaiting_provider",
    };
  }
  return {
    code: null,
    errorClass: null,
    message: null,
    operationStatus: "succeeded",
    retryable: null,
    status: "published",
  };
}

/**
 * Computes an exponential retry backoff delay with jitter within policy bounds.
 *
 * Applies full jitter between 75% and 100% of the exponential interval, bounded by
 * policy maximums and provider retry-after headers.
 *
 * @param policy - Provider adapter retry policy.
 * @param completedAttempts - Number of prior failed attempts.
 * @param random - Random number generator producing a float in [0, 1).
 * @param retryAfter - Minimum delay requested by provider headers in seconds.
 * @returns Delay in seconds, or null if maximum attempts were reached.
 */
function boundedDelaySeconds(
  policy: NonNullable<DistributionPublishExecution["retryPolicy"]>,
  completedAttempts: number,
  random: () => number,
  retryAfter = 0,
): number | null {
  if (completedAttempts >= policy.maxAttempts) return null;
  const sample = random();
  const jitter = Number.isFinite(sample) ? 0.75 + Math.min(1, Math.max(0, sample)) * 0.25 : 0.875;
  const exponential = Math.min(
    policy.maxDelaySeconds,
    policy.baseDelaySeconds * 2 ** Math.max(0, completedAttempts - 1),
  );
  return Math.min(policy.maxDelaySeconds, Math.max(1, Math.ceil(exponential * jitter), retryAfter));
}

/**
 * Computes the retry delay for a failed publication attempt based on provider retry policy.
 *
 * Returns null if the failure was non-retryable or no retry policy is defined.
 *
 * @param execution - Result of the provider publish call.
 * @param completedAttempts - 1-based attempt count.
 * @param random - PRNG function.
 * @returns Delay in seconds, or null if retries should not proceed.
 */
function providerRetryDelaySeconds(
  execution: DistributionPublishExecution,
  completedAttempts: number,
  random: () => number,
): number | null {
  if (
    execution.result.outcome !== "confirmed_failure" ||
    !execution.result.failure.retryable ||
    !execution.retryPolicy
  ) {
    return null;
  }
  return boundedDelaySeconds(
    execution.retryPolicy,
    completedAttempts,
    random,
    execution.result.failure.retryAfterSeconds,
  );
}

/**
 * Dispatches initial background sync triggers for analytics and comments to Cloudflare Queues.
 *
 * Enqueues Analytics immediately after publication; Comment-body collection is
 * emitted only when the deployment explicitly enables recurring collection.
 *
 * @param env - Automation worker environment bindings.
 * @param distributionId - Target distribution UUID.
 * @param analyticsEventId - Minted analytics sync event ID, if assigned.
 * @param commentsEventId - Minted comments sync event ID, if assigned.
 */
async function dispatchInitialEngagementTriggers(
  env: AutomationEnv,
  distributionId: string,
  analyticsEventId: string | null | undefined,
  commentsEventId: string | null | undefined,
): Promise<void> {
  if (analyticsEventId && env.ANALYTICS_QUEUE) {
    try {
      await env.ANALYTICS_QUEUE.sendBatch([
        {
          body: {
            event_id: analyticsEventId,
            request_id: analyticsEventId,
            target_id: distributionId,
            type: "provider.sync",
            version: 1,
            workload: "analytics",
          },
          contentType: "json",
        },
      ]);
    } catch {
      // Retained durably in analytics_sync_event_id; hourly sweep recovers lost sends.
    }
  }
  if (env.RECURRING_COMMENTS_ENABLED === "true" && commentsEventId && env.COMMENTS_QUEUE) {
    try {
      await env.COMMENTS_QUEUE.sendBatch([
        {
          body: {
            event_id: commentsEventId,
            request_id: commentsEventId,
            target_id: distributionId,
            type: "provider.sync",
            version: 1,
            workload: "comments",
          },
          contentType: "json",
        },
      ]);
    } catch {
      // Retained durably in comments_sync_event_id; hourly sweep recovers lost sends.
    }
  }
}

/**
 * Records the results of a publication attempt in provider operations and distributions tables.
 *
 * Updates distribution status (published, awaiting_provider, failed, or needs_reconciliation),
 * schedules retries or poll attempts, stores rate limit budgets, and triggers initial engagement syncs.
 * Reconciliation-eligible outcomes always arm a `distribution.reconcile.requested` trigger
 * and a next-attempt time, even when the provider returned no operation evidence (#256).
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message.
 * @param row - Active distribution row.
 * @param execution - Provider publication execution outcome.
 * @param random - PRNG function.
 * @param transaction - Transaction runner for database operations.
 */
function recordPublishOutcome(
  env: AutomationEnv,
  message: DistributionMessage,
  row: DistributionRow,
  execution: DistributionPublishExecution,
  random: () => number,
  transaction: typeof withSystemTransactionEffect,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const result = execution.result;
    const state = failureState(result);
    const retryDelay = providerRetryDelaySeconds(execution, row.attempt_count + 1, random);
    // Entering `awaiting_provider` starts the fixed-interval provider poll
    // loop; `needs_reconciliation` keeps the publish retry ladder's backoff.
    // Neither arm requires providerOperationId: a missing operation identity is
    // itself the ambiguity the reconcile trigger resolves, so the row always
    // gets a deterministic next attempt instead of stranding (#256).
    const nextAttemptDelay =
      retryDelay ??
      (state.status === "awaiting_provider"
        ? providerPollIntervalSeconds
        : state.status === "needs_reconciliation"
          ? ((execution.retryPolicy && boundedDelaySeconds(execution.retryPolicy, 0, random)) ??
            providerPollIntervalSeconds)
          : null);
    const providerOperationId = result.providerOperationId ?? null;
    const providerPostId =
      result.outcome === "confirmed_success" ? (result.providerPostId ?? null) : null;
    const providerUrl =
      result.outcome === "confirmed_success" ? (result.providerUrl ?? null) : null;
    let analyticsEventId: string | null | undefined;
    let commentsEventId: string | null | undefined;
    yield* transaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `UPDATE provider_operations
       SET status = $4, provider_operation_id = $5, provider_post_id = $6,
           provider_url = $7, error_class = $8, last_error = $9,
           completed_at = CASE WHEN $4 IN ('succeeded', 'failed') THEN now() ELSE NULL END,
           -- The hold always covers a full Provider retrieval window from the
           -- last outcome write: a freshly handed-out URL may still be fetched
           -- for up to that window even after the attempt records terminal
           -- status, and an unresolved attempt needs its media for the poll or
           -- reconciliation that follows.
           media_hold_until = now() + ($10 * INTERVAL '1 second'),
           updated_at = now()
       WHERE distribution_id = $1 AND operation = $2 AND idempotency_key = $3`,
          [
            row.id,
            "publish",
            idempotencyKey(message),
            state.operationStatus,
            providerOperationId,
            providerPostId,
            providerUrl,
            state.errorClass,
            state.message,
            providerMediaRetrievalLeaseSeconds,
          ],
        );
        const updated = yield* client.query<{
          analytics_event_id: string | null;
          comments_event_id: string | null;
          reconciliation_attempt_count: number;
          status: string;
        }>(
          `UPDATE distributions
       SET status = CASE
             WHEN $2 = 'published' THEN 'published'
             WHEN status = 'processing' THEN $2
             ELSE status
           END,
           provider_operation_id = COALESCE($3, provider_operation_id),
           platform_post_id = CASE
             WHEN $2 = 'published' THEN COALESCE($4, platform_post_id)
             ELSE platform_post_id
           END,
           platform_url = CASE
             WHEN $2 = 'published' THEN COALESCE($5, platform_url)
             ELSE platform_url
           END,
           published_at = CASE
             WHEN $2 = 'published' THEN COALESCE(published_at, now())
             ELSE published_at
           END,
           analytics_next_sync_at = CASE
             WHEN $2 = 'published' THEN COALESCE(analytics_next_sync_at, now())
             ELSE analytics_next_sync_at
           END,
           analytics_sync_event_id = CASE
             WHEN $2 = 'published' THEN COALESCE(analytics_sync_event_id, gen_random_uuid())
             ELSE analytics_sync_event_id
           END,
           comments_next_sync_at = CASE
             WHEN $2 = 'published' AND $10::boolean THEN COALESCE(comments_next_sync_at, now())
             ELSE comments_next_sync_at
           END,
           comments_sync_event_id = CASE
             WHEN $2 = 'published' AND $10::boolean THEN COALESCE(comments_sync_event_id, gen_random_uuid())
             ELSE comments_sync_event_id
           END,
           failure_code = CASE
             WHEN $2 = 'published' OR status = 'processing' THEN $6
             ELSE failure_code
           END,
           failure_retryable = CASE
             WHEN $2 = 'published' OR status = 'processing' THEN $7
             ELSE failure_retryable
           END,
           error_message = CASE
             WHEN $2 = 'published' OR status = 'processing' THEN $8
             ELSE error_message
           END,
           reconciliation_attempt_count = CASE
             WHEN $2 = 'published' OR status = 'processing' THEN 0
             ELSE reconciliation_attempt_count
           END,
           provider_poll_attempts = CASE
             WHEN $2 = 'awaiting_provider' AND status = 'processing' THEN 0
             ELSE provider_poll_attempts
           END,
           next_attempt_at = CASE
             WHEN $2 = 'published' THEN NULL
             WHEN status = 'processing' AND $9::integer IS NULL THEN NULL
             WHEN status = 'processing' THEN now() + ($9 * INTERVAL '1 second')
             ELSE next_attempt_at
           END,
           updated_at = now()
       WHERE id = $1
         AND status IN ('processing', 'cancel_requested', 'needs_reconciliation')
       RETURNING analytics_sync_event_id::text AS analytics_event_id,
                 comments_sync_event_id::text AS comments_event_id,
                 reconciliation_attempt_count, status`,
          [
            row.id,
            state.status,
            providerOperationId,
            providerPostId,
            providerUrl,
            state.code,
            state.retryable,
            state.message,
            nextAttemptDelay,
            env.RECURRING_COMMENTS_ENABLED === "true",
          ],
        );
        analyticsEventId = updated.rows[0]?.analytics_event_id;
        commentsEventId = updated.rows[0]?.comments_event_id;
        const updatedRow = updated.rows[0];
        if (row.platform_user_id !== null) {
          const budget =
            result.metadata?.rateLimitBudget ??
            (result.outcome === "confirmed_failure" &&
            result.failure.classification === "rate_limit"
              ? {
                  percentUsed: 100,
                  remaining: 0,
                  resetsInSeconds: result.failure.retryAfterSeconds ?? null,
                }
              : null);
          if (budget) {
            yield* recordRateLimitBudget(client, row.platform, row.platform_user_id, budget);
          }
        }
        // Every reconciliation-eligible outcome leaves its trigger armed in the
        // same transaction that records it, so a lost Queue delivery can never
        // strand the row. The dedupe key uses the post-update attempt count so
        // it matches the Due scanner's `reconcile:<attempt>` numbering: a
        // scanner re-arm dedupes against this event instead of double-arming
        // (#256). Rows that stayed cancel_requested or terminal gain no
        // trigger.
        if (
          nextAttemptDelay !== null &&
          updatedRow !== undefined &&
          (updatedRow.status === "awaiting_provider" ||
            updatedRow.status === "needs_reconciliation")
        ) {
          yield* client.query(
            `INSERT INTO outbox_events
           (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES ($1, 'distribution.reconcile.requested', 'distribution', $2, $3, $4)
         ON CONFLICT DO NOTHING`,
            [
              row.org_id,
              row.id,
              `distribution:${row.id}:reconcile:${updatedRow.reconciliation_attempt_count + 1}`,
              JSON.stringify({ distribution_id: row.id, version: 1 }),
            ],
          );
        }
        yield* finishJobLease(client, eventKey(message), "succeeded");
      }),
    );
    if (state.status === "published") {
      yield* Effect.promise(() =>
        dispatchInitialEngagementTriggers(env, row.id, analyticsEventId, commentsEventId),
      );
    }
  });
}

/**
 * Flags a distribution cancel operation as requiring reconciliation when no adapter cancel method exists.
 *
 * Updates provider operations and distributions to 'needs_reconciliation', clearing active leases.
 * The row is made immediately actionable — next_attempt_at = now() plus a
 * reconcile trigger armed in the same transaction — so the unresolved cancel
 * can never strand without a next attempt (#256).
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message.
 * @param row - Active distribution row.
 * @param transaction - Transaction runner for database operations.
 */
function markCancelNeedsReconciliation(
  env: AutomationEnv,
  message: DistributionMessage,
  row: DistributionRow,
  transaction: typeof withSystemTransactionEffect,
): Effect.Effect<void, DatabaseError> {
  return transaction(env, (client) =>
    Effect.gen(function* () {
      yield* client.query(
        `UPDATE provider_operations
       SET status = 'needs_reconciliation', error_class = 'ambiguous',
           last_error = 'No accepted provider cancellation adapter is configured.',
           -- An unresolved cancel still needs its media for the reconciliation
           -- that follows, so the retrieval-window hold is refreshed.
           media_hold_until = now() + ($3 * INTERVAL '1 second'),
           updated_at = now()
       WHERE distribution_id = $1 AND operation = 'cancel' AND idempotency_key = $2`,
        [row.id, idempotencyKey(message), providerMediaRetrievalLeaseSeconds],
      );
      yield* client.query(
        `UPDATE distributions
       SET status = 'needs_reconciliation',
           failure_code = 'provider_cancel_unavailable',
           failure_retryable = false,
           error_message = 'Cancellation requires provider reconciliation.',
           next_attempt_at = now(),
           updated_at = now()
       WHERE id = $1 AND status = 'cancel_requested'`,
        [row.id],
      );
      // Arm the reconcile trigger with the scanner's `reconcile:<attempt>`
      // dedupe key so a scanner re-arm dedupes against this event (#256).
      yield* client.query(
        `INSERT INTO outbox_events
       (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
       VALUES ($1, 'distribution.reconcile.requested', 'distribution', $2, $3, $4)
       ON CONFLICT DO NOTHING`,
        [
          row.org_id,
          row.id,
          `distribution:${row.id}:reconcile:${row.reconciliation_attempt_count + 1}`,
          JSON.stringify({ distribution_id: row.id, version: 1 }),
        ],
      );
      yield* finishJobLease(client, eventKey(message), "succeeded");
    }),
  );
}

/**
 * Records the outcome of a provider publication cancellation attempt.
 *
 * Updates the distribution status to 'cancelled' if confirmed, or 'needs_reconciliation' if ambiguous or failed.
 * An unresolved cancel is made immediately actionable — next_attempt_at =
 * now() plus a reconcile trigger armed in the same transaction — so it can
 * never strand without a next attempt (#256).
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message.
 * @param row - Active distribution row.
 * @param execution - Cancellation execution outcome from the provider adapter.
 * @param transaction - Transaction runner for database operations.
 */
function recordCancelOutcome(
  env: AutomationEnv,
  message: DistributionMessage,
  row: DistributionRow,
  execution: DistributionPublishExecution,
  transaction: typeof withSystemTransactionEffect,
): Effect.Effect<void, DatabaseError> {
  const result = execution.result;
  const confirmed = result.outcome === "confirmed_success";
  const failure = confirmed ? null : result.failure;
  return transaction(env, (client) =>
    Effect.gen(function* () {
      yield* client.query(
        `UPDATE provider_operations
       SET status = $3, provider_operation_id = $4,
           provider_post_id = $5, provider_url = $6,
           error_class = $7, last_error = $8,
           completed_at = CASE WHEN $3 IN ('succeeded', 'failed') THEN now() ELSE NULL END,
           -- The cancel outcome itself does not prove the Provider stopped
           -- fetching the published objects, so the hold always covers a full
           -- retrieval window; a follow-up reconciliation can then still
           -- replay the frozen media while that window is open.
           media_hold_until = now() + ($9 * INTERVAL '1 second'),
           updated_at = now()
       WHERE distribution_id = $1 AND operation = 'cancel' AND idempotency_key = $2`,
        [
          row.id,
          idempotencyKey(message),
          confirmed
            ? "succeeded"
            : result.outcome === "unknown"
              ? "needs_reconciliation"
              : "failed",
          result.providerOperationId ?? null,
          result.outcome === "confirmed_success" ? (result.providerPostId ?? null) : null,
          result.outcome === "confirmed_success" ? (result.providerUrl ?? null) : null,
          failure?.classification ?? null,
          failure?.message ?? null,
          providerMediaRetrievalLeaseSeconds,
        ],
      );
      yield* client.query(
        `UPDATE distributions
       SET status = $2, failure_code = $3,
           failure_retryable = CASE WHEN $2 = 'cancelled' THEN NULL ELSE false END,
           error_message = $4,
           next_attempt_at = CASE WHEN $2 = 'cancelled' THEN NULL ELSE now() END,
           updated_at = now()
       WHERE id = $1 AND status = 'cancel_requested'`,
        [
          row.id,
          confirmed ? "cancelled" : "needs_reconciliation",
          failure?.code ?? null,
          failure?.message ?? null,
        ],
      );
      // An unresolved cancel arms its reconcile trigger with the scanner's
      // `reconcile:<attempt>` dedupe key so a scanner re-arm dedupes against
      // this event (#256).
      if (!confirmed) {
        yield* client.query(
          `INSERT INTO outbox_events
         (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES ($1, 'distribution.reconcile.requested', 'distribution', $2, $3, $4)
         ON CONFLICT DO NOTHING`,
          [
            row.org_id,
            row.id,
            `distribution:${row.id}:reconcile:${row.reconciliation_attempt_count + 1}`,
            JSON.stringify({ distribution_id: row.id, version: 1 }),
          ],
        );
      }
      yield* finishJobLease(client, eventKey(message), "succeeded");
    }),
  );
}

/**
 * Computes normalized distribution and operation state descriptors from a status lookup execution.
 *
 * Distinguishes published posts, ongoing processing ('awaiting_provider'), confirmed failures,
 * ambiguous unknown states, and not-found responses. A lookup failure caused by missing
 * provider evidence is terminal `failed` — it can never resolve (#256).
 *
 * @param execution - Distribution lookup execution result.
 * @returns State mapping including status, errors, provider IDs, and polling flags.
 */
function reconciliationState(execution: DistributionLookupExecution): {
  code: string | null;
  errorClass: string | null;
  message: string | null;
  operationStatus: "failed" | "needs_reconciliation" | "succeeded";
  providerOperationId: string | null;
  providerPostId: string | null;
  providerUrl: string | null;
  retryable: boolean | null;
  shouldPoll: boolean;
  status: "awaiting_provider" | "failed" | "needs_reconciliation" | "published";
} {
  if (execution.result.kind === "lookup_failure") {
    const { failure } = execution.result;
    // A lookup with no usable provider evidence can never resolve, so it is a
    // terminal failure rather than another reconciliation round-trip; other
    // lookup failures stay reconciliation-eligible while they are retryable
    // (#256).
    const evidenceMissing = failure.code === "provider_lookup_evidence_unavailable";
    return {
      code: failure.code,
      errorClass: failure.classification,
      message: failure.message,
      operationStatus: evidenceMissing ? "failed" : "needs_reconciliation",
      providerOperationId: null,
      providerPostId: null,
      providerUrl: null,
      retryable: false,
      shouldPoll: !evidenceMissing && failure.retryable,
      status: evidenceMissing ? "failed" : "needs_reconciliation",
    };
  }
  const { status } = execution.result;
  switch (status.state) {
    case "processing":
      return {
        code: null,
        errorClass: null,
        message: null,
        operationStatus: "succeeded",
        providerOperationId: status.providerOperationId,
        providerPostId: null,
        providerUrl: null,
        retryable: null,
        shouldPoll: true,
        status: "awaiting_provider",
      };
    case "published":
      return {
        code: null,
        errorClass: null,
        message: null,
        operationStatus: "succeeded",
        providerOperationId: status.result.providerOperationId ?? null,
        providerPostId: status.result.providerPostId ?? null,
        providerUrl: status.result.providerUrl ?? null,
        retryable: null,
        shouldPoll: false,
        status: "published",
      };
    case "failed":
      return {
        code: status.result.failure.code,
        errorClass: status.result.failure.classification,
        message: status.result.failure.message,
        operationStatus: "succeeded",
        providerOperationId: status.result.providerOperationId ?? null,
        providerPostId: null,
        providerUrl: null,
        retryable: status.result.failure.retryable,
        shouldPoll: false,
        status: "failed",
      };
    case "unknown":
      return {
        code: status.result.failure.code,
        errorClass: "ambiguous",
        message: status.result.failure.message,
        operationStatus: "needs_reconciliation",
        providerOperationId: status.result.providerOperationId ?? null,
        providerPostId: null,
        providerUrl: null,
        retryable: false,
        shouldPoll: true,
        status: "needs_reconciliation",
      };
    case "not_found":
      return {
        code: "provider_publication_not_found",
        errorClass: "deterministic",
        message: "The provider publication could not be found.",
        operationStatus: "succeeded",
        providerOperationId: null,
        providerPostId: null,
        providerUrl: null,
        retryable: false,
        shouldPoll: true,
        status: "needs_reconciliation",
      };
  }
}

/**
 * Records the results of a provider reconciliation lookup in the database.
 *
 * Enforces provider poll budgets for ongoing processing and the shared
 * reconciliation attempt ceiling for unresolved outcomes, schedules retries or
 * poll attempts, and makes exhausted budgets, missing provider evidence, and
 * non-retryable lookup failures terminal `failed` states so no row strands
 * without a next attempt (#256).
 * Stores rate limit budgets and triggers initial engagement syncs if published.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message.
 * @param row - Active distribution row.
 * @param execution - Provider status lookup execution result.
 * @param random - PRNG function.
 * @param transaction - Transaction runner for database operations.
 */
function recordReconciliationOutcome(
  env: AutomationEnv,
  message: DistributionMessage,
  row: DistributionRow,
  execution: DistributionLookupExecution,
  random: () => number,
  transaction: typeof withSystemTransactionEffect,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const state = reconciliationState(execution);
    // A Provider that is still assembling the publication is polled on a fixed
    // interval against its own budget: the wait is the Provider's processing
    // time, not a failure to back off from. Exhausting the poll budget is a
    // terminal failure — the row must not wait for reconciliation forever
    // (#256).
    const providerStillProcessing = state.status === "awaiting_provider";
    const pollBudgetExhausted =
      providerStillProcessing && row.provider_poll_attempts >= maximumProviderPollAttempts - 1;
    // Reconciliation re-arms only while the adapter's retry policy still has
    // budget and the shared reconciliation attempt ceiling has room for the
    // next attempt. Every other unresolved outcome — including a non-retryable
    // lookup failure that can never be rearmed — is terminal `failed` with the
    // provider's safe code so the row can never strand in needs_reconciliation
    // without a next attempt or loop reconciliation indefinitely (#256).
    const rearmDelay =
      !providerStillProcessing &&
      state.status === "needs_reconciliation" &&
      state.shouldPoll &&
      execution.retryPolicy
        ? boundedDelaySeconds(execution.retryPolicy, row.reconciliation_attempt_count + 1, random)
        : null;
    const reconciliationBudgetExhausted =
      !providerStillProcessing &&
      state.status === "needs_reconciliation" &&
      (rearmDelay === null ||
        row.reconciliation_attempt_count + 1 >= maximumReconciliationAttempts);
    const outcome = pollBudgetExhausted
      ? {
          code: "provider_poll_budget_exhausted",
          message: "The provider did not confirm the publication within its poll window.",
          retryable: false,
          status: "failed" as const,
        }
      : reconciliationBudgetExhausted
        ? {
            code: state.code ?? "reconciliation_attempts_exhausted",
            message:
              state.message ??
              "The provider outcome could not be confirmed within the reconciliation budget.",
            retryable: false,
            status: "failed" as const,
          }
        : {
            code: state.code,
            message: state.message,
            retryable: state.retryable,
            status: state.status,
          };
    const nextAttemptDelay =
      providerStillProcessing && !pollBudgetExhausted
        ? providerPollIntervalSeconds
        : rearmDelay !== null && !reconciliationBudgetExhausted
          ? rearmDelay
          : null;
    let analyticsEventId: string | null | undefined;
    let commentsEventId: string | null | undefined;
    yield* transaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `UPDATE provider_operations
       SET status = $3, provider_operation_id = $4,
           provider_post_id = $5, provider_url = $6,
           error_class = $7, last_error = $8,
           completed_at = CASE WHEN $3 IN ('succeeded', 'failed') THEN now() ELSE NULL END,
           -- Reconciliation cannot prove the Provider's final retrieval has
           -- finished, so every outcome — published, failed, or still
           -- outstanding — re-arms the full retrieval window. Cleanup relies
           -- on that expiry rather than on operation status.
           media_hold_until = now() + ($9 * INTERVAL '1 second'),
           updated_at = now()
       WHERE distribution_id = $1 AND operation = 'reconcile'
         AND idempotency_key = $2`,
          [
            row.id,
            idempotencyKey(message),
            state.operationStatus,
            state.providerOperationId ?? row.provider_operation_id,
            state.providerPostId,
            state.providerUrl,
            state.errorClass,
            state.message,
            providerMediaRetrievalLeaseSeconds,
          ],
        );
        const updated = yield* client.query<{
          analytics_event_id: string | null;
          comments_event_id: string | null;
          reconciliation_attempt_count: number;
          status: string;
        }>(
          `UPDATE distributions
         SET status = CASE WHEN status = 'cancel_requested' THEN status ELSE $2 END,
             provider_operation_id = COALESCE($3, provider_operation_id),
             platform_post_id = COALESCE($4, platform_post_id),
             platform_url = COALESCE($5, platform_url),
             published_at = CASE
               WHEN $2 = 'published' THEN COALESCE(published_at, now())
               ELSE published_at
             END,
             analytics_next_sync_at = CASE
               WHEN $2 = 'published' THEN COALESCE(analytics_next_sync_at, now())
               ELSE analytics_next_sync_at
             END,
             analytics_sync_event_id = CASE
               WHEN $2 = 'published' THEN COALESCE(analytics_sync_event_id, gen_random_uuid())
               ELSE analytics_sync_event_id
             END,
             comments_next_sync_at = CASE
               WHEN $2 = 'published' AND $11::boolean THEN COALESCE(comments_next_sync_at, now())
               ELSE comments_next_sync_at
             END,
             comments_sync_event_id = CASE
               WHEN $2 = 'published' AND $11::boolean THEN COALESCE(comments_sync_event_id, gen_random_uuid())
               ELSE comments_sync_event_id
             END,
             failure_code = CASE WHEN status = 'cancel_requested' THEN failure_code ELSE $6 END,
             failure_retryable = CASE WHEN status = 'cancel_requested' THEN failure_retryable ELSE $7 END,
             error_message = CASE WHEN status = 'cancel_requested' THEN error_message ELSE $8 END,
             provider_poll_attempts = CASE
               WHEN $10::boolean AND status <> 'cancel_requested'
                 THEN provider_poll_attempts + 1
               ELSE provider_poll_attempts
             END,
             next_attempt_at = CASE
               WHEN status = 'cancel_requested' OR $9::integer IS NULL THEN NULL
               ELSE now() + ($9 * INTERVAL '1 second')
             END,
             updated_at = now()
         WHERE id = $1
           AND status IN ('awaiting_provider', 'needs_reconciliation', 'cancel_requested')
         RETURNING analytics_sync_event_id::text AS analytics_event_id,
                   comments_sync_event_id::text AS comments_event_id,
                   reconciliation_attempt_count, status`,
          [
            row.id,
            outcome.status,
            state.providerOperationId,
            state.providerPostId,
            state.providerUrl,
            outcome.code,
            outcome.retryable,
            outcome.message,
            nextAttemptDelay,
            providerStillProcessing,
            env.RECURRING_COMMENTS_ENABLED === "true",
          ],
        );
        analyticsEventId = updated.rows[0]?.analytics_event_id;
        commentsEventId = updated.rows[0]?.comments_event_id;
        const updatedRow = updated.rows[0];
        if (row.platform_user_id !== null && execution.metadata?.rateLimitBudget) {
          yield* recordRateLimitBudget(
            client,
            row.platform,
            row.platform_user_id,
            execution.metadata.rateLimitBudget,
          );
        }
        // Re-arm the next reconcile trigger only when the row actually moved
        // to a reconciliation-eligible state; a concurrent cancel or terminal
        // transition must not gain a trigger. The dedupe key uses the
        // post-update attempt count so it matches the Due scanner's
        // `reconcile:<attempt>` numbering — a scanner re-arm dedupes against
        // this event instead of claiming an independent budget slot (#256).
        if (
          nextAttemptDelay !== null &&
          updatedRow !== undefined &&
          (updatedRow.status === "awaiting_provider" ||
            updatedRow.status === "needs_reconciliation")
        ) {
          yield* client.query(
            `INSERT INTO outbox_events
           (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES ($1, 'distribution.reconcile.requested', 'distribution', $2, $3, $4)
         ON CONFLICT DO NOTHING`,
            [
              row.org_id,
              row.id,
              `distribution:${row.id}:reconcile:${updatedRow.reconciliation_attempt_count + 1}`,
              JSON.stringify({ distribution_id: row.id, version: 1 }),
            ],
          );
        }
        yield* finishJobLease(client, eventKey(message), "succeeded");
      }),
    );
    if (outcome.status === "published") {
      yield* Effect.promise(() =>
        dispatchInitialEngagementTriggers(env, row.id, analyticsEventId, commentsEventId),
      );
    }
  });
}
/**
 * Atomically persists a just-in-time token rotation for a publish target's
 * platform account (#256).
 *
 * Encrypts the rotated access/refresh tokens and commits them with the new
 * expiry (or NULL when omitted), `connected` status, a reset refresh-attempt state, and the next
 * background refresh arm (`max(now + 1h, expiresAt - 7d)`, matching the
 * background refresh cadence, or NULL when expiry is absent) in a single guarded UPDATE. The
 * `token_expires_at IS NOT DISTINCT FROM` guard makes the write conditional on
 * the credential snapshot the publish read: a concurrent rotation that already
 * committed yields zero rows and resolves false, so the caller must not publish
 * with credentials it could not persist. A revoked account is never resurrected.
 *
 * @param env - Automation worker environment bindings.
 * @param transaction - Transaction runner for database operations.
 * @param expectedTokenExpiresAt - Token expiry the publish target was read with.
 * @param now - Reference timestamp for the next-attempt arm.
 * @param rotation - Plaintext rotated token set from the provider refresh.
 * @returns Promise resolving true when the rotation committed, false on a lost race.
 */
function persistRotatedTokens(
  env: AutomationEnv,
  transaction: typeof withSystemTransactionEffect,
  expectedTokenExpiresAt: Date | string | null,
  now: Date,
  rotation: {
    accessToken: string;
    expiresAt?: string;
    platformAccountId: string;
    refreshToken?: string;
    scopes: string[];
  },
): Promise<boolean> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const cipher = tokenCipherFor(env);
      const accessToken = yield* Effect.promise(() => cipher.encrypt(rotation.accessToken));
      const refreshToken = rotation.refreshToken
        ? yield* Effect.promise(() => cipher.encrypt(rotation.refreshToken!))
        : null;
      const expiresAt = rotation.expiresAt !== undefined ? new Date(rotation.expiresAt) : null;
      const nextAttemptAt =
        expiresAt !== null
          ? new Date(Math.max(now.getTime() + 3_600_000, expiresAt.getTime() - 7 * 86_400_000))
          : null;
      const updated = yield* transaction(env, (client) =>
        client.query(
          `UPDATE platform_accounts
             SET access_token = $2, refresh_token = COALESCE($3, refresh_token),
                 token_expires_at = $4,
                 scopes = COALESCE($5::text[], scopes),
                 connection_status = 'connected', last_synced_at = now(),
                 token_refresh_event_id = NULL,
                 token_refresh_lease_expires_at = NULL,
                 token_refresh_next_attempt_at = $6::timestamptz,
                 token_refresh_attempt_count = 0,
                 token_refresh_last_error = NULL,
                 reconnect_notified_at = NULL, updated_at = now()
             WHERE id = $1
               AND connection_status <> 'revoked'
               AND token_expires_at IS NOT DISTINCT FROM $7::timestamptz`,
          [
            rotation.platformAccountId,
            accessToken,
            refreshToken,
            expiresAt,
            rotation.scopes.length > 0 ? rotation.scopes : null,
            nextAttemptAt,
            expectedTokenExpiresAt,
          ],
        ),
      );
      return updated.rowCount === 1;
    }),
  );
}

/**
 * Main queue consumer handler for processing distribution outbox messages.
 *
 * Coordinates execution of 'publish', 'cancel', and 'reconcile' distribution operations.
 * Claims distributed job leases, decrypts tokens, calls platform provider adapters,
 * updates database state machines, and dispatches follow-up engagement or polling tasks.
 * Composes provider IO with persistence in the calling job fiber; persistence
 * rejections and lease deferrals surface as typed AutomationJobError failures
 * (ProviderAdapterError stays in the declared channel for provider throws),
 * which the job boundary classifies into ack/retry/DLQ handling.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Outbox message from the queue.
 * @param dependencies - Optional dependency overrides for testing (credentials, media resolver, time, registry).
 * @returns Effect producing 'processed' or 'skipped'; fails with RetryableJobError on active leases or classified persistence errors.
 */
export function processDistributionMessage(
  env: AutomationEnv,
  message: DistributionMessage,
  dependencies: DistributionProcessingDependencies = {},
): Effect.Effect<"processed" | "skipped", AutomationJobError | ProviderAdapterError> {
  return Effect.gen(function* () {
    if (!isOutboxMessage(message)) return "skipped" as const;
    const operationType = operation(message);
    if (!operationType) return "skipped" as const;
    const transaction = dependencies.transaction ?? withSystemTransactionEffect;
    // The registry is resolved lazily and shared: claim needs its capability to
    // freeze a deliverable object, and the publish path needs the same graph.
    // Building it on first use keeps an environment whose provider
    // configuration is unusable from failing the claim itself — the attempt is
    // still recorded, and the failure surfaces on the Provider path.
    let built: ProviderRegistry | undefined;
    const registry = (): ProviderRegistry =>
      (built ??= dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env));
    const prepared = yield* prepare(
      env,
      message,
      operationType,
      transaction,
      dependencies.now?.() ?? new Date(),
      (platform) => registry().get(platform)?.capability ?? null,
    ).pipe(Effect.mapError(classifyJobError));
    if (prepared.outcome === "deferred") {
      return yield* Effect.fail(
        new RetryableJobError({
          message: "distribution event lease is still active",
        }),
      );
    }
    if (prepared.outcome === "skipped") return "skipped" as const;
    const { row, snapshot } = prepared;
    const providers = registry();
    if (operationType === "reconcile") {
      const execution = yield* Effect.provide(
        executeProviderLookupEffect(
          providers,
          {
            operationId: idempotencyKey(message),
            requestId: message.request_id ?? message.event_id,
          },
          {
            connectionStatus: row.connection_status ?? "unavailable",
            // Reconciliation replays the bytes the publish attempt froze, so a
            // Post edited or un-attached since then cannot break a Provider
            // upload that is still resuming (#256).
            media: frozenMediaEntries(snapshot),
            platform: row.platform,
            providerAccountId: row.platform_user_id ?? undefined,
            providerOperationId: row.provider_operation_id,
            providerPostId: row.platform_post_id,
            storedAccessToken: row.access_token ?? "",
            tokenExpiresAt: row.token_expires_at === null ? null : new Date(row.token_expires_at),
          },
          {
            decryptToken: dependencies.decryptToken ?? decryptStoredToken(env),
            // The resolver lets a resumable-capable adapter replay the original
            // Asset bytes so a persisted upload session resumes in place (#256).
            mediaFor: dependencies.mediaFor ?? createProviderMediaResolver(env),
          },
          dependencies.now?.() ?? new Date(),
        ),
        createProviderServiceLive(providers),
      );
      yield* recordReconciliationOutcome(
        env,
        message,
        row,
        execution,
        dependencies.random ?? Math.random,
        transaction,
      ).pipe(Effect.mapError(classifyJobError));
      return "processed" as const;
    }
    if (operationType === "cancel") {
      if (!providers.get(row.platform)?.cancelPublication) {
        yield* markCancelNeedsReconciliation(env, message, row, transaction).pipe(
          Effect.mapError(classifyJobError),
        );
        return "processed" as const;
      }
      const execution = yield* Effect.provide(
        executeProviderCancelEffect(
          providers,
          {
            operationId: idempotencyKey(message),
            requestId: message.request_id ?? message.event_id,
          },
          {
            connectionStatus: row.connection_status ?? "unavailable",
            platform: row.platform,
            providerAccountId: row.platform_user_id ?? undefined,
            providerOperationId: row.provider_operation_id,
            providerPostId: row.platform_post_id,
            storedAccessToken: row.access_token ?? "",
            tokenExpiresAt: row.token_expires_at === null ? null : new Date(row.token_expires_at),
          },
          {
            decryptToken: dependencies.decryptToken ?? decryptStoredToken(env),
          },
          dependencies.now?.() ?? new Date(),
        ),
        createProviderServiceLive(providers),
      );
      yield* recordCancelOutcome(env, message, row, execution, transaction).pipe(
        Effect.mapError(classifyJobError),
      );
      return "processed" as const;
    }
    const now = dependencies.now?.() ?? new Date();
    const execution = yield* Effect.provide(
      executeProviderPublishEffect(
        providers,
        {
          operationId: idempotencyKey(message),
          requestId: message.request_id ?? message.event_id,
        },
        {
          connectionStatus: row.connection_status ?? "unavailable",
          hashtags: snapshot.content.hashtags,
          idempotencyKey: idempotencyKey(message),
          // Content and media both come from the snapshot written when this
          // attempt claimed its work, never from live Post state.
          media: frozenMediaEntries(snapshot),
          platform: row.platform,
          platformAccountId: row.platform_account_id ?? undefined,
          postId: row.post_id,
          providerAccountId: row.platform_user_id ?? undefined,
          providerOptions: snapshot.content.provider_options,
          storedAccessToken: row.access_token ?? "",
          storedRefreshToken: row.refresh_token,
          textContent: snapshot.content.text,
          title: snapshot.content.title,
          tokenExpiresAt: row.token_expires_at === null ? null : new Date(row.token_expires_at),
        },
        {
          decryptToken: dependencies.decryptToken ?? decryptStoredToken(env),
          mediaFor: dependencies.mediaFor ?? createProviderMediaResolver(env),
          persistRefreshedTokens:
            dependencies.persistRefreshedTokens ??
            ((rotation) =>
              persistRotatedTokens(env, transaction, row.token_expires_at, now, rotation)),
        },
        now,
      ),
      createProviderServiceLive(providers),
    );
    yield* recordPublishOutcome(
      env,
      message,
      row,
      execution,
      dependencies.random ?? Math.random,
      transaction,
    ).pipe(Effect.mapError(classifyJobError));
    return "processed" as const;
  });
}

/**
 * Scans and enqueues due distributions for publication or scheduled reconciliation.
 *
 * Claims a bounded batch of distributions that are scheduled, failed with retryable flag,
 * awaiting provider poll, due for reconciliation, or stalled in processing past the
 * grace period. Stalled processing rows transition to `needs_reconciliation` and arm
 * `distribution.reconcile.requested` — never a second publish (#256).
 *
 * @param env - Automation worker environment bindings.
 * @param limit - Maximum number of distributions to claim (defaults to 100).
 * @param stalledGraceSeconds - Grace period for stalled processing recovery (defaults to 300s).
 * @returns Effect producing the number of distributions claimed and transitioned; fails with a classified AutomationJobError.
 */
export function enqueueDueDistributions(
  env: AutomationEnv,
  limit = 100,
  stalledGraceSeconds = distributionProcessingGraceSeconds,
): Effect.Effect<number, AutomationJobError> {
  return claimDueOutboxWork(env, "distribution", limit, [stalledGraceSeconds]);
}

/**
 * Sweeps scheduled distributions within the delayed delivery horizon that lack armed outbox commands.
 *
 * Recovers lost delayed delivery triggers or schedules near-term publications ahead of time.
 *
 * @param env - Automation worker environment bindings.
 * @param limit - Maximum number of distributions to claim (defaults to 100).
 * @param overdueGraceSeconds - Grace duration before an un-triggered scheduled distribution is deemed overdue.
 * @param horizonSeconds - Maximum delayed delivery horizon supported by Cloudflare Queues.
 * @returns Effect producing the number of swept distributions armed with outbox commands; fails with a classified AutomationJobError.
 */
export function sweepDueDistributions(
  env: AutomationEnv,
  limit = 100,
  overdueGraceSeconds = overdueRecoveryGraceSeconds,
  horizonSeconds = maximumDelayedDeliverySeconds,
): Effect.Effect<number, AutomationJobError> {
  return claimDueOutboxWork(env, "distribution_sweep", limit, [
    overdueGraceSeconds,
    horizonSeconds,
  ]);
}
