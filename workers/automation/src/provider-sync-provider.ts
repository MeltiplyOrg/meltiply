import type { Platform } from "@meltiply/domain";
import { Effect } from "effect";
import {
  classifyProviderFailure,
  normalizeProviderFailure,
  ProviderAdapterError,
  ProviderService,
  type ProviderAccountAnalytics,
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

export function safeProviderUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      return undefined;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export interface ProviderCredentialTarget {
  connectionStatus: string;
  storedAccessToken: string;
  tokenExpiresAt: Date | null;
}

export function hasUsableProviderCredentials(
  target: Pick<ProviderCredentialTarget, "connectionStatus" | "tokenExpiresAt">,
  now: Date,
): boolean {
  return (
    target.connectionStatus === "connected" &&
    (target.tokenExpiresAt === null || target.tokenExpiresAt > now)
  );
}

const controlCharactersPattern = /[\u0000-\u001f\u007f]/;

export interface ProviderAccountReadTarget {
  connectionStatus: string;
  platform: Platform;
  providerAccountId: string;
  storedAccessToken: string;
  tokenExpiresAt: Date | null;
}

export type ProviderAccountExecution =
  | {
      outcome: "failure";
      failure: ProviderFailure;
      retryPolicy?: ProviderRetryPolicy;
    }
  | {
      outcome: "success";
      account: ProviderAccountAnalytics;
      retryPolicy?: ProviderRetryPolicy;
    };

export interface ProviderReadTarget {
  connectionStatus: string;
  cursor: string | null;
  platform: Platform;
  providerAccountId?: string;
  providerPostId: string;
  providerOperationId?: string;
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

function boundedText(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== "string" || value.length > maximum) return undefined;
  if (!allowEmpty && value.trim().length === 0) return undefined;
  return value;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function metric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function cursor(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !controlCharactersPattern.test(value)
    ? value
    : undefined;
}

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
    const comments = metric(item?.comments);
    const impressions = metric(item?.impressions);
    const likes = metric(item?.likes);
    const reach = metric(item?.reach);
    const shares = metric(item?.shares);
    const views = metric(item?.views);
    const watchTimeSeconds = metric(item?.watchTimeSeconds);
    if (
      normalizedPostId !== providerPostId ||
      !recordedAt ||
      comments === undefined ||
      impressions === undefined ||
      likes === undefined ||
      reach === undefined ||
      shares === undefined ||
      views === undefined ||
      watchTimeSeconds === undefined
    ) {
      return undefined;
    }
    items.push({
      comments,
      impressions,
      likes,
      providerPostId: normalizedPostId,
      reach,
      recordedAt,
      shares,
      views,
      watchTimeSeconds,
    });
  }
  const nextCursor = page.nextCursor === undefined ? undefined : cursor(page.nextCursor);
  if (page.nextCursor !== undefined && !nextCursor) return undefined;
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

function normalizeAccountAnalytics(value: unknown): ProviderAccountAnalytics | undefined {
  const body = value as Partial<ProviderAccountAnalytics> | null | undefined;
  const followers = metric(body?.followers);
  const recordedAt = timestamp(body?.recordedAt);
  if (followers === undefined || !recordedAt) return undefined;
  const following = body?.following === undefined ? undefined : metric(body.following);
  const posts = body?.posts === undefined ? undefined : metric(body.posts);
  return {
    followers,
    ...(following === undefined ? {} : { following }),
    ...(posts === undefined ? {} : { posts }),
    recordedAt,
  };
}

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
    const authorAvatarUrl =
      item?.authorAvatarUrl === undefined ? undefined : safeProviderUrl(item.authorAvatarUrl);
    if (item?.authorAvatarUrl !== undefined && !authorAvatarUrl) {
      return undefined;
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

async function credentials(
  target: ProviderCredentialTarget,
  dependencies: ProviderSyncDependencies,
  now: Date,
): Promise<string | undefined> {
  if (!hasUsableProviderCredentials(target, now)) {
    return undefined;
  }
  const accessToken = await dependencies.decryptToken(target.storedAccessToken);
  return accessToken.trim() || undefined;
}

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
            {
              providerPostId: target.providerPostId,
              ...(target.providerOperationId
                ? { providerOperationId: target.providerOperationId }
                : {}),
            },
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

export function executeProviderAccountAnalyticsEffect(
  registry: ProviderRegistry,
  context: ProviderRequestContext,
  target: ProviderAccountReadTarget,
  dependencies: ProviderSyncDependencies,
  now = new Date(),
): Effect.Effect<ProviderAccountExecution, never, ProviderService> {
  const adapter = registry.get(target.platform);
  if (!adapter?.getAccountAnalytics) {
    return Effect.succeed(failure("provider_account_analytics_unavailable", 422));
  }
  return Effect.catch(
    Effect.gen(function* () {
      const accessToken = yield* Effect.tryPromise({
        catch: () =>
          caughtFailure(
            undefined,
            "provider_account_analytics_preparation_failed",
            adapter.retryPolicy,
          ),
        try: () => credentials(target, dependencies, now),
      });
      if (!accessToken) {
        return failure("provider_reconnect_required", 401, adapter.retryPolicy);
      }
      const account = yield* Effect.mapError(
        Effect.flatMap(ProviderService, (service) =>
          service.getAccountAnalytics(target.platform, context, {
            accessToken,
            accountId: target.providerAccountId,
          }),
        ),
        (cause) => caughtFailure(cause, "provider_account_analytics_failed", adapter.retryPolicy),
      );
      const normalized = normalizeAccountAnalytics(account);
      return normalized
        ? { account: normalized, outcome: "success", retryPolicy: adapter.retryPolicy }
        : caughtFailure(
            undefined,
            "provider_account_analytics_invalid_response",
            adapter.retryPolicy,
          );
    }),
    (failureExecution: ProviderAccountExecution) => Effect.succeed(failureExecution),
  );
}

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
