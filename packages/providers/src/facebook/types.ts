import { malformed, requiredIdentifier } from "../failures";
import type { ProviderHttpClient } from "../http";
import { PROVIDER_LIMITS } from "../limits";
import { META_GRAPH_API_VERSION } from "../meta";
import type { ProviderCredentials, ProviderRequestContext } from "../types";
import type { ConfirmedSuccess } from "../results";
import {
  bearer,
  boundedString,
  providerIdentifier,
  record,
  secureUrl,
  STANDARD_VIDEO_MIME_TYPES,
} from "../values";

export const FACEBOOK_GRAPH_ORIGIN = "https://graph.facebook.com";
export const FACEBOOK_UPLOAD_ORIGIN = "https://rupload.facebook.com";
export const FACEBOOK_LIMITS = PROVIDER_LIMITS.facebook;
export const FACEBOOK_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
  "image/tiff",
];
export const FACEBOOK_VIDEO_TYPES = STANDARD_VIDEO_MIME_TYPES;

export const FACEBOOK_PUBLISHING_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
] as const;

export const FACEBOOK_CONFIGURED_SCOPES = [
  ...FACEBOOK_PUBLISHING_SCOPES,
  "pages_manage_engagement",
  "read_insights",
  "pages_read_user_content",
] as const;

export const FACEBOOK_BUSINESS_DISCOVERY_SCOPE = "business_management";

const operationPhases = [
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
] as const;

export type FacebookOperationPhase = (typeof operationPhases)[number];

const operationPhaseSet: ReadonlySet<string> = new Set(operationPhases);
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

export function graphUrl(path: string): URL {
  return new URL(`/${META_GRAPH_API_VERSION}/${path}`, FACEBOOK_GRAPH_ORIGIN);
}

export async function graphGet(
  http: ProviderHttpClient,
  context: ProviderRequestContext,
  accessToken: string,
  url: URL,
): Promise<Record<string, unknown> | undefined> {
  return record(
    (
      await http.request(context, {
        headers: bearer(accessToken),
        method: "GET",
        url: url.toString(),
      })
    ).body,
  );
}

export function nodeUrl(id: string, fields?: string): URL {
  const url = graphUrl(encodeURIComponent(id));
  if (fields) url.searchParams.set("fields", fields);
  return url;
}

export function facebookPermalink(id: string): string {
  return `https://www.facebook.com/${encodeURIComponent(id)}`;
}

export function facebookAccountId(credentials: ProviderCredentials): string {
  return requiredIdentifier(credentials.accountId, "facebook_page_account_required");
}

export function facebookOperationId(phase: FacebookOperationPhase, id: string): string {
  return `${phase}:${id}`;
}

function isFacebookOperationPhase(value: string): value is FacebookOperationPhase {
  return operationPhaseSet.has(value);
}

export function parseFacebookOperationId(value: unknown): FacebookOperation | undefined {
  const match = providerIdentifier(value)?.match(operationPattern);
  const phase = match?.[1];
  const id = providerIdentifier(match?.[2]);
  if (!phase || !id || !isFacebookOperationPhase(phase)) return undefined;
  return { id, phase };
}

export function facebookPublishedVideo(
  phase: FacebookOperationPhase,
  id: string,
): ConfirmedSuccess {
  return {
    outcome: "confirmed_success",
    providerOperationId: facebookOperationId(phase, id),
    providerPostId: id,
    providerUrl: facebookPermalink(id),
  };
}

/** A native draft is a terminal handoff, not a public Post, so it has no post ID. */
export function facebookNativeDraft(
  phase: "post_draft" | "video_draft" | "reel_draft",
  id: string,
): ConfirmedSuccess {
  return {
    outcome: "confirmed_success",
    delivery: "draft",
    providerOperationId: facebookOperationId(phase, id),
  };
}

/** The Reel binary upload URL must target rupload.facebook.com for the same video. */
export function validateFacebookUploadUrl(value: unknown, videoId: string): string {
  const url = secureUrl(value);
  if (
    !url ||
    url.origin !== FACEBOOK_UPLOAD_ORIGIN ||
    url.search ||
    uploadPathPattern.exec(url.pathname)?.[1] !== videoId
  ) {
    throw malformed();
  }
  return url.toString();
}

export function parseFacebookReelStatus(value: unknown, expectedId: string): FacebookReelStatus {
  const body = record(value);
  const status = record(body?.status);
  const phaseStatus = (phase: unknown) => boundedString(record(phase)?.status, 64)?.toLowerCase();
  const video = boundedString(status?.video_status, 64)?.toLowerCase();
  const uploading = phaseStatus(status?.uploading_phase);
  const processing = phaseStatus(status?.processing_phase);
  const publishing = phaseStatus(status?.publishing_phase);
  if (
    providerIdentifier(body?.id) !== expectedId ||
    !video ||
    !uploading ||
    !processing ||
    !publishing
  ) {
    throw malformed();
  }
  return { processing, publishing, uploading, video };
}

export function isFacebookReelStatusFailed(status: FacebookReelStatus): boolean {
  return (
    status.video === "expired" ||
    status.video === "upload_failed" ||
    [status.video, status.uploading, status.processing, status.publishing].some(
      (value) => value === "error" || value === "failed",
    )
  );
}

export function isFacebookReelStatusPublished(status: FacebookReelStatus): boolean {
  return status.publishing === "completed" || status.publishing === "complete";
}
