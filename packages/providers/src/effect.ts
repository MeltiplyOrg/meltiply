import type { Platform } from "@meltiply/domain";
import { Context, Duration, Effect, Layer, Schedule } from "effect";

import { classifyProviderFailure, ProviderAdapterError } from "./failures";
import type {
  OAuthExchangeInput,
  OAuthExchangeResult,
  ProviderAccountAnalytics,
  ProviderAdapter,
  ProviderAnalyticsRecord,
  ProviderCommentRecord,
  ProviderCredentials,
  ProviderBroadcastInfo,
  ProviderOperationResult,
  ProviderPage,
  ProviderPageInput,
  ProviderPublicationLookup,
  ProviderPublicationRequirements,
  ProviderPublicationStatus,
  ProviderRequestContext,
  ProviderRetryPolicy,
  ProviderReplyInput,
  ProviderTokenSet,
  PublishInput,
} from "./types";

/**
 * Runs one raw adapter call lazily, linking fiber interruption and caller abort.
 * The combined signal reaches every HTTP stage through the child context.
 * Metadata is copied back after settlement; normalized errors retain identity,
 * while unexpected throws become deterministic provider_unexpected with an
 * internal cause retained for sanitized structured logging only.
 * No retries occur here, regardless of operation kind or idempotency key.
 */
export function providerCallEffect<A>(
  context: ProviderRequestContext,
  call: (context: ProviderRequestContext) => Promise<A>,
): Effect.Effect<A, ProviderAdapterError> {
  return Effect.tryPromise({
    catch: (cause) =>
      cause instanceof ProviderAdapterError
        ? cause
        : new ProviderAdapterError(
            classifyProviderFailure({
              code: "provider_unexpected",
              status: 400,
            }),
            { cause },
          ),
    try: async (signal) => {
      const child: ProviderRequestContext = {
        ...context,
        signal: context.signal ? AbortSignal.any([signal, context.signal]) : signal,
      };
      try {
        return await call(child);
      } finally {
        context.metadata = child.metadata;
      }
    },
  });
}

function unsupported(method: string): Effect.Effect<never, ProviderAdapterError> {
  return Effect.fail(
    new ProviderAdapterError(
      classifyProviderFailure({
        code: `provider_unsupported_${method}`,
        status: 400,
      }),
    ),
  );
}

function withAdapterMethod<M, A>(
  method: M | undefined,
  label: string,
  context: ProviderRequestContext,
  invoke: (fn: M, child: ProviderRequestContext) => Promise<A>,
): Effect.Effect<A, ProviderAdapterError> {
  if (!method) return unsupported(label);
  return providerCallEffect(context, (child) => invoke(method, child));
}

/**
 * Publishes one distribution through the adapter as a typed Effect.
 * Executes exactly once: no provider proves a remote idempotency contract
 * (adapters validate `idempotencyKey` locally but never transmit it), so
 * automatic write retries could duplicate posts and are refused here.
 * Ambiguous remote outcomes stay on the success channel as `unknown` results
 * for reconciliation rather than failures.
 * Returns Effect resolving to the ProviderOperationResult. Example:
 * `{ outcome: "confirmed_success", providerPostId: "post-1" }`.
 */
export function publishEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  input: PublishInput,
): Effect.Effect<ProviderOperationResult, ProviderAdapterError> {
  return withAdapterMethod(adapter.publish, "publish", context, (publish, child) =>
    publish(child, credentials, input),
  );
}

/**
 * Looks up remote publication state through the adapter as a typed Effect.
 * Some adapters resume publishing during reconciliation, so lookup is not
 * assumed read-only and is never automatically retried here. Durable worker
 * scheduling owns further reconciliation and any Retry-After delay.
 * Returns Effect resolving to the ProviderPublicationStatus.
 */
export function lookupPublicationEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  lookup: ProviderPublicationLookup,
): Effect.Effect<ProviderPublicationStatus, ProviderAdapterError> {
  return withAdapterMethod(
    adapter.lookupPublication,
    "lookup_publication",
    context,
    (lookupPublication, child) => lookupPublication(child, credentials, lookup),
  );
}

/**
 * Cancels a remote publication through the adapter as a typed Effect.
 * Executes exactly once: a timeout or ambiguous failure may follow an
 * already-accepted remote cancellation, so callers reconcile instead of
 * retrying. There is deliberately no write-retry helper in this package.
 * Returns Effect resolving to the ProviderOperationResult.
 */
export function cancelPublicationEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  lookup: ProviderPublicationLookup,
): Effect.Effect<ProviderOperationResult, ProviderAdapterError> {
  return withAdapterMethod(
    adapter.cancelPublication,
    "cancel_publication",
    context,
    (cancelPublication, child) => cancelPublication(child, credentials, lookup),
  );
}

/**
 * Sends a reply to a provider comment through the adapter as a typed Effect.
 * Executes exactly once: replies carry no proven remote idempotency
 * mechanism, so a 5xx or timeout after dispatch must reconcile rather than
 * retry, even when the caller supplies an idempotency key (keys are validated
 * locally, never transmitted, and prove nothing about the remote operation).
 * Returns Effect resolving to the ProviderOperationResult.
 */
export function replyEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  input: ProviderReplyInput,
): Effect.Effect<ProviderOperationResult, ProviderAdapterError> {
  return withAdapterMethod(adapter.reply, "reply", context, (reply, child) =>
    reply(child, credentials, input),
  );
}

/**
 * Reads account-level lifetime counters through the adapter as a typed Effect.
 * Pure read: retry policy is applied by the caller; no Post identity is needed.
 */
export function getAccountAnalyticsEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
): Effect.Effect<ProviderAccountAnalytics, ProviderAdapterError> {
  return withAdapterMethod(
    adapter.getAccountAnalytics,
    "account_analytics",
    context,
    (getAccountAnalytics, child) => getAccountAnalytics(child, credentials),
  );
}

/**
 * Lists provider analytics records through the adapter as a typed Effect.
 * Pure read: safe to retry via `withReadRetry` on transient/timeout
 * failures. Rate-limit failures propagate untouched to the worker due-work
 * scheduler with their `retryAfterSeconds` hint.
 * Returns Effect resolving to the analytics page.
 */
export function listAnalyticsEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  lookup: ProviderPublicationLookup,
  page: ProviderPageInput,
): Effect.Effect<ProviderPage<ProviderAnalyticsRecord>, ProviderAdapterError> {
  return withAdapterMethod(
    adapter.listAnalytics,
    "list_analytics",
    context,
    (listAnalytics, child) => listAnalytics(child, credentials, lookup, page),
  );
}

/**
 * Lists provider comment records through the adapter as a typed Effect.
 * Pure read: safe to retry via `withReadRetry` on transient/timeout
 * failures. Rate-limit failures propagate untouched to the worker due-work
 * scheduler with their `retryAfterSeconds` hint.
 * Returns Effect resolving to the comments page.
 */
export function listCommentsEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
  lookup: ProviderPublicationLookup,
  page: ProviderPageInput,
): Effect.Effect<ProviderPage<ProviderCommentRecord>, ProviderAdapterError> {
  return withAdapterMethod(adapter.listComments, "list_comments", context, (listComments, child) =>
    listComments(child, credentials, lookup, page),
  );
}

/**
 * Fetches TikTok publication requirements through the adapter as a typed Effect.
 * Pure read: safe to retry via `withReadRetry` on transient/timeout failures.
 * Returns Effect resolving to the publication requirements.
 */
export function getPublicationRequirementsEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  credentials: ProviderCredentials,
): Effect.Effect<ProviderPublicationRequirements, ProviderAdapterError> {
  return withAdapterMethod(
    adapter.getPublicationRequirements,
    "publication_requirements",
    context,
    (getPublicationRequirements, child) => getPublicationRequirements(child, credentials),
  );
}

/**
 * Exchanges an OAuth authorization code through the adapter as a typed Effect.
 * Executes exactly once: token issuance is a credential mutation with no
 * proven remote idempotency, so callers must not retry timeouts. Token
 * responses stay in the typed OAuthConnection; tokens are never logged
 * (see `failureDiagnostic` for the log-safe projection).
 * Returns Effect resolving to the OAuth exchange result.
 */
export function exchangeAuthorizationCodeEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  input: OAuthExchangeInput,
): Effect.Effect<OAuthExchangeResult, ProviderAdapterError> {
  return withAdapterMethod(
    adapter.exchangeAuthorizationCode,
    "exchange_authorization_code",
    context,
    (exchangeAuthorizationCode, child) => exchangeAuthorizationCode(child, input),
  );
}

/**
 * Refreshes a provider access token through the adapter as a typed Effect.
 * Executes exactly once: refresh failures surface as auth-classified
 * ProviderAdapterError values for the caller to re-authenticate, never as
 * retries. Token behavior is otherwise unchanged.
 * Returns Effect resolving to the new token set.
 */
export function refreshAccessTokenEffect(
  adapter: ProviderAdapter,
  context: ProviderRequestContext,
  refreshToken: string,
): Effect.Effect<ProviderTokenSet, ProviderAdapterError> {
  return withAdapterMethod(
    adapter.refreshAccessToken,
    "refresh_access_token",
    context,
    (refreshAccessToken, child) => refreshAccessToken(child, refreshToken),
  );
}

/**
 * Revokes credentials exactly once through the abortable adapter boundary.
 * A synthetic operation context supplies cancellation for token-only callers.
 * No retry follows an ambiguous response or timeout.
 */
export function revokeEffect(
  adapter: ProviderAdapter,
  accessToken: string,
): Effect.Effect<void, ProviderAdapterError> {
  return withAdapterMethod(
    adapter.revoke,
    "revoke",
    { operationId: "oauth-revoke", requestId: "oauth-revoke" },
    (revoke, child) => revoke(accessToken, child),
  );
}

/**
 * Reports whether an Effect failure is eligible for inner Effect retries.
 * Only `timeout` and `transient` failures pass. `rate_limit` is deliberately
 * excluded even though marked retryable: its `retryAfterSeconds` hint belongs
 * to the worker due-work scheduler, and an inner fixed backoff would compete
 * with (and undercut) the provider's requested delay. `ambiguous`,
 * `deterministic`, `auth`, and `quota` failures stop immediately.
 * Returns true only for safe inner read retries. Example: HTTP 503 → true,
 * HTTP 429 → false (deferred to due-work), HTTP 400 → false, ambiguous
 * timeout-after-write → false.
 */
export function isRetryableFailure(error: unknown): boolean {
  return (
    error instanceof ProviderAdapterError &&
    error.failure.retryable &&
    (error.failure.classification === "timeout" || error.failure.classification === "transient")
  );
}

/**
 * Builds an Effect retry schedule from an adapter retry policy.
 * Combines exponential backoff (each delay capped at maxDelaySeconds) with an
 * output ceiling of maxAttempts total tries, preserving the schedule's delay
 * behavior. The schedule itself is failure-agnostic: callers pair it with
 * `Effect.retry`'s `while` guard (`isRetryableFailure`) so the first
 * deterministic, auth, quota, rate-limit, or ambiguous failure stops retries
 * immediately with that failure preserved. Inner retries use policy backoff
 * only; the provider Retry-After hint stays on the failure for the outer
 * due-work scheduler (workers read `retryAfterSeconds` when parking the next
 * attempt), so honoring it is unchanged from the Promise path and there is
 * exactly one scheduler per rate-limit response.
 * Returns a Duration schedule for `Effect.retry`.
 */
export function readRetrySchedule(
  policy: ProviderRetryPolicy,
): Schedule.Schedule<Duration.Duration> {
  const base = Duration.millis(policy.baseDelaySeconds * 1_000);
  const cap = Duration.millis(policy.maxDelaySeconds * 1_000);
  return Schedule.exponential(base).pipe(
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, cap))),
    Schedule.upTo({ times: Math.max(policy.maxAttempts - 1, 0) }),
  );
}

/**
 * Retries a read-only provider Effect under an adapter retry policy.
 * Only transient/timeout failures consume retries; the first deterministic,
 * auth, quota, rate-limit, or ambiguous failure stops the schedule
 * immediately with that failure preserved. Rate-limit failures in particular
 * propagate with their `retryAfterSeconds` hint untouched, leaving exactly
 * one owner (the worker due-work scheduler) for rate-limit backoff.
 * Returns Effect resolving to the read result. Example: flaky analytics list
 * failing twice with HTTP 500 then succeeding resolves on attempt three.
 */
export function withReadRetry<A>(
  effect: Effect.Effect<A, ProviderAdapterError>,
  policy: ProviderRetryPolicy,
): Effect.Effect<A, ProviderAdapterError> {
  return Effect.retry(effect, {
    schedule: readRetrySchedule(policy),
    while: isRetryableFailure,
  });
}

/**
 * Effect service shape exposing worker-facing provider operations.
 * Keeps provider-specific branching inside `packages/providers`: generic
 * workers select a platform and compose Effects without learning per-provider
 * rules, OAuth shapes, or transfer modes. Write operations execute exactly
 * once; only read operations are eligible for `withReadRetry`, and only on
 * transient/timeout failures.
 */
export interface ProviderServiceShape {
  readonly getBroadcastInfo: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
  ) => Effect.Effect<ProviderBroadcastInfo, ProviderAdapterError>;
  readonly endBroadcast: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
  ) => Effect.Effect<ProviderOperationResult, ProviderAdapterError>;
  readonly cancelPublication: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
  ) => Effect.Effect<ProviderOperationResult, ProviderAdapterError>;
  readonly exchangeAuthorizationCode: (
    platform: Platform,
    context: ProviderRequestContext,
    input: OAuthExchangeInput,
  ) => Effect.Effect<OAuthExchangeResult, ProviderAdapterError>;
  readonly getAccountAnalytics: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
  ) => Effect.Effect<ProviderAccountAnalytics, ProviderAdapterError>;
  readonly getPublicationRequirements: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
  ) => Effect.Effect<ProviderPublicationRequirements, ProviderAdapterError>;
  readonly listAnalytics: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
    page: ProviderPageInput,
  ) => Effect.Effect<ProviderPage<ProviderAnalyticsRecord>, ProviderAdapterError>;
  readonly listComments: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
    page: ProviderPageInput,
  ) => Effect.Effect<ProviderPage<ProviderCommentRecord>, ProviderAdapterError>;
  readonly lookupPublication: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
  ) => Effect.Effect<ProviderPublicationStatus, ProviderAdapterError>;
  readonly publish: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    input: PublishInput,
  ) => Effect.Effect<ProviderOperationResult, ProviderAdapterError>;
  readonly refreshAccessToken: (
    platform: Platform,
    context: ProviderRequestContext,
    refreshToken: string,
  ) => Effect.Effect<ProviderTokenSet, ProviderAdapterError>;
  readonly reply: (
    platform: Platform,
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    input: ProviderReplyInput,
  ) => Effect.Effect<ProviderOperationResult, ProviderAdapterError>;
  readonly revoke: (
    platform: Platform,
    accessToken: string,
  ) => Effect.Effect<void, ProviderAdapterError>;
}

/**
 * Effect service tag for application-facing provider operations.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "ProviderService",
) {}

/**
 * Structural adapter source: anything exposing `get` (notably ProviderRegistry)
 * without importing the registry module, avoiding an index/effect import cycle.
 */
export interface ProviderAdapterSource {
  get(platform: Platform): ProviderAdapter | undefined;
}

function resolveAdapter(
  source: ProviderAdapterSource,
  platform: Platform,
): Effect.Effect<ProviderAdapter, ProviderAdapterError> {
  const adapter = source.get(platform);
  return adapter
    ? Effect.succeed(adapter)
    : Effect.fail(
        new ProviderAdapterError(
          classifyProviderFailure({
            code: "provider_not_configured",
            status: 400,
          }),
        ),
      );
}

function makeProviderService(source: ProviderAdapterSource): ProviderServiceShape {
  const on = <A>(
    platform: Platform,
    run: (adapter: ProviderAdapter) => Effect.Effect<A, ProviderAdapterError>,
  ): Effect.Effect<A, ProviderAdapterError> =>
    Effect.flatMap(resolveAdapter(source, platform), run);

  return {
    getBroadcastInfo: (platform, context, credentials, lookup) =>
      on(platform, (adapter) =>
        withAdapterMethod(adapter.getBroadcastInfo, "broadcast_info", context, (fn, child) =>
          fn(child, credentials, lookup),
        ),
      ),
    endBroadcast: (platform, context, credentials, lookup) =>
      on(platform, (adapter) =>
        withAdapterMethod(adapter.endBroadcast, "end_broadcast", context, (fn, child) =>
          fn(child, credentials, lookup),
        ),
      ),
    cancelPublication: (platform, context, credentials, lookup) =>
      on(platform, (adapter) => cancelPublicationEffect(adapter, context, credentials, lookup)),
    exchangeAuthorizationCode: (platform, context, input) =>
      on(platform, (adapter) => exchangeAuthorizationCodeEffect(adapter, context, input)),
    getAccountAnalytics: (platform, context, credentials) =>
      on(platform, (adapter) => getAccountAnalyticsEffect(adapter, context, credentials)),
    getPublicationRequirements: (platform, context, credentials) =>
      on(platform, (adapter) => getPublicationRequirementsEffect(adapter, context, credentials)),
    listAnalytics: (platform, context, credentials, lookup, page) =>
      on(platform, (adapter) => listAnalyticsEffect(adapter, context, credentials, lookup, page)),
    listComments: (platform, context, credentials, lookup, page) =>
      on(platform, (adapter) => listCommentsEffect(adapter, context, credentials, lookup, page)),
    lookupPublication: (platform, context, credentials, lookup) =>
      on(platform, (adapter) => lookupPublicationEffect(adapter, context, credentials, lookup)),
    publish: (platform, context, credentials, input) =>
      on(platform, (adapter) => publishEffect(adapter, context, credentials, input)),
    refreshAccessToken: (platform, context, refreshToken) =>
      on(platform, (adapter) => refreshAccessTokenEffect(adapter, context, refreshToken)),
    reply: (platform, context, credentials, input) =>
      on(platform, (adapter) => replyEffect(adapter, context, credentials, input)),
    revoke: (platform, accessToken) =>
      on(platform, (adapter) => revokeEffect(adapter, accessToken)),
  };
}

/**
 * Creates the live ProviderService Layer over a configured adapter source.
 * Backed by the real ProviderRegistry in production; provider HTTP behavior,
 * error normalization, and retry policies are unchanged from the Promise path.
 * Returns a Layer providing ProviderService with no requirements.
 */
export function createProviderServiceLive(
  source: ProviderAdapterSource,
): Layer.Layer<ProviderService> {
  return Layer.succeed(ProviderService, makeProviderService(source));
}

/**
 * Creates a test ProviderService Layer backed by caller-supplied fake adapters.
 * Fakes use the plain ProviderAdapter interface (Promise methods), so existing
 * stub style carries over; Effect callers compose against the same service
 * shape as production. Unlisted platforms fail `provider_not_configured`.
 * Returns a Layer providing ProviderService with no requirements.
 */
export function createProviderServiceTest(
  adapters: Partial<Record<Platform, ProviderAdapter>>,
): Layer.Layer<ProviderService> {
  const source: ProviderAdapterSource = {
    get: (platform) => adapters[platform],
  };
  return Layer.succeed(ProviderService, makeProviderService(source));
}
