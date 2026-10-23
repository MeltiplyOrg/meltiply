import type { Platform } from "@meltiply/domain";
import { Context, Duration, Effect, Layer, Schedule } from "effect";

import { classifyProviderFailure, ProviderAdapterError } from "./failures";
import type {
  OAuthExchangeInput,
  OAuthExchangeResult,
  ProviderAdapter,
  ProviderAnalyticsRecord,
  ProviderCommentRecord,
  ProviderCredentials,
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

/**
 * Fails with a deterministic non-retryable `provider_unsupported` error.
 * Used when an adapter does not implement an optional capability method, so
 * Effect callers observe a typed failure instead of a TypeError on undefined.
 * Returns a failing Effect; never resolves.
 */
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
  if (!adapter.publish) return unsupported("publish");
  return providerCallEffect(context, (child) => adapter.publish!(child, credentials, input));
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
  if (!adapter.lookupPublication) return unsupported("lookup_publication");
  return providerCallEffect(context, (child) =>
    adapter.lookupPublication!(child, credentials, lookup),
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
  if (!adapter.cancelPublication) return unsupported("cancel_publication");
  return providerCallEffect(context, (child) =>
    adapter.cancelPublication!(child, credentials, lookup),
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
  if (!adapter.reply) return unsupported("reply");
  return providerCallEffect(context, (child) => adapter.reply!(child, credentials, input));
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
  if (!adapter.listAnalytics) return unsupported("list_analytics");
  return providerCallEffect(context, (child) =>
    adapter.listAnalytics!(child, credentials, lookup, page),
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
  if (!adapter.listComments) return unsupported("list_comments");
  return providerCallEffect(context, (child) =>
    adapter.listComments!(child, credentials, lookup, page),
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
  if (!adapter.getPublicationRequirements) {
    return unsupported("publication_requirements");
  }
  return providerCallEffect(context, (child) =>
    adapter.getPublicationRequirements!(child, credentials),
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
  if (!adapter.exchangeAuthorizationCode) {
    return unsupported("exchange_authorization_code");
  }
  return providerCallEffect(context, (child) => adapter.exchangeAuthorizationCode!(child, input));
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
  if (!adapter.refreshAccessToken) return unsupported("refresh_access_token");
  return providerCallEffect(context, (child) => adapter.refreshAccessToken!(child, refreshToken));
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
  if (!adapter.revoke) return unsupported("revoke");
  return providerCallEffect({ operationId: "oauth-revoke", requestId: "oauth-revoke" }, (context) =>
    adapter.revoke!(accessToken, context),
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
 * Projects a provider failure into a log-safe diagnostic record.
 * Projects only canonical failure fields and credential-free request metadata.
 * Raw causes remain on the Error for the shared error serializer, never in this
 * context record. Returns classification, code, retryability, request facts, and
 * any missing public OAuth scope names so a grant problem is named in logs.
 */
export function failureDiagnostic(error: ProviderAdapterError): {
  classification: ProviderAdapterError["failure"]["classification"];
  code: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  request?: ProviderAdapterError["request"];
  missing_scopes?: readonly string[];
} {
  const { classification, code, retryable, retryAfterSeconds } = error.failure;
  return {
    classification,
    code,
    retryable,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(error.request ? { request: error.request } : {}),
    ...(error.missingScopes ? { missing_scopes: error.missingScopes } : {}),
  };
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

/**
 * Resolves the adapter for a platform or fails typed when unconfigured.
 * Missing platforms surface as deterministic non-retryable
 * `provider_not_configured` failures rather than undefined dereferences.
 * Returns Effect resolving to the registered adapter.
 */
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

/**
 * Builds the ProviderService implementation over an adapter source.
 * Each method resolves the platform adapter then delegates to the matching
 * Effect wrapper, so provider-specific logic stays inside the adapters while
 * workers compose a uniform Effect interface.
 * Returns the service implementation.
 */
function makeProviderService(source: ProviderAdapterSource): ProviderServiceShape {
  return {
    cancelPublication: (platform, context, credentials, lookup) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        cancelPublicationEffect(adapter, context, credentials, lookup),
      ),
    exchangeAuthorizationCode: (platform, context, input) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        exchangeAuthorizationCodeEffect(adapter, context, input),
      ),
    getPublicationRequirements: (platform, context, credentials) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        getPublicationRequirementsEffect(adapter, context, credentials),
      ),
    listAnalytics: (platform, context, credentials, lookup, page) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        listAnalyticsEffect(adapter, context, credentials, lookup, page),
      ),
    listComments: (platform, context, credentials, lookup, page) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        listCommentsEffect(adapter, context, credentials, lookup, page),
      ),
    lookupPublication: (platform, context, credentials, lookup) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        lookupPublicationEffect(adapter, context, credentials, lookup),
      ),
    publish: (platform, context, credentials, input) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        publishEffect(adapter, context, credentials, input),
      ),
    refreshAccessToken: (platform, context, refreshToken) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        refreshAccessTokenEffect(adapter, context, refreshToken),
      ),
    reply: (platform, context, credentials, input) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        replyEffect(adapter, context, credentials, input),
      ),
    revoke: (platform, accessToken) =>
      Effect.flatMap(resolveAdapter(source, platform), (adapter) =>
        revokeEffect(adapter, accessToken),
      ),
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
