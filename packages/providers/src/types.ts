import type { PlatformCapability } from "@meltiply/contracts";

import type { RateLimitBudget } from "./rate-limit";

export type ProviderFailureClass =
  | "ambiguous"
  | "auth"
  | "deterministic"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "transient";

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
      outcome: "confirmed_success";
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
      metadata?: ProviderOperationMetadata;
      providerOperationId: string;
      state: "processing";
    }
  | {
      metadata?: ProviderOperationMetadata;
      result: Extract<ProviderOperationResult, { outcome: "confirmed_success" }>;
      state: "published";
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

/**
 * Remote-ingest attachment: the provider fetches the media from a public HTTPS
 * URL. `metadata` carries the verified duration/dimensions resolved from the
 * stored rendition so capability duration and dimension checks apply per
 * attachment; it is absent when processing could not establish those facts.
 */
export interface ProviderRemoteMedia {
  contentType: string;
  fileSize: number;
  metadata?: ProviderMediaMetadata;
  mode: "remote_ingest";
  url: string;
}

/**
 * Byte or resumable-stream attachment: bytes are pushed to the provider from a
 * Worker stream. `metadata` matches {@link ProviderRemoteMedia.metadata} so
 * every attachment kind carries its own verified facts.
 */
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

export interface TikTokPublishOptions {
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  brandContent: boolean;
  brandOrganic: boolean;
  isAiGenerated: boolean;
  musicUsageConfirmed: true;
  privacyLevel: TikTokPrivacyLevel;
}

export type YouTubePrivacyStatus = "public" | "unlisted" | "private";

/**
 * Creator-selected YouTube publication options mapped to `videos.insert` status fields.
 * `madeForKids` is a required COPPA declaration; `privacyStatus` is optional and the
 * adapter applies the established public default when it is omitted.
 */
export interface YouTubePublishOptions {
  madeForKids: boolean;
  privacyStatus?: YouTubePrivacyStatus;
}

export interface ProviderPublishOptions {
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

/**
 * One resolved publish request: the composed caption plus the Post's ordered
 * attachments as ProviderMedia items, where the array index is the attachment
 * position the creator arranged. `media` is required so every caller decides
 * explicitly: an empty array is a text-only publish, which stays valid only
 * where the platform capability permits it. Per-attachment kind derives from
 * each item's `contentType`; per-attachment verified duration and dimensions
 * ride on {@link ProviderMedia.metadata} rather than a sibling field.
 */
export interface PublishInput {
  caption: string;
  hashtags: string[];
  idempotencyKey: string;
  media: ProviderMedia[];
  providerOptions?: ProviderPublishOptions;
}

export interface ProviderPublicationLookup {
  /**
   * Replayable media supplied only for adapters that declare
   * `continuesResumableUpload`: reconciliation re-opens the original Asset
   * stream so a persisted resumable session can resume from the provider's
   * acknowledged byte offset instead of stalling until the session expires.
   * Adapters without the capability never receive it and ignore the field.
   */
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

/** Account-level counters captured on a slower cadence than per-Post snapshots. */
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
  authorizationUrl?(input: OAuthAuthorizationInput): string;
  extractRateLimitBudget?(headers: Headers): RateLimitBudget | null;
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
  /**
   * Narrow opt-in continuation seam: returns true when the retained
   * providerOperationId names an open resumable upload session this adapter
   * can continue inside `lookupPublication` once `lookup.media` replays the
   * original Asset bytes. Generic callers resolve media only when this
   * predicate accepts; adapters that omit it keep the read-only status lookup.
   */
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
  retryPolicy?: ProviderRetryPolicy;
  revoke?(accessToken: string, context?: ProviderRequestContext): Promise<void>;
  transferModes: readonly ProviderTransferMode[];
}
