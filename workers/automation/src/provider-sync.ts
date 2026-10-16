import { Effect } from "effect";
import {
  analyticsTerminalAgeSeconds,
  demandDrivenCommentsAgeSeconds,
  type DatabaseError,
  type Platform,
} from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  cachedProviderRegistryFromEnvironment,
  classifyProviderFailure,
  createProviderServiceLive,
  type ProviderAdapterError,
  type ProviderAnalyticsRecord,
  type ProviderCommentRecord,
  type ProviderFailure,
  type ProviderRequestContext,
  type ProviderRetryPolicy,
  type ProviderRegistry,
  type ProviderService,
} from "@meltiply/providers";

import { withSystemTransactionEffect } from "./database";
import { type AutomationJobError, classifyJobError, QueuePublisher } from "./effect/index";
import type { AutomationEnv } from "./env";
import {
  isProviderSyncMessage,
  type ProviderSyncMessage,
  type ProviderSyncWorkload,
} from "./messages";
import { decryptStoredToken, tokenCipherFor } from "./provider-credentials";
import {
  executeProviderAnalyticsEffect,
  executeProviderCommentsEffect,
  executeProviderTokenRefreshEffect,
  type ProviderReadExecution,
  type ProviderReadTarget,
  type ProviderRefreshExecution,
  type ProviderSyncDependencies,
} from "./provider-sync-provider";

/**
 * Transaction runner for provider sync: the Effect-native system transaction
 * contract, so load/record statements compose inside the caller's program.
 */
type SystemTransaction = typeof withSystemTransactionEffect;

interface DistributionSyncRow extends Record<string, unknown> {
  access_token: string | null;
  attempt_count: number;
  connection_status: string | null;
  cursor: string | null;
  event_id: string;
  id: string;
  org_id: string;
  platform: Platform;
  platform_user_id: string | null;
  platform_post_id: string;
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

const platforms: readonly Platform[] = ["tiktok", "youtube", "instagram", "facebook", "threads"];
export {
  maximumDelayedDeliverySeconds,
  minimumProviderVisibilityTimeoutSeconds,
  overdueRecoveryGraceSeconds,
  providerAttemptLeaseSeconds,
} from "./due-work";

import {
  claimOnDemandCommentsWork,
  maximumDelayedDeliverySeconds,
  maximumProviderSyncAttempts,
  onDemandCommentsBound,
  releaseDueProviderSyncClaims,
  sweepDueProviderSyncWork,
  type DueWorkClaim,
} from "./due-work";

/**
 * Filters platforms to those implementing the required adapter capability for a given workload.
 *
 * @param registry - Provider adapter registry.
 * @param workload - Target workload ('analytics', 'comments', or 'token_refresh').
 * @returns Array of eligible platform names.
 */
function eligiblePlatforms(registry: ProviderRegistry, workload: ProviderSyncWorkload): Platform[] {
  return platforms.filter((platform) => {
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

/**
 * Validates and constrains the provider sync batch size between 1 and 100.
 *
 * @param value - Batch size candidate, defaulting to 50.
 * @returns Validated integer batch size.
 * @throws {RangeError} If value is not an integer between 1 and 100.
 */
function boundedBatchSize(value = 50): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError("provider sync batch size must be between 1 and 100");
  }
  return value;
}

/**
 * Resolves the Cloudflare Queue binding for a provider sync workload.
 *
 * @param env - Automation worker environment bindings.
 * @param workload - Provider sync workload kind ('analytics', 'comments', 'token_refresh').
 * @returns Corresponding Cloudflare Queue binding.
 * @throws {Error} If the requested queue binding is missing.
 */
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

/**
 * Dispatches claimed provider sync items as messages to their target Cloudflare Queue.
 *
 * Effect program: resolves the workload's Queue binding (a missing binding is a
 * classified job failure) and publishes through the QueuePublisher service so
 * delivery stays injectable in tests. Automatically computes delivery delays
 * based on `next_due_at`. If dispatch fails, the claims are released back to the
 * database and the program yields 0 — the send error itself never propagates.
 *
 * @param env - Automation worker environment bindings.
 * @param workload - Target workload.
 * @param claims - Claimed work items.
 * @param transaction - Transaction runner for database operations.
 * @returns Effect producing the number of messages successfully published.
 */
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
      const message: ProviderSyncMessage = {
        event_id: claim.event_id,
        request_id: claim.event_id,
        target_id: claim.target_id,
        type: "provider.sync",
        version: 1,
        workload,
      };
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

/**
 * Identifier for the trigger armed alongside the next due moment.
 *
 * Work due beyond the delayed-delivery horizon is left unarmed (null) so the hourly
 * sweep converts it once it comes into range, matching the Due work contract in `due-work.ts`.
 *
 * @param delaySeconds - Delay in seconds until execution, or null if no schedule.
 * @returns Minted UUID string if within the horizon, otherwise null.
 */
function armedEventId(delaySeconds: number | null): string | null {
  if (delaySeconds === null) return null;
  if (delaySeconds > maximumDelayedDeliverySeconds) return null;
  return crypto.randomUUID();
}

/**
 * Dispatches a delayed queue message for the next recurring provider sync execution.
 *
 * Best-effort Effect: the `sendTrigger` dependency override still intercepts the
 * dispatch for tests, and every send/queue-resolution failure is swallowed
 * (`Effect.catch` to void) because the armed event is already durable — the
 * hourly sweep recovers any trigger lost in transit.
 *
 * @param env - Automation worker environment bindings.
 * @param workload - Workload kind.
 * @param targetId - Target record UUID (distribution or platform account).
 * @param eventId - Minted trigger event ID.
 * @param delaySeconds - Delay in seconds before execution.
 * @param dependencies - Optional dependency overrides for testing.
 * @returns Effect that always succeeds; delivery happens via QueuePublisher
 *   unless a sendTrigger override is injected.
 */
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
      const message: ProviderSyncMessage = {
        event_id: eventId,
        request_id: eventId,
        target_id: targetId,
        type: "provider.sync",
        version: 1,
        workload,
      };
      yield* publisher.sendBatch(queue, [
        {
          body: message,
          ...(boundedDelay > 0 ? { delaySeconds: boundedDelay } : {}),
        },
      ]);
    }),
    () => Effect.void,
  );
}

/**
 * Hourly recovery sweep for provider sync work: converts rows whose next due
 * moment has come inside the delayed-delivery horizon and re-arms triggers that
 * were lost, so no kind of provider work depends on a per-minute poll.
 *
 * @param env - Automation worker environment bindings.
 * @param dependencies - Optional overrides for batch size, registry, and transaction.
 * @returns Effect producing per-workload counts of claimed and dispatched jobs.
 *   Claim/dispatch failures surface on the typed error channel; an invalid
 *   batchSize remains a RangeError defect.
 */
export function sweepDueProviderJobs(
  env: AutomationEnv,
  dependencies: ProviderDueDependencies = {},
): Effect.Effect<ProviderDueResult, AutomationJobError | ProviderAdapterError, QueuePublisher> {
  return Effect.gen(function* () {
    const registry = dependencies.providerRegistry ?? cachedProviderRegistryFromEnvironment(env);
    const transaction = dependencies.transaction ?? withSystemTransactionEffect;
    const batchSize = boundedBatchSize(dependencies.batchSize);
    const analytics = yield* sweepDueProviderSyncWork(
      env,
      "analytics",
      batchSize,
      eligiblePlatforms(registry, "analytics"),
      transaction,
    );
    const comments = yield* sweepDueProviderSyncWork(
      env,
      "comments",
      batchSize,
      eligiblePlatforms(registry, "comments"),
      transaction,
    );
    const tokenRefresh = yield* sweepDueProviderSyncWork(
      env,
      "token_refresh",
      batchSize,
      eligiblePlatforms(registry, "token_refresh"),
      transaction,
    );
    return {
      analytics: yield* sendClaims(env, "analytics", analytics, transaction),
      comments: yield* sendClaims(env, "comments", comments, transaction),
      token_refresh: yield* sendClaims(env, "token_refresh", tokenRefresh, transaction),
    };
  });
}

/**
 * Arm and deliver Comment fetches for Distributions the cadence ladder no
 * longer schedules, in response to a creator opening the Inbox.
 *
 * The Inbox request itself performs no Provider call: this claims a bounded page
 * of that organization's unscheduled Distributions and hands them to the same
 * comments Queue path the scheduled ladder uses, so the consumer, event guard,
 * lease, and checkpoint are unchanged. The claim is the only trust boundary that
 * matters here — it bounds how many Distributions one open may arm and refuses a
 * Distribution fetched within `onDemandCommentsIntervalSeconds` — so repeated
 * opens cannot force repeated Provider calls.
 *
 * @param env - Automation worker environment bindings.
 * @param input - Filter parameters including optional distributionId and organizationId.
 * @param dependencies - Optional dependency overrides for batch size and transaction.
 * @returns Effect producing the number of on-demand comments sync messages
 *   dispatched; claim failures surface on the typed error channel and an
 *   invalid batchSize remains a RangeError defect.
 */
export function requestOnDemandCommentsSync(
  env: AutomationEnv,
  input: { distributionId: string | null; organizationId: string },
  dependencies: ProviderDueDependencies = {},
): Effect.Effect<number, AutomationJobError | ProviderAdapterError, QueuePublisher> {
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

/**
 * Loads and locks a published distribution record matching the incoming sync event ID.
 *
 * If the event ID no longer matches the distribution row, unsets the sync event and clears leases.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Provider sync queue message.
 * @param transaction - Transaction runner for database operations.
 * @returns Locked distribution target row, or undefined if event is stale.
 */
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
              COALESCE(distribution.published_at, distribution.created_at) AS published_at,
              distribution.${prefix}_cursor AS cursor,
              distribution.${prefix}_attempt_count AS attempt_count,
              distribution.${prefix}_sync_event_id::text AS event_id,
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
      if (result.rows[0]) return result.rows[0];
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

/**
 * Loads and locks a platform account record matching the token refresh event ID.
 *
 * If the event ID no longer matches, unsets the sync event and clears leases.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Provider sync queue message.
 * @param transaction - Transaction runner for database operations.
 * @returns Locked platform account target row, or undefined if event is stale.
 */
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

/**
 * Calculates the elapsed age in seconds since a post's publication timestamp.
 *
 * @param publishedAt - Original post publication date or ISO string.
 * @param now - Current reference timestamp.
 * @returns Non-negative elapsed seconds.
 */
function ageSeconds(publishedAt: Date | string, now: Date): number {
  return Math.max(0, (now.valueOf() - new Date(publishedAt).valueOf()) / 1_000);
}

/**
 * Next analytics cadence, or null once the Distribution passes
 * `analyticsTerminalAgeSeconds`: analytics on a Distribution that old is
 * archival, so it stops being scheduled instead of flooring at a daily poll
 * forever. Null is the same "no longer scheduled" value the failure path
 * already writes, so `armedEventId` leaves the row unarmed.
 *
 * @param age - Elapsed seconds since publication.
 * @param active - Boolean indicating whether metrics changed since the last snapshot.
 * @returns Cadence interval in seconds, or null if terminal.
 */
function analyticsCadenceSeconds(age: number, active: boolean): number | null {
  if (age >= analyticsTerminalAgeSeconds) return null;
  if (!active && age >= 7 * 86_400) return 86_400;
  if (age < 86_400) return active ? 900 : 1_800;
  if (age < 7 * 86_400) return active ? 3_600 : 7_200;
  if (age < 30 * 86_400) return active ? 21_600 : 43_200;
  return 86_400;
}

/**
 * Comment cadence for a published Distribution, or `null` once it is no longer
 * scheduled at all.
 *
 * Day zero is deliberately slower than a live-chat cadence: 600s active / 1200s
 * inactive halves the first day's Provider calls (288 to 144 active, 144 to 72
 * inactive) while keeping the worst-case delay before a new Comment is visible
 * at 10 minutes. Past `demandDrivenCommentsAgeSeconds` nothing is scheduled and
 * an Inbox open arms the fetch instead (see `requestOnDemandCommentsSync`), so
 * Meltiply stops paying a daily Provider call per Distribution forever. The
 * accepted tradeoff is that a Comment on such a Distribution produces no
 * notification until someone looks.
 *
 * @param age - Elapsed seconds since publication.
 * @param active - Boolean indicating whether new comments were returned in the last page.
 * @returns Cadence interval in seconds, or null if transitioned to demand-driven.
 */
function commentsCadenceSeconds(age: number, active: boolean): number | null {
  if (age >= demandDrivenCommentsAgeSeconds) return null;
  if (!active && age >= 7 * 86_400) return 86_400;
  if (age < 86_400) return active ? 600 : 1_200;
  if (age < 7 * 86_400) return active ? 1_800 : 3_600;
  return active ? 10_800 : 21_600;
}

/**
 * Computes an exponential retry backoff delay with jitter for failed sync attempts.
 *
 * Honors provider retryAfter headers and adapter retry policy bounds.
 *
 * @param failure - Structured provider failure object.
 * @param attemptCount - Current attempt counter.
 * @param retryPolicy - Provider adapter retry policy.
 * @param random - PRNG function.
 * @returns Delay in seconds, or null if non-retryable or maximum attempts reached.
 */
function retryDelaySeconds(
  failure: ProviderFailure,
  attemptCount: number,
  retryPolicy: ProviderRetryPolicy | undefined,
  random: () => number,
): number | null {
  const maxAttempts = Math.min(maximumProviderSyncAttempts, retryPolicy?.maxAttempts ?? 5);
  if (!failure.retryable || attemptCount >= maxAttempts) return null;
  const base = retryPolicy?.baseDelaySeconds ?? 60;
  const maximum = retryPolicy?.maxDelaySeconds ?? 3_600;
  const sample = random();
  const jitter = Number.isFinite(sample) ? 0.75 + Math.min(1, Math.max(0, sample)) * 0.25 : 0.875;
  return Math.min(
    maximum,
    Math.max(
      1,
      Math.ceil(base * 2 ** Math.max(0, attemptCount - 1) * jitter),
      failure.retryAfterSeconds ?? 0,
    ),
  );
}

/**
 * Enforces that the distribution's active sync event ID has not changed under concurrency.
 *
 * Row-locks the distribution row to guard against double processing or superseded events.
 *
 * @param client - Transactional database client.
 * @param row - Target distribution record.
 * @param workload - Target sync workload ('analytics' or 'comments').
 * @returns True if the active sync event ID matches the processing event.
 */
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

/**
 * Records a failed analytics or comments sync attempt, computing backoff and updating leases.
 *
 * Sets reconnect_required on the platform account if the failure was auth-related,
 * unsets or rearms the sync event ID, and dispatches the next delayed trigger if retryable.
 *
 * @param env - Automation worker environment bindings.
 * @param row - Distribution sync row.
 * @param workload - Workload kind ('analytics' or 'comments').
 * @param execution - Failed provider read execution outcome.
 * @param transaction - Transaction runner for database operations.
 * @param random - PRNG function.
 * @param dependencies - Optional dependency overrides.
 * @returns Effect completing once the failure is persisted and any retry
 *   trigger is dispatched; the transaction's throws are classified onto the
 *   AutomationJobError channel while the trigger send stays best-effort.
 */
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

/**
 * Extracts the most recent analytics record from an array based on recordedAt timestamp.
 *
 * @param items - Array of provider analytics records.
 * @returns Latest record by recordedAt timestamp, or undefined if array is empty.
 */
function latestAnalytics(items: ProviderAnalyticsRecord[]): ProviderAnalyticsRecord | undefined {
  return [...items].sort(
    (left, right) => new Date(right.recordedAt).valueOf() - new Date(left.recordedAt).valueOf(),
  )[0];
}

/**
 * Records successful analytics metrics in analytics_snapshots and computes the next polling cadence.
 *
 * Detects engagement changes to differentiate active vs inactive cadence ladders, inserts hourly snapshots,
 * clears attempt counts, and schedules the next trigger.
 *
 * @param env - Automation worker environment bindings.
 * @param row - Distribution sync row.
 * @param execution - Successful analytics execution page.
 * @param now - Reference timestamp.
 * @param transaction - Transaction runner for database operations.
 * @param dependencies - Optional dependency overrides.
 * @returns Effect completing once the snapshot and next cadence are persisted
 *   and any follow-up trigger is dispatched; the transaction's throws are
 *   classified onto the AutomationJobError channel while the trigger send
 *   stays best-effort.
 */
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

/**
 * Inserts synced comments into the comments table and schedules the next comments polling trigger.
 *
 * Deduplicates comments on conflict with (distribution_id, platform_comment_id), updates content and author metadata,
 * resets failure counts, and arms the next delayed delivery trigger according to post age and activity.
 *
 * @param env - Automation worker environment bindings.
 * @param row - Distribution sync row.
 * @param execution - Successful comment execution page.
 * @param now - Reference timestamp.
 * @param transaction - Transaction runner for database operations.
 * @param dependencies - Optional dependency overrides.
 * @returns Effect completing once the comments page and next cadence are
 *   persisted and any follow-up trigger is dispatched; the transaction's throws
 *   are classified onto the AutomationJobError channel while the trigger send
 *   stays best-effort.
 */
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

/**
 * The workload-specific surface of distribution sync processing: the adapter
 * read executor, the failure code recorded when a returned cursor repeats the
 * stored one, and the success persistence routine. Everything else — target
 * load, registry and clock resolution, service provisioning, and failure
 * recording — is shared orchestration owned by processDistributionSync.
 */
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

/**
 * Shared orchestration for analytics and comments sync messages.
 *
 * Loads and locks the distribution target, resolves the provider registry and
 * reference timestamp, runs the workload's adapter read inside the live
 * ProviderService layer, then persists the outcome: a stalled cursor (success
 * whose nextCursor repeats the stored one) is recorded as a malformed-response
 * failure under the workload's stalled-cursor code, adapter failures keep their
 * classified failure, and successes dispatch to the workload's recorder.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Provider sync queue message.
 * @param dependencies - Dependencies for token decryption, registry, clock, and transactions.
 * @param operation - Workload-specific executor, stalled-cursor code, and success recorder.
 * @returns Effect producing 'skipped' when no distribution matches the event,
 *   otherwise 'processed'; load and persistence failures land on the
 *   AutomationJobError channel and provider adapter errors pass through
 *   unclassified for the boundary to map.
 */
function processDistributionSync<T>(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies,
  operation: DistributionSyncOperation<T>,
): Effect.Effect<
  "processed" | "skipped",
  AutomationJobError | ProviderAdapterError,
  QueuePublisher
> {
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

/**
 * Processes an analytics sync message for a published distribution post.
 *
 * Declares the analytics workload for the shared distribution-sync
 * orchestration: the listAnalytics executor, the
 * 'provider_analytics_cursor_stalled' failure code, and metrics-snapshot
 * persistence on success.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Provider sync queue message.
 * @param dependencies - Dependencies for token decryption, registry, and transactions.
 * @returns Effect producing 'processed' or 'skipped'; load and persistence
 *   failures land on the AutomationJobError channel and provider adapter errors
 *   pass through unclassified for the boundary to map.
 */
function processAnalytics(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies,
): Effect.Effect<
  "processed" | "skipped",
  AutomationJobError | ProviderAdapterError,
  QueuePublisher
> {
  return processDistributionSync<ProviderAnalyticsRecord>(env, message, dependencies, {
    execute: executeProviderAnalyticsEffect,
    recordSuccess: recordAnalyticsSuccess,
    stalledCursorCode: "provider_analytics_cursor_stalled",
    workload: "analytics",
  });
}

/**
 * Processes a comments sync message for a published distribution post.
 *
 * Declares the comments workload for the shared distribution-sync
 * orchestration: the listComments executor, the
 * 'provider_comments_cursor_stalled' failure code, and comment upsert
 * persistence on success.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Provider sync queue message.
 * @param dependencies - Dependencies for token decryption, registry, and transactions.
 * @returns Effect producing 'processed' or 'skipped'; load and persistence
 *   failures land on the AutomationJobError channel and provider adapter errors
 *   pass through unclassified for the boundary to map.
 */
function processComments(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies,
): Effect.Effect<
  "processed" | "skipped",
  AutomationJobError | ProviderAdapterError,
  QueuePublisher
> {
  return processDistributionSync<ProviderCommentRecord>(env, message, dependencies, {
    execute: executeProviderCommentsEffect,
    recordSuccess: recordCommentsSuccess,
    stalledCursorCode: "provider_comments_cursor_stalled",
    workload: "comments",
  });
}

/**
 * Records a failed OAuth token refresh attempt, transitioning account connection status and backoff.
 *
 * Marks connection_status as 'reconnect_required' or 'expired' if auth failed or token already expired,
 * sets next attempt timestamps if retryable, and sends delayed trigger messages.
 *
 * @param env - Automation worker environment bindings.
 * @param row - Platform account token refresh row.
 * @param execution - Failed refresh execution result.
 * @param now - Reference timestamp.
 * @param transaction - Transaction runner for database operations.
 * @param random - PRNG function.
 * @param dependencies - Optional dependency overrides.
 * @returns Effect completing once the failure is persisted and any retry
 *   trigger is dispatched; the transaction's throws are classified onto the
 *   AutomationJobError channel while the trigger send stays best-effort.
 */
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

/**
 * Encrypts and stores newly refreshed OAuth credentials in the platform_accounts table.
 *
 * Encrypts access and refresh tokens, updates expiration timestamps (or clears them to NULL
 * when absent), sets connection_status to 'connected', and schedules the next refresh attempt
 * (7 days before token expiration or minimum 1 hour). When expiration is absent, clears scheduled
 * refresh event ID and next attempt timestamp without queueing a follow-up trigger.
 *
 * @param env - Automation worker environment bindings.
 * @param row - Platform account token refresh row.
 * @param execution - Successful refresh execution result containing new token set.
 * @param now - Reference timestamp.
 * @param transaction - Transaction runner for database operations.
 * @param random - PRNG function.
 * @param dependencies - Optional dependency overrides.
 * @returns Effect completing once rotated credentials are persisted and any
 *   next refresh trigger is dispatched. An encryption failure is recorded as a
 *   token-refresh failure outcome instead of failing the job; the
 *   transaction's throws are classified onto the AutomationJobError channel
 *   while the trigger send stays best-effort.
 */
function recordTokenSuccess(
  env: AutomationEnv,
  row: TokenRefreshRow,
  execution: Extract<ProviderRefreshExecution, { outcome: "success" }>,
  now: Date,
  transaction: SystemTransaction,
  random: () => number,
  dependencies: ProviderSyncProcessingDependencies = {},
): Effect.Effect<void, AutomationJobError, QueuePublisher> {
  return Effect.gen(function* () {
    const encrypted = yield* Effect.catch(
      Effect.tryPromise({
        try: async () => {
          const cipher = tokenCipherFor(env);
          return {
            accessToken: await cipher.encrypt(execution.tokens.accessToken),
            refreshToken: execution.tokens.refreshToken
              ? await cipher.encrypt(execution.tokens.refreshToken)
              : row.refresh_token,
          };
        },
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
        random,
        dependencies,
      );
      return;
    }
    const expiresAt =
      execution.tokens.expiresAt !== undefined ? new Date(execution.tokens.expiresAt) : null;
    const scopes =
      execution.tokens.scopes.length > 0 ? execution.tokens.scopes : (row.scopes ?? []);
    const nextAttemptAt =
      expiresAt !== null
        ? new Date(Math.max(now.getTime() + 3_600_000, expiresAt.getTime() - 7 * 86_400_000))
        : null;
    const delay =
      nextAttemptAt !== null ? Math.max(0, (nextAttemptAt.getTime() - now.getTime()) / 1000) : null;
    const nextEventId = armedEventId(delay);
    const committed = yield* transaction(env, (client) =>
      Effect.gen(function* () {
        const updated = yield* client.query(
          `UPDATE platform_accounts
             SET access_token = $3, refresh_token = $4,
                 token_expires_at = $5, scopes = $6,
                 connection_status = 'connected', last_synced_at = now(),
                 token_refresh_event_id = $8::uuid,
                 token_refresh_lease_expires_at = NULL,
                 token_refresh_next_attempt_at = $9::timestamptz,
                 token_refresh_attempt_count = 0,
                 token_refresh_last_error = NULL,
                 reconnect_notified_at = NULL, updated_at = now()
             WHERE id = $1 AND token_refresh_event_id = $2::uuid
               AND token_expires_at IS NOT DISTINCT FROM $7::timestamptz`,
          [
            row.id,
            row.event_id,
            encrypted.accessToken,
            encrypted.refreshToken,
            expiresAt,
            scopes,
            row.token_expires_at,
            nextEventId,
            nextAttemptAt,
          ],
        );
        if (updated.rowCount === 0) {
          yield* client.query(
            `UPDATE platform_accounts
               SET token_refresh_event_id = NULL,
                   token_refresh_lease_expires_at = NULL, updated_at = now()
               WHERE id = $1 AND token_refresh_event_id = $2::uuid`,
            [row.id, row.event_id],
          );
          return false;
        }
        return true;
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

/**
 * Processes an OAuth access token refresh queue message.
 *
 * Loads the account target, invokes the provider adapter's refreshAccessToken method,
 * and delegates outcome handling to recordTokenSuccess or recordTokenFailure.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Provider sync queue message.
 * @param dependencies - Dependencies for token decryption, registry, and transactions.
 * @returns Effect producing 'processed' or 'skipped'; load and persistence
 *   failures land on the AutomationJobError channel and provider adapter errors
 *   pass through unclassified for the boundary to map.
 */
function processTokenRefresh(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies,
): Effect.Effect<
  "processed" | "skipped",
  AutomationJobError | ProviderAdapterError,
  QueuePublisher
> {
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
      yield* recordTokenSuccess(
        env,
        row,
        execution,
        now,
        transaction,
        dependencies.random ?? Math.random,
        dependencies,
      );
    }
    return "processed" as const;
  });
}

/**
 * Main queue consumer router for provider sync queue messages.
 *
 * Directs messages to `processAnalytics`, `processComments`, or `processTokenRefresh` based on workload type.
 *
 * @param env - Automation worker environment bindings.
 * @param message - Provider sync message from the queue.
 * @param dependencies - Optional dependency overrides for testing.
 * @returns Effect producing 'processed' or 'skipped', with no internal
 *   execution boundary; requires QueuePublisher for best-effort trigger
 *   dispatch and fails with classified AutomationJobError or a provider
 *   adapter error the boundary maps.
 */
export function processProviderSyncMessage(
  env: AutomationEnv,
  message: ProviderSyncMessage,
  dependencies: ProviderSyncProcessingDependencies = {},
): Effect.Effect<
  "processed" | "skipped",
  AutomationJobError | ProviderAdapterError,
  QueuePublisher
> {
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
