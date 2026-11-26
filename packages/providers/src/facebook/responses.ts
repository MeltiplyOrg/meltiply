import {
  classifyProviderFailure,
  malformed,
  ProviderAdapterError,
  rejected,
  rejection,
} from "../failures";
import { OAUTH_TOKEN_MAX_CHARS } from "../limits";
import { addSeconds } from "../oauth";
import { confirmedFailure, unknownResult } from "../results";
import type {
  OAuthConnection,
  ProviderBroadcastInfo,
  ProviderMedia,
  ProviderPublicationLookup,
  ProviderPublicationStatus,
  PublishInput,
} from "../types";
import {
  boundedCursor,
  boundedString,
  boundedText,
  metricValue,
  normalizeContentType,
  numericOrStringIdentifier,
  providerIdentifier,
  record,
  required,
  secureUrl,
  validFileSize,
} from "../values";
import {
  FACEBOOK_GRAPH_ORIGIN,
  FACEBOOK_IMAGE_TYPES,
  FACEBOOK_LIMITS,
  FACEBOOK_VIDEO_TYPES,
  facebookNativeDraft,
  facebookOperationId,
  facebookPermalink,
  facebookPublishedPost,
  facebookPublishedVideo,
  isFacebookReelStatusFailed,
  isFacebookReelStatusPublished,
  parseFacebookOperationId,
  type FacebookOperation,
  type FacebookReelStatus,
  type FacebookRefreshSecret,
} from "./types";

const numericIdPattern = /^\d+$/;
const vanityHandlePattern = /^[A-Za-z0-9.]{1,255}$/;
const pageTaskPattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const reservedPaths = new Set([
  "events",
  "gaming",
  "groups",
  "help",
  "marketplace",
  "pages",
  "people",
  "privacy",
  "profile.php",
  "settings",
  "watch",
]);
const contentTasks = ["CREATE_CONTENT", "PROFILE_PLUS_CREATE_CONTENT"];
const maxPageTasks = 32;
const liveStatuses = new Set([
  "LIVE",
  "LIVE_NOW",
  "UNPUBLISHED",
  "SCHEDULED_UNPUBLISHED",
  "SCHEDULED_LIVE",
  "PREVIEW",
  "VOD",
  "SCHEDULED_CANCELED",
]);
const failedVideoStatuses = ["error", "expired", "upload_failed"];
const publishedStoryStatuses = ["PUBLISHED", "ARCHIVED"];
const maxStreamUrlChars = 4096;

type OAuthField =
  | "authorization_token"
  | "business_user_identity"
  | "business_user_list"
  | "long_lived_token"
  | "token_type"
  | "token_expiry"
  | "permissions"
  | "page_list"
  | "page_identity"
  | "page_access_token"
  | "page_tasks"
  | "page_pagination";

export function oauthMalformed(field: OAuthField, cause?: Error): ProviderAdapterError {
  return new ProviderAdapterError(
    classifyProviderFailure({ code: `facebook_oauth_${field}_invalid`, malformedResponse: true }),
    cause ? { cause } : undefined,
  );
}

export function expiryDiagnostic(
  source: "exchange" | "debug_token",
  facts: Readonly<Record<string, unknown>>,
): Error {
  const rendered = Object.entries(facts)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => {
      const shown =
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean" ||
        value === null
          ? String(value)
          : typeof value;
      return `${name}=${shown}`;
    });
  return new Error(
    `Facebook OAuth expiry rejected: ${[`source=${source}`, ...rendered, `maximum_seconds=${FACEBOOK_LIMITS.tokenLifetimeMaxSeconds}`].join(", ")}`,
  );
}

export function decodeRefreshSecret(value: string): FacebookRefreshSecret {
  const raw = required("refreshToken", value, OAUTH_TOKEN_MAX_CHARS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw rejected("facebook_refresh_secret_invalid");
  }
  const body = record(parsed);
  const pageId = providerIdentifier(body?.pageId);
  const userAccessToken = boundedString(body?.userAccessToken, FACEBOOK_LIMITS.tokenMaxChars);
  if (!body || Object.keys(body).length !== 2 || !pageId || !userAccessToken) {
    throw rejected("facebook_refresh_secret_invalid");
  }
  return { pageId, userAccessToken };
}

export function encodeRefreshSecret(value: FacebookRefreshSecret): string {
  return JSON.stringify(value);
}

export function grantedPermissions(value: unknown): string[] {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw oauthMalformed("permissions");
  const granted = new Set<string>();
  for (const item of data) {
    const entry = record(item);
    const permission = boundedString(entry?.permission, 128);
    const status = boundedString(entry?.status, 32)?.toLowerCase();
    if (!permission || !status) throw oauthMalformed("permissions");
    if (status === "granted") granted.add(permission);
  }
  return [...granted];
}

function facebookVanityHandle(link: unknown): string | undefined {
  if (typeof link !== "string" || !URL.canParse(link)) return undefined;
  const url = new URL(link);
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const [candidate] = segments;
  if (
    (host !== "facebook.com" && !host.endsWith(".facebook.com")) ||
    url.searchParams.has("id") ||
    segments.length !== 1 ||
    !candidate ||
    numericIdPattern.test(candidate) ||
    !vanityHandlePattern.test(candidate) ||
    reservedPaths.has(candidate.toLowerCase())
  ) {
    return undefined;
  }
  return candidate;
}

export function nextPageCursor(pagingValue: unknown, seenCursors: Set<string>): string | undefined {
  if (pagingValue === undefined) return undefined;
  const paging = record(pagingValue);
  const cursors = paging?.cursors === undefined ? {} : record(paging.cursors);
  if (!paging || !cursors) throw oauthMalformed("page_pagination");
  const cursorFromPaging =
    cursors.after === undefined ? undefined : (boundedCursor(cursors.after) ?? null);
  if (cursorFromPaging === null) throw oauthMalformed("page_pagination");
  if (paging.next === undefined) return undefined;
  if (typeof paging.next !== "string" || !URL.canParse(paging.next)) {
    throw oauthMalformed("page_pagination");
  }
  const nextUrl = new URL(paging.next);
  const rawAfter = nextUrl.searchParams.get("after");
  const cursorFromNext = rawAfter === null ? undefined : boundedCursor(rawAfter);
  const cursor = cursorFromPaging ?? cursorFromNext;
  if (
    nextUrl.origin !== FACEBOOK_GRAPH_ORIGIN ||
    (rawAfter !== null && !cursorFromNext) ||
    (cursorFromPaging !== undefined &&
      cursorFromNext !== undefined &&
      cursorFromPaging !== cursorFromNext) ||
    !cursor ||
    seenCursors.has(cursor)
  ) {
    throw oauthMalformed("page_pagination");
  }
  seenCursors.add(cursor);
  return cursor;
}

function parsePageTasks(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxPageTasks ||
    value.some((task) => typeof task !== "string" || !pageTaskPattern.test(task))
  ) {
    throw oauthMalformed("page_tasks");
  }
  return value;
}

export function facebookInspectedExpiry(
  value: unknown,
  clientId: string,
  exchangedAt: Date,
): string | undefined {
  const data = record(record(value)?.data);
  const evidence = {
    expiry: data?.expires_at,
    token_valid: data?.is_valid === true,
    app_matches: data?.app_id === clientId,
  };
  if (
    data?.is_valid !== true ||
    data.app_id !== clientId ||
    typeof data.expires_at !== "number" ||
    !Number.isSafeInteger(data.expires_at)
  ) {
    throw oauthMalformed("token_expiry", expiryDiagnostic("debug_token", evidence));
  }
  if (data.expires_at === 0) return undefined;
  const exchangedSeconds = Math.floor(exchangedAt.getTime() / 1_000);
  const lifetime = data.expires_at - exchangedSeconds;
  try {
    return addSeconds(
      new Date(exchangedSeconds * 1_000),
      lifetime,
      FACEBOOK_LIMITS.tokenLifetimeMaxSeconds,
    );
  } catch {
    throw oauthMalformed(
      "token_expiry",
      expiryDiagnostic("debug_token", { ...evidence, lifetime_seconds: lifetime }),
    );
  }
}

export function facebookPageConnection(
  value: unknown,
  longToken: { accessToken: string; expiresAt?: string },
  grantedScopes: readonly string[],
): OAuthConnection | undefined {
  const page = record(value);
  const id = providerIdentifier(page?.id);
  const displayName = boundedText(page?.name, 500);
  const accessToken = boundedString(page?.access_token, FACEBOOK_LIMITS.tokenMaxChars);
  if (!id || !displayName) throw oauthMalformed("page_identity");
  if (!accessToken) throw oauthMalformed("page_access_token");
  const tasks = parsePageTasks(page?.tasks);
  if (!tasks.some((task) => contentTasks.includes(task))) return undefined;
  const avatarUrl = secureUrl(
    record(record(page?.picture)?.data)?.url ??
      (typeof page?.picture === "string" ? page.picture : undefined),
  )?.href;
  const username = facebookVanityHandle(page?.link);
  return {
    accessToken,
    account: {
      ...(avatarUrl ? { avatarUrl } : {}),
      displayName,
      id,
      ...(username ? { username } : {}),
    },
    ...(longToken.expiresAt === undefined ? {} : { expiresAt: longToken.expiresAt }),
    refreshToken: encodeRefreshSecret({ pageId: id, userAccessToken: longToken.accessToken }),
    scopes: [...grantedScopes],
  };
}

function summaryCount(edge: unknown): number | undefined {
  return metricValue(record(record(edge)?.summary)?.total_count);
}

export function facebookAccountFollowers(body: Record<string, unknown> | undefined): number {
  const followers = metricValue(body?.followers_count);
  if (followers === undefined) throw malformed();
  return followers;
}

export function facebookReelEngagement(
  metrics: ReadonlyMap<string, number>,
  video: Record<string, unknown> | undefined,
): { comments: number; likes: number; shares: number; views: number } {
  const likes = summaryCount(video?.likes);
  const comments = summaryCount(video?.comments);
  const views = metrics.get("blue_reels_play_count");
  const socialActions = metrics.get("post_video_social_actions");
  if (
    comments === undefined ||
    likes === undefined ||
    views === undefined ||
    socialActions === undefined ||
    socialActions < comments
  ) {
    throw malformed();
  }
  return { comments, likes, shares: socialActions - comments, views };
}

export function remoteVideoUrl(input: PublishInput): string {
  const [media] = input.media;
  if (input.media.length !== 1 || !media || media.mode !== "remote_ingest") {
    throw rejected("facebook_reel_invalid");
  }
  const mediaUrl = secureUrl(media.url)?.href;
  if (
    !FACEBOOK_VIDEO_TYPES.includes(normalizeContentType(media.contentType)) ||
    !validFileSize(media.fileSize, FACEBOOK_LIMITS.maxVideoBytes) ||
    !mediaUrl
  ) {
    throw rejected("facebook_reel_media_invalid");
  }
  return mediaUrl;
}

export function photoUrl(media: ProviderMedia): string {
  const url = media.mode === "remote_ingest" ? secureUrl(media.url) : undefined;
  if (
    !url ||
    !FACEBOOK_IMAGE_TYPES.includes(normalizeContentType(media.contentType)) ||
    !validFileSize(media.fileSize, FACEBOOK_LIMITS.maxImageBytes)
  ) {
    throw rejected("facebook_photo_invalid");
  }
  return url.href;
}

function broadcastState(status: string): ProviderBroadcastInfo["state"] {
  if (status === "LIVE" || status === "LIVE_NOW") return "live";
  if (status === "PREVIEW") return "testing";
  return "ready";
}

export function liveOperation(lookup: ProviderPublicationLookup): FacebookOperation {
  const operation = parseFacebookOperationId(lookup.providerOperationId);
  if (operation?.phase !== "live") throw malformed();
  return operation;
}

export function facebookBroadcastInfo(
  body: Record<string, unknown> | undefined,
  id: string,
): ProviderBroadcastInfo {
  if (numericOrStringIdentifier(body?.id) !== id) throw malformed();
  const status = body?.status;
  if (typeof status !== "string" || !liveStatuses.has(status)) throw malformed();
  if (status === "VOD") {
    return { state: "ended", providerPostId: id, providerUrl: facebookPermalink(id) };
  }
  if (status === "SCHEDULED_CANCELED") return { state: "ended" };
  const stream = boundedString(body?.secure_stream_url, maxStreamUrlChars);
  if (!stream || !URL.canParse(stream) || new URL(stream).protocol !== "rtmps:") {
    throw malformed();
  }
  const state = broadcastState(status);
  return {
    state,
    ...(state === "live" ? { providerPostId: id } : {}),
    ingestUrl: stream,
    providerUrl: facebookPermalink(id),
  };
}

export function facebookStoryStatus(
  body: Record<string, unknown> | undefined,
  mediaId: string,
): ProviderPublicationStatus {
  const data = body?.data;
  if (!Array.isArray(data)) throw malformed();
  const retainedOperationId = facebookOperationId("story", mediaId);
  const story = data
    .map(record)
    .find((item) => numericOrStringIdentifier(item?.media_id) === mediaId);
  if (!story) {
    return {
      state: "unknown",
      result: unknownResult("facebook_story_evidence_pending", retainedOperationId),
    };
  }
  const id = numericOrStringIdentifier(story.post_id);
  if (!id || !publishedStoryStatuses.includes(String(story.status))) throw malformed();
  const permalink = secureUrl(story.url)?.href;
  return {
    state: "published",
    result: {
      outcome: "confirmed_success",
      providerOperationId: retainedOperationId,
      providerPostId: id,
      ...(permalink ? { providerUrl: permalink } : {}),
    },
  };
}

export function facebookVideoStatus(
  body: Record<string, unknown> | undefined,
  operation: FacebookOperation & { phase: "video" | "video_draft" },
): ProviderPublicationStatus {
  const status = record(body?.status)?.video_status;
  if (body?.id !== operation.id || typeof status !== "string") throw malformed();
  const retainedOperationId = facebookOperationId(operation.phase, operation.id);
  if (failedVideoStatuses.includes(status)) {
    return {
      state: "failed",
      result: confirmedFailure(
        rejection("facebook_video_processing_failed", 422),
        retainedOperationId,
      ),
    };
  }
  if (status !== "ready") return { state: "processing", providerOperationId: retainedOperationId };
  return operation.phase === "video_draft"
    ? { state: "delivered", result: facebookNativeDraft("video_draft", operation.id) }
    : { state: "published", result: facebookPublishedVideo("video", operation.id) };
}

export function facebookPostStatus(
  post: Record<string, unknown> | undefined,
  postId: string,
  phase: "post" | "post_draft",
): ProviderPublicationStatus {
  if (post?.id !== postId || typeof post.is_published !== "boolean") throw malformed();
  if (post.is_published) return { result: facebookPublishedPost(postId), state: "published" };
  if (phase === "post_draft") {
    return { state: "delivered", result: facebookNativeDraft("post_draft", postId) };
  }
  return { providerOperationId: facebookOperationId("post", postId), state: "processing" };
}

export function facebookReelLookupStatus(
  status: FacebookReelStatus,
  videoId: string,
  operation: FacebookOperation | undefined,
): ProviderPublicationStatus {
  const retainedOperationId = facebookOperationId(
    operation?.phase ?? "finishing",
    operation?.id ?? videoId,
  );
  if (isFacebookReelStatusFailed(status)) {
    return {
      result: confirmedFailure(
        rejection("facebook_reel_processing_failed", 422),
        retainedOperationId,
      ),
      state: "failed",
    };
  }
  if (isFacebookReelStatusPublished(status)) {
    return {
      result: {
        outcome: "confirmed_success",
        providerOperationId: retainedOperationId,
        providerPostId: videoId,
      },
      state: "published",
    };
  }
  if (operation?.phase === "reel_draft") {
    return status.video === "ready"
      ? { state: "delivered", result: facebookNativeDraft("reel_draft", videoId) }
      : { state: "processing", providerOperationId: retainedOperationId };
  }
  if (operation && operation.phase !== "finishing") {
    return {
      result: unknownResult(
        operation.phase === "finish_submitted"
          ? "facebook_finish_evidence_pending"
          : "facebook_upload_evidence_pending",
        retainedOperationId,
      ),
      state: "unknown",
    };
  }
  return { providerOperationId: retainedOperationId, state: "processing" };
}
