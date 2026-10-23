import type { components, operations } from "@meltiply/contracts/schema";
export type BrandProfile = components["schemas"]["BrandProfile"];
export type BrandProfileColor = components["schemas"]["BrandProfileColor"];
export type BrandProfileListResponse = components["schemas"]["BrandProfileListResponse"];
export type CreateBrandProfileInput = components["schemas"]["CreateBrandProfileRequest"];
export type UpdateBrandProfileInput = components["schemas"]["UpdateBrandProfileRequest"];

/**
 * Fixed accessible palette for Brand Profile color labels, mirroring the
 * `BrandProfileColor` enum in the OpenAPI contract. The compile-time exhaustiveness
 * check below fails the build if the contract palette gains a color this list
 * does not carry; `satisfies` rejects values outside the contract.
 */
export const BRAND_PROFILE_COLORS = [
  "#b91c1c",
  "#991b1b",
  "#7f1d1d",
  "#c2410c",
  "#9a3412",
  "#7c2d12",
  "#b45309",
  "#92400e",
  "#78350f",
  "#a16207",
  "#854d0e",
  "#713f12",
  "#4d7c0f",
  "#3f6212",
  "#365314",
  "#15803d",
  "#166534",
  "#14532d",
  "#0f766e",
  "#115e59",
  "#134e4a",
  "#0e7490",
  "#155e75",
  "#164e63",
  "#0369a1",
  "#075985",
  "#0c4a6e",
  "#1d4ed8",
  "#1e40af",
  "#1e3a8a",
  "#4338ca",
  "#3730a3",
  "#312e81",
  "#6d28d9",
  "#5b21b6",
  "#4c1d95",
  "#7e22ce",
  "#6b21a8",
  "#581c87",
  "#a21caf",
  "#86198f",
  "#701a75",
  "#be185d",
  "#9d174d",
  "#831843",
  "#be123c",
  "#9f1239",
  "#881337",
  "#374151",
  "#1f2937",
  "#111827",
] as const satisfies readonly BrandProfileColor[];

/** Compile-time proof that {@link BRAND_PROFILE_COLORS} covers the whole contract palette. */
type MissingPaletteColors = Exclude<BrandProfileColor, (typeof BRAND_PROFILE_COLORS)[number]>;
const _paletteIsExhaustive: MissingPaletteColors extends never ? true : never = true;
void _paletteIsExhaustive;

const BRAND_PROFILE_COLOR_CLASSES: Record<BrandProfileColor, string> = {
  "#0369a1": "bg-[#0369a1]",
  "#075985": "bg-[#075985]",
  "#0c4a6e": "bg-[#0c4a6e]",
  "#0e7490": "bg-[#0e7490]",
  "#0f766e": "bg-[#0f766e]",
  "#111827": "bg-[#111827]",
  "#115e59": "bg-[#115e59]",
  "#134e4a": "bg-[#134e4a]",
  "#14532d": "bg-[#14532d]",
  "#155e75": "bg-[#155e75]",
  "#15803d": "bg-[#15803d]",
  "#164e63": "bg-[#164e63]",
  "#166534": "bg-[#166534]",
  "#1d4ed8": "bg-[#1d4ed8]",
  "#1e3a8a": "bg-[#1e3a8a]",
  "#1e40af": "bg-[#1e40af]",
  "#1f2937": "bg-[#1f2937]",
  "#312e81": "bg-[#312e81]",
  "#365314": "bg-[#365314]",
  "#3730a3": "bg-[#3730a3]",
  "#374151": "bg-[#374151]",
  "#3f6212": "bg-[#3f6212]",
  "#4338ca": "bg-[#4338ca]",
  "#4c1d95": "bg-[#4c1d95]",
  "#4d7c0f": "bg-[#4d7c0f]",
  "#581c87": "bg-[#581c87]",
  "#5b21b6": "bg-[#5b21b6]",
  "#6b21a8": "bg-[#6b21a8]",
  "#6d28d9": "bg-[#6d28d9]",
  "#701a75": "bg-[#701a75]",
  "#713f12": "bg-[#713f12]",
  "#78350f": "bg-[#78350f]",
  "#7c2d12": "bg-[#7c2d12]",
  "#7e22ce": "bg-[#7e22ce]",
  "#7f1d1d": "bg-[#7f1d1d]",
  "#831843": "bg-[#831843]",
  "#854d0e": "bg-[#854d0e]",
  "#86198f": "bg-[#86198f]",
  "#881337": "bg-[#881337]",
  "#92400e": "bg-[#92400e]",
  "#991b1b": "bg-[#991b1b]",
  "#9a3412": "bg-[#9a3412]",
  "#9d174d": "bg-[#9d174d]",
  "#9f1239": "bg-[#9f1239]",
  "#a16207": "bg-[#a16207]",
  "#a21caf": "bg-[#a21caf]",
  "#b45309": "bg-[#b45309]",
  "#b91c1c": "bg-[#b91c1c]",
  "#be123c": "bg-[#be123c]",
  "#be185d": "bg-[#be185d]",
  "#c2410c": "bg-[#c2410c]",
};

/** Resolves the contract color label to a statically discoverable Tailwind class. */
export function brandProfileColorClass(color: BrandProfileColor): string {
  return BRAND_PROFILE_COLOR_CLASSES[color];
}

export type UserProfile = components["schemas"]["UserProfile"];
export type WorkspaceRole = components["schemas"]["WorkspaceRole"];
export type WorkspaceMember = components["schemas"]["WorkspaceMember"];
export type WorkspaceMemberListResponse = components["schemas"]["WorkspaceMemberListResponse"];
export type WorkspaceInvitation = components["schemas"]["WorkspaceInvitation"];
export type WorkspaceInvitationListResponse =
  components["schemas"]["WorkspaceInvitationListResponse"];
export type InvitationPreview = components["schemas"]["InvitationPreview"];
export type InstallationSummary = components["schemas"]["InstallationSummary"];
export type AccountLifecycle = components["schemas"]["AccountLifecycle"];
export type AuditListResponse = components["schemas"]["AuditListResponse"];
export type AuditEntry = AuditListResponse["entries"][number];
export type AuditQueryParams = NonNullable<operations["listWorkspaceAudit"]["parameters"]["query"]>;

export type Platform = components["schemas"]["Platform"];
export type PlatformCapability = components["schemas"]["PlatformCapability"];
export type PlatformCapabilitiesResponse = components["schemas"]["PlatformCapabilitiesResponse"];
export type PlatformAccount = components["schemas"]["PlatformAccount"];
export type ConnectionStatus = components["schemas"]["ConnectionStatus"];
export type PlatformAccountsResponse = components["schemas"]["PlatformAccountsResponse"];
export type PlatformQueryParams = NonNullable<
  operations["listPlatformAccounts"]["parameters"]["query"]
>;
export type PublishingRequirements = components["schemas"]["PublishingRequirements"];
export type TikTokPrivacyLevel = components["schemas"]["TikTokPrivacyLevel"];
export type TikTokPublishingRequirements = components["schemas"]["TikTokPublishingRequirements"];

export type OAuthSelectionAccount = components["schemas"]["OAuthSelectionAccount"];
export type OAuthSelection = components["schemas"]["OAuthSelection"];
export type OAuthSelectionConfirmRequest = components["schemas"]["OAuthSelectionConfirmRequest"];

/**
 * Uploaded media owned by a Post attachment. Assets are internal infrastructure:
 * they are reachable only through the composer's attachment upload, the
 * per-Post ordered attachment list, and scoped read/preview/download helpers —
 * there is no browsable Asset library and no text Asset.
 */
export type Asset = components["schemas"]["Asset"];
export type CreateUploadSessionInput = components["schemas"]["CreateUploadSessionRequest"];
export type UploadSession = components["schemas"]["UploadSession"];
export type UploadSessionResponse = components["schemas"]["UploadSessionResponse"];
export type UploadSessionDetailResponse = components["schemas"]["UploadSessionDetailResponse"];
export type CreateUploadPartsInput = components["schemas"]["CreateUploadPartsRequest"];
export type CreateUploadPartsResponse = components["schemas"]["CreateUploadPartsResponse"];
export type CompleteUploadInput = components["schemas"]["CompleteUploadRequest"];
export type CompletedPart = components["schemas"]["CompletedPart"];

/**
 * Durable composition identity. One Post owns its default content, its ordered
 * attachment relationships, its saved per-Channel target settings, and the
 * independent per-Channel publication outcomes; scheduling, editing, and
 * publishing all preserve `Post.id`. Publication success is never derived from
 * `Post.status`, which only marks draft versus active lifecycle.
 */
export type Post = components["schemas"]["Post"];
export type PostListResponse = components["schemas"]["PostListResponse"];
/**
 * One ordered Post-to-Asset relationship. `position` is the creator's
 * zero-based ordering and `asset` carries the current upload/processing state
 * so a draft can persist while its media is still preparing.
 */
export type PostAttachment = components["schemas"]["PostAttachment"];
/**
 * Saved per-Channel settings for one Platform account on a Post. A null
 * `attachment_ids` inherits the Post's ordered attachments, `[]` publishes
 * text only, and a list overrides membership and order for that Channel.
 */
export type PostTarget = components["schemas"]["PostTarget"];
export type PostTargetInput = components["schemas"]["PostTargetInput"];
export type CreatePostInput = components["schemas"]["CreatePostRequest"];
export type UpdatePostInput = components["schemas"]["UpdatePostRequest"];
export type SchedulePostInput = components["schemas"]["SchedulePostRequest"];
export type PostQueryParams = NonNullable<operations["listPosts"]["parameters"]["query"]>;

export type Distribution = components["schemas"]["Distribution"];
export type DistributionListResponse = components["schemas"]["DistributionListResponse"];
export type UpdateDistributionInput = components["schemas"]["UpdateDistributionRequest"];
export type DistributionQueryParams = NonNullable<
  operations["listDistributions"]["parameters"]["query"]
>;

export type CalendarEvent = components["schemas"]["CalendarEvent"];
export type CalendarResponse = components["schemas"]["CalendarResponse"];
export type CalendarQueryParams = NonNullable<
  operations["listCalendarEvents"]["parameters"]["query"]
>;

/**
 * One stored metric the Analytics page may rank and chart. The page never
 * derives engagement rates or offers metrics the Providers do not report.
 */
export type AnalyticsMetric = components["schemas"]["AnalyticsMetric"];
/** Range presets offered by the Analytics toolbar and URL state. */
export type AnalyticsRangePreset = "7d" | "30d" | "90d" | "366d";
export type PlatformMetrics = components["schemas"]["PlatformMetrics"];
export type AnalyticsSummary = components["schemas"]["AnalyticsSummary"];
export type AnalyticsPostRow = components["schemas"]["AnalyticsPostRow"];
export type AnalyticsPostsResponse = components["schemas"]["AnalyticsPostsResponse"];
export type AnalyticsDashboard = components["schemas"]["AnalyticsDashboard"];
export type AnalyticsDashboardQueryParams = NonNullable<
  operations["getAnalyticsDashboard"]["parameters"]["query"]
>;
export type AnalyticsDaySeries = components["schemas"]["AnalyticsDaySeries"];
export type AnalyticsBestTime = components["schemas"]["AnalyticsBestTime"];
export type AnalyticsFormat = components["schemas"]["AnalyticsFormat"];
export type AnalyticsPlatformBreakdown = components["schemas"]["AnalyticsPlatformBreakdown"];
export type AnalyticsSummaryQueryParams = NonNullable<
  operations["getAnalyticsSummary"]["parameters"]["query"]
>;
export type AnalyticsPostsQueryParams = NonNullable<
  operations["getAnalyticsPosts"]["parameters"]["query"]
>;

/**
 * Cache-key inputs shared by both Analytics reads. `range` is part of the key
 * but never sent to the API; the rolling start/end window is recomputed inside
 * each query function so the key stays stable between renders.
 */
export interface AnalyticsScopeParams {
  account_id?: string;
  brand_profile_id?: string;
  format?: AnalyticsFormat;
  platform?: Platform;
  range: AnalyticsRangePreset;
}

/** Analytics Post read inputs plus the ranking metric and requested page. */
export interface AnalyticsPostScopeParams extends AnalyticsScopeParams {
  limit: number;
  metric: AnalyticsMetric;
  offset?: number;
}

export type SignedUrlResponse = components["schemas"]["SignedUrlResponse"];
