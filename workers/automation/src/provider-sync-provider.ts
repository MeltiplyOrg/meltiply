import type { Platform } from "@meltiply/domain";
import { Effect } from "effect";
import {
  classifyProviderFailure,
  normalizeProviderFailure,
  ProviderAdapterError,
  ProviderService,
  type ProviderAdapter,
  type ProviderAnalyticsRecord,
  type ProviderCommentRecord,
  type ProviderFailure,
  type ProviderPage,
  type ProviderRequestContext,
  type ProviderRetryPolicy,
  type ProviderTokenSet,
  type ProviderRegistry,
} from "@meltiply/providers";
import { normalizeIdentifier } from "./validation";

export interface ProviderReadTarget {
  connectionStatus: string;
  cursor: string | null;
  platform: Platform;
  providerAccountId?: string;
  providerPostId: string;
  storedAccessToken: string;
  tokenExpiresAt: Date | null;
}

interface ProviderRefreshTarget {
  platform: Platform;
  storedAccessToken: string;
  storedRefreshToken: string | null;
}

export type ProviderReadExecution<T> =
  | {
      outcome: "failure";
      failure: ProviderFailure;
      retryPolicy?: ProviderRetryPolicy;
    }
  | {
      outcome: "success";
      page: ProviderPage<T>;
      retryPolicy?: ProviderRetryPolicy;
    };

export type ProviderRefreshExecution =
  | {
      outcome: "failure";
      failure: ProviderFailure;
      retryPolicy?: ProviderRetryPolicy;
    }
  | {
      outcome: "success";
      tokens: ProviderTokenSet;
      retryPolicy?: ProviderRetryPolicy;
    };

export interface ProviderSyncDependencies {
  decryptToken: (storedToken: string) => Promise<string>;
}

type ProviderExecutionFailure = {
  outcome: "failure";
  failure: ProviderFailure;
  retryPolicy?: ProviderRetryPolicy;
};

/**
 * Constructs a standardized provider execution failure descriptor.
 *
 * @param code - Error code categorizing the failure cause.
 * @param status - HTTP response status code to map into provider failure classification.
 * @param retryPolicy - Optional adapter retry policy governing backoff or dead-lettering.
 * @returns Standardized failure outcome object with classified failure attributes.
 */
function failure(
  code: string,
  status: number,
  retryPolicy?: ProviderRetryPolicy,
): ProviderExecutionFailure {
  return {
    failure: classifyProviderFailure({ code, status }),
    outcome: "failure",
    ...(retryPolicy ? { retryPolicy } : {}),
  };
}

/**
 * Maps a caught exception or generic error into a standardized provider failure outcome.
 *
 * Preserves structured provider adapter error details when available, except for generic
 * `provider_unexpected` adapter errors which fall back to the workload-specific code
 * to preserve retryability semantics for unexpected throws.
 *
 * @param cause - Intercepted exception or error object.
 * @param code - Fallback error code used when the error is unknown or unexpected.
 * @param retryPolicy - Optional adapter retry policy for retry delay calculations.
 * @returns Standardized failure outcome object with normalized failure classification.
 */
function caughtFailure(
  cause: unknown,
  code: string,
  retryPolicy?: ProviderRetryPolicy,
): ProviderExecutionFailure {
  return {
    failure:
      cause instanceof ProviderAdapterError && cause.failure.code !== "provider_unexpected"
        ? normalizeProviderFailure(cause.failure)
        : classifyProviderFailure({ code }),
    outcome: "failure",
    ...(retryPolicy ? { retryPolicy } : {}),
  };
}

/**
 * Validates that an untrusted value is a string within length bounds.
 *
 * @param value - Untrusted value to validate.
 * @param maximum - Maximum permissible character length.
 * @param allowEmpty - When false, rejects whitespace-only or empty strings. Defaults to false.
 * @returns Validated string value, or undefined if invalid or exceeds bounds.
 */
function boundedText(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || value.length > maximum) return undefined;
  if (!allowEmpty && value.trim().length === 0) return undefined;
  return value;
}

/**
 * Validates and normalizes an untrusted timestamp value into an ISO 8601 string.
 *
 * @param value - String value representing a date/time.
 * @returns Standardized ISO string, or undefined if not a string or represents an invalid date.
 */
function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

/**
 * Validates that an untrusted metric value is a non-negative safe integer.
 *
 * @param value - Untrusted value to inspect.
 * @returns Verified non-negative integer, or undefined if non-numeric, negative, or unsafe.
 */
function metric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Validates a provider pagination cursor string.
 *
 * Ensures the cursor is non-empty, within 4096 characters, and contains no control characters.
 *
 * @param value - Untrusted cursor value.
 * @returns Validated cursor string, or undefined if invalid.
 */
function cursor(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

/**
 * Normalizes and validates an analytics page returned from a provider adapter.
 *
 * Verifies that the item collection is bounded (maximum 100 items), items match the
 * expected provider post ID, and all engagement metrics are valid non-negative integers.
 *
 * @param page - Raw analytics page object returned by the provider adapter.
 * @param providerPostId - Expected platform post identifier to enforce matching attribution.
 * @returns Cleaned and validated analytics page, or undefined if malformed or mismatched.
 */
function normalizeAnalytics(
  page: ProviderPage<ProviderAnalyticsRecord>,
  providerPostId: string,
): ProviderPage<ProviderAnalyticsRecord> | undefined {
  if (!page || !Array.isArray(page.items) || page.items.length > 100) {
    return undefined;
  }
  const items: ProviderAnalyticsRecord[] = [];
  for (const item of page.items) {
    const normalizedPostId = normalizeIdentifier(item?.providerPostId);
    const recordedAt = timestamp(item?.recordedAt);
    const values = [
      metric(item?.comments),
      metric(item?.impressions),
      metric(item?.likes),
      metric(item?.reach),
      metric(item?.shares),
      metric(item?.views),
      metric(item?.watchTimeSeconds),
    ];
    if (
      normalizedPostId !== providerPostId ||
      !recordedAt ||
      values.some((value) => value === undefined)
    ) {
      return undefined;
    }
    items.push({
      comments: values[0]!,
      impressions: values[1]!,
      likes: values[2]!,
      providerPostId: normalizedPostId,
      reach: values[3]!,
      recordedAt,
      shares: values[4]!,
      views: values[5]!,
      watchTimeSeconds: values[6]!,
    });
  }
  const nextCursor = page.nextCursor === undefined ? undefined : cursor(page.nextCursor);
  if (page.nextCursor !== undefined && !nextCursor) return undefined;
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

/**
 * Normalizes and validates a comments page returned from a provider adapter.
 *
 * Deduplicates comments by identifier, enforces string length limits, validates HTTPS avatar
 * URLs, and ensures all comments belong to the requested post identifier.
 *
 * @param page - Raw comment page returned by the provider adapter.
 * @param providerPostId - Expected platform post identifier to enforce matching attribution.
 * @returns Cleaned and validated comment page, or undefined if invalid or contains duplicates.
 */
function normalizeComments(
  page: ProviderPage<ProviderCommentRecord>,
  providerPostId: string,
): ProviderPage<ProviderCommentRecord> | undefined {
  if (!page || !Array.isArray(page.items) || page.items.length > 100) {
    return undefined;
  }
  const identifiers = new Set<string>();
  const items: ProviderCommentRecord[] = [];
  for (const item of page.items) {
    const providerCommentId = normalizeIdentifier(item?.providerCommentId);
    const normalizedPostId = normalizeIdentifier(item?.providerPostId);
    const body = boundedText(item?.body, 10_000, true);
    const commentedAt = timestamp(item?.commentedAt);
    const authorDisplayName =
      item?.authorDisplayName === undefined ? undefined : boundedText(item.authorDisplayName, 500);
    let authorAvatarUrl: string | undefined;
    if (item?.authorAvatarUrl !== undefined) {
      try {
        const parsed = new URL(item.authorAvatarUrl);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
          return undefined;
        }
        parsed.search = "";
        parsed.hash = "";
        authorAvatarUrl = parsed.toString();
      } catch {
        return undefined;
      }
    }
    if (
      !providerCommentId ||
      identifiers.has(providerCommentId) ||
      normalizedPostId !== providerPostId ||
      body === undefined ||
      !commentedAt ||
      (item?.authorDisplayName !== undefined && !authorDisplayName)
    ) {
      return undefined;
    }
    identifiers.add(providerCommentId);
    items.push({
      ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
      ...(authorDisplayName ? { authorDisplayName } : {}),
      body,
      commentedAt,
      providerCommentId,
      providerPostId: normalizedPostId,
    });
  }
  const nextCursor = page.nextCursor === undefined ? undefined : cursor(page.nextCursor);
  if (page.nextCursor !== undefined && !nextCursor) return undefined;
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

/**
 * Decrypts and validates the access token for a provider read target.
 *
 * Enforces that the provider connection status is active ('connected') and the stored token
 * has not passed its expiration timestamp.
 *
 * @param target - Provider read target containing connection status and encrypted credentials.
 * @param dependencies - Helper providing token decryption capabilities.
 * @param now - Current reference timestamp for evaluating expiration.
 * @returns Decrypted access token string, or undefined if disconnected or expired.
 */
async function credentials(
  target: ProviderReadTarget,
  dependencies: ProviderSyncDependencies,
  now: Date,
): Promise<string | undefined> {
  if (
    target.connectionStatus !== "connected" ||
    (target.tokenExpiresAt !== null && target.tokenExpiresAt <= now)
  ) {
    return undefined;
  }
  const accessToken = await dependencies.decryptToken(target.storedAccessToken);
  return accessToken.trim() || undefined;
}

/**
 * Executes a protected read request against a provider adapter as an Effect program.
 *
 * Effect-first core: checks adapter capability, decrypts stored access credentials
 * via Effect.tryPromise, then runs the read Effect and classifies caught errors into
 * structured failure outcomes. Read Effects execute exactly once; existing durable
 * due-work scheduling owns retry/backoff. Requires ProviderService when the caller
 * passes a service-backed read Effect (analytics/comments do).
 *
 * @param adapter - Platform adapter implementation, if available.
 * @param available - Boolean indicating whether the specific read capability is supported.
 * @param target - Target social account credentials and post details.
 * @param dependencies - Injected dependencies including token decryption.
 * @param now - Current reference timestamp for credential validity checks.
 * @param codes - Classification error codes for unavailable, preparation, invalid, or failed requests.
 * @param read - Callback building the provider read Effect given a decrypted access token.
 * @returns Effect resolving to success with page data or structured failure; never fails.
 */
function executeProviderReadEffect<T, R>(
  adapter: ProviderAdapter | undefined,
  available: boolean,
  target: ProviderReadTarget,
  dependencies: ProviderSyncDependencies,
  now: Date,
  codes: {
    failed: string;
    invalidResponse: string;
    preparation: string;
    unavailable: string;
  },
  read: (
    accessToken: string,
  ) => Effect.Effect<ProviderPage<T> | undefined, ProviderAdapterError, R>,
): Effect.Effect<ProviderReadExecution<T>, never, R> {
  if (!adapter || !available) {
    return Effect.succeed(failure(codes.unavailable, 422));
  }
  return Effect.catch(
    Effect.gen(function* () {
      const accessToken = yield* Effect.tryPromise({
        catch: () => caughtFailure(undefined, codes.preparation, adapter.retryPolicy),
        try: () => credentials(target, dependencies, now),
      });
      if (!accessToken) {
        return failure("provider_reconnect_required", 401, adapter.retryPolicy);
      }
      const page = yield* Effect.mapError(read(accessToken), (cause) =>
        caughtFailure(cause, codes.failed, adapter.retryPolicy),
      );
      return page
        ? { outcome: "success", page, retryPolicy: adapter.retryPolicy }
        : caughtFailure(undefined, codes.invalidResponse, adapter.retryPolicy);
    }),
    (failureExecution: ProviderReadExecution<T>) => Effect.succeed(failureExecution),
  );
}

/**
 * Fetches and normalizes social post analytics as an Effect program.
 *
 * Requires the caller's ProviderService: verifies capability, decrypts
 * credentials, and retrieves engagement metrics up to 100 entries without
 * creating a separate fiber or replacing the supplied service.
 *
 * @param registry - Provider adapter registry mapping platforms to implementations.
 * @param context - Request context containing tracing and logger metadata.
 * @param target - Post target descriptor including account credentials and post ID.
 * @param dependencies - Dependencies for token decryption.
 * @param now - Reference timestamp defaulting to current time.
 * @returns Effect resolving to validated metrics page or classified failure.
 */
export function executeProviderAnalyticsEffect(
  registry: ProviderRegistry,
  context: ProviderRequestContext,
  target: ProviderReadTarget,
  dependencies: ProviderSyncDependencies,
  now = new Date(),
): Effect.Effect<ProviderReadExecution<ProviderAnalyticsRecord>, never, ProviderService> {
  const adapter = registry.get(target.platform);
  return executeProviderReadEffect(
    adapter,
    Boolean(adapter?.listAnalytics && adapter.capability.analytics),
    target,
    dependencies,
    now,
    {
      failed: "provider_analytics_failed",
      invalidResponse: "provider_analytics_invalid_response",
      preparation: "provider_analytics_preparation_failed",
      unavailable: "provider_analytics_unavailable",
    },
    (accessToken: string) =>
      Effect.flatMap(ProviderService, (service) =>
        Effect.map(
          service.listAnalytics(
            target.platform,
            context,
            {
              accessToken,
              ...(target.providerAccountId ? { accountId: target.providerAccountId } : {}),
            },
            { providerPostId: target.providerPostId },
            {
              ...(target.cursor ? { cursor: target.cursor } : {}),
              limit: 100,
            },
          ),
          (page) => normalizeAnalytics(page, target.providerPostId),
        ),
      ),
  );
}

/**
 * Fetches and sanitizes social post comments as an Effect program.
 *
 * Requires the caller's ProviderService: decrypts credentials, lists comments,
 * deduplicates comment IDs, and bounds body/author metadata without creating
 * a separate fiber or replacing the supplied service.
 *
 * @param registry - Provider adapter registry mapping platforms to implementations.
 * @param context - Request context containing tracing and logger metadata.
 * @param target - Post target descriptor including account credentials, post ID, and cursor.
 * @param dependencies - Dependencies for token decryption.
 * @param now - Reference timestamp defaulting to current time.
 * @returns Effect resolving to validated comments page or classified failure.
 */
export function executeProviderCommentsEffect(
  registry: ProviderRegistry,
  context: ProviderRequestContext,
  target: ProviderReadTarget,
  dependencies: ProviderSyncDependencies,
  now = new Date(),
): Effect.Effect<ProviderReadExecution<ProviderCommentRecord>, never, ProviderService> {
  const adapter = registry.get(target.platform);
  return executeProviderReadEffect(
    adapter,
    Boolean(adapter?.listComments && adapter.capability.comments),
    target,
    dependencies,
    now,
    {
      failed: "provider_comments_failed",
      invalidResponse: "provider_comments_invalid_response",
      preparation: "provider_comments_preparation_failed",
      unavailable: "provider_comments_unavailable",
    },
    (accessToken: string) =>
      Effect.flatMap(ProviderService, (service) =>
        Effect.map(
          service.listComments(
            target.platform,
            context,
            {
              accessToken,
              ...(target.providerAccountId ? { accountId: target.providerAccountId } : {}),
            },
            { providerPostId: target.providerPostId },
            {
              ...(target.cursor ? { cursor: target.cursor } : {}),
              limit: 100,
            },
          ),
          (page) => normalizeComments(page, target.providerPostId),
        ),
      ),
  );
}

/**
 * Refreshes an expired or expiring OAuth access token as an Effect program.
 *
 * Effect-first core requiring ProviderService: decrypts the stored refresh token
 * (or fallback access token), invokes provider token refresh, and validates that
 * new access tokens and any present future expiration timestamps are valid.
 * Absent expiry stays absent; malformed results and provider failures retain
 * their classified outcomes so callers can retry or request reauthentication.
 *
 * @param registry - Provider adapter registry mapping platforms to implementations.
 * @param context - Request context containing tracing and logger metadata.
 * @param target - Refresh target containing platform and encrypted token secrets.
 * @param dependencies - Dependencies for token decryption.
 * @param now - Reference timestamp defaulting to current time.
 * @returns Effect resolving to new tokens (with optional expiration) or classified failure.
 */
export function executeProviderTokenRefreshEffect(
  registry: ProviderRegistry,
  context: ProviderRequestContext,
  target: ProviderRefreshTarget,
  dependencies: ProviderSyncDependencies,
  now = new Date(),
): Effect.Effect<ProviderRefreshExecution, never, ProviderService> {
  const adapter = registry.get(target.platform);
  if (!adapter?.refreshAccessToken) {
    return Effect.succeed(failure("provider_token_refresh_unavailable", 422));
  }
  return Effect.catch(
    Effect.gen(function* () {
      const refreshSecret = yield* Effect.tryPromise({
        catch: () =>
          caughtFailure(undefined, "provider_token_preparation_failed", adapter.retryPolicy),
        try: () => dependencies.decryptToken(target.storedRefreshToken ?? target.storedAccessToken),
      });
      if (!refreshSecret.trim()) {
        return failure("provider_reconnect_required", 401, adapter.retryPolicy);
      }
      const tokens = yield* Effect.flatMap(ProviderService, (service) =>
        Effect.mapError(
          service.refreshAccessToken(target.platform, context, refreshSecret),
          (cause) => caughtFailure(cause, "provider_token_refresh_failed", adapter.retryPolicy),
        ),
      );
      const accessToken = boundedText(tokens?.accessToken, 16_384);
      const refreshToken =
        tokens?.refreshToken === undefined ? undefined : boundedText(tokens.refreshToken, 16_384);
      let expiresAt: string | undefined;
      if (tokens?.expiresAt !== undefined) {
        expiresAt = timestamp(tokens.expiresAt);
        if (!expiresAt || new Date(expiresAt) <= now) {
          return caughtFailure(undefined, "provider_token_invalid_response", adapter.retryPolicy);
        }
      }
      const scopes = Array.isArray(tokens?.scopes)
        ? tokens.scopes.map((scope) => boundedText(scope, 255))
        : [];
      if (
        !accessToken ||
        (tokens?.refreshToken !== undefined && !refreshToken) ||
        scopes.some((scope) => !scope)
      ) {
        return caughtFailure(undefined, "provider_token_invalid_response", adapter.retryPolicy);
      }
      return {
        outcome: "success",
        retryPolicy: adapter.retryPolicy,
        tokens: {
          accessToken,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(refreshToken ? { refreshToken } : {}),
          scopes: scopes as string[],
        },
      };
    }),
    (failureExecution: ProviderRefreshExecution) => Effect.succeed(failureExecution),
  );
}
