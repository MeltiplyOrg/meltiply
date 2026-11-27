import type { components } from "@meltiply/contracts/schema";
import type { EngagementMetric, PlatformCapability, ProviderFailureClass } from "@meltiply/domain";

export type { ProviderFailureClass };

export interface RateLimitBudget {
  percentUsed: number | null;
  remaining: number | null;
  resetsInSeconds: number | null;
}

export type ProviderTransferMode = "byte_upload" | "remote_ingest" | "resumable_upload";

export interface ProviderOperationMetadata {
  rateLimitBudget?: RateLimitBudget;
}

export interface ProviderRequestContext {
  operationId: string;
  requestId: string;
  metadata?: ProviderOperationMetadata;
  signal?: AbortSignal;
}

export interface ProviderCredentials {
  accountId?: string;
  accessToken: string;
}

export interface ProviderFailure {
  classification: ProviderFailureClass;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export type ProviderOperationResult =
  | {
      metadata?: ProviderOperationMetadata;
      /** Terminal remote handoff, not a published Post (draft, inbox, experiment, or broadcast). */
      delivery?: "draft" | "inbox" | "experiment" | "broadcast";
      outcome: "confirmed_success";
      warnings?: components["schemas"]["Distribution"]["provider_warnings"];
      providerOperationId?: string;
      providerPostId?: string;
      providerUrl?: string;
    }
  | {
      failure: ProviderFailure;
      metadata?: ProviderOperationMetadata;
      outcome: "confirmed_failure";
      providerOperationId?: string;
    }
  | {
      failure: ProviderFailure & { classification: "ambiguous" };
      metadata?: ProviderOperationMetadata;
      outcome: "unknown";
      providerOperationId?: string;
    };

export type ProviderPublicationStatus = (
  | {
      providerOperationId: string;
      state: "processing";
    }
  | {
      result: Extract<ProviderOperationResult, { outcome: "confirmed_success" }>;
      state: "published";
    }
  | {
      result: Extract<ProviderOperationResult, { outcome: "confirmed_success" }>;
      state: "delivered";
    }
  | {
      result: Extract<ProviderOperationResult, { outcome: "confirmed_failure" }>;
      state: "failed";
    }
  | {
      result: Extract<ProviderOperationResult, { outcome: "unknown" }>;
      state: "unknown";
    }
  | {
      state: "not_found";
    }
) & {
  metadata?: ProviderOperationMetadata;
};

export interface ProviderRemoteMedia {
  contentType: string;
  fileSize: number;
  metadata?: ProviderMediaMetadata;
  mode: "remote_ingest";
  url: string;
}

export interface ProviderStreamMedia {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  fileSize: number;
  metadata?: ProviderMediaMetadata;
  mode: "byte_upload" | "resumable_upload";
}

export type ProviderMedia = ProviderRemoteMedia | ProviderStreamMedia;

export interface ProviderMediaMetadata {
  durationSeconds?: number;
  height?: number;
  width?: number;
}

export type TikTokPrivacyLevel =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY";

export const TIKTOK_PRIVACY_LEVELS: ReadonlySet<TikTokPrivacyLevel> = new Set([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
]);

export interface TikTokPublishOptions {
  postMode?: "direct" | "inbox";
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  autoAddMusic?: boolean;
  brandContent: boolean;
  brandOrganic: boolean;
  isAiGenerated: boolean;
  musicUsageConfirmed: true;
  privacyLevel?: TikTokPrivacyLevel;
}

export type InstagramPostType = "feed" | "reel" | "story";

export type InstagramTrialGraduation = "manual" | "performance";

export interface InstagramPublishOptions {
  content?: components["schemas"]["InstagramContentOptions"];
  mediaOptions?: components["schemas"]["InstagramContentOptions"][];
  postType?: InstagramPostType;
  trialGraduation?: InstagramTrialGraduation;
  trialReel?: boolean;
}

export type YouTubePrivacyStatus = "public" | "unlisted" | "private";

export const YOUTUBE_PRIVACY_STATUSES: ReadonlySet<YouTubePrivacyStatus> = new Set([
  "private",
  "public",
  "unlisted",
]);

/** `madeForKids` is a required COPPA declaration; omitted `privacyStatus` defaults to `"public"`. */
export interface YouTubePublishOptions {
  postType?: "video" | "live";
  madeForKids: boolean;
  privacyStatus?: YouTubePrivacyStatus;
}

export type FacebookPostType =
  | "feed"
  | "video"
  | "reel"
  | "story"
  | "slideshow"
  | "crosspost"
  | "ab_test"
  | "live";

/** A link carousel card; Meta requires a public preview image for each card. */
export interface FacebookLinkCard {
  link: string;
  picture: string;
  name?: string;
  description?: string;
}

export type FacebookOptimizationGoal =
  | "AVG_TIME_WATCHED"
  | "COMMENTS"
  | "IMPRESSIONS"
  | "IMPRESSIONS_UNIQUE"
  | "LINK_CLICKS"
  | "REACTIONS"
  | "REELS_PLAYS"
  | "SHARES"
  | "VIDEO_VIEWS_60S";

/** Saved experiment intent; drafts may retain unanswered required choices. */
export interface FacebookABTestOptions {
  name?: string;
  controlVideoId?: string;
  experimentVideoIds?: string[];
  optimizationGoal?: FacebookOptimizationGoal;
  durationSeconds?: number;
}

export interface FacebookPublishOptions {
  postType?: FacebookPostType;
  deliveryMode?: "publish" | "draft";
  link?: string;
  linkCards?: FacebookLinkCard[];
  crosspostedVideoId?: string;
  abTest?: FacebookABTestOptions;
}

export interface ProviderPublishOptions {
  facebook?: FacebookPublishOptions;
  threads?: components["schemas"]["ThreadsPublishOptions"];
  instagram?: InstagramPublishOptions;
  tiktok?: TikTokPublishOptions;
  youtube?: YouTubePublishOptions;
}

export interface TikTokPublicationRequirements {
  commentAllowed: boolean;
  creatorAvatarUrl?: string;
  creatorDisplayName: string;
  creatorUsername: string;
  duetAllowed: boolean;
  maxVideoDurationSeconds: number;
  platform: "tiktok";
  privacyLevels: TikTokPrivacyLevel[];
  stitchAllowed: boolean;
}

export type ProviderPublicationRequirements = TikTokPublicationRequirements;

export interface PublishInput {
  caption: string;
  hashtags: string[];
  idempotencyKey: string;
  media: ProviderMedia[];
  providerOptions?: ProviderPublishOptions;
}

export interface ProviderPublicationLookup {
  /** Supplied only for adapters whose `continuesResumableUpload` accepts the retained operation ID. */
  media?: ProviderMedia;
  providerOperationId?: string;
  providerPostId?: string;
}

export interface ProviderPageInput {
  cursor?: string;
  limit: number;
}

export interface ProviderPage<T> {
  items: T[];
  nextCursor?: string;
}

export type ProviderAnalyticsMetric = EngagementMetric;

export interface ProviderAnalyticsRecord {
  /** Nullable counters are Provider metrics that may be unavailable, never zero by default. */
  clicks?: number | null;
  comments: number;
  impressions: number;
  likes: number;
  providerPostId: string;
  reach: number;
  recordedAt: string;
  saves?: number | null;
  shares: number;
  views: number;
  watchTimeSeconds: number;
}

export interface ProviderAccountAnalytics {
  followers: number;
  following?: number;
  posts?: number;
  recordedAt: string;
}

export interface ProviderCommentRecord {
  authorAvatarUrl?: string;
  authorDisplayName?: string;
  body: string;
  commentedAt: string;
  providerCommentId: string;
  providerPostId: string;
}

export interface ProviderReplyInput {
  idempotencyKey: string;
  providerCommentId: string;
  text: string;
}

export interface ProviderTokenSet {
  accessToken: string;
  /** ISO expiry when time-bounded; absent means no time-based expiry, not immunity to revocation. */
  expiresAt?: string;
  refreshToken?: string;
  scopes: string[];
}

/**
 * Encoder credentials read on demand for an authorized content writer.
 * Never persist in publication IDs, shared read models, analytics, or logs.
 */
export interface ProviderBroadcastInfo {
  state: "ready" | "testing" | "live" | "ended";
  ingestUrl?: string;
  streamKey?: string;
  providerUrl?: string;
  providerPostId?: string;
}

export interface ProviderRetryPolicy {
  baseDelaySeconds: number;
  maxAttempts: number;
  maxDelaySeconds: number;
}

export interface OAuthAuthorizationInput {
  codeChallenge: string;
  redirectUri: string;
  state: string;
}

export interface OAuthExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OAuthConnection extends ProviderTokenSet {
  account: {
    avatarUrl?: string;
    displayName?: string;
    id: string;
    username?: string;
  };
}

export interface OAuthAccountSelection {
  accounts: OAuthConnection[];
}

export type OAuthExchangeResult = OAuthConnection | OAuthAccountSelection;

/**
 * Raw Promise/SDK adapter boundary, implemented only inside packages/providers.
 * Applications compose ProviderService Effects; this shape exists for adapter
 * construction, capability inspection, and injected boundary fakes.
 */
export interface ProviderAdapter {
  getBroadcastInfo?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
  ): Promise<ProviderBroadcastInfo>;
  endBroadcast?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
  ): Promise<ProviderOperationResult>;
  authorizationUrl?(input: OAuthAuthorizationInput): string;
  cancelPublication?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
  ): Promise<ProviderOperationResult>;
  capability: PlatformCapability;
  exchangeAuthorizationCode?(
    context: ProviderRequestContext,
    input: OAuthExchangeInput,
  ): Promise<OAuthExchangeResult>;
  getPublicationRequirements?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
  ): Promise<ProviderPublicationRequirements>;
  getAccountAnalytics?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
  ): Promise<ProviderAccountAnalytics>;
  listAnalytics?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
    page: ProviderPageInput,
  ): Promise<ProviderPage<ProviderAnalyticsRecord>>;
  listComments?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
    page: ProviderPageInput,
  ): Promise<ProviderPage<ProviderCommentRecord>>;
  /** Returns true when `providerOperationId` names an open resumable upload this adapter can continue in `lookupPublication`. */
  continuesResumableUpload?(providerOperationId: string): boolean;
  lookupPublication?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    lookup: ProviderPublicationLookup,
  ): Promise<ProviderPublicationStatus>;
  publish?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    input: PublishInput,
  ): Promise<ProviderOperationResult>;
  refreshAccessToken?(
    context: ProviderRequestContext,
    refreshToken: string,
  ): Promise<ProviderTokenSet>;
  reply?(
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    input: ProviderReplyInput,
  ): Promise<ProviderOperationResult>;
  /**
   * Metrics whose stored zero cannot be told apart from "the Provider did not
   * return it".
   *
   * An adapter that normalizes a missing insight to `0` names those metrics here,
   * so consumers read a zero as unknown instead of as an observed count. Adapters
   * that reject an incomplete response omit the field: their zeros are
   * observations. This is the only place the distinction is stated.
   */
  ambiguousZeroMetrics?: readonly ProviderAnalyticsMetric[];
  retryPolicy?: ProviderRetryPolicy;
  revoke?(accessToken: string, context?: ProviderRequestContext): Promise<void>;
  transferModes: readonly ProviderTransferMode[];
}
