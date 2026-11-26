import { Effect } from "effect";
import {
  analyticsTerminalAgeSeconds,
  demandDrivenCommentsAgeSeconds,
  PLATFORM_IDS,
  type DatabaseError,
  type Platform,
} from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";
import { errorDiagnostic, log } from "@meltiply/observability";
import {
  cachedProviderRegistryFromEnvironment,
  classifyProviderFailure,
  createProviderServiceLive,
  type ProviderAnalyticsRecord,
  type ProviderCommentRecord,
  type ProviderFailure,
  type ProviderRequestContext,
  type ProviderRetryPolicy,
  type ProviderRegistry,
  type ProviderService,
} from "@meltiply/providers";

import { withSystemTransactionEffect } from "./database";
import {
  claimOnDemandCommentsWork,
  maximumDelayedDeliverySeconds,
  maximumProviderSyncAttempts,
  onDemandCommentsBound,
  releaseDueProviderSyncClaims,
  sweepDueProviderSyncWork,
  type DueWorkClaim,
} from "./due-work";
import { type AutomationJobError, classifyJobError, QueuePublisher } from "./effect/index";
import { recurringCommentsEnabled, type AutomationEnv } from "./env";
import {
  isProviderSyncMessage,
  providerSyncMessage,
  type ProviderSyncMessage,
  type ProviderSyncWorkload,
} from "./messages";
import {
  decryptStoredToken,
  encryptRotatedTokens,
  nextTokenRefreshAt,
  persistRotatedPlatformTokens,
} from "./provider-credentials";
import {
  executeProviderAnalyticsEffect,
  executeProviderCommentsEffect,
  executeProviderTokenRefreshEffect,
  type ProviderReadExecution,
  type ProviderReadTarget,
  type ProviderRefreshExecution,
  type ProviderSyncDependencies,
} from "./provider-sync-provider";
import { nextDelaySeconds } from "./retry-policy";

type SystemTransaction = typeof withSystemTransactionEffect;

interface DistributionSyncRow extends Record<string, unknown> {
  access_token: string | null;
  attempt_count: number;
  connection_status: string | null;
  cursor: string | null;
  on_demand: boolean;
  event_id: string;
  id: string;
  org_id: string;
  platform: Platform;
  platform_user_id: string | null;
  platform_post_id: string;
  provider_operation_id: string | null;
  published_at: Date | string;
  token_expires_at: Date | string | null;
}

interface TokenRefreshRow extends Record<string, unknown> {
  access_token: string;
  attempt_count: number;
  event_id: string;
  id: string;
  platform: Platform;
  refresh_token: string | null;
  scopes: string[] | null;
  token_expires_at: Date | string;
}

export interface ProviderDueResult {
  analytics: number;
  comments: number;
  token_refresh: number;
}

export interface ProviderDueDependencies {
  batchSize?: number;
  providerRegistry?: ProviderRegistry;
  transaction?: SystemTransaction;
}

export interface ProviderSyncProcessingDependencies {
  decryptToken?: (storedToken: string) => Promise<string>;
  now?: () => Date;
  providerRegistry?: ProviderRegistry;
  random?: () => number;
  sendTrigger?: (
    workload: ProviderSyncWorkload,
    targetId: string,
    eventId: string,
    delaySeconds: number,
  ) => Promise<void>;
  transaction?: SystemTransaction;
}

export {
  maximumDelayedDeliverySeconds,
  overdueRecoveryGraceSeconds,
  providerAttemptLeaseSeconds,
} from "./due-work";

function eligiblePlatforms(registry: ProviderRegistry, workload: ProviderSyncWorkload): Platform[] {
  return PLATFORM_IDS.filter((platform) => {
    const adapter = registry.get(platform);
    switch (workload) {
      case "analytics":
        return Boolean(adapter?.capability.analytics && adapter.listAnalytics);
      case "comments":
        return Boolean(adapter?.capability.comments && adapter.listComments);
      case "token_refresh":
        return Boolean(adapter?.refreshAccessToken);
    }
  });
}

function boundedBatchSize(value = 50): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError("provider sync batch size must be between 1 and 100");
  }
  return value;
}

function queueFor(env: AutomationEnv, workload: ProviderSyncWorkload): Queue<unknown> {
  const queue =
    workload === "analytics"
      ? env.ANALYTICS_QUEUE
      : workload === "comments"
        ? env.COMMENTS_QUEUE
        : env.TOKEN_REFRESH_QUEUE;
  if (!queue) {
    throw new Error(`${workload} Queue binding is unavailable`);
  }
  return queue;
}

function sendClaims(
  env: AutomationEnv,
  workload: ProviderSyncWorkload,
  claims: DueWorkClaim[],
  transaction: SystemTransaction,
): Effect.Effect<number, AutomationJobError, QueuePublisher> {
  return Effect.gen(function* () {
    if (claims.length === 0) return 0;
    const queue = yield* Effect.try({
      try: () => queueFor(env, workload),
      catch: (cause) => classifyJobError(cause),
    });
    const publisher = yield* QueuePublisher;
    const messages = claims.map((claim) => {
      let delaySeconds: number | null = null;
      if (claim.next_due_at) {
        const diff = Math.ceil((new Date(claim.next_due_at).getTime() - Date.now()) / 1000);
        delaySeconds = Math.max(0, Math.min(maximumDelayedDeliverySeconds, diff));
      }
      const message: ProviderSyncMessage = providerSyncMessage(
        workload,
        claim.target_id,
        claim.event_id,
      );
      return {
        body: message,
        ...(delaySeconds !== null && delaySeconds > 0 ? { delaySeconds } : {}),
      };
    });
    return yield* publisher.sendBatch(queue, messages).pipe(
      Effect.map(() => claims.length),
      Effect.catch((cause) =>
        Effect.as(
          releaseDueProviderSyncClaims(
            env,
            workload,
            claims.map((claim) => ({ cause, claim })),
            transaction,
          ),
          0,
        ),
      ),
    );
  });
}

function armedEventId(delaySeconds: number | null): string | null {
  if (delaySeconds === null) return null;
  if (delaySeconds > maximumDelayedDeliverySeconds) return null;
  return crypto.randomUUID();
}

function sendNextProviderTrigger(
  env: AutomationEnv,
  workload: ProviderSyncWorkload,
  targetId: string,
  eventId: string,
  delaySeconds: number,
  dependencies: ProviderSyncProcessingDependencies = {},
): Effect.Effect<void, never, QueuePublisher> {
  return Effect.catch(
    Effect.gen(function* () {
      const sendTrigger = dependencies.sendTrigger;
      if (sendTrigger) {
        yield* Effect.tryPromise({
          try: () => sendTrigger(workload, targetId, eventId, delaySeconds),
          catch: (cause) => classifyJobError(cause),
        });
        return;
      }
      const queue = yield* Effect.try({
        try: () => queueFor(env, workload),
        catch: (cause) => classifyJobError(cause),
      });
      const publisher = yield* QueuePublisher;
      const boundedDelay = Math.max(0, Math.ceil(delaySeconds));
      const message: ProviderSyncMessage = providerSyncMessage(workload, targetId, eventId);
      yield* publisher.sendBatch(queue, [
        {
          body: message,
          ...(boundedDelay > 0 ? { delaySeconds: boundedDelay } : {}),
        },
      ]);
    }),
    (cause) => {
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
          event: "provider_sync_trigger_send_failed",
          outcome: "deferred_to_sweep",
          retry_class: "none",
          target_id: targetId,
          workload,
        },
      );
      return Effect.void;
    },
  );
}

export function sweepDueProviderJobs(
  env: AutomationEnv,
  dependencies: ProviderDueDependencies = {},
): Effect.Effect<ProviderDueResult, AutomationJobError, QueuePublisher> {
  return Effect.gen(function* () {
    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const transaction = dependencies.transaction ?? withSystemTransactionEffect;
    const batchSize = boundedBatchSize(dependencies.batchSize);
    const [[analytics, comments], tokenRefresh] = yield* Effect.all(
      [
        Effect.gen(function* () {
          const analyticsClaims = yield* sweepDueProviderSyncWork(
            env,
            "analytics",
            batchSize,
            eligiblePlatforms(registry, "analytics"),
            transaction,
          );
          const commentsClaims = yield* sweepDueProviderSyncWork(
            env,
            "comments",
            batchSize,
            eligiblePlatforms(registry, "comments"),
            transaction,
          );
          return [analyticsClaims, commentsClaims] as const;
        }),
        sweepDueProviderSyncWork(
          env,
          "token_refresh",
          batchSize,
          eligiblePlatforms(registry, "token_refresh"),
          transaction,
        ),
      ],
      { concurrency: 2 },
    );
    const [analyticsSent, commentsSent, tokenRefreshSent] = yield* Effect.all(
      [
        sendClaims(env, "analytics", analytics, transaction),
        sendClaims(env, "comments", comments, transaction),
        sendClaims(env, "token_refresh", tokenRefresh, transaction),
      ],
      { concurrency: 3 },
    );
    return {
      analytics: analyticsSent,
      comments: commentsSent,
      token_refresh: tokenRefreshSent,
    };
  });
}

export function requestOnDemandCommentsSync(
  env: AutomationEnv,
  input: { distributionId: string | null; organizationId: string },
  dependencies: ProviderDueDependencies = {},
): Effect.Effect<number, AutomationJobError, QueuePublisher> {
  return Effect.gen(function* () {
    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const transaction = dependencies.transaction ?? withSystemTransactionEffect;
    const claims = yield* claimOnDemandCommentsWork(
      env,
      {
        bound: boundedBatchSize(dependencies.batchSize ?? onDemandCommentsBound),
        distributionId: input.distributionId,
        organizationId: input.organizationId,
        platforms: eligiblePlatforms(registry, "comments"),
      },
      transaction,
    );
    return yield* sendClaims(env, "comments", claims, transaction);
  });
}

function loadDistributionTarget(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  transaction: SystemTransaction,
): Effect.Effect<DistributionSyncRow | undefined, DatabaseError> {
  const prefix = message.workload === "analytics" ? "analytics" : "comments";
  return transaction(env, (client) =>
    Effect.gen(function* () {
      const result = yield* client.query<DistributionSyncRow>(
        `SELECT distribution.id, distribution.org_id, distribution.platform,
              distribution.platform_post_id,
              distribution.provider_operation_id,
              COALESCE(distribution.published_at, distribution.created_at) AS published_at,
              distribution.${prefix}_cursor AS cursor,
              distribution.${prefix}_attempt_count AS attempt_count,
              distribution.${prefix}_sync_event_id::text AS event_id,
              distribution.comments_sync_on_demand AS on_demand,
              account.access_token, account.connection_status,
              account.token_expires_at, account.platform_user_id
       FROM distributions AS distribution
       LEFT JOIN platform_accounts AS account
         ON account.id = distribution.platform_account_id
       WHERE distribution.id = $1
         AND distribution.status = 'published'
         AND distribution.platform_post_id IS NOT NULL
         AND distribution.platform_post_id <> ''
         AND distribution.${prefix}_sync_event_id = $2::uuid
       FOR UPDATE OF distribution`,
        [message.target_id, message.event_id],
      );
      const row = result.rows[0];
      if (
        row &&
        (message.workload !== "comments" || recurringCommentsEnabled(env) || row.on_demand)
      )
        return row;
      yield* client.query(
        `UPDATE distributions
       SET ${prefix}_sync_event_id = NULL,
           ${prefix}_lease_expires_at = NULL,
           ${prefix}_next_sync_at = NULL, updated_at = now()
       WHERE id = $1 AND ${prefix}_sync_event_id = $2::uuid`,
        [message.target_id, message.event_id],
      );
      return undefined;
    }),
  );
}

function loadTokenTarget(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  transaction: SystemTransaction,
): Effect.Effect<TokenRefreshRow | undefined, DatabaseError> {
  return transaction(env, (client) =>
    Effect.gen(function* () {
      const result = yield* client.query<TokenRefreshRow>(
        `SELECT id, platform, access_token, refresh_token,
              token_expires_at::text AS token_expires_at,
              scopes, token_refresh_attempt_count AS attempt_count,
              token_refresh_event_id::text AS event_id
       FROM platform_accounts
       WHERE id = $1 AND token_refresh_event_id = $2::uuid
         AND connection_status IN ('connected', 'expiring')
         AND token_expires_at IS NOT NULL
       FOR UPDATE`,
        [message.target_id, message.event_id],
      );
      if (result.rows[0]) return result.rows[0];
      yield* client.query(
        `UPDATE platform_accounts
       SET token_refresh_event_id = NULL,
           token_refresh_lease_expires_at = NULL,
           token_refresh_next_attempt_at = NULL, updated_at = now()
       WHERE id = $1 AND token_refresh_event_id = $2::uuid`,
        [message.target_id, message.event_id],
      );
      return undefined;
    }),
  );
}

function ageSeconds(publishedAt: Date | string, now: Date): number {
  return Math.max(0, (now.valueOf() - new Date(publishedAt).valueOf()) / 1_000);
}

function analyticsCadenceSeconds(age: number, active: boolean): number | null {
  if (age >= analyticsTerminalAgeSeconds) return null;
  if (!active && age >= 7 * 86_400) return 86_400;
  if (age < 86_400) return active ? 900 : 1_800;
  if (age < 7 * 86_400) return active ? 3_600 : 7_200;
  if (age < 30 * 86_400) return active ? 21_600 : 43_200;
  return 86_400;
}

function commentsCadenceSeconds(age: number, active: boolean): number | null {
  if (age >= demandDrivenCommentsAgeSeconds) return null;
  if (!active && age >= 7 * 86_400) return 86_400;
  if (age < 86_400) return active ? 600 : 1_200;
  if (age < 7 * 86_400) return active ? 1_800 : 3_600;
  return active ? 10_800 : 21_600;
}

function retryDelaySeconds(
  failure: ProviderFailure,
  attemptCount: number,
  retryPolicy: ProviderRetryPolicy | undefined,
  random: () => number,
): number | null {
  if (!failure.retryable) return null;
  return nextDelaySeconds(
    {
      attemptBase: 1,
      baseSeconds: retryPolicy?.baseDelaySeconds ?? 60,
      jitter: "quarter",
      maxAttempts: Math.min(maximumProviderSyncAttempts, retryPolicy?.maxAttempts ?? 5),
      maxSeconds: retryPolicy?.maxDelaySeconds ?? 3_600,
    },
    attemptCount,
    { random, retryAfterSeconds: failure.retryAfterSeconds },
  );
}

function requireCurrentDistributionEvent(
  client: EffectTransactionClient,
  row: DistributionSyncRow,
  workload: "analytics" | "comments",
): Effect.Effect<boolean, DatabaseError> {
  const prefix = workload === "analytics" ? "analytics" : "comments";
  return Effect.map(
    client.query(
      `SELECT id FROM distributions
     WHERE id = $1 AND ${prefix}_sync_event_id = $2::uuid
     FOR UPDATE`,
      [row.id, row.event_id],
    ),
    (result) => result.rowCount === 1,
  );
}

function recordDistributionFailure(
  env: AutomationEnv,
  row: DistributionSyncRow,
  workload: "analytics" | "comments",
  execution:
    | Extract<ProviderReadExecution<ProviderAnalyticsRecord>, { outcome: "failure" }>
    | Extract<ProviderReadExecution<ProviderCommentRecord>, { outcome: "failure" }>,
  transaction: SystemTransaction,
  random: () => number,
  dependencies: ProviderSyncProcessingDependencies = {},
): Effect.Effect<void, AutomationJobError, QueuePublisher> {
  const prefix = workload === "analytics" ? "analytics" : "comments";
  const delay = retryDelaySeconds(
    execution.failure,
    row.attempt_count,
    execution.retryPolicy,
    random,
  );
  const evidence = `${execution.failure.classification}:${execution.failure.code}`;
  const nextEventId = armedEventId(delay);
  return Effect.gen(function* () {
    yield* transaction(env, (client) =>
      Effect.gen(function* () {
        if (!(yield* requireCurrentDistributionEvent(client, row, workload))) {
          return;
        }
        yield* client.query(
          `UPDATE distributions
             SET ${prefix}_sync_event_id = $5::uuid,
                 ${prefix}_lease_expires_at = NULL,
                 ${prefix}_next_sync_at = CASE
                   WHEN $3::integer IS NULL THEN NULL
                   ELSE now() + ($3 * INTERVAL '1 second')
                 END,
                 ${prefix}_last_error = $4, updated_at = now()
             WHERE id = $1 AND ${prefix}_sync_event_id = $2::uuid`,
          [row.id, row.event_id, delay, evidence, nextEventId],
        );
        if (execution.failure.classification === "auth") {
          yield* client.query(
            `UPDATE platform_accounts AS account
               SET connection_status = 'reconnect_required',
                   reconnect_notified_at = COALESCE(reconnect_notified_at, now()),
                   updated_at = now()
               FROM distributions AS distribution
               WHERE distribution.id = $1
                 AND account.id = distribution.platform_account_id`,
            [row.id],
          );
        }
      }),
    ).pipe(Effect.mapError(classifyJobError));
    if (delay !== null && nextEventId !== null) {
      yield* sendNextProviderTrigger(env, workload, row.id, nextEventId, delay, dependencies);
    }
  });
}

function latestAnalytics(items: ProviderAnalyticsRecord[]): ProviderAnalyticsRecord | undefined {
  let latest: ProviderAnalyticsRecord | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const time = new Date(item.recordedAt).valueOf();
    if (time > latestTime) {
      latest = item;
      latestTime = time;
    }
  }
  return latest;
}

function recordAnalyticsSuccess(
  env: AutomationEnv,
  row: DistributionSyncRow,
  execution: Extract<ProviderReadExecution<ProviderAnalyticsRecord>, { outcome: "success" }>,
  now: Date,
  transaction: SystemTransaction,
  dependencies: ProviderSyncProcessingDependencies = {},
): Effect.Effect<void, AutomationJobError, QueuePublisher> {
  const current = latestAnalytics(execution.page.items);
  const nextCursor = execution.page.nextCursor ?? null;
  let delay: number | null = 0;
  let nextEventId: string | null = null;
  return Effect.gen(function* () {
    yield* transaction(env, (client) =>
      Effect.gen(function* () {
        if (!(yield* requireCurrentDistributionEvent(client, row, "analytics"))) {
          return;
        }
        let active = false;
        if (current) {
          const previous = yield* client.query<{
            comments: number | string;
            likes: number | string;
            shares: number | string;
            views: number | string;
          }>(
            `SELECT views, likes, comments, shares
               FROM analytics_snapshots
               WHERE distribution_id = $1
               ORDER BY snapshot_at DESC, id DESC
               LIMIT 1`,
            [row.id],
          );
          const prior = previous.rows[0];
          active =
            !prior ||
            Number(prior.views) !== current.views ||
            Number(prior.likes) !== current.likes ||
            Number(prior.comments) !== current.comments ||
            Number(prior.shares) !== current.shares;
          yield* client.query(
            `INSERT INTO analytics_snapshots
                 (distribution_id, org_id, views, likes, comments, shares,
                  watch_time_sec, reach, impressions, snapshot_at, raw_data)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                       date_trunc('hour', $10::timestamptz), $11::jsonb)
               ON CONFLICT (distribution_id, snapshot_at) DO UPDATE
               SET views = EXCLUDED.views, likes = EXCLUDED.likes,
                   comments = EXCLUDED.comments, shares = EXCLUDED.shares,
                   watch_time_sec = EXCLUDED.watch_time_sec,
                   reach = EXCLUDED.reach, impressions = EXCLUDED.impressions,
                   raw_data = EXCLUDED.raw_data
               WHERE analytics_snapshots.views IS DISTINCT FROM EXCLUDED.views
                  OR analytics_snapshots.likes IS DISTINCT FROM EXCLUDED.likes
                  OR analytics_snapshots.comments IS DISTINCT FROM EXCLUDED.comments
                  OR analytics_snapshots.shares IS DISTINCT FROM EXCLUDED.shares
                  OR analytics_snapshots.watch_time_sec IS DISTINCT FROM EXCLUDED.watch_time_sec
                  OR analytics_snapshots.reach IS DISTINCT FROM EXCLUDED.reach
                  OR analytics_snapshots.impressions IS DISTINCT FROM EXCLUDED.impressions
              `,
            [
              row.id,
              row.org_id,
              current.views,
              current.likes,
              current.comments,
              current.shares,
              current.watchTimeSeconds,
              current.reach,
              current.impressions,
              now,
              JSON.stringify({
                provider_post_id: current.providerPostId,
                recorded_at: current.recordedAt,
              }),
            ],
          );
        }
        delay = nextCursor ? 0 : analyticsCadenceSeconds(ageSeconds(row.published_at, now), active);
        nextEventId = armedEventId(delay);
        yield* client.query(
          `UPDATE distributions
             SET analytics_cursor = $3,
                 analytics_last_synced_at = now(),
                 analytics_next_sync_at = CASE
                   WHEN $4::integer IS NULL THEN NULL
                   ELSE now() + ($4 * INTERVAL '1 second')
                 END,
                 analytics_lease_expires_at = NULL,
                 analytics_sync_event_id = $5::uuid,
                 analytics_attempt_count = 0,
                 analytics_last_error = NULL, updated_at = now()
             WHERE id = $1 AND analytics_sync_event_id = $2::uuid`,
          [row.id, row.event_id, nextCursor, delay, nextEventId],
        );
      }),
    ).pipe(Effect.mapError(classifyJobError));
    if (delay !== null && nextEventId !== null) {
      yield* sendNextProviderTrigger(env, "analytics", row.id, nextEventId, delay, dependencies);
    }
  });
}

function recordCommentsSuccess(
  env: AutomationEnv,
  row: DistributionSyncRow,
  execution: Extract<ProviderReadExecution<ProviderCommentRecord>, { outcome: "success" }>,
  now: Date,
  transaction: SystemTransaction,
  dependencies: ProviderSyncProcessingDependencies = {},
): Effect.Effect<void, AutomationJobError, QueuePublisher> {
  const nextCursor = execution.page.nextCursor ?? null;
  let delay: number | null = 0;
  let nextEventId: string | null = null;
  return Effect.gen(function* () {
    yield* transaction(env, (client) =>
      Effect.gen(function* () {
        if (!(yield* requireCurrentDistributionEvent(client, row, "comments"))) {
          return;
        }
        if (execution.page.items.length > 0) {
          yield* client.query(
            `INSERT INTO comments
                 (distribution_id, org_id, platform_comment_id, author_name,
                  author_avatar, body, commented_at, synced_at)
                SELECT $1, $2, input.provider_comment_id, input.author_name,
                      input.author_avatar, input.body, input.commented_at, now()
                FROM jsonb_to_recordset($3::jsonb) AS input(
                  provider_comment_id text,
                  author_name text,
                  author_avatar text,
                  body text,
                  commented_at timestamptz
                )
                ON CONFLICT (distribution_id, platform_comment_id) DO UPDATE
                SET author_name = EXCLUDED.author_name,
                    author_avatar = EXCLUDED.author_avatar,
                    body = EXCLUDED.body,
                    commented_at = EXCLUDED.commented_at,
                    synced_at = EXCLUDED.synced_at,
                    updated_at = now()`,
            [
              row.id,
              row.org_id,
              JSON.stringify(
                execution.page.items.map((comment) => ({
                  author_avatar: comment.authorAvatarUrl ?? null,
                  author_name: comment.authorDisplayName ?? null,
                  body: comment.body,
                  commented_at: comment.commentedAt,
                  provider_comment_id: comment.providerCommentId,
                })),
              ),
            ],
          );
        }
        delay = nextCursor
          ? 0
          : row.on_demand || !recurringCommentsEnabled(env)
            ? null
            : commentsCadenceSeconds(
                ageSeconds(row.published_at, now),
                execution.page.items.length > 0,
              );
        nextEventId = armedEventId(delay);
        yield* client.query(
          `UPDATE distributions
             SET comments_cursor = $3,
                 comments_last_synced_at = now(),
                 comments_next_sync_at = CASE
                   WHEN $4::integer IS NULL THEN NULL
                   ELSE now() + ($4 * INTERVAL '1 second')
                 END,
                 comments_lease_expires_at = NULL,
                 comments_sync_event_id = $5::uuid,
                 comments_sync_on_demand = comments_sync_on_demand AND $5::uuid IS NOT NULL,
                 comments_attempt_count = 0,
                 comments_last_error = NULL, updated_at = now()
             WHERE id = $1 AND comments_sync_event_id = $2::uuid`,
          [row.id, row.event_id, nextCursor, delay, nextEventId],
        );
      }),
    ).pipe(Effect.mapError(classifyJobError));
    if (delay !== null && nextEventId !== null) {
      yield* sendNextProviderTrigger(env, "comments", row.id, nextEventId, delay, dependencies);
    }
  });
}

interface DistributionSyncOperation<T> {
  execute: (
    registry: ProviderRegistry,
    context: ProviderRequestContext,
    target: ProviderReadTarget,
    dependencies: ProviderSyncDependencies,
    now: Date,
  ) => Effect.Effect<ProviderReadExecution<T>, never, ProviderService>;
  recordSuccess: (
    env: AutomationEnv,
    row: DistributionSyncRow,
    execution: Extract<ProviderReadExecution<T>, { outcome: "success" }>,
    now: Date,
    transaction: SystemTransaction,
    dependencies: ProviderSyncProcessingDependencies,
  ) => Effect.Effect<void, AutomationJobError, QueuePublisher>;
  stalledCursorCode: string;
  workload: "analytics" | "comments";
}

function processDistributionSync<T>(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies,
  operation: DistributionSyncOperation<T>,
): Effect.Effect<"processed" | "skipped", AutomationJobError, QueuePublisher> {
  return Effect.gen(function* () {
    const transaction = dependencies.transaction ?? withSystemTransactionEffect;
    const row = yield* loadDistributionTarget(env, message, transaction).pipe(
      Effect.mapError(classifyJobError),
    );
    if (!row) return "skipped" as const;
    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const now = dependencies.now?.() ?? new Date();
    const execution = yield* Effect.provide(
      operation.execute(
        registry,
        { operationId: message.event_id, requestId: message.request_id },
        {
          connectionStatus: row.connection_status ?? "unavailable",
          cursor: row.cursor,
          platform: row.platform,
          providerAccountId: row.platform_user_id ?? undefined,
          providerPostId: row.platform_post_id,
          providerOperationId: row.provider_operation_id ?? undefined,
          storedAccessToken: row.access_token ?? "",
          tokenExpiresAt: row.token_expires_at === null ? null : new Date(row.token_expires_at),
        },
        { decryptToken: dependencies.decryptToken ?? decryptStoredToken(env) },
        now,
      ),
      createProviderServiceLive(registry),
    );
    if (
      execution.outcome === "success" &&
      execution.page.nextCursor &&
      execution.page.nextCursor === row.cursor
    ) {
      yield* recordDistributionFailure(
        env,
        row,
        operation.workload,
        {
          failure: classifyProviderFailure({
            code: operation.stalledCursorCode,
            malformedResponse: true,
          }),
          outcome: "failure",
          retryPolicy: execution.retryPolicy,
        },
        transaction,
        dependencies.random ?? Math.random,
        dependencies,
      );
    } else if (execution.outcome === "failure") {
      yield* recordDistributionFailure(
        env,
        row,
        operation.workload,
        execution,
        transaction,
        dependencies.random ?? Math.random,
        dependencies,
      );
    } else {
      yield* operation.recordSuccess(env, row, execution, now, transaction, dependencies);
    }
    return "processed" as const;
  });
}

function processAnalytics(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies,
): Effect.Effect<"processed" | "skipped", AutomationJobError, QueuePublisher> {
  return processDistributionSync<ProviderAnalyticsRecord>(env, message, dependencies, {
    execute: executeProviderAnalyticsEffect,
    recordSuccess: recordAnalyticsSuccess,
    stalledCursorCode: "provider_analytics_cursor_stalled",
    workload: "analytics",
  });
}

function processComments(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies,
): Effect.Effect<"processed" | "skipped", AutomationJobError, QueuePublisher> {
  return processDistributionSync<ProviderCommentRecord>(env, message, dependencies, {
    execute: executeProviderCommentsEffect,
    recordSuccess: recordCommentsSuccess,
    stalledCursorCode: "provider_comments_cursor_stalled",
    workload: "comments",
  });
}

function recordTokenFailure(
  env: AutomationEnv,
  row: TokenRefreshRow,
  execution: Extract<ProviderRefreshExecution, { outcome: "failure" }>,
  now: Date,
  transaction: SystemTransaction,
  random: () => number,
  dependencies: ProviderSyncProcessingDependencies = {},
): Effect.Effect<void, AutomationJobError, QueuePublisher> {
  const expiry = new Date(row.token_expires_at);
  const authorizationLost = execution.failure.classification === "auth" || expiry <= now;
  const delay = authorizationLost
    ? null
    : retryDelaySeconds(execution.failure, row.attempt_count, execution.retryPolicy, random);
  const reconnect = authorizationLost || delay === null;
  const evidence = `${execution.failure.classification}:${execution.failure.code}`;
  const nextEventId = armedEventId(delay);
  return Effect.gen(function* () {
    yield* transaction(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(
          `UPDATE platform_accounts
             SET connection_status = CASE
                   WHEN $3 THEN CASE
                     WHEN $4::timestamptz <= $5::timestamptz THEN 'expired'
                     ELSE 'reconnect_required'
                   END
                   WHEN connection_status = 'connected' THEN 'expiring'
                   ELSE connection_status
                 END,
                 token_refresh_event_id = $8::uuid,
                 token_refresh_lease_expires_at = NULL,
                 token_refresh_next_attempt_at = CASE
                   WHEN $6::integer IS NULL THEN NULL
                   ELSE $5::timestamptz + ($6 * INTERVAL '1 second')
                 END,
                 token_refresh_last_error = $7,
                 reconnect_notified_at = CASE
                   WHEN $3 THEN COALESCE(reconnect_notified_at, $5::timestamptz)
                   ELSE reconnect_notified_at
                 END,
                 updated_at = now()
             WHERE id = $1 AND token_refresh_event_id = $2::uuid`,
          [row.id, row.event_id, reconnect, expiry, now, delay, evidence, nextEventId],
        );
      }),
    ).pipe(Effect.mapError(classifyJobError));
    if (delay !== null && nextEventId !== null) {
      yield* sendNextProviderTrigger(
        env,
        "token_refresh",
        row.id,
        nextEventId,
        delay,
        dependencies,
      );
    }
  });
}

function recordTokenSuccess(
  env: AutomationEnv,
  row: TokenRefreshRow,
  execution: Extract<ProviderRefreshExecution, { outcome: "success" }>,
  now: Date,
  transaction: SystemTransaction,
  dependencies: ProviderSyncProcessingDependencies = {},
): Effect.Effect<void, AutomationJobError, QueuePublisher> {
  return Effect.gen(function* () {
    const encrypted = yield* Effect.catch(
      Effect.tryPromise({
        try: () => encryptRotatedTokens(env, execution.tokens),
        catch: (cause) => classifyJobError(cause),
      }),
      () => Effect.succeed(null),
    );
    if (encrypted === null) {
      yield* recordTokenFailure(
        env,
        row,
        {
          failure: classifyProviderFailure({
            code: "provider_token_encryption_failed",
          }),
          outcome: "failure",
          retryPolicy: execution.retryPolicy,
        },
        now,
        transaction,
        dependencies.random ?? Math.random,
        dependencies,
      );
      return;
    }
    const expiresAt =
      execution.tokens.expiresAt !== undefined ? new Date(execution.tokens.expiresAt) : null;
    const scopes =
      execution.tokens.scopes.length > 0 ? execution.tokens.scopes : (row.scopes ?? []);
    const nextAttemptAt = nextTokenRefreshAt(expiresAt, now);
    const delay =
      nextAttemptAt !== null ? Math.max(0, (nextAttemptAt.getTime() - now.getTime()) / 1000) : null;
    const nextEventId = armedEventId(delay);
    const committed = yield* transaction(env, (client) =>
      persistRotatedPlatformTokens(client, {
        accessToken: encrypted.accessToken,
        expectedEventId: row.event_id,
        expectedTokenExpiresAt: row.token_expires_at,
        expiresAt,
        nextAttemptAt,
        nextEventId,
        platformAccountId: row.id,
        refreshToken: encrypted.refreshToken,
        scopes,
      }),
    ).pipe(Effect.mapError(classifyJobError));
    if (committed && nextEventId !== null && delay !== null) {
      yield* sendNextProviderTrigger(
        env,
        "token_refresh",
        row.id,
        nextEventId,
        delay,
        dependencies,
      );
    }
  });
}

function processTokenRefresh(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies,
): Effect.Effect<"processed" | "skipped", AutomationJobError, QueuePublisher> {
  return Effect.gen(function* () {
    const transaction = dependencies.transaction ?? withSystemTransactionEffect;
    const row = yield* loadTokenTarget(env, message, transaction).pipe(
      Effect.mapError(classifyJobError),
    );
    if (!row) return "skipped" as const;
    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const now = dependencies.now?.() ?? new Date();
    const execution = yield* Effect.provide(
      executeProviderTokenRefreshEffect(
        registry,
        { operationId: message.event_id, requestId: message.request_id },
        {
          platform: row.platform,
          storedAccessToken: row.access_token,
          storedRefreshToken: row.refresh_token,
        },
        { decryptToken: dependencies.decryptToken ?? decryptStoredToken(env) },
        now,
      ),
      createProviderServiceLive(registry),
    );
    if (execution.outcome === "failure") {
      yield* recordTokenFailure(
        env,
        row,
        execution,
        now,
        transaction,
        dependencies.random ?? Math.random,
        dependencies,
      );
    } else {
      yield* recordTokenSuccess(env, row, execution, now, transaction, dependencies);
    }
    return "processed" as const;
  });
}

export function processProviderSyncMessage(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies = {},
): Effect.Effect<"processed" | "skipped", AutomationJobError, QueuePublisher> {
  if (!isProviderSyncMessage(message)) return Effect.succeed("skipped");
  switch (message.workload) {
    case "analytics":
      return processAnalytics(env, message, dependencies);
    case "comments":
      return processComments(env, message, dependencies);
    case "token_refresh":
      return processTokenRefresh(env, message, dependencies);
  }
}
