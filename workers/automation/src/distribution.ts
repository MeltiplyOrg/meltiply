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
import { errorDiagnostic, log } from "@meltiply/observability";
import {
  isPlatform,
  isProviderFailureClass,
  recordPublicationUsage,
  reportingConfiguration,
} from "@meltiply/reporting";

import { withSystemTransactionEffect } from "./database";
import { recordDiagnostic } from "./diagnostic-reporting";
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
import { armDistributionReconcile, armOutboxCommand, outboxDedupeKey } from "./outbox-commands";
import { decryptStoredToken, tokenCipherFor } from "./provider-credentials";
import { isOutboxMessage, providerSyncMessage, type OutboxMessage } from "./messages";
import { nextDelaySeconds } from "./retry-policy";

type DistributionMessage = OutboxMessage;

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
  signature_text: string | null;
  status: string;
  attempt_count: number;
  title_override: string | null;
  token_expires_at: Date | string | null;
}

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

function eventKey(message: DistributionMessage): string {
  return `outbox:${message.event_id}`;
}

type DistributionOperation = "cancel" | "publish" | "reconcile";

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

function idempotencyKey(message: DistributionMessage): string {
  return `queue:${message.event_id}`;
}

const rateLimitRemainingThreshold = 5;
const rateLimitPercentThreshold = 90;
const rateLimitMaxParkSeconds = 3_600;
const rateLimitUnknownResetParkSeconds = 60;

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

function frozenCandidate(
  entry: DistributionMediaEntry,
  capability: PlatformCapability | null,
): DistributionMediaCandidate | null {
  if (!capability) return null;
  return entry.candidates.find((candidate) => candidateDeliversTo(capability, candidate)) ?? null;
}

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

interface PublicationSnapshot {
  content: {
    hashtags: string[];
    provider_options?: ProviderPublishOptions;
    signature?: string | null;
    text: string;
    title: string;
  };
  media: FrozenMediaItem[];
  post_id: string;
  version: 1;
}

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
      signature: row.signature_text ?? null,
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
                distribution.signature_text,
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
      const dueScheduledPublish =
        distribution !== undefined &&
        distribution.status === "scheduled" &&
        distribution.scheduled_at !== null &&
        new Date(distribution.scheduled_at).getTime() <= now.getTime();
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
        yield* armOutboxCommand(client, {
          aggregateId: distribution.id,
          aggregateType: "distribution",
          dedupeKey: outboxDedupeKey.distributionRateLimitPark(distribution.id, message.event_id),
          onConflict: "nothing",
          orgId: distribution.org_id,
          payload: { distribution_id: distribution.id, version: 1 },
          topic: "distribution.publish.requested",
        });
        yield* finishJobLease(client, eventKey(message), "skipped");
        return { outcome: "skipped" };
      }
      const selectedAttachmentIds = distribution.attachment_ids;
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
      const snapshot =
        operationType === "publish"
          ? publicationSnapshot(distribution, capabilityFor(distribution.platform))
          : yield* frozenSnapshotFor(client, distribution.id);
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
        yield* client.query(
          `UPDATE distributions
         SET status = 'needs_reconciliation',
             failure_code = 'provider_outcome_ambiguous',
             failure_retryable = false,
             error_message = 'The provider outcome requires reconciliation.',
             next_attempt_at = now(),
             updated_at = now()
         WHERE id = $1 AND status NOT IN ('delivered', 'published', 'cancelled')`,
          [distribution.id],
        );
        yield* armDistributionReconcile(client, {
          completedAttempts: distribution.reconciliation_attempt_count,
          distributionId: distribution.id,
          orgId: distribution.org_id,
        });
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

function failureState(result: ProviderOperationResult): {
  code: string | null;
  errorClass: string | null;
  message: string | null;
  operationStatus: "failed" | "needs_reconciliation" | "started" | "succeeded";
  retryable: boolean | null;
  status: "awaiting_provider" | "delivered" | "failed" | "needs_reconciliation" | "published";
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
  if (result.delivery) {
    return {
      code: null,
      errorClass: null,
      message: null,
      operationStatus: "succeeded",
      retryable: null,
      status: "delivered",
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

function boundedDelaySeconds(
  policy: NonNullable<DistributionPublishExecution["retryPolicy"]>,
  completedAttempts: number,
  random: () => number,
  retryAfter = 0,
): number | null {
  return nextDelaySeconds(
    {
      attemptBase: 1,
      baseSeconds: policy.baseDelaySeconds,
      clampBeforeJitter: true,
      jitter: "quarter",
      maxAttempts: policy.maxAttempts,
      maxSeconds: policy.maxDelaySeconds,
    },
    completedAttempts,
    { random, retryAfterSeconds: retryAfter },
  );
}

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

async function dispatchInitialEngagementTriggers(
  env: AutomationEnv,
  distributionId: string,
  analyticsEventId: string | null | undefined,
  commentsEventId: string | null | undefined,
): Promise<void> {
  const sendTrigger = async (
    queue: Queue<unknown> | undefined,
    workload: "analytics" | "comments",
    eventId: string | null | undefined,
  ): Promise<void> => {
    if (!eventId || !queue) return;
    try {
      await queue.sendBatch([
        {
          body: providerSyncMessage(workload, distributionId, eventId),
          contentType: "json",
        },
      ]);
    } catch (cause) {
      log(
        "warn",
        {
          environment: env.ENVIRONMENT,
          job_id: eventId,
          service: "automation",
          trace_id: eventId,
          version: env.VERSION,
        },
        {
          ...errorDiagnostic(cause),
          distribution_id: distributionId,
          event: "engagement_trigger_send_failed",
          outcome: "deferred_to_sweep",
          retry_class: "none",
          workload,
        },
      );
    }
  };
  await sendTrigger(env.ANALYTICS_QUEUE, "analytics", analyticsEventId);
  if (env.RECURRING_COMMENTS_ENABLED === "true") {
    await sendTrigger(env.COMMENTS_QUEUE, "comments", commentsEventId);
  }
}

function reportCommittedProviderFailure(
  env: AutomationEnv,
  row: { platform: string },
  execution: DistributionPublishExecution,
): Effect.Effect<void> {
  const { result } = execution;
  if (result.outcome === "confirmed_success") return Effect.void;
  const classification = result.failure.classification;
  if (!isProviderFailureClass(classification)) return Effect.void;
  const platform = isPlatform(row.platform) ? row.platform : undefined;
  return recordDiagnostic(env, {
    category: "provider_failure",
    failureClass: classification,
    error: { name: "ProviderAdapterError" },
    handled: true,
    occurredAt: new Date().toISOString(),
    operation: "publish",
    ...(platform === undefined ? {} : { platform }),
  }).pipe(Effect.asVoid);
}

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
             WHEN $2 = 'delivered' THEN 'delivered'
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
           provider_warnings = COALESCE($11::jsonb, provider_warnings),
           next_attempt_at = CASE
             WHEN $2 IN ('published', 'delivered') THEN NULL
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
            result.outcome === "confirmed_success" && result.warnings
              ? JSON.stringify(result.warnings)
              : null,
          ],
        );
        analyticsEventId = updated.rows[0]?.analytics_event_id;
        commentsEventId = updated.rows[0]?.comments_event_id;
        const updatedRow = updated.rows[0];
        if (updatedRow?.status === "published") {
          yield* recordPublicationUsage(
            client,
            {
              distributionId: row.id,
              platform: row.platform,
              postId: row.post_id,
            },
            reportingConfiguration(env),
          );
        }
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
        if (
          nextAttemptDelay !== null &&
          updatedRow !== undefined &&
          (updatedRow.status === "awaiting_provider" ||
            updatedRow.status === "needs_reconciliation")
        ) {
          yield* armDistributionReconcile(client, {
            completedAttempts: updatedRow.reconciliation_attempt_count,
            distributionId: row.id,
            orgId: row.org_id,
          });
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
      yield* armDistributionReconcile(client, {
        completedAttempts: row.reconciliation_attempt_count,
        distributionId: row.id,
        orgId: row.org_id,
      });
      yield* finishJobLease(client, eventKey(message), "succeeded");
    }),
  );
}

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
      if (!confirmed) {
        yield* armDistributionReconcile(client, {
          completedAttempts: row.reconciliation_attempt_count,
          distributionId: row.id,
          orgId: row.org_id,
        });
      }
      yield* finishJobLease(client, eventKey(message), "succeeded");
    }),
  );
}

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
  status: "awaiting_provider" | "delivered" | "failed" | "needs_reconciliation" | "published";
} {
  if (execution.result.kind === "lookup_failure") {
    const { failure } = execution.result;
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
    case "delivered":
      return {
        code: null,
        errorClass: null,
        message: null,
        operationStatus: "succeeded",
        providerOperationId: status.result.providerOperationId ?? null,
        providerPostId: null,
        providerUrl: null,
        retryable: null,
        shouldPoll: false,
        status: "delivered",
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
    const providerStillProcessing = state.status === "awaiting_provider";
    const pollBudgetExhausted =
      providerStillProcessing && row.provider_poll_attempts >= maximumProviderPollAttempts - 1;
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
         SET status = CASE WHEN $2 = 'delivered' THEN 'delivered' WHEN status = 'cancel_requested' THEN status ELSE $2 END,
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
             provider_warnings = COALESCE($12::jsonb, provider_warnings),
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
            execution.result.kind === "publication" &&
            (execution.result.status.state === "published" ||
              execution.result.status.state === "delivered") &&
            execution.result.status.result.warnings
              ? JSON.stringify(execution.result.status.result.warnings)
              : null,
          ],
        );
        analyticsEventId = updated.rows[0]?.analytics_event_id;
        commentsEventId = updated.rows[0]?.comments_event_id;
        const updatedRow = updated.rows[0];
        if (updatedRow?.status === "published") {
          yield* recordPublicationUsage(
            client,
            {
              distributionId: row.id,
              platform: row.platform,
              postId: row.post_id,
            },
            reportingConfiguration(env),
          );
        }
        if (row.platform_user_id !== null && execution.metadata?.rateLimitBudget) {
          yield* recordRateLimitBudget(
            client,
            row.platform,
            row.platform_user_id,
            execution.metadata.rateLimitBudget,
          );
        }
        if (
          nextAttemptDelay !== null &&
          updatedRow !== undefined &&
          (updatedRow.status === "awaiting_provider" ||
            updatedRow.status === "needs_reconciliation")
        ) {
          yield* armDistributionReconcile(client, {
            completedAttempts: updatedRow.reconciliation_attempt_count,
            distributionId: row.id,
            orgId: row.org_id,
          });
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
): Effect.Effect<boolean, DatabaseError> {
  return Effect.gen(function* () {
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
  });
}

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
          media: frozenMediaEntries(snapshot),
          platform: row.platform,
          platformAccountId: row.platform_account_id ?? undefined,
          postId: row.post_id,
          providerAccountId: row.platform_user_id ?? undefined,
          providerOptions: snapshot.content.provider_options,
          signature: snapshot.content.signature ?? null,
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
    yield* reportCommittedProviderFailure(env, row, execution);
    return "processed" as const;
  });
}

export function enqueueDueDistributions(
  env: AutomationEnv,
  limit = 100,
  stalledGraceSeconds = distributionProcessingGraceSeconds,
): Effect.Effect<number, AutomationJobError> {
  return claimDueOutboxWork(env, "distribution", limit, [stalledGraceSeconds]);
}

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
