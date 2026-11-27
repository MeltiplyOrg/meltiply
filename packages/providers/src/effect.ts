import type { Platform } from "@meltiply/domain";
import { Context, Duration, Effect, Layer, Schedule } from "effect";

import { classifyProviderFailure, ProviderAdapterError, rejected } from "./failures";
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
  return Effect.fail(rejected(`provider_unsupported_${method}`));
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

function isRetryableFailure(error: unknown): boolean {
  return (
    error instanceof ProviderAdapterError &&
    error.failure.retryable &&
    (error.failure.classification === "timeout" || error.failure.classification === "transient")
  );
}

function readRetrySchedule(policy: ProviderRetryPolicy): Schedule.Schedule<Duration.Duration> {
  const base = Duration.millis(policy.baseDelaySeconds * 1_000);
  const cap = Duration.millis(policy.maxDelaySeconds * 1_000);
  return Schedule.exponential(base).pipe(
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, cap))),
    Schedule.upTo({ times: Math.max(policy.maxAttempts - 1, 0) }),
  );
}

export function withReadRetry<A>(
  effect: Effect.Effect<A, ProviderAdapterError>,
  policy: ProviderRetryPolicy,
): Effect.Effect<A, ProviderAdapterError> {
  return Effect.retry(effect, {
    schedule: readRetrySchedule(policy),
    while: isRetryableFailure,
  });
}

/** Worker-facing Effect boundary: writes execute once and reconcile; only reads are eligible for `withReadRetry`. */
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

export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "ProviderService",
) {}

export interface ProviderAdapterSource {
  get(platform: Platform): ProviderAdapter | undefined;
}

function resolveAdapter(
  source: ProviderAdapterSource,
  platform: Platform,
): Effect.Effect<ProviderAdapter, ProviderAdapterError> {
  const adapter = source.get(platform);
  return adapter ? Effect.succeed(adapter) : Effect.fail(rejected("provider_not_configured"));
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
      on(platform, (adapter) =>
        withAdapterMethod(adapter.cancelPublication, "cancel_publication", context, (fn, child) =>
          fn(child, credentials, lookup),
        ),
      ),
    exchangeAuthorizationCode: (platform, context, input) =>
      on(platform, (adapter) =>
        withAdapterMethod(
          adapter.exchangeAuthorizationCode,
          "exchange_authorization_code",
          context,
          (fn, child) => fn(child, input),
        ),
      ),
    getAccountAnalytics: (platform, context, credentials) =>
      on(platform, (adapter) =>
        withAdapterMethod(adapter.getAccountAnalytics, "account_analytics", context, (fn, child) =>
          fn(child, credentials),
        ),
      ),
    getPublicationRequirements: (platform, context, credentials) =>
      on(platform, (adapter) =>
        withAdapterMethod(
          adapter.getPublicationRequirements,
          "publication_requirements",
          context,
          (fn, child) => fn(child, credentials),
        ),
      ),
    listAnalytics: (platform, context, credentials, lookup, page) =>
      on(platform, (adapter) => listAnalyticsEffect(adapter, context, credentials, lookup, page)),
    listComments: (platform, context, credentials, lookup, page) =>
      on(platform, (adapter) =>
        withAdapterMethod(adapter.listComments, "list_comments", context, (fn, child) =>
          fn(child, credentials, lookup, page),
        ),
      ),
    lookupPublication: (platform, context, credentials, lookup) =>
      on(platform, (adapter) =>
        withAdapterMethod(adapter.lookupPublication, "lookup_publication", context, (fn, child) =>
          fn(child, credentials, lookup),
        ),
      ),
    publish: (platform, context, credentials, input) =>
      on(platform, (adapter) => publishEffect(adapter, context, credentials, input)),
    refreshAccessToken: (platform, context, refreshToken) =>
      on(platform, (adapter) =>
        withAdapterMethod(
          adapter.refreshAccessToken,
          "refresh_access_token",
          context,
          (fn, child) => fn(child, refreshToken),
        ),
      ),
    reply: (platform, context, credentials, input) =>
      on(platform, (adapter) =>
        withAdapterMethod(adapter.reply, "reply", context, (fn, child) =>
          fn(child, credentials, input),
        ),
      ),
    revoke: (platform, accessToken) =>
      on(platform, (adapter) => revokeEffect(adapter, accessToken)),
  };
}

export function createProviderServiceLive(
  source: ProviderAdapterSource,
): Layer.Layer<ProviderService> {
  return Layer.succeed(ProviderService, makeProviderService(source));
}

export function createProviderServiceTest(
  adapters: Partial<Record<Platform, ProviderAdapter>>,
): Layer.Layer<ProviderService> {
  return Layer.succeed(ProviderService, makeProviderService({ get: (p) => adapters[p] }));
}
