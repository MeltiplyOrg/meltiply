import type { components } from "@meltiply/contracts/schema";

export const RFC4122_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAXIMUM_NOTIFICATION_RECIPIENTS = 20;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && RFC4122_UUID_PATTERN.test(value);
}

/** The message of a non-empty `Error`, otherwise `fallback`. */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

export function codePointLength(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
  }
  return count;
}

export type WorkerEnvironment =
  | "local"
  | "preview"
  | "production"
  | "selfhost"
  | "staging"
  | "test";

export function isDevelopmentEnvironment(
  environment: string | { readonly ENVIRONMENT?: string } | undefined,
): boolean {
  const value = typeof environment === "string" ? environment : environment?.ENVIRONMENT;
  return value === "local" || value === "test";
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export {
  AssetPolicyError,
  ASSET_UPLOAD_POLICY,
  assetOrphanGraceSeconds,
  isAcceptedMediaType,
  mediaUploadExtension,
  mediaUploadMaximum,
  UNSAFE_PATH_SEGMENT_PATTERN,
  uploadLayout,
  validateUpload,
} from "./asset-policy";
export {
  analyticsTerminalAgeSeconds,
  demandDrivenCommentsAgeSeconds,
  maximumDelayedDeliverySeconds,
  overdueRecoveryGraceSeconds,
} from "./due-work";
export {
  can,
  INSTALLATION_SEAT_LIMIT,
  isWorkspaceRole,
  type WorkspaceCapability,
  type WorkspaceRole,
} from "./capabilities";
export {
  ActiveOrganizationRequiredError,
  AuthenticationRequiredError,
  DatabaseError,
  ForbiddenError,
  InvalidRequestError,
  MailSubmissionError,
  NotFoundError,
  RequestContext,
  StorageUnavailableError,
  type MailSubmissionClassification,
  type RequestContextData,
} from "./effect";

export const rateLimitBudgetFreshSeconds = 2 * 60 * 60;

export type PlatformCapability = components["schemas"]["PlatformCapability"];
export type Platform = components["schemas"]["Platform"];
export type AssetStatus = components["schemas"]["AssetStatus"];
export type AssetType = components["schemas"]["AssetType"];
export type ConnectionStatus = components["schemas"]["ConnectionStatus"];
export type DistributionStatus = components["schemas"]["DistributionStatus"];
export type EngagementMetric = "comments" | "reactions" | "shares" | "views";
export type Post = components["schemas"]["Post"];
export type PostStatus = components["schemas"]["PostStatus"];
export type PostAttachment = components["schemas"]["PostAttachment"];
export type PostTarget = components["schemas"]["PostTarget"];
export type ReplyStatus = components["schemas"]["ReplyStatus"];

const accountExpiringWindowMilliseconds = 7 * 24 * 60 * 60 * 1_000;

export function accountStatus(
  account: {
    readonly connection_status: ConnectionStatus;
    readonly revoked_at?: Date | string | null;
    readonly token_expires_at?: Date | string | null;
  },
  now = Date.now(),
): ConnectionStatus {
  if (account.revoked_at || account.connection_status === "revoked") return "revoked";
  if (account.connection_status !== "connected" && account.connection_status !== "expiring") {
    return account.connection_status;
  }
  if (!account.token_expires_at) return account.connection_status;
  const expiresAt = new Date(account.token_expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return "expired";
  return account.connection_status === "expiring" ||
    expiresAt - now <= accountExpiringWindowMilliseconds
    ? "expiring"
    : "connected";
}

export function isAccountUsable(
  account: {
    readonly connection_status: string | null | undefined;
    readonly revoked_at?: Date | string | null;
    readonly token_expires_at?: Date | string | null;
  },
  now = Date.now(),
): boolean {
  if (
    account.revoked_at ||
    (account.connection_status !== "connected" && account.connection_status !== "expiring")
  ) {
    return false;
  }
  if (!account.token_expires_at) return true;
  const expiresAt = new Date(account.token_expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export const PLATFORM_IDS: readonly Platform[] = [
  "tiktok",
  "youtube",
  "instagram",
  "facebook",
  "threads",
];

const PLATFORM_ID_SET: ReadonlySet<string> = new Set(PLATFORM_IDS);

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && PLATFORM_ID_SET.has(value);
}

export const PROVIDER_MEDIA_ROUTE_PREFIX = "/api/v1/provider-media/";

export const PROVIDER_FAILURE_CLASSES = [
  "ambiguous",
  "auth",
  "deterministic",
  "quota",
  "rate_limit",
  "timeout",
  "transient",
] as const;

export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number];

export const ASSET_VIDEO_MAX_BYTES = 500 * 1024 * 1024;

export function oauthCallbackPath(platform: Platform): string {
  return `/api/v1/platforms/${platform}/callback`;
}

export function unavailableCapabilities(): PlatformCapability[] {
  return PLATFORM_IDS.map((platform) => ({
    accepted_mime_types: [],
    analytics: false,
    asset_types: [],
    comments: false,
    connect_available: false,
    max_caption_length: null,
    max_file_size: null,
    max_hashtags: null,
    max_media_count: null,
    max_video_duration_sec: null,
    min_media_count: 0,
    multi_asset_types: [],
    notes: ["Provider configuration and live capability acceptance are pending."],
    platform,
    publish: false,
    reply: false,
  }));
}

interface CommunityLimits {
  readonly max_distributions: number | null;
  readonly max_platforms: number | null;
  readonly max_storage_bytes: number | null;
  readonly max_uploads: number | null;
}

export const COMMUNITY_LIMITS: CommunityLimits = Object.freeze({
  max_distributions: null,
  max_platforms: null,
  max_storage_bytes: null,
  max_uploads: null,
});

export function isoDateTimeOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Throws `RangeError` for an unparseable value. */
export function isoDateTime(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
export function isoPeriodKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function isRequestScopedDatabasePool(env: {
  readonly DATABASE_POOL_MODE?: string;
  readonly ENVIRONMENT?: string;
}): boolean {
  return env.ENVIRONMENT === "local" || env.DATABASE_POOL_MODE === "request";
}
