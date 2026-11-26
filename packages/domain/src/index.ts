import type { components } from "@meltiply/contracts/schema";

/** The message of a non-empty `Error`, otherwise `fallback`. */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

/** Counts Unicode code points without allocating an intermediate character array. */
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

/** Valid runtime environment labels shared by API and automation Workers. */
export type WorkerEnvironment =
  | "local"
  | "preview"
  | "production"
  | "selfhost"
  | "staging"
  | "test";

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
  WORKSPACE_ROLES,
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
export type DistributionStatus = components["schemas"]["DistributionStatus"];
export type Post = components["schemas"]["Post"];
export type PostStatus = components["schemas"]["PostStatus"];
export type PostAttachment = components["schemas"]["PostAttachment"];
export type PostTarget = components["schemas"]["PostTarget"];
export type ReplyStatus = components["schemas"]["ReplyStatus"];

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

/** OAuth callback path shared by Provider redirect URIs and route registration. */
export function oauthCallbackPath(platform: Platform): string {
  return `/api/v1/platforms/${platform}/callback`;
}

/** One fully disabled capability row per Platform, reported while a Provider is unconfigured. */
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
