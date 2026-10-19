import { Effect } from "effect";
import type { components } from "@meltiply/contracts/schema";
import { isoDateTime, rateLimitBudgetFreshSeconds } from "@meltiply/domain";
import { ProviderRegistry } from "@meltiply/providers";

import {
  activeBrandProfilePredicate,
  requireActiveBrandProfileEffect,
} from "./brand-profile-guard";
import { disconnectPlatformAccountEffect } from "./brand-profile-service";
import { CoreApiError, type CoreApiService } from "./core-types";
import { activeOrganizationIdEffect, withTenantTransactionEffect } from "./database";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  reserveIdempotencyEffect,
} from "./idempotency";
import { lockOrganizationEffect } from "./organization-lock";
import { createDistributionMethods } from "./distribution-service";

type Schemas = components["schemas"];
type AnalyticsSnapshot = Schemas["AnalyticsSnapshot"];
type InboxComment = Schemas["InboxComment"];
type Platform = Schemas["Platform"];
type PlatformAccount = Schemas["PlatformAccount"];
type PlatformCapability = Schemas["PlatformCapability"];
type ReplyStatus = Schemas["ReplyStatus"];

interface PlatformAccountRow extends Record<string, unknown> {
  avatar_url: string | null;
  brand_profile_id: string;
  connection_status: Schemas["ConnectionStatus"];
  created_at: Date | string;
  display_name: string | null;
  id: string;
  last_synced_at: Date | string | null;
  org_id: string;
  platform: Platform;
  platform_user_id: string;
  rate_limit_percent_used: number | null;
  rate_limit_remaining: number | null;
  rate_limit_resets_at: Date | string | null;
  revoked_at: Date | string | null;
  scopes: string[] | null;
  token_expires_at: Date | string | null;
  updated_at: Date | string;
  username?: string | null;
}

/** A calendar row projects one pending or completed publication of one Post. */
interface CalendarRow extends Record<string, unknown> {
  brand_profile_id: string;
  id: string;
  platform: Platform;
  platform_account_id: string | null;
  post_id: string;
  post_title: string;
  published_at: Date | string | null;
  scheduled_at: Date | string | null;
  status: Schemas["DistributionStatus"];
  updated_at: Date | string;
}

interface AnalyticsRow extends Record<string, unknown> {
  comments: number | string;
  impressions: number | string;
  last_synced_at: Date | string | null;
  likes: number | string;
  platform: Platform;
  post_count: number | string;
  reach: number | string;
  shares: number | string;
  views: number | string;
  watch_time_sec: number | string;
}

interface AnalyticsPostRow extends Record<string, unknown> {
  comments: number | string;
  destination_count: number | string;
  excerpt: string;
  last_synced_at: Date | string | null;
  likes: number | string;
  platforms: Platform[];
  post_id: string;
  published_at: Date | string;
  shares: number | string;
  title: string;
  views: number | string;
}

interface AnalyticsSnapshotRow extends Record<string, unknown> {
  comments: number | string;
  distribution_id: string;
  id: string;
  impressions: number | string;
  likes: number | string;
  post_id: string;
  reach: number | string;
  shares: number | string;
  snapshot_at: Date | string;
  views: number | string;
  watch_time_sec: number | string;
}

interface DistributionAnalyticsRow extends Record<string, unknown> {
  comments: number | string | null;
  distribution_id: string;
  id: string | null;
  impressions: number | string | null;
  likes: number | string | null;
  post_id: string;
  reach: number | string | null;
  shares: number | string | null;
  snapshot_at: Date | string | null;
  views: number | string | null;
  watch_time_sec: number | string | null;
}

interface InboxRow extends Record<string, unknown> {
  author_avatar: string | null;
  author_name: string | null;
  body: string;
  brand_profile_id: string;
  commented_at: Date | string;
  distribution_id: string;
  post_id: string;
  id: string;
  platform: Platform;
  platform_comment_id: string;
  reply_attempted_at: Date | string | null;
  reply_error: string | null;
  reply_status: string;
  reply_text: string | null;
  synced_at: Date | string;
  updated_at: Date | string;
}

interface ReplyTargetRow extends InboxRow {
  account_connection_status: Schemas["ConnectionStatus"] | null;
  account_revoked_at: Date | string | null;
  account_token_expires_at: Date | string | null;
}

const platforms: readonly Platform[] = ["tiktok", "youtube", "instagram", "facebook", "threads"];

/**
 * Converts a nullable database numeric or string column value into a JavaScript number.
 *
 * Defaults null or undefined input to 0, ensuring consistent arithmetic and serialization.
 *
 * @param value - Candidate numeric value, string representation, or null.
 * @returns Parsed number or 0 if null.
 */
function number(value: number | string | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * Formats a nullable database timestamp into an ISO-8601 string representation.
 *
 * Preserves null values while standardizing valid Dates or date strings via `isoDateTime`.
 *
 * @param value - Database date, ISO string, or null.
 * @returns ISO-8601 string or `null` if the input is null.
 */
function optionalDateTime(value: Date | string | null): string | null {
  return value === null ? null : isoDateTime(value);
}

/**
 * Maps each contract analytics metric to its already-aggregated `per_post`
 * column. A typed whitelist keeps the ranking column out of interpolated SQL;
 * the service never accepts a caller-provided column name.
 */
const ANALYTICS_POST_SORT_COLUMNS = {
  comments: "pp.comments",
  likes: "pp.likes",
  shares: "pp.shares",
  views: "pp.views",
} as const satisfies Record<Schemas["AnalyticsMetric"], string>;

/**
 * Builds an immutable lookup map from social platform identifier to capability descriptor.
 *
 * Deep clones capability objects to prevent mutation leaks across callers.
 *
 * @param capabilities - Readonly collection of platform capability definitions.
 * @returns Readonly map keyed by platform.
 */
function capabilityMap(
  capabilities: readonly PlatformCapability[],
): ReadonlyMap<Platform, PlatformCapability> {
  return new Map(
    capabilities.map((capability) => [capability.platform, structuredClone(capability)]),
  );
}

/**
 * Evaluates the effective connection status of a platform account based on tokens and revocations.
 *
 * Considers explicit revocation timestamps, token expiration against current time,
 * and flags accounts expiring within a 7-day grace threshold as `'expiring'`.
 *
 * @param row - Partial platform account record containing status, revocation, and token expiry.
 * @param now - Reference epoch millisecond timestamp for expiry comparisons (defaults to current time).
 * @returns Resolved connection status (`"connected"`, `"expiring"`, `"expired"`, or `"revoked"`).
 */
function accountStatus(
  row: Pick<PlatformAccountRow, "connection_status" | "revoked_at" | "token_expires_at">,
  now = Date.now(),
): Schemas["ConnectionStatus"] {
  if (row.revoked_at || row.connection_status === "revoked") return "revoked";
  if (row.connection_status !== "connected") return row.connection_status;
  if (!row.token_expires_at) return "connected";
  const expiresAt = new Date(row.token_expires_at).getTime();
  if (expiresAt <= now) return "expired";
  return expiresAt - now <= 7 * 24 * 60 * 60 * 1_000 ? "expiring" : "connected";
}

/**
 * Transforms a database platform account row into an API `PlatformAccount` entity.
 *
 * Attaches cloned platform capabilities, computes dynamic connection status,
 * and formats rate-limit budget information if available.
 *
 * @param row - Raw database row from `platform_accounts` joined with `rate_limit_budgets`.
 * @param capabilities - Platform capabilities lookup map.
 * @returns Formatted API `PlatformAccount` object.
 */
function mapPlatformAccount(
  row: PlatformAccountRow,
  capabilities: ReadonlyMap<Platform, PlatformCapability>,
): PlatformAccount {
  const budget =
    row.rate_limit_remaining !== null || row.rate_limit_percent_used !== null
      ? {
          percent_used: row.rate_limit_percent_used,
          remaining: row.rate_limit_remaining,
          resets_at: row.rate_limit_resets_at ? isoDateTime(row.rate_limit_resets_at) : null,
        }
      : null;
  return {
    avatar_url: row.avatar_url,
    brand_profile_id: row.brand_profile_id,
    capabilities: structuredClone(capabilities.get(row.platform)!),
    connection_status: accountStatus(row),
    created_at: isoDateTime(row.created_at),
    display_name: row.display_name,
    id: row.id,
    last_synced_at: optionalDateTime(row.last_synced_at),
    org_id: row.org_id,
    platform: row.platform,
    platform_user_id: row.platform_user_id,
    rate_limit_budget: budget,
    scopes: row.scopes ?? [],
    token_expires_at: optionalDateTime(row.token_expires_at),
    username: (row.username as string | null) ?? null,
    updated_at: isoDateTime(row.updated_at),
  };
}

/**
 * Maps an analytics snapshot database record to the API `AnalyticsSnapshot` schema.
 *
 * Coerces numeric database fields to numbers and formats timestamps to ISO-8601.
 *
 * @param row - Database row from `analytics_snapshots`.
 * @returns Formatted `AnalyticsSnapshot` contract object.
 */
function mapSnapshot(row: AnalyticsSnapshotRow): AnalyticsSnapshot {
  return {
    comments: number(row.comments),
    distribution_id: row.distribution_id,
    id: row.id,
    impressions: number(row.impressions),
    likes: number(row.likes),
    reach: number(row.reach),
    shares: number(row.shares),
    post_id: row.post_id,
    snapshot_at: isoDateTime(row.snapshot_at),
    views: number(row.views),
    watch_time_sec: number(row.watch_time_sec),
  };
}

/**
 * Normalizes an internal database reply status string into an API contract `ReplyStatus`.
 *
 * Maps `'in_progress'` to `'processing'`, `'succeeded'` to `'replied'`, and defaults to `'not_replied'`.
 *
 * @param value - Internal database reply status string.
 * @returns Contract `ReplyStatus` enum string.
 */
function contractReplyStatus(value: string): ReplyStatus {
  switch (value) {
    case "queued":
      return "queued";
    case "in_progress":
      return "processing";
    case "succeeded":
      return "replied";
    case "failed":
      return "failed";
    case "needs_reconciliation":
      return "needs_reconciliation";
    default:
      return "not_replied";
  }
}

/**
 * Translates an API contract `ReplyStatus` filter into its corresponding database column value.
 *
 * Converts `'not_replied'` to `'none'`, `'processing'` to `'in_progress'`, and `'replied'` to `'succeeded'`.
 *
 * @param value - API reply status filter or undefined.
 * @returns Corresponding database reply status string, or `null` if unmapped/omitted.
 */
function databaseReplyStatus(value: ReplyStatus | undefined): string | null {
  switch (value) {
    case "not_replied":
      return "none";
    case "queued":
      return "queued";
    case "processing":
      return "in_progress";
    case "replied":
      return "succeeded";
    case "failed":
      return "failed";
    case "needs_reconciliation":
      return "needs_reconciliation";
    default:
      return null;
  }
}

/**
 * Converts an inbox comment database record to the API `InboxComment` contract schema.
 *
 * Normalizes reply status, constructs a structured failure object if `reply_error` is present,
 * and formats timestamps to ISO strings.
 *
 * @param row - Raw database row from `comments` joined with `distributions`.
 * @returns Formatted `InboxComment` object.
 */
function mapInboxComment(row: InboxRow): InboxComment {
  const attemptedAt = row.reply_attempted_at ?? row.updated_at;
  return {
    author_avatar: row.author_avatar,
    author_name: row.author_name,
    body: row.body,
    brand_profile_id: row.brand_profile_id,
    commented_at: isoDateTime(row.commented_at),
    distribution_id: row.distribution_id,
    failure: row.reply_error
      ? {
          code: "provider_reply_failed",
          last_occurred_at: isoDateTime(attemptedAt),
          message: row.reply_error,
          retryable: true,
        }
      : null,
    id: row.id,
    post_id: row.post_id,
    platform: row.platform,
    platform_comment_id: row.platform_comment_id,
    reply_status: contractReplyStatus(row.reply_status),
    reply_text: row.reply_text,
    synced_at: isoDateTime(row.synced_at),
    updated_at: isoDateTime(row.updated_at),
  };
}

/**
 * Factory creating the unified core API service instance for Meltiply.
 *
 * Combines distribution management, social platform account management,
 * content calendar queries, cross-platform analytics aggregation, and inbox comments.
 *
 * @param configuredCapabilities - Optional platform capability list (defaults to `ProviderRegistry`).
 * @returns Configured `CoreApiService` instance implementing all core business operations via Effect.
 */
export function createCoreApiService(
  configuredCapabilities = new ProviderRegistry().capabilities(),
): CoreApiService {
  const capabilities = capabilityMap(configuredCapabilities);
  const distributionMethods = createDistributionMethods();

  return {
    ...distributionMethods,
    /**
     * Lists supported social media platforms and their respective feature capabilities.
     *
     * Returns deep clones of cached capabilities (publishing, analytics, comments, video limits)
     * for TikTok, YouTube, Instagram, Facebook, and Threads.
     *
     * @returns Array of cloned `PlatformCapability` objects.
     */
    platformCapabilities() {
      return platforms.map((platform) => structuredClone(capabilities.get(platform)!));
    },

    /**
     * Resolves the active tenant organization ID for the authenticated session via Effect.
     *
     * Queries `public.auth_active_org_id()` within a tenant transaction.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @returns Effect resolving to unique organization ID string.
     * @throws {AccessDenied} If the user lacks active organization membership.
     */
    activeOrganization(env, session) {
      return withTenantTransactionEffect(env, session, (client) =>
        activeOrganizationIdEffect(client),
      );
    },

    /**
     * Lists connected social platform accounts for the active tenant with rate-limit budgets via Effect.
     *
     * Left joins recent rate limit budgets (within fresh window) and computes dynamic
     * token expiry statuses. When `brandProfileId` is provided the result is restricted
     * to Channels owned by that Brand Profile; omitted returns the workspace-wide
     * aggregate across all Brand Profiles.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param brandProfileId - Optional Brand Profile UUID restricting the listing.
     * @returns Effect resolving to array of populated `PlatformAccount` entities.
     */
    listPlatformAccounts(env, session, brandProfileId) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<PlatformAccountRow>(
            `SELECT
               pa.id, pa.org_id, pa.brand_profile_id, pa.platform,
               pa.platform_user_id, pa.display_name, pa.avatar_url,
               pa.metadata->>'username' AS username,
               pa.connection_status, pa.token_expires_at, pa.last_synced_at,
               pa.revoked_at,
               COALESCE(pa.scopes, ARRAY[]::text[]) AS scopes,
               pa.created_at, pa.updated_at,
               rlb.remaining AS rate_limit_remaining,
               rlb.percent_used AS rate_limit_percent_used,
               rlb.resets_at AS rate_limit_resets_at
             FROM platform_accounts pa
             LEFT JOIN rate_limit_budgets rlb
               ON rlb.platform = pa.platform
               AND rlb.account_id = pa.platform_user_id
               AND rlb.updated_at > now() - ($1 * INTERVAL '1 second')
             WHERE ($2::uuid IS NULL OR pa.brand_profile_id = $2)
               AND ${activeBrandProfilePredicate("pa.brand_profile_id")}
             ORDER BY pa.created_at ASC, pa.id ASC`,
            [rateLimitBudgetFreshSeconds, brandProfileId ?? null],
          );
          return result.rows.map((row) => mapPlatformAccount(row, capabilities));
        }),
      );
    },

    /**
     * Disconnects a platform account, cancelling scheduled/queued distributions on it via Effect.
     *
     * Idempotently cancels all in-flight scheduled or queued distributions targeting the account,
     * deletes the platform account record, enqueues a durable remote-revocation outbox event,
     * and records operation idempotency. The local cutover is immediate; the provider-side
     * token revocation is retried asynchronously by the automation worker.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param accountId - Platform account ID to disconnect.
     * @param idempotencyKey - Client-provided idempotency key.
     * @returns Effect resolving to object indicating replay status.
     * @throws {CoreApiError} 404 `not_found` if the platform account does not exist.
     */
    disconnectPlatform(env, session, accountId, idempotencyKey) {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(accountId);
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "disconnect-platform",
              idempotencyKey,
              requestHash,
            );
            if (replay) return { replayed: true, value: undefined };

            const account = yield* client.query<{
              access_token: string;
              brand_profile_id: string;
              id: string;
              platform: string;
            }>(
              `SELECT id, brand_profile_id, platform, access_token
               FROM platform_accounts
               WHERE id = $1`,
              [accountId],
            );
            const accountRow = account.rows[0];
            if (!accountRow) {
              return yield* Effect.fail(
                new CoreApiError(404, "not_found", "The platform account was not found."),
              );
            }
            yield* disconnectPlatformAccountEffect(client, organizationId, accountRow);
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "disconnect-platform",
              idempotencyKey,
              204,
              null,
            );
            return { replayed: false, value: undefined };
          }),
        );
      });
    },

    /**
     * Queries pending and completed publication events across a given time window via Effect.
     *
     * Joins each Distribution to its retained Post so calendar entries carry
     * the durable Post identity and title. Soft-deleted Posts are excluded just
     * like the Post list; retained Distribution history remains available to
     * analytics and reconciliation without resurrecting deleted compositions.
     * Filters `event_at` within `[start, end]` and, when `brandProfileId` is
     * supplied, restricts results to that Brand Profile's publications.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param start - Start of event window.
     * @param end - End of event window.
     * @param limit - Maximum calendar entries to return (default: 500).
     * @param brandProfileId - Optional Brand Profile UUID restricting the listing.
     * @returns Effect resolving to chronologically ordered calendar items.
     */
    calendar(env, session, start, end, limit = 500, brandProfileId) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<CalendarRow>(
            `SELECT
               d.id, d.post_id, p.title AS post_title, d.platform,
               d.platform_account_id, d.status, d.scheduled_at, d.published_at,
               d.updated_at, d.brand_profile_id
             FROM distributions d
             JOIN posts p ON p.id = d.post_id AND p.org_id = d.org_id
             WHERE d.event_at >= $1 AND d.event_at <= $2
               AND p.deleted_at IS NULL
               AND ($4::uuid IS NULL OR d.brand_profile_id = $4)
               AND ${activeBrandProfilePredicate("d.brand_profile_id")}
             ORDER BY d.event_at ASC, d.id ASC
             LIMIT $3`,
            [start, end, limit, brandProfileId ?? null],
          );
          return result.rows.map((row) => ({
            post_id: row.post_id,
            post_title: row.post_title,
            brand_profile_id: row.brand_profile_id,
            id: row.id,
            platform: row.platform,
            platform_account_id: row.platform_account_id,
            published_at: optionalDateTime(row.published_at),
            scheduled_at: optionalDateTime(row.scheduled_at),
            status: row.status,
            updated_at: isoDateTime(row.updated_at),
          }));
        }),
      );
    },

    /**
     * Aggregates platform-level performance analytics for Distributions
     * published inside a date range via Effect.
     *
     * Cohorts on `published_at` (never the calendar's scheduled `event_at`)
     * and derives coverage from the Platforms actually published in scope.
     * Employs a set-based Common Table Expression (CTE) with `DISTINCT ON` to
     * select the latest snapshot per Distribution at or before the range end,
     * computing sums for views, likes, comments, shares, watch time, reach, and
     * impressions.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param filters - Analytics filters including dates, platform, and optional Brand Profile scope.
     * @returns Effect resolving to summary analytics response with platform breakdowns, totals, and sync status.
     */
    summaryAnalytics(env, session, filters) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<AnalyticsRow>(
            `WITH candidates AS (
               SELECT id, platform
               FROM distributions
               WHERE status = 'published'
                 AND published_at >= $1
                 AND published_at <= $2
                 AND ($3::text IS NULL OR platform = $3)
                 AND ($4::uuid IS NULL OR brand_profile_id = $4)
                 AND ${activeBrandProfilePredicate("brand_profile_id")}
             ),
             latest AS (
               SELECT DISTINCT ON (s.distribution_id)
                 s.distribution_id,
                 s.views, s.likes, s.comments, s.shares,
                 s.watch_time_sec, s.reach, s.impressions, s.snapshot_at
               FROM analytics_snapshots s
               JOIN candidates c ON c.id = s.distribution_id
               WHERE s.snapshot_at <= $2
               ORDER BY s.distribution_id, s.snapshot_at DESC, s.id DESC
             )
             SELECT
               c.platform,
               COALESCE(SUM(l.views), 0) AS views,
               COALESCE(SUM(l.likes), 0) AS likes,
               COALESCE(SUM(l.comments), 0) AS comments,
               COALESCE(SUM(l.shares), 0) AS shares,
               COALESCE(SUM(l.watch_time_sec), 0) AS watch_time_sec,
               COALESCE(SUM(l.reach), 0) AS reach,
               COALESCE(SUM(l.impressions), 0) AS impressions,
               COUNT(*) AS post_count,
               MAX(l.snapshot_at) AS last_synced_at
             FROM candidates c
             LEFT JOIN latest l ON l.distribution_id = c.id
             GROUP BY c.platform
             ORDER BY c.platform ASC`,
            [filters.start, filters.end, filters.platform ?? null, filters.brandProfileId ?? null],
          );
          const unsupportedPlatforms = result.rows
            .map((row) => row.platform)
            .filter((platform) => !capabilities.get(platform)?.analytics);
          const lastSynced = result.rows.reduce<number | null>((latest, row) => {
            if (!row.last_synced_at) return latest;
            const timestamp = new Date(row.last_synced_at).getTime();
            return latest === null || timestamp > latest ? timestamp : latest;
          }, null);
          const byPlatform = result.rows.map((row) => ({
            comments: number(row.comments),
            impressions: number(row.impressions),
            last_synced_at: optionalDateTime(row.last_synced_at),
            likes: number(row.likes),
            platform: row.platform,
            post_count: number(row.post_count),
            reach: number(row.reach),
            shares: number(row.shares),
            views: number(row.views),
            watch_time_sec: number(row.watch_time_sec),
          }));
          return {
            by_platform: byPlatform,
            last_synced_at: lastSynced === null ? null : new Date(lastSynced).toISOString(),
            partial: unsupportedPlatforms.length > 0,
            range: {
              end: filters.end.toISOString(),
              start: filters.start.toISOString(),
            },
            totals: byPlatform.reduce(
              (totals, row) => ({
                comments: totals.comments + row.comments,
                impressions: totals.impressions + row.impressions,
                likes: totals.likes + row.likes,
                post_count: totals.post_count + row.post_count,
                reach: totals.reach + row.reach,
                shares: totals.shares + row.shares,
                views: totals.views + row.views,
                watch_time_sec: totals.watch_time_sec + row.watch_time_sec,
              }),
              {
                comments: 0,
                impressions: 0,
                likes: 0,
                post_count: 0,
                reach: 0,
                shares: 0,
                views: 0,
                watch_time_sec: 0,
              },
            ),
            unsupported_platforms: unsupportedPlatforms,
          };
        }),
      );
    },

    /**
     * Ranks Posts by one stored metric over Distributions published inside the
     * requested cohort.
     *
     * Each included Distribution contributes its latest snapshot at or before
     * the range end; an unsynced Distribution still counts as a destination and
     * contributes zero. Rows exclude soft-deleted Posts and Brand Profiles,
     * order by the selected metric, publication time, then Post id, and fetch
     * one extra row to report `has_more` without a second count query.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param filters - Cohort dates, optional Platform/Brand Profile scope,
     *   ranking metric, and limit/offset pagination.
     * @returns Effect resolving to the ranked Post rows and pagination metadata.
     */
    analyticsPosts(env, session, filters) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<AnalyticsPostRow>(
            `WITH candidates AS (
               SELECT d.id AS distribution_id, d.post_id, d.platform, d.published_at
               FROM distributions d
               WHERE d.status = 'published'
                 AND d.published_at >= $1
                 AND d.published_at <= $2
                 AND ($3::text IS NULL OR d.platform = $3)
                 AND ($4::uuid IS NULL OR d.brand_profile_id = $4)
                 AND ${activeBrandProfilePredicate("d.brand_profile_id")}
             ),
             latest AS (
               SELECT DISTINCT ON (s.distribution_id)
                 s.distribution_id,
                 s.views, s.likes, s.comments, s.shares, s.snapshot_at
               FROM analytics_snapshots s
               JOIN candidates c ON c.distribution_id = s.distribution_id
               WHERE s.snapshot_at <= $2
               ORDER BY s.distribution_id, s.snapshot_at DESC, s.id DESC
             ),
             per_post AS (
               SELECT
                 c.post_id,
                 MIN(c.published_at) AS published_at,
                 COUNT(*) AS destination_count,
                 ARRAY_AGG(DISTINCT c.platform ORDER BY c.platform) AS platforms,
                 MAX(l.snapshot_at) AS last_synced_at,
                 COALESCE(SUM(l.views), 0) AS views,
                 COALESCE(SUM(l.likes), 0) AS likes,
                 COALESCE(SUM(l.comments), 0) AS comments,
                 COALESCE(SUM(l.shares), 0) AS shares
               FROM candidates c
               LEFT JOIN latest l ON l.distribution_id = c.distribution_id
               GROUP BY c.post_id
             )
             SELECT
               p.id AS post_id,
               p.title,
               LEFT(btrim(regexp_replace(p.default_text, '\\s+', ' ', 'g')), 140) AS excerpt,
               pp.published_at,
               pp.destination_count,
               pp.platforms,
               pp.last_synced_at,
               pp.views,
               pp.likes,
               pp.comments,
               pp.shares
             FROM per_post pp
             JOIN posts p ON p.id = pp.post_id AND p.deleted_at IS NULL
             ORDER BY ${ANALYTICS_POST_SORT_COLUMNS[filters.metric]} DESC,
                      pp.published_at DESC,
                      pp.post_id ASC
             LIMIT $5 OFFSET $6`,
            [
              filters.start,
              filters.end,
              filters.platform ?? null,
              filters.brandProfileId ?? null,
              filters.limit + 1,
              filters.offset,
            ],
          );
          return {
            has_more: result.rows.length > filters.limit,
            limit: filters.limit,
            offset: filters.offset,
            posts: result.rows.slice(0, filters.limit).map((row) => ({
              comments: number(row.comments),
              destination_count: number(row.destination_count),
              excerpt: row.excerpt,
              last_synced_at: optionalDateTime(row.last_synced_at),
              likes: number(row.likes),
              platforms: row.platforms,
              post_id: row.post_id,
              published_at: isoDateTime(row.published_at),
              shares: number(row.shares),
              title: row.title,
              unsupported_platforms: row.platforms.filter(
                (platform) => !capabilities.get(platform)?.analytics,
              ),
              views: number(row.views),
            })),
          };
        }),
      );
    },

    /**
     * Verifies an active distribution exists within tenant scope, excluding
     * soft-deleted Brand Profiles before querying chronologically ordered
     * snapshots within the optional date bounds.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param distributionId - Target distribution identifier.
     * @param filters - Query filters containing start date, end date, and result limit.
     * @returns Effect resolving to chronological list of analytics snapshots.
     * @throws {CoreApiError} 404 `not_found` if the distribution does not exist or is deleted.
     */
    distributionAnalytics(env, session, distributionId, filters) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<DistributionAnalyticsRow>(
            `SELECT
               snapshot.id, target.id AS distribution_id,
               target.post_id AS post_id,
               snapshot.views, snapshot.likes, snapshot.comments,
               snapshot.shares, snapshot.watch_time_sec, snapshot.reach,
               snapshot.impressions, snapshot.snapshot_at
             FROM (
               SELECT id, post_id
               FROM distributions
               WHERE id = $1
                 AND ${activeBrandProfilePredicate("brand_profile_id")}
             ) AS target
             LEFT JOIN LATERAL (
               SELECT
                 id, views, likes, comments, shares, watch_time_sec,
                 reach, impressions, snapshot_at
               FROM analytics_snapshots
               WHERE distribution_id = target.id
                 AND ($2::timestamptz IS NULL OR snapshot_at >= $2)
                 AND ($3::timestamptz IS NULL OR snapshot_at <= $3)
               ORDER BY snapshot_at ASC, id ASC
               LIMIT $4
             ) AS snapshot ON true
             ORDER BY snapshot.snapshot_at ASC NULLS LAST,
                      snapshot.id ASC NULLS LAST`,
            [distributionId, filters.start ?? null, filters.end ?? null, filters.limit],
          );
          if (result.rows.length === 0) {
            return yield* Effect.fail(
              new CoreApiError(404, "not_found", "The distribution was not found."),
            );
          }
          return result.rows.flatMap((row) =>
            row.id === null
              ? []
              : [
                  mapSnapshot({
                    comments: row.comments!,
                    distribution_id: row.distribution_id,
                    id: row.id,
                    impressions: row.impressions!,
                    likes: row.likes!,
                    post_id: row.post_id,
                    reach: row.reach!,
                    shares: row.shares!,
                    snapshot_at: row.snapshot_at!,
                    views: row.views!,
                    watch_time_sec: row.watch_time_sec!,
                  }),
                ],
          );
        }),
      );
    },

    /**
     * Lists received audience comments with pagination and filtering across distributions via Effect.
     *
     * Supports filtering by reply status, platform, distribution, Brand Profile, and unreplied
     * flags. When `brandProfileId` is provided the result is restricted to comments on that
     * profile's distributions; omitted returns the workspace-wide aggregate.
     * Fetches `limit + 1` rows to determine pagination continuation.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param filters - Inbox search filters (unreplied, platform, distributionId, brandProfileId,
     *   replyStatus, limit, offset).
     * @returns Effect resolving to paginated inbox comments list with pagination metadata.
     */
    inbox(env, session, filters) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const values: unknown[] = [];
          const conditions: string[] = [activeBrandProfilePredicate("d.brand_profile_id")];
          const parameter = (value: unknown) => {
            values.push(value);
            return `$${values.length}`;
          };
          if (filters.unreplied) {
            conditions.push("c.replied = false");
          }
          if (filters.platform) {
            conditions.push(`d.platform = ${parameter(filters.platform)}`);
          }
          if (filters.distributionId) {
            conditions.push(`c.distribution_id = ${parameter(filters.distributionId)}`);
          }
          if (filters.brandProfileId) {
            conditions.push(`d.brand_profile_id = ${parameter(filters.brandProfileId)}`);
          }
          const replyStatus = databaseReplyStatus(filters.replyStatus);
          if (replyStatus !== null) {
            conditions.push(`c.reply_status = ${parameter(replyStatus)}`);
          }
          const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
          values.push(filters.limit + 1, filters.offset);
          const result = yield* client.query<InboxRow>(
            `SELECT
               c.id, c.distribution_id, d.platform, c.platform_comment_id,
               c.author_name, c.author_avatar, c.body, c.reply_text,
               c.reply_status, c.reply_error, c.reply_attempted_at,
               c.commented_at, c.synced_at, c.updated_at,
               d.brand_profile_id, d.post_id
             FROM comments c
             JOIN distributions d
               ON d.id = c.distribution_id AND d.org_id = c.org_id
             ${where}
             ORDER BY c.commented_at DESC, c.id DESC
             LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values,
          );
          return {
            comments: result.rows.slice(0, filters.limit).map(mapInboxComment),
            has_more: result.rows.length > filters.limit,
            limit: filters.limit,
            offset: filters.offset,
          };
        }),
      );
    },

    /**
     * Queues an outbound reply to an audience comment and schedules asynchronous dispatch via Effect.
     *
     * Verifies platform reply capability, plan entitlement, account connection health, and that
     * a reply is not already pending or sent. Queues a `comment.reply.requested` outbox event.
     * The comment's Brand Profile is derived from its distribution and must match the
     * `brandProfileId` in the request body.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param commentId - Comment ID to reply to.
     * @param brandProfileId - Brand Profile UUID that must own the comment's distribution.
     * @param text - Outbound reply message body.
     * @param idempotencyKey - Client-provided idempotency key.
     * @param requestId - Optional request ID for telemetry tracing.
     * @returns Effect resolving to object indicating replay status and the updated `InboxComment`.
     * @throws {CoreApiError} 404 `not_found` if comment does not exist or belongs to another profile.
     * @throws {CoreApiError} 404 `brand_profile_not_found` if the profile is missing or foreign.
     * @throws {CoreApiError} 409 `brand_profile_deleted` if the profile is soft-deleted.
     * @throws {CoreApiError} 422 `unsupported_capability` if the platform cannot reply to comments.
     * @throws {CoreApiError} 409 `platform_reconnect_required` if account is disconnected/expired.
     */
    replyToComment(env, session, commentId, brandProfileId, text, idempotencyKey, requestId) {
      return Effect.gen(function* () {
        const requestHash = yield* hashIdempotencyRequestEffect(
          JSON.stringify({
            brand_profile_id: brandProfileId,
            comment_id: commentId,
            text,
          }),
        );
        return yield* withTenantTransactionEffect(env, session, (client) =>
          Effect.gen(function* () {
            const organizationId = yield* activeOrganizationIdEffect(client);
            const replay = yield* reserveIdempotencyEffect(
              client,
              organizationId,
              "reply-to-comment",
              idempotencyKey,
              requestHash,
            );
            if (replay) {
              return {
                replayed: true,
                value: replay.response_body as InboxComment,
              };
            }
            yield* lockOrganizationEffect(client, organizationId);
            yield* requireActiveBrandProfileEffect(client, organizationId, brandProfileId);

            const target = yield* client.query<ReplyTargetRow>(
              `SELECT
                 c.id, c.distribution_id, d.platform, c.platform_comment_id,
                 c.author_name, c.author_avatar, c.body, c.reply_text,
                 c.reply_status, c.reply_error, c.reply_attempted_at,
                 c.commented_at, c.synced_at, c.updated_at,
                 d.brand_profile_id, d.post_id,
                 pa.connection_status AS account_connection_status,
                 pa.revoked_at AS account_revoked_at,
                 pa.token_expires_at AS account_token_expires_at
               FROM comments c
               JOIN distributions d
                 ON d.id = c.distribution_id AND d.org_id = c.org_id
               JOIN organizations o ON o.id = c.org_id
               LEFT JOIN platform_accounts pa
                 ON pa.id = d.platform_account_id AND pa.org_id = d.org_id
               WHERE c.id = $1 AND d.brand_profile_id = $2
               FOR UPDATE OF c`,
              [commentId, brandProfileId],
            );
            const row = target.rows[0];
            if (!row) {
              return yield* Effect.fail(
                new CoreApiError(404, "not_found", "The comment was not found."),
              );
            }
            const capability = capabilities.get(row.platform)!;
            if (!capability.reply) {
              return yield* Effect.fail(
                new CoreApiError(
                  422,
                  "unsupported_capability",
                  `${row.platform} comment replies are not available.`,
                ),
              );
            }
            if (
              !row.account_connection_status ||
              accountStatus({
                connection_status: row.account_connection_status,
                revoked_at: row.account_revoked_at,
                token_expires_at: row.account_token_expires_at,
              }) !== "connected"
            ) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "platform_reconnect_required",
                  "Reconnect the platform account before replying.",
                ),
              );
            }
            if (contractReplyStatus(row.reply_status) === "replied") {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "already_replied",
                  "The comment already has a confirmed reply.",
                ),
              );
            }
            if (row.reply_status === "queued" || row.reply_status === "in_progress") {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "reply_in_progress",
                  "A reply is already queued for this comment.",
                ),
              );
            }

            const updated = yield* client.query<InboxRow>(
              `UPDATE comments
               SET reply_text = $2,
                   reply_status = 'queued',
                   reply_error = NULL,
                   reply_attempted_at = now(),
                   updated_at = now()
               WHERE id = $1
               RETURNING
                 id, distribution_id, $3::text AS platform,
                 $4::uuid AS brand_profile_id, $5::uuid AS post_id,
                 platform_comment_id,
                 author_name, author_avatar, body, reply_text, reply_status,
                 reply_error, reply_attempted_at, commented_at, synced_at,
                 updated_at`,
              [commentId, text, row.platform, brandProfileId, row.post_id],
            );
            const comment = mapInboxComment(updated.rows[0]!);
            yield* client.query(
              `INSERT INTO outbox_events
                 (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
               VALUES ($1, 'comment.reply.requested', 'comment', $2, $3, $4)`,
              [
                organizationId,
                commentId,
                idempotencyKey,
                {
                  comment_id: commentId,
                  distribution_id: row.distribution_id,
                  platform: row.platform,
                  ...(requestId ? { request_id: requestId } : {}),
                  text,
                  version: 1,
                },
              ],
            );
            yield* completeIdempotencyEffect(
              client,
              organizationId,
              "reply-to-comment",
              idempotencyKey,
              202,
              comment,
            );
            return { replayed: false, value: comment };
          }),
        );
      });
    },
  };
}
