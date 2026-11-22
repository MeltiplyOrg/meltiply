import { malformed, requiredIdentifier } from "../adapter-helpers";
import { META_GRAPH_API_VERSION, PROVIDER_LIMITS } from "../limits";
import { boundedString, providerIdentifier, record, secureUrl } from "../meta-common";
import type { ProviderCredentials, ProviderOperationResult } from "../types";

export const FACEBOOK_GRAPH_ORIGIN = "https://graph.facebook.com";
export const FACEBOOK_UPLOAD_ORIGIN = "https://rupload.facebook.com";
export const FACEBOOK_AUTHORIZATION_ORIGIN = "https://www.facebook.com";
export const FACEBOOK_API_VERSION = META_GRAPH_API_VERSION;
export const FACEBOOK_LIMITS = PROVIDER_LIMITS.facebook;

/** Permissions required to publish and read Page engagement. */
export const FACEBOOK_PUBLISHING_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
] as const;

/** Additional permissions required by Reels analytics; requested but not required to connect. */
const analyticsScopes = ["pages_manage_engagement", "read_insights"] as const;

export const FACEBOOK_CONFIGURED_SCOPES = [
  ...FACEBOOK_PUBLISHING_SCOPES,
  ...analyticsScopes,
  "pages_read_user_content",
] as const;

export const FACEBOOK_BUSINESS_DISCOVERY_SCOPE = "business_management";

export type FacebookOperationPhase =
  | "ab_test"
  | "ended_live"
  | "live"
  | "finish_submitted"
  | "finishing"
  | "post"
  | "post_draft"
  | "reel_draft"
  | "story"
  | "upload_submitted"
  | "uploaded"
  | "video"
  | "video_draft";

const operationPhases: ReadonlySet<string> = new Set<FacebookOperationPhase>([
  "ab_test",
  "ended_live",
  "live",
  "finish_submitted",
  "finishing",
  "post",
  "post_draft",
  "reel_draft",
  "story",
  "upload_submitted",
  "uploaded",
  "video",
  "video_draft",
]);

function isFacebookOperationPhase(value: string): value is FacebookOperationPhase {
  return operationPhases.has(value);
}

const operationPattern = /^([a-z_]+):(.+)$/;
const uploadPathPattern = /^\/video-upload\/v\d+\.\d+\/(.+)$/;

export interface FacebookOperation {
  id: string;
  phase: FacebookOperationPhase;
}

export interface FacebookReelStatus {
  processing: string;
  publishing: string;
  uploading: string;
  video: string;
}

export interface FacebookRefreshSecret {
  pageId: string;
  userAccessToken: string;
}

/**
 * Extracts and validates the required Facebook Page account identifier from credentials.
 * Ensures accountId is present and conforms to provider identifier format rules.
 */
export function facebookAccountId(credentials: ProviderCredentials): string {
  return requiredIdentifier(credentials.accountId, "facebook_page_account_required");
}

/**
 * Encodes the publication kind or video lifecycle phase with its provider ID.
 * Post identities distinguish ordinary feed posts from asynchronous Reels
 * during subsequent reconciliation and analytics reads.
 */
export function facebookOperationId(phase: FacebookOperationPhase, id: string): string {
  return `${phase}:${id}`;
}

/**
 * Parses an ordinary Page post or asynchronous video operation identity.
 * Unknown phases and invalid provider IDs fail closed.
 */
export function parseFacebookOperationId(value: unknown): FacebookOperation | undefined {
  const normalized = providerIdentifier(value);
  const match = normalized?.match(operationPattern);
  const phase = match?.[1];
  const id = providerIdentifier(match?.[2]);
  if (!phase || !id || !isFacebookOperationPhase(phase)) return undefined;
  return { id, phase };
}

/**
 * Returns a confirmed Page feed publication using Meta's page_post_id.
 * The query-free permalink remains intact through delivery URL sanitization.
 */
export function facebookPublishedPost(
  id: string,
): Extract<ProviderOperationResult, { outcome: "confirmed_success" }> {
  return {
    outcome: "confirmed_success",
    providerOperationId: facebookOperationId("post", id),
    providerPostId: id,
    providerUrl: `https://www.facebook.com/${encodeURIComponent(id)}`,
  };
}

/** Records a terminal native draft without manufacturing a public Post ID. */
export function facebookNativeDraft(
  phase: "post_draft" | "video_draft" | "reel_draft",
  id: string,
): Extract<ProviderOperationResult, { outcome: "confirmed_success" }> {
  return {
    outcome: "confirmed_success",
    delivery: "draft",
    providerOperationId: facebookOperationId(phase, id),
  };
}

/** Accepts string IDs and safe numeric Story/Live/AB-test IDs without losing precision. */
export function facebookStoryPostId(value: unknown): string | undefined {
  return providerIdentifier(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value,
  );
}

/**
 * Validates a Facebook Reel binary upload URL returned by the Graph API.
 * Confirms strict HTTPS origin on rupload.facebook.com and matching videoId path structure.
 */
export function validateFacebookUploadUrl(value: unknown, videoId: string): string {
  const url = secureUrl(value);
  if (!url) throw malformed();
  if (
    url.origin !== FACEBOOK_UPLOAD_ORIGIN ||
    url.search ||
    uploadPathPattern.exec(url.pathname)?.[1] !== videoId
  ) {
    throw malformed();
  }
  return url.toString();
}

/**
 * Parses and validates the multi-phase processing status of a published Facebook Reel.
 * Asserts matching video ID and extracts status for uploading, processing, and publishing phases.
 */
export function parseFacebookReelStatus(value: unknown, expectedId: string): FacebookReelStatus {
  const body = record(value);
  const status = record(body?.status);
  const id = providerIdentifier(body?.id);
  const video = boundedString(status?.video_status, 64)?.toLowerCase();
  const uploading = boundedString(record(status?.uploading_phase)?.status, 64)?.toLowerCase();
  const processing = boundedString(record(status?.processing_phase)?.status, 64)?.toLowerCase();
  const publishing = boundedString(record(status?.publishing_phase)?.status, 64)?.toLowerCase();
  if (id !== expectedId || !status || !video || !uploading || !processing || !publishing) {
    throw malformed();
  }
  return { processing, publishing, uploading, video };
}

/** Determines whether Meta has terminated Reel ingestion or publication. */
export function isFacebookReelStatusFailed(status: FacebookReelStatus): boolean {
  return (
    ["expired", "upload_failed"].includes(status.video) ||
    [status.video, status.uploading, status.processing, status.publishing].some(
      (value) => value === "error" || value === "failed",
    )
  );
}

/** Evaluates whether a Facebook Reel has finished publishing and is live on the Page. */
export function isFacebookReelStatusPublished(status: FacebookReelStatus): boolean {
  return status.publishing === "completed" || status.publishing === "complete";
}
