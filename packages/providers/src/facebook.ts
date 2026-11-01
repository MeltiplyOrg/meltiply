import type { PlatformCapability } from "@meltiply/domain";
import { extractRateLimitBudget } from "./rate-limit";

import {
  addSeconds,
  confirmedFailure,
  isHttp404,
  malformed,
  requiredIdentifier,
  unknownResult,
} from "./adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "./failures";
import { ProviderHttpClient } from "./http";
import {
  assertConfiguredRedirectUri,
  bearer,
  boundedCursor,
  boundedString,
  boundedText,
  exactRedirectUri,
  metricValue,
  providerIdentifier,
  record,
  required,
  secureUrl,
  validatePageInput,
} from "./meta-common";
import type {
  FacebookPostType,
  OAuthConnection,
  OAuthExchangeResult,
  ProviderAdapter,
  ProviderCredentials,
  ProviderFailure,
  ProviderOperationResult,
  ProviderRequestContext,
  ProviderTokenSet,
  PublishInput,
} from "./types";

const graphOrigin = "https://graph.facebook.com";
const uploadOrigin = "https://rupload.facebook.com";
const authorizationOrigin = "https://www.facebook.com";
const apiVersion = "v25.0";
const videoMaximumBytes = 500 * 1024 * 1024;
const tokenLifetimeMaximumSeconds = 90 * 24 * 60 * 60;

/** Permissions required to publish and read Page engagement. */
const publishingScopes = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
] as const;
/** Additional permissions required by Reels analytics; requested but not required to connect. */
const analyticsScopes = ["pages_manage_engagement", "read_insights"] as const;
const configuredScopes = [...publishingScopes, ...analyticsScopes] as const;
const businessDiscoveryScope = "business_management";

/** Facebook's caption ceiling remains known even before live publishing is configured. */
export const FACEBOOK_MAX_CAPTION_LENGTH = 2_200;

/** Documented per-photo ceiling for Page photo posts. */
const photoMaximumBytes = 10 * 1024 * 1024;

/** Documented ceiling for photos attached to one Page post. */
const FACEBOOK_MAX_PHOTOS = 10;

/**
 * Reports whether a failed write may already have landed remotely.
 *
 * Meta accepts a request before its response reaches us when the connection
 * times out or resets, so these classifications must reconcile rather than
 * report a failure the Page may contradict.
 */
function isAmbiguousWrite(classification: ProviderFailure["classification"]): boolean {
  return (
    classification === "ambiguous" || classification === "timeout" || classification === "transient"
  );
}

const capability: PlatformCapability = {
  accepted_mime_types: ["image/jpeg", "image/png", "video/mp4", "video/quicktime"],
  analytics: true,
  asset_types: ["image", "video"],
  comments: false,
  connect_available: true,
  max_caption_length: FACEBOOK_MAX_CAPTION_LENGTH,
  max_file_size: videoMaximumBytes,
  max_hashtags: 30,
  max_media_count: 10,
  max_video_duration_sec: 60,
  min_media_count: 0,
  multi_asset_types: ["image"],
  notes: [
    "Facebook Pages use an explicit Page access token; personal profiles are unsupported.",
    "Text and link posts publish through the documented Page feed edge.",
    "A single photo publishes as a Page photo post; 2-10 photos publish as one multi-photo post.",
    "Photo posts accept JPEG or PNG up to 10 MiB each; Facebook strips embedded location metadata.",
    "Page Reels use a hosted HTTPS video and the documented remote-ingest flow.",
    "Videos publish through the resumable Video API upload; Reels remain the single-video shortcut.",
    "Stories publish one photo or one video and require media that was never published before.",
    "Ordinary video is capped at 500 MiB; Reels and Stories at 60 seconds.",
    "Analytics reads Reel plays from Video Insights and likes/comments from the Video edges; shares come from the documented comments-plus-shares social-actions metric.",
    "Video Insights requires read_insights and pages_manage_engagement; old connections must reconnect to grant them.",
    "Colored text backgrounds are not documented for Page publishing, so no such control is offered.",
  ],
  platform: "facebook",
  publish: true,
  reply: false,
};

type FacebookOperationPhase =
  | "finish_submitted"
  | "finishing"
  | "post_submitted"
  | "posted"
  | "upload_submitted"
  | "uploaded";

interface FacebookOperation {
  id: string;
  phase: FacebookOperationPhase;
}

interface ReelStatus {
  processing: string;
  publishing: string;
  uploading: string;
  video: string;
}

interface RefreshSecret {
  pageId: string;
  userAccessToken: string;
}

export interface FacebookAdapterOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  redirectUri: string;
  timeoutMilliseconds?: number;
}

/**
 * Extracts and validates the required Facebook Page account identifier from credentials.
 * Ensures accountId is present and conforms to provider identifier format rules.
 * Returns the validated Facebook Page ID string. Throws ProviderAdapterError if missing or malformed.
 */
function accountId(credentials: ProviderCredentials): string {
  return requiredIdentifier(credentials.accountId, "facebook_page_account_required");
}

/**
 * Formats a composite Facebook operation identifier encoding lifecycle phase and video ID.
 * Produces deterministic tracking strings such as 'finishing:123456789'.
 * Returns formatted operation identifier string.
 */
function operationId(phase: FacebookOperationPhase, id: string): string {
  return `${phase}:${id}`;
}

/**
 * Parses and validates an opaque Facebook operation identifier string into its phase and video ID.
 * Matches allowed phases ('finish_submitted', 'finishing', 'upload_submitted', 'uploaded').
 * Returns structured FacebookOperation object, or undefined if malformed or unrecognized.
 */
function parseOperationId(value: unknown): FacebookOperation | undefined {
  const normalized = providerIdentifier(value);
  const match = normalized?.match(
    /^(finish_submitted|finishing|posted|upload_submitted|uploaded):(.+)$/,
  );
  const id = providerIdentifier(match?.[2]);
  return match && id ? { id, phase: match[1] as FacebookOperationPhase } : undefined;
}

/**
 * Decodes and validates the composite Facebook refresh secret payload stored in database credentials.
 * Facebook Page access tokens require renewing a user token and refetching the Page token;
 * the refresh secret securely packages both `{ pageId, userAccessToken }` into JSON.
 * Returns parsed RefreshSecret record. Throws ProviderAdapterError if JSON is invalid or fields missing.
 */
function refreshSecret(value: string): RefreshSecret {
  const raw = required("refreshToken", value, 16_384);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "facebook_refresh_secret_invalid",
        status: 400,
      }),
    );
  }
  const body = record(parsed);
  const pageId = providerIdentifier(body?.pageId);
  const userAccessToken = boundedString(body?.userAccessToken, 16_000);
  if (!body || Object.keys(body).length !== 2 || !pageId || !userAccessToken) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "facebook_refresh_secret_invalid",
        status: 400,
      }),
    );
  }
  return { pageId, userAccessToken };
}

/**
 * Encodes a RefreshSecret object containing pageId and userAccessToken into a JSON string.
 * Used when establishing or refreshing Facebook OAuth connections for encrypted storage.
 * Returns JSON-serialized refresh secret string.
 */
function encodeRefreshSecret(value: RefreshSecret): string {
  return JSON.stringify(value);
}

/**
 * Validates a Facebook Reel binary upload URL returned by the Graph API.
 * Confirms strict HTTPS origin on rupload.facebook.com and matching videoId path structure.
 * Returns canonical upload URL string. Throws ProviderAdapterError if origin or path is invalid.
 */
function validateUploadUrl(value: unknown, videoId: string): string {
  const normalized = secureUrl(value);
  if (!normalized) throw malformed();
  const url = new URL(normalized);
  const escapedId = videoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    url.origin !== uploadOrigin ||
    url.search ||
    !new RegExp(`^/video-upload/v\\d+\\.\\d+/${escapedId}$`).test(url.pathname)
  ) {
    throw malformed();
  }
  return url.toString();
}

/**
 * Chooses the Facebook publication family for one resolved input.
 *
 * The creator's saved `postType` wins when present. Otherwise a single video
 * keeps the historical Reel behaviour, a single image becomes a photo post, and
 * multiple images become one multi-photo post. Anything else — including a
 * video mixed with images, which no Facebook endpoint accepts — fails closed
 * rather than silently dropping attachments.
 *
 * @param input - Composed caption plus the Post's ordered attachments.
 * @returns The family to publish, with its resolved media kinds.
 * @throws ProviderAdapterError when the attachment set fits no family.
 */
function facebookPostType(input: PublishInput): FacebookPostType {
  const requested = input.providerOptions?.facebook?.postType;
  if (requested) return requested;
  if (input.media.length === 0) return "post";
  const allImages = input.media.every((media) =>
    media.contentType.split(";", 1)[0]!.trim().toLowerCase().startsWith("image/"),
  );
  if (allImages) return "photo";
  // A single video keeps the historical Reel behaviour; a video mixed with
  // images fits no Facebook endpoint and is reported by the family validators.
  return "reel";
}

/**
 * Validates the caption and hashtag envelope shared by every Facebook family.
 * @throws ProviderAdapterError with `code` when the envelope is not publishable.
 */
function facebookEnvelope(input: PublishInput, code: string): string {
  required("idempotencyKey", input.idempotencyKey, 255);
  const description = input.caption.trim();
  if ([...description].length > FACEBOOK_MAX_CAPTION_LENGTH || input.hashtags.length > 30) {
    throw new ProviderAdapterError(classifyProviderFailure({ code, status: 400 }));
  }
  return description;
}

/**
 * Requires every attachment to be remote-ingest media of one allowed kind.
 *
 * Facebook fetches hosted HTTPS URLs directly, so a stream attachment cannot be
 * published here. Each attachment is checked for kind, size, and reachability
 * before any provider call, keeping a partial failure from publishing only the
 * first photo of a multi-photo post.
 *
 * @param input - Composed caption plus the Post's ordered attachments.
 * @param kind - Required attachment kind.
 * @param maximum - Per-attachment byte ceiling.
 * @param code - Failure code reported for any violation.
 * @returns The validated secure URLs in attachment order.
 * @throws ProviderAdapterError when an attachment cannot be sent.
 */
function facebookRemoteMedia(
  input: PublishInput,
  kind: "image" | "video",
  maximum: number,
  code: string,
): string[] {
  return input.media.map((media) => {
    const url = media.mode === "remote_ingest" ? secureUrl(media.url) : undefined;
    const resolvedKind = media.contentType
      .split(";", 1)[0]!
      .trim()
      .toLowerCase()
      .startsWith("image/")
      ? "image"
      : "video";
    const accepted =
      media.mode === "remote_ingest" &&
      resolvedKind === kind &&
      Number.isSafeInteger(media.fileSize) &&
      media.fileSize > 0 &&
      media.fileSize <= maximum &&
      url !== undefined;
    if (!accepted) throw new ProviderAdapterError(classifyProviderFailure({ code, status: 400 }));
    return url;
  });
}

/**
 * Validates and extracts Reel publication parameters from a PublishInput
 * descriptor.
 * Facebook publishes exactly one video as one Reel, so a post carrying zero or
 * multiple attachments fails closed rather than silently publishing only the
 * first. Enforces remote_ingest mode, caption length <= 2200, hashtag count
 * <= 30, valid MP4/MOV MIME types, and file size within 500 MiB.
 * @param input - Composed caption plus the Post's ordered attachments.
 * @returns `{ description, mediaUrl }` for the single Reel attachment.
 * @throws ProviderAdapterError when the post is not a single publishable video.
 */
function reelInput(input: PublishInput): {
  description: string;
  mediaUrl: string;
} {
  required("idempotencyKey", input.idempotencyKey, 255);
  const description = input.caption.trim();
  const [media] = input.media;
  if (
    input.media.length !== 1 ||
    !media ||
    media.mode !== "remote_ingest" ||
    [...description].length > FACEBOOK_MAX_CAPTION_LENGTH ||
    input.hashtags.length > 30
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "facebook_reel_invalid",
        status: 400,
      }),
    );
  }
  const contentType = media.contentType.split(";", 1)[0]!.toLowerCase();
  const mediaUrl = secureUrl(media.url);
  if (
    !["video/mp4", "video/quicktime"].includes(contentType) ||
    !Number.isSafeInteger(media.fileSize) ||
    media.fileSize < 1 ||
    media.fileSize > videoMaximumBytes ||
    !mediaUrl
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: "facebook_reel_media_invalid",
        status: 400,
      }),
    );
  }
  return { description, mediaUrl };
}

/**
 * Safely extracts and lowercases a phase status string from a Reel status response field.
 * Returns normalized status string (e.g. 'complete', 'error'), or undefined if absent or malformed.
 */
function phaseStatus(value: unknown): string | undefined {
  return boundedString(record(value)?.status, 64)?.toLowerCase();
}

/**
 * Parses and validates the multi-phase processing status of a published Facebook Reel.
 * Asserts matching video ID and extracts status for uploading, processing, and publishing phases.
 * Returns typed ReelStatus record. Throws ProviderAdapterError if response is malformed.
 */
function reelStatus(value: unknown, expectedId: string): ReelStatus {
  const body = record(value);
  const status = record(body?.status);
  const id = providerIdentifier(body?.id);
  const video = boundedString(status?.video_status, 64)?.toLowerCase();
  const uploading = phaseStatus(status?.uploading_phase);
  const processing = phaseStatus(status?.processing_phase);
  const publishing = phaseStatus(status?.publishing_phase);
  if (id !== expectedId || !status || !video || !uploading || !processing || !publishing) {
    throw malformed();
  }
  return { processing, publishing, uploading, video };
}

/**
 * Determines whether Meta has terminated Reel ingestion or publication.
 * Error/failed phases and the documented expired/upload_failed video statuses
 * are final failures, not indefinite processing.
 */
function statusFailed(status: ReelStatus): boolean {
  return (
    ["expired", "upload_failed"].includes(status.video) ||
    [status.video, status.uploading, status.processing, status.publishing].some(
      (value) => value === "error" || value === "failed",
    )
  );
}

/**
 * Evaluates whether a Facebook Reel has completely finished publishing and is live on the Page.
 * Accepts Meta's documented "completed" and example-response "complete" phase values.
 */
function statusPublished(status: ReelStatus): boolean {
  return status.publishing === "completed" || status.publishing === "complete";
}

/**
 * Identifies a malformed Facebook OAuth response field in existing warning logs.
 * Static field names preserve the shared transient classification. Optional
 * internal diagnostics contain only expiry facts, never credentials or bodies.
 */
function oauthMalformed(
  field:
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
    | "page_pagination",
  cause?: Error,
): ProviderAdapterError {
  return new ProviderAdapterError(
    classifyProviderFailure({
      code: `facebook_oauth_${field}_invalid`,
      malformedResponse: true,
    }),
    cause ? { cause } : undefined,
  );
}

/**
 * Builds internal expiry evidence for OAuth warnings without retaining tokens,
 * app identities, or raw responses. Only finite numbers are rendered; all other
 * provider values appear as their type, so hostile strings cannot enter logs.
 */
function expiryDiagnostic(
  source: "exchange" | "debug_token",
  value: unknown,
  lifetime: unknown,
  valid?: boolean,
  appMatches?: boolean,
): Error {
  const numeric = (input: unknown): string =>
    typeof input === "number" && Number.isFinite(input)
      ? String(input)
      : input === null
        ? "null"
        : typeof input;
  return new Error(
    `Facebook OAuth expiry rejected: source=${source}, expiry=${numeric(value)}, lifetime_seconds=${numeric(lifetime)}, maximum_seconds=${tokenLifetimeMaximumSeconds}` +
      (valid === undefined ? "" : `, token_valid=${valid}`) +
      (appMatches === undefined ? "" : `, app_matches=${appMatches}`),
  );
}

const RESERVED_FACEBOOK_PATHS: Record<string, true> = {
  events: true,
  gaming: true,
  groups: true,
  help: true,
  marketplace: true,
  pages: true,
  people: true,
  privacy: true,
  "profile.php": true,
  settings: true,
  watch: true,
};

/**
 * Extracts a legitimate vanity handle from a Facebook Page link URL.
 * Accepts only canonical facebook.com paths with a single non-reserved,
 * non-numeric segment. Rejects profile.php/id queries, category paths,
 * pure numeric IDs, and reserved system paths so fake handles are never emitted.
 */
function facebookVanityHandle(link: unknown): string | undefined {
  if (typeof link !== "string" || !link) return undefined;
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    if (host !== "facebook.com" && !host.endsWith(".facebook.com")) {
      return undefined;
    }
    if (url.searchParams.has("id")) {
      return undefined;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) {
      return undefined;
    }
    const candidate = segments[0]!;
    if (/^\d+$/.test(candidate) || !/^[A-Za-z0-9.]{1,255}$/.test(candidate)) {
      return undefined;
    }
    if (RESERVED_FACEBOOK_PATHS[candidate.toLowerCase()]) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Instantiates a ProviderAdapter for Facebook Pages Reel publishing and OAuth authentication.
 * Configures Graph API v25.0 endpoints, remote ingest flow, rate limit budget extraction,
 * Page token derivation, and multi-phase asynchronous video reconciliation.
 * OAuth validation failures identify invalid fields without exposing credentials;
 * inspected zero expiry is represented by the token contract's absent expiry.
 * Returns configured ProviderAdapter conforming to Meltiply provider contracts.
 */
export function createFacebookAdapter(options: FacebookAdapterOptions): ProviderAdapter {
  const clientId = required("clientId", options.clientId, 255);
  const clientSecret = required("clientSecret", options.clientSecret);
  const configuredRedirectUri = exactRedirectUri(options.redirectUri);
  const now = options.now ?? (() => new Date());
  const http = new ProviderHttpClient({
    allowedOrigins: [graphOrigin, uploadOrigin],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    rateLimitBudget: (headers) => extractRateLimitBudget("facebook", headers),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });

  /**
   * Exchanges a user token for a validated long-lived bearer token.
   * Missing expiry triggers same-app token inspection: a zero timestamp means
   * no time-based expiry, while a positive timestamp must be future and bounded.
   * Explicit invalid exchange lifetimes fail closed with credential-free facts.
   */
  const exchangeLongLived = async (
    context: ProviderRequestContext,
    currentToken: string,
  ): Promise<{ accessToken: string; expiresAt?: string }> => {
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      fb_exchange_token: required("userAccessToken", currentToken, 16_000),
      grant_type: "fb_exchange_token",
    });
    const response = await http.request<unknown>(context, {
      body: form,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
      url: `${graphOrigin}/${apiVersion}/oauth/access_token`,
    });
    const body = record(response.body);
    const accessToken = boundedString(body?.access_token, 16_000);
    const tokenType = boundedString(body?.token_type, 32)?.toLowerCase();
    if (!accessToken) throw oauthMalformed("long_lived_token");
    if (tokenType !== "bearer") throw oauthMalformed("token_type");
    let lifetime = body?.expires_in;
    let expirySource: "exchange" | "debug_token" = "exchange";
    let expiryValue: unknown = lifetime;
    let exchangedAt = now();
    if (lifetime === undefined) {
      const debugUrl = new URL(`/${apiVersion}/debug_token`, graphOrigin);
      debugUrl.searchParams.set("input_token", accessToken);
      const inspected = await http.request<unknown>(context, {
        headers: bearer(`${clientId}|${clientSecret}`),
        method: "GET",
        url: debugUrl.toString(),
      });
      const data = record(record(inspected.body)?.data);
      expirySource = "debug_token";
      expiryValue = data?.expires_at;
      if (
        data?.is_valid !== true ||
        data.app_id !== clientId ||
        typeof data.expires_at !== "number" ||
        !Number.isSafeInteger(data.expires_at)
      ) {
        throw oauthMalformed(
          "token_expiry",
          expiryDiagnostic(
            expirySource,
            expiryValue,
            undefined,
            data?.is_valid === true,
            data?.app_id === clientId,
          ),
        );
      }
      if (data.expires_at === 0) return { accessToken };
      lifetime = data.expires_at - Math.floor(exchangedAt.getTime() / 1_000);
      // Preserve Meta's absolute Unix-second expiry, including subsecond clocks.
      exchangedAt = new Date(Math.floor(exchangedAt.getTime() / 1_000) * 1_000);
    }
    let expiresAt: string;
    try {
      expiresAt = addSeconds(exchangedAt, lifetime, tokenLifetimeMaximumSeconds);
    } catch (cause) {
      if (cause instanceof ProviderAdapterError) {
        throw oauthMalformed("token_expiry", expiryDiagnostic(expirySource, expiryValue, lifetime));
      }
      throw cause;
    }
    return {
      accessToken,
      expiresAt,
    };
  };

  const getReelStatus = async (
    context: ProviderRequestContext,
    accessToken: string,
    videoId: string,
  ): Promise<ReelStatus | undefined> => {
    const url = new URL(`/${apiVersion}/${encodeURIComponent(videoId)}`, graphOrigin);
    url.searchParams.set("fields", "id,status");
    try {
      const response = await http.request<unknown>(context, {
        headers: bearer(accessToken),
        method: "GET",
        url: url.toString(),
      });
      return reelStatus(response.body, videoId);
    } catch (cause) {
      if (isHttp404(cause)) return undefined;
      throw cause;
    }
  };

  /**
   * Publishes a text, link, or multi-photo Page post through the feed edge.
   *
   * Multi-photo posts need each photo uploaded unpublished first, because the
   * feed edge references them by `media_fbid`. An unpublished photo lasts about
   * 24 hours, so the photo uploads and the feed call happen in one attempt; a
   * failure part-way leaves orphaned unpublished photos that Facebook expires
   * on its own rather than a half-published post.
   *
   * @returns Confirmed success carrying the Page post id, or the classified
   *   outcome when the write may already have landed.
   */
  const publishFeedPost = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    pageId: string,
    input: PublishInput,
  ): Promise<ProviderOperationResult> => {
    const description = facebookEnvelope(input, "facebook_post_invalid");
    const links = facebookRemoteMedia(input, "image", photoMaximumBytes, "facebook_photo_invalid");
    const link = input.providerOptions?.facebook?.link;
    if (input.media.length > 1 && link) {
      throw new ProviderAdapterError(
        classifyProviderFailure({ code: "facebook_post_invalid", status: 400 }),
      );
    }
    if (input.media.length === 0 && !description && !link) {
      throw new ProviderAdapterError(
        classifyProviderFailure({ code: "facebook_post_invalid", status: 400 }),
      );
    }
    const photoIds: string[] = [];
    for (const url of links) {
      const body = new URLSearchParams({ published: "false", url });
      const uploaded = await http.request<unknown>(context, {
        body,
        headers: {
          ...bearer(credentials.accessToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        sideEffectPossible: true,
        url: `${graphOrigin}/${apiVersion}/${encodeURIComponent(pageId)}/photos`,
      });
      const photoId = providerIdentifier(record(uploaded.body)?.id);
      if (!photoId) throw malformed(true);
      photoIds.push(photoId);
    }
    const body = new URLSearchParams();
    if (description) body.set("message", description);
    if (link) body.set("link", link);
    photoIds.forEach((photoId, index) => {
      body.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: photoId }));
    });
    try {
      const response = await http.request<unknown>(context, {
        body,
        headers: {
          ...bearer(credentials.accessToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        sideEffectPossible: true,
        url: `${graphOrigin}/${apiVersion}/${encodeURIComponent(pageId)}/feed`,
      });
      const postId = providerIdentifier(record(response.body)?.id);
      if (!postId) throw malformed(true);
      return {
        outcome: "confirmed_success",
        providerOperationId: operationId("posted", postId),
        providerPostId: postId,
      };
    } catch (cause) {
      if (!(cause instanceof ProviderAdapterError)) throw cause;
      if (isAmbiguousWrite(cause.failure.classification)) {
        return unknownResult(cause.failure, operationId("post_submitted", photoIds.join("_")));
      }
      return { failure: cause.failure, outcome: "confirmed_failure" };
    }
  };

  /**
   * Publishes one photo, or up to ten photos as one multi-photo post.
   *
   * A single photo is published in one `/photos` call, which returns both the
   * photo id and the resulting post id. Multiple photos defer to the feed
   * family, the only documented way to attach several photos to one Page post.
   *
   * @returns Confirmed success carrying the Page post id.
   */
  const publishPhotos = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    pageId: string,
    input: PublishInput,
  ): Promise<ProviderOperationResult> => {
    if (input.media.length === 0 || input.media.length > FACEBOOK_MAX_PHOTOS) {
      throw new ProviderAdapterError(
        classifyProviderFailure({ code: "facebook_photo_invalid", status: 400 }),
      );
    }
    if (input.media.length > 1) {
      return publishFeedPost(context, credentials, pageId, input);
    }
    const description = facebookEnvelope(input, "facebook_photo_invalid");
    const [url] = facebookRemoteMedia(input, "image", photoMaximumBytes, "facebook_photo_invalid");
    const body = new URLSearchParams({ published: "true", url: url! });
    if (description) body.set("caption", description);
    try {
      const response = await http.request<unknown>(context, {
        body,
        headers: {
          ...bearer(credentials.accessToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        sideEffectPossible: true,
        url: `${graphOrigin}/${apiVersion}/${encodeURIComponent(pageId)}/photos`,
      });
      const uploaded = record(response.body);
      const postId = providerIdentifier(uploaded?.post_id);
      const photoId = providerIdentifier(uploaded?.id);
      if (!postId || !photoId) throw malformed(true);
      return {
        outcome: "confirmed_success",
        providerOperationId: operationId("posted", postId),
        providerPostId: postId,
        providerUrl: `https://www.facebook.com/${postId}`,
      };
    } catch (cause) {
      if (!(cause instanceof ProviderAdapterError)) throw cause;
      if (isAmbiguousWrite(cause.failure.classification)) {
        return unknownResult(cause.failure);
      }
      return { failure: cause.failure, outcome: "confirmed_failure" };
    }
  };

  /**
   * Publishes one photo or one video as a Page Story.
   *
   * Stories accept exactly one attachment, and Meta rejects media that has
   * already appeared in a published post. A video Story reuses the Reel upload
   * handshake with the `/video_stories` edge; a photo Story uploads the picture
   * unpublished and then references it by id.
   *
   * @returns Confirmed success carrying the Story post id when Meta reports it.
   */
  const publishStory = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    pageId: string,
    input: PublishInput,
  ): Promise<ProviderOperationResult> => {
    if (input.media.length !== 1) {
      throw new ProviderAdapterError(
        classifyProviderFailure({ code: "facebook_story_invalid", status: 400 }),
      );
    }
    // Stories take no caption on either edge, so only the shared envelope is
    // validated here; nothing from it is sent.
    facebookEnvelope(input, "facebook_story_invalid");
    const media = input.media[0]!;
    const isVideo = !media.contentType.split(";", 1)[0]!.trim().toLowerCase().startsWith("image/");
    const [mediaUrl] = facebookRemoteMedia(
      input,
      isVideo ? "video" : "image",
      isVideo ? videoMaximumBytes : photoMaximumBytes,
      "facebook_story_media_invalid",
    );
    if (!isVideo) {
      const uploadBody = new URLSearchParams({ published: "false", url: mediaUrl! });
      const uploaded = await http.request<unknown>(context, {
        body: uploadBody,
        headers: {
          ...bearer(credentials.accessToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        sideEffectPossible: true,
        url: `${graphOrigin}/${apiVersion}/${encodeURIComponent(pageId)}/photos`,
      });
      const photoId = providerIdentifier(record(uploaded.body)?.id);
      if (!photoId) throw malformed(true);
      return submitStoryFinish(context, credentials, pageId, {
        edge: "photo_stories",
        photoId,
      });
    }
    const createUrl = new URL(
      `/${apiVersion}/${encodeURIComponent(pageId)}/video_stories`,
      graphOrigin,
    );
    createUrl.searchParams.set("upload_phase", "start");
    const createResponse = await http.request<unknown>(context, {
      headers: bearer(credentials.accessToken),
      method: "POST",
      sideEffectPossible: true,
      url: createUrl.toString(),
    });
    const createBody = record(createResponse.body);
    const videoId = providerIdentifier(createBody?.video_id);
    if (!videoId) throw malformed(true);
    const uploadUrl = validateUploadUrl(createBody?.upload_url, videoId);
    try {
      const uploadResponse = await http.request<unknown>(context, {
        headers: {
          Authorization: `OAuth ${required("accessToken", credentials.accessToken)}`,
          file_url: mediaUrl!,
        },
        method: "POST",
        sideEffectPossible: true,
        url: uploadUrl,
      });
      if (record(uploadResponse.body)?.success !== true) throw malformed(true);
      return submitStoryFinish(context, credentials, pageId, {
        edge: "video_stories",
        videoId,
      });
    } catch (cause) {
      if (!(cause instanceof ProviderAdapterError)) throw cause;
      if (isAmbiguousWrite(cause.failure.classification)) {
        return unknownResult(cause.failure, operationId("upload_submitted", videoId));
      }
      return { failure: cause.failure, outcome: "confirmed_failure" };
    }
  };

  /**
   * Publishes one video as a Page Reel through the documented three-phase flow.
   *
   * @returns Confirmed success once Meta acknowledges the finish phase.
   */
  const publishReel = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    pageId: string,
    input: PublishInput,
  ): Promise<ProviderOperationResult> => {
    const { description, mediaUrl } = reelInput(input);
    const createUrl = new URL(
      `/${apiVersion}/${encodeURIComponent(pageId)}/video_reels`,
      graphOrigin,
    );
    createUrl.searchParams.set("upload_phase", "start");
    const createResponse = await http.request<unknown>(context, {
      headers: bearer(credentials.accessToken),
      method: "POST",
      sideEffectPossible: true,
      url: createUrl.toString(),
    });
    const createBody = record(createResponse.body);
    const videoId = providerIdentifier(createBody?.video_id);
    if (!videoId) throw malformed(true);
    const uploadUrl = validateUploadUrl(createBody?.upload_url, videoId);
    try {
      const uploadResponse = await http.request<unknown>(context, {
        headers: {
          Authorization: `OAuth ${required("accessToken", credentials.accessToken)}`,
          file_url: mediaUrl,
        },
        method: "POST",
        sideEffectPossible: true,
        url: uploadUrl,
      });
      if (record(uploadResponse.body)?.success !== true) {
        throw malformed(true);
      }
      return submitFinish(
        context,
        credentials,
        videoId,
        description,
        input.providerOptions?.facebook?.isAiGenerated === true,
      );
    } catch (cause) {
      if (!(cause instanceof ProviderAdapterError)) throw cause;
      if (isAmbiguousWrite(cause.failure.classification)) {
        return unknownResult(cause.failure, operationId("upload_submitted", videoId));
      }
      return {
        failure: cause.failure,
        outcome: "confirmed_failure",
        providerOperationId: operationId("uploaded", videoId),
      };
    }
  };

  /**
   * Completes a Story publication for an already uploaded photo or video.
   *
   * Photo Stories reference the unpublished photo by id, while video Stories
   * repeat the Reel handshake against the `/video_stories` edge. Meta reports
   * `post_id` for Stories but only `success` for Reels, so the id is optional
   * here and a missing one is not treated as a failed publication.
   *
   * @param target - Which Stories edge to finish and the media id it references.
   * @returns Confirmed success with the Story post id when Meta supplies it.
   */
  const submitStoryFinish = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    pageId: string,
    target:
      | { edge: "photo_stories" | "video_stories"; photoId: string }
      | {
          edge: "photo_stories" | "video_stories";
          videoId: string;
        },
  ): Promise<ProviderOperationResult> => {
    const url = new URL(`/${apiVersion}/${encodeURIComponent(pageId)}/${target.edge}`, graphOrigin);
    if ("photoId" in target) url.searchParams.set("photo_id", target.photoId);
    if ("videoId" in target) {
      url.searchParams.set("video_id", target.videoId);
      url.searchParams.set("upload_phase", "finish");
      url.searchParams.set("video_state", "PUBLISHED");
    }
    try {
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: url.toString(),
      });
      const body = record(response.body);
      if (body?.success !== true) throw malformed(true);
      const postId = providerIdentifier(body.post_id);
      return {
        outcome: "confirmed_success",
        ...(postId ? { providerOperationId: operationId("posted", postId) } : {}),
        ...(postId ? { providerPostId: postId } : {}),
      };
    } catch (cause) {
      if (!(cause instanceof ProviderAdapterError)) throw cause;
      if (isAmbiguousWrite(cause.failure.classification)) {
        return unknownResult(cause.failure);
      }
      return { failure: cause.failure, outcome: "confirmed_failure" };
    }
  };

  const submitFinish = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    videoId: string,
    description: string,
    isAiGenerated: boolean,
  ): Promise<ProviderOperationResult> => {
    const url = new URL(
      `/${apiVersion}/${encodeURIComponent(accountId(credentials))}/video_reels`,
      graphOrigin,
    );
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("upload_phase", "finish");
    url.searchParams.set("video_state", "PUBLISHED");
    // Reels document `is_ai_generated` on the finish phase only; the default
    // stays absent so Meta's own false default applies.
    if (isAiGenerated) url.searchParams.set("is_ai_generated", "true");
    if (description) url.searchParams.set("description", description);
    try {
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "POST",
        sideEffectPossible: true,
        url: url.toString(),
      });
      if (record(response.body)?.success !== true) throw malformed(true);
      return {
        outcome: "confirmed_success",
        providerOperationId: operationId("finishing", videoId),
      };
    } catch (cause) {
      if (!(cause instanceof ProviderAdapterError)) throw cause;
      if (
        cause.failure.classification === "ambiguous" ||
        cause.failure.classification === "timeout" ||
        cause.failure.classification === "transient"
      ) {
        return unknownResult(cause.failure, operationId("finish_submitted", videoId));
      }
      return {
        failure: cause.failure,
        outcome: "confirmed_failure",
        providerOperationId: operationId("uploaded", videoId),
      };
    }
  };

  return {
    extractRateLimitBudget: (headers) => extractRateLimitBudget("facebook", headers),
    /**
     * Builds the state-bound Facebook dialog URL for Page publishing and discovery.
     * business_management enables business-user Page assignments in addition to
     * directly managed Pages. Rejects callbacks that differ from configuration.
     */
    authorizationUrl(input) {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const url = new URL(`/${apiVersion}/dialog/oauth`, authorizationOrigin);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", configuredRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", [...configuredScopes, businessDiscoveryScope].join(","));
      url.searchParams.set("state", required("state", input.state, 1_024));
      return url.toString();
    },

    capability,

    /**
     * Exchanges the code and discovers publishable direct and business-assigned Pages.
     * With business_management consent, enumerates business users and their assigned_pages.
     * Every edge is paginated with independent cursor tracking. Up to four business-user
     * edges run concurrently; results keep discovery order and Page ids are deduplicated.
     * Bounds Page records and requests to 1,000; failures drain in-flight work before rejecting.
     */
    async exchangeAuthorizationCode(context, input): Promise<OAuthExchangeResult> {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const shortForm = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: required("authorizationCode", input.code),
        grant_type: "authorization_code",
        redirect_uri: configuredRedirectUri,
      });
      const shortResponse = await http.request<unknown>(context, {
        body: shortForm,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: `${graphOrigin}/${apiVersion}/oauth/access_token`,
      });
      const shortToken = boundedString(record(shortResponse.body)?.access_token, 16_000);
      if (!shortToken) throw oauthMalformed("authorization_token");

      const longToken = await exchangeLongLived(context, shortToken);
      const permissionsUrl = new URL(`/${apiVersion}/me/permissions`, graphOrigin);
      const permissionsResponse = await http.request<unknown>(context, {
        headers: bearer(longToken.accessToken),
        method: "GET",
        url: permissionsUrl.toString(),
      });
      const permissionsBody = record(permissionsResponse.body);
      if (!Array.isArray(permissionsBody?.data)) {
        throw oauthMalformed("permissions");
      }
      const grantedScopes: string[] = [];
      for (const item of permissionsBody.data) {
        const entry = record(item);
        const permission = boundedString(entry?.permission, 128);
        const status = boundedString(entry?.status, 32)?.toLowerCase();
        if (!permission || !status) {
          throw oauthMalformed("permissions");
        }
        if (status === "granted" && !grantedScopes.includes(permission)) {
          grantedScopes.push(permission);
        }
      }

      const hasRequiredPublishingScopes = publishingScopes.every((scope) =>
        grantedScopes.includes(scope),
      );
      if (!hasRequiredPublishingScopes) {
        return { accounts: [] };
      }

      const businessUsers = new Set<string>();
      const businessPaths: string[] = [];
      let discoveredCount = 0;
      let requestCount = 0;
      let failed = false;

      /**
       * Traverses one edge sequentially, validating cursors before each next request.
       * Shared counters bound all workers; business-user discovery queues independent edges.
       * Returns candidates in edge order without cross-edge deduplication, so response timing
       * cannot change the retained Page token or the user's account ordering.
       */
      const discover = async (discoveryPath: string): Promise<OAuthConnection[]> => {
        const candidates: OAuthConnection[] = [];
        const pageIds = new Set<string>();
        const isBusinessUserList = discoveryPath === "me/business_users";
        const seenCursors = new Set<string>();
        let nextCursor: string | undefined;
        while (!failed) {
          if (requestCount >= 1_000) throw oauthMalformed("page_pagination");
          requestCount += 1;
          const pagesUrl = new URL(`/${apiVersion}/${discoveryPath}`, graphOrigin);
          pagesUrl.searchParams.set(
            "fields",
            isBusinessUserList ? "id" : "id,name,access_token,tasks,picture,link",
          );
          pagesUrl.searchParams.set("limit", "100");
          if (nextCursor !== undefined) {
            pagesUrl.searchParams.set("after", nextCursor);
          }

          const pagesResponse = await http.request<unknown>(context, {
            headers: bearer(longToken.accessToken),
            method: "GET",
            url: pagesUrl.toString(),
          });
          const pagesBody = record(pagesResponse.body);
          if (!Array.isArray(pagesBody?.data) || pagesBody.data.length > 100) {
            throw oauthMalformed("page_list");
          }

          if (!isBusinessUserList) {
            discoveredCount += pagesBody.data.length;
            if (discoveredCount > 1_000) {
              throw oauthMalformed("page_list");
            }
          }

          for (const value of pagesBody.data) {
            if (isBusinessUserList) {
              const id = providerIdentifier(record(value)?.id);
              if (!id) throw oauthMalformed("business_user_identity");
              if (!businessUsers.has(id)) {
                businessUsers.add(id);
                if (businessUsers.size > 1_000) throw oauthMalformed("business_user_list");
                businessPaths.push(`${id}/assigned_pages`);
              }
              continue;
            }
            const page = record(value);
            const id = providerIdentifier(page?.id);
            const displayName = boundedText(page?.name, 500);
            const accessToken = boundedString(page?.access_token, 16_000);
            const tasks = page?.tasks;
            if (!id || !displayName) {
              throw oauthMalformed("page_identity");
            }
            if (!accessToken) throw oauthMalformed("page_access_token");
            if (
              !Array.isArray(tasks) ||
              tasks.length > 32 ||
              tasks.some(
                (task) => typeof task !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(task),
              )
            ) {
              throw oauthMalformed("page_tasks");
            }
            if (pageIds.has(id)) continue;

            const picture = record(page?.picture);
            const pictureData = record(picture?.data);
            const rawAvatar =
              pictureData?.url ?? (typeof page?.picture === "string" ? page.picture : undefined);
            const avatarUrl = secureUrl(rawAvatar);
            const username = facebookVanityHandle(page?.link);

            if (tasks.includes("CREATE_CONTENT") || tasks.includes("PROFILE_PLUS_CREATE_CONTENT")) {
              pageIds.add(id);
              candidates.push({
                accessToken,
                account: {
                  ...(avatarUrl ? { avatarUrl } : {}),
                  displayName,
                  id,
                  ...(username ? { username } : {}),
                },
                ...(longToken.expiresAt === undefined ? {} : { expiresAt: longToken.expiresAt }),
                refreshToken: encodeRefreshSecret({
                  pageId: id,
                  userAccessToken: longToken.accessToken,
                }),
                scopes: [...grantedScopes],
              });
            }
          }

          if (pagesBody.paging === undefined) {
            break;
          }
          const paging = record(pagesBody.paging);
          if (!paging) {
            throw oauthMalformed("page_pagination");
          }

          let rawCursorFromPaging: string | undefined;
          if (paging.cursors !== undefined) {
            const cursors = record(paging.cursors);
            if (!cursors) {
              throw oauthMalformed("page_pagination");
            }
            if (cursors.after !== undefined) {
              const validated = boundedCursor(cursors.after);
              if (!validated) {
                throw oauthMalformed("page_pagination");
              }
              rawCursorFromPaging = validated;
            }
          }

          if (paging.next === undefined) {
            break;
          }

          if (typeof paging.next !== "string") {
            throw oauthMalformed("page_pagination");
          }

          let nextUrl: URL;
          try {
            nextUrl = new URL(paging.next);
          } catch {
            throw oauthMalformed("page_pagination");
          }

          if (nextUrl.origin !== new URL(graphOrigin).origin) {
            throw oauthMalformed("page_pagination");
          }

          const rawAfterParam = nextUrl.searchParams.get("after");
          let validatedAfterParam: string | undefined;
          if (rawAfterParam !== null) {
            validatedAfterParam = boundedCursor(rawAfterParam);
            if (!validatedAfterParam) {
              throw oauthMalformed("page_pagination");
            }
          }

          if (
            rawCursorFromPaging !== undefined &&
            validatedAfterParam !== undefined &&
            rawCursorFromPaging !== validatedAfterParam
          ) {
            throw oauthMalformed("page_pagination");
          }

          const resolvedCursor = rawCursorFromPaging ?? validatedAfterParam;
          if (!resolvedCursor) {
            throw oauthMalformed("page_pagination");
          }

          if (seenCursors.has(resolvedCursor)) {
            throw oauthMalformed("page_pagination");
          }

          seenCursors.add(resolvedCursor);
          nextCursor = resolvedCursor;
        }
        return candidates;
      };

      const eligible = await discover("me/accounts");
      if (grantedScopes.includes(businessDiscoveryScope)) {
        await discover("me/business_users");
      }
      const businessResults: OAuthConnection[][] = new Array(businessPaths.length);
      let nextEdge = 0;
      // Each worker takes one independent edge at a time. A failed edge stops new
      // work; all workers settle before the callback can return or reject.
      const outcomes = await Promise.allSettled(
        Array.from({ length: Math.min(4, businessPaths.length) }, async () => {
          while (!failed && nextEdge < businessPaths.length) {
            const index = nextEdge++;
            try {
              businessResults[index] = await discover(businessPaths[index]!);
            } catch (cause) {
              failed = true;
              throw cause;
            }
          }
        }),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
      const identifiers = new Set(eligible.map((connection) => connection.account.id));
      for (const candidates of businessResults) {
        for (const candidate of candidates) {
          if (identifiers.has(candidate.account.id)) continue;
          identifiers.add(candidate.account.id);
          eligible.push(candidate);
        }
      }
      return { accounts: eligible };
    },

    /** Reads Page followers only; Page likes (`fan_count`) are not accounts the Page follows. */
    async getAccountAnalytics(context, credentials) {
      const url = new URL(
        `/${apiVersion}/${encodeURIComponent(accountId(credentials))}`,
        graphOrigin,
      );
      url.searchParams.set("fields", "followers_count");
      const response = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: url.toString(),
      });
      const body = record(response.body);
      const followers = metricValue(body?.followers_count);
      if (followers === undefined) throw malformed();
      return {
        followers,
        recordedAt: now().toISOString(),
      };
    },

    /**
     * Reads lifetime engagement for one published Page Reel.
     *
     * Video Insights supplies the Reels play count and the documented
     * comments-plus-shares social-actions total with `period=lifetime`. The
     * Video object supplies like and comment summaries; shares are the
     * social-actions total minus the separately measured comments. A missing
     * metric or a social-actions total below the comment count is an error, so a
     * failed measurement is never stored as zero. Video Insights require
     * `read_insights` and `pages_manage_engagement`.
     *
     * @param context - Provider request context carrying cancellation.
     * @param credentials - Page access token and Page identity.
     * @param lookup - Publication whose providerPostId names the Reel video.
     * @param page - Single-page input; Video Insights are not paginated here.
     * @returns One analytics record for the Reel.
     * @throws {ProviderAdapterError} On a rejected permission, malformed
     *   Insights response, or missing requested counter.
     */
    async listAnalytics(context, credentials, lookup, page) {
      validatePageInput("facebook", page);
      if (page.cursor) {
        throw new ProviderAdapterError(
          classifyProviderFailure({
            code: "facebook_analytics_not_paginated",
            status: 400,
          }),
        );
      }
      const providerPostId = requiredIdentifier(
        lookup.providerPostId,
        "facebook_video_id_required",
      );
      const insightsUrl = new URL(
        `/${apiVersion}/${encodeURIComponent(providerPostId)}/video_insights`,
        graphOrigin,
      );
      insightsUrl.searchParams.set("metric", "blue_reels_play_count,post_video_social_actions");
      insightsUrl.searchParams.set("period", "lifetime");
      const insightsResponse = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: insightsUrl.toString(),
      });
      const insights = record(insightsResponse.body)?.data;
      if (!Array.isArray(insights) || insights.length > 20) throw malformed();
      const metrics = new Map<string, number>();
      for (const value of insights) {
        const metric = record(value);
        const name = boundedString(metric?.name, 64);
        const values = metric?.values;
        if (!Array.isArray(values) || values.length !== 1) throw malformed();
        const result = metricValue(record(values[0])?.value);
        if (!name || result === undefined || metrics.has(name)) throw malformed();
        metrics.set(name, result);
      }

      const videoUrl = new URL(`/${apiVersion}/${encodeURIComponent(providerPostId)}`, graphOrigin);
      videoUrl.searchParams.set(
        "fields",
        "likes.summary(true).limit(0),comments.summary(true).limit(0)",
      );
      const videoResponse = await http.request<unknown>(context, {
        headers: bearer(credentials.accessToken),
        method: "GET",
        url: videoUrl.toString(),
      });
      const video = record(videoResponse.body);
      const likes = metricValue(record(record(video?.likes)?.summary)?.total_count);
      const comments = metricValue(record(record(video?.comments)?.summary)?.total_count);
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
      return {
        items: [
          {
            comments,
            impressions: 0,
            likes,
            providerPostId,
            recordedAt: now().toISOString(),
            reach: 0,
            shares: socialActions - comments,
            views,
            watchTimeSeconds: 0,
          },
        ],
      };
    },

    async lookupPublication(context, credentials, lookup) {
      accountId(credentials);
      const providerPostId = providerIdentifier(lookup.providerPostId);
      if (lookup.providerPostId && !providerPostId) throw malformed();
      const operation = parseOperationId(lookup.providerOperationId);
      if (lookup.providerOperationId && !operation) throw malformed();
      const videoId = providerPostId ?? operation?.id;
      if (!videoId) throw malformed();
      const status = await getReelStatus(context, credentials.accessToken, videoId);
      if (!status) return { state: "not_found" };
      const retainedOperationId = operation
        ? operationId(operation.phase, operation.id)
        : operationId("finishing", videoId);
      if (statusFailed(status)) {
        return {
          result: confirmedFailure("facebook_reel_processing_failed", 422, retainedOperationId),
          state: "failed",
        };
      }
      if (statusPublished(status)) {
        return {
          result: {
            outcome: "confirmed_success",
            providerOperationId: retainedOperationId,
            providerPostId: videoId,
          },
          state: "published",
        };
      }
      if (operation && operation.phase !== "finishing") {
        return {
          result: unknownResult(
            classifyProviderFailure({
              code:
                operation.phase === "finish_submitted"
                  ? "facebook_finish_evidence_pending"
                  : "facebook_upload_evidence_pending",
              sideEffectPossible: true,
            }),
            retainedOperationId,
          ),
          state: "unknown",
        };
      }
      return { providerOperationId: retainedOperationId, state: "processing" };
    },

    async publish(context, credentials, input) {
      const pageId = accountId(credentials);
      const postType = facebookPostType(input);
      switch (postType) {
        case "post":
          return publishFeedPost(context, credentials, pageId, input);
        case "photo":
          return publishPhotos(context, credentials, pageId, input);
        case "story":
          return publishStory(context, credentials, pageId, input);
        case "reel":
          return publishReel(context, credentials, pageId, input);
      }
    },

    /**
     * Rotates the user token and derives a token for the same Page.
     * Preserves absent expiry for inspected zero-expiry tokens; finite lifetimes
     * remain bounded. A changed Page identity or missing Page token fails closed.
     */
    async refreshAccessToken(context, value): Promise<ProviderTokenSet> {
      const current = refreshSecret(value);
      const longToken = await exchangeLongLived(context, current.userAccessToken);
      const pageUrl = new URL(`/${apiVersion}/${encodeURIComponent(current.pageId)}`, graphOrigin);
      pageUrl.searchParams.set("fields", "id,name,access_token");
      const pageResponse = await http.request<unknown>(context, {
        headers: bearer(longToken.accessToken),
        method: "GET",
        url: pageUrl.toString(),
      });
      const page = record(pageResponse.body);
      const id = providerIdentifier(page?.id);
      const accessToken = boundedString(page?.access_token, 16_000);
      if (id !== current.pageId || !accessToken) throw malformed();
      return {
        accessToken,
        ...(longToken.expiresAt === undefined ? {} : { expiresAt: longToken.expiresAt }),
        refreshToken: encodeRefreshSecret({
          pageId: current.pageId,
          userAccessToken: longToken.accessToken,
        }),
        scopes: [...configuredScopes],
      };
    },

    retryPolicy: {
      baseDelaySeconds: 30,
      maxAttempts: 8,
      maxDelaySeconds: 900,
    },

    transferModes: ["remote_ingest"],
  };
}
