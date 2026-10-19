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
  providerIdentifier,
  record,
  required,
  secureUrl,
} from "./meta-common";
import type {
  OAuthConnection,
  OAuthExchangeResult,
  ProviderAdapter,
  ProviderCredentials,
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

const publishingScopes = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
] as const;

/** Facebook's caption ceiling remains known even before live publishing is configured. */
export const FACEBOOK_MAX_CAPTION_LENGTH = 2_200;

const capability: PlatformCapability = {
  accepted_mime_types: ["video/mp4", "video/quicktime"],
  analytics: false,
  asset_types: ["video"],
  comments: false,
  connect_available: true,
  max_caption_length: FACEBOOK_MAX_CAPTION_LENGTH,
  max_file_size: videoMaximumBytes,
  max_hashtags: 30,
  max_media_count: 1,
  max_video_duration_sec: 60,
  min_media_count: 1,
  multi_asset_types: [],
  notes: [
    "Facebook Pages use an explicit Page access token; personal profiles are unsupported.",
    "Page Reels use a hosted HTTPS video and the documented remote-ingest flow.",
    "One video publishes one Reel; carousels and photo posts are not supported.",
    "Reels are limited to 500 MiB and 60 seconds.",
  ],
  platform: "facebook",
  publish: true,
  reply: false,
};

type FacebookOperationPhase = "finish_submitted" | "finishing" | "upload_submitted" | "uploaded";

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
  const match = normalized?.match(/^(finish_submitted|finishing|upload_submitted|uploaded):(.+)$/);
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
 * Determines whether any phase of Facebook Reel ingestion or publication has permanently failed.
 * Checks video status, uploading phase, processing phase, and publishing phase for 'error' or 'failed'.
 * Returns true if any phase indicates failure, false otherwise.
 */
function statusFailed(status: ReelStatus): boolean {
  return [status.video, status.uploading, status.processing, status.publishing].some(
    (value) => value === "error" || value === "failed",
  );
}

/**
 * Evaluates whether a Facebook Reel has completely finished publishing and is live on the Page.
 * Returns true if publishing phase status equals 'complete', false otherwise.
 */
function statusPublished(status: ReelStatus): boolean {
  return status.publishing === "complete";
}

/**
 * Identifies a malformed Facebook OAuth response field in existing warning logs.
 * Static field names preserve the shared transient classification. Optional
 * internal diagnostics contain only expiry facts, never credentials or bodies.
 */
function oauthMalformed(
  field:
    | "authorization_token"
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

  const submitFinish = async (
    context: ProviderRequestContext,
    credentials: ProviderCredentials,
    videoId: string,
    description: string,
  ): Promise<ProviderOperationResult> => {
    const url = new URL(
      `/${apiVersion}/${encodeURIComponent(accountId(credentials))}/video_reels`,
      graphOrigin,
    );
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("upload_phase", "finish");
    url.searchParams.set("video_state", "PUBLISHED");
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
     * Builds the Facebook OAuth dialog URL for Page Reels using only the documented
     * Page permissions; unsupported legacy video scopes would block authorization.
     * Preserves caller state and rejects callbacks that differ from configuration.
     */
    authorizationUrl(input) {
      assertConfiguredRedirectUri(input.redirectUri, configuredRedirectUri);
      const url = new URL(`/${apiVersion}/dialog/oauth`, authorizationOrigin);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", configuredRedirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", publishingScopes.join(","));
      url.searchParams.set("state", required("state", input.state, 1_024));
      return url.toString();
    },

    capability,

    /**
     * Exchanges the code for a user token and discovers every publishable Page as a choice.
     * Bounds both Page count and requests to 1,000, including empty continuation pages.
     * Candidates retain true identity, Page credentials, and inspected zero-expiry semantics;
     * neither a single eligible Page nor multiple Pages are automatically connected.
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

      const eligible: OAuthConnection[] = [];
      const identifiers = new Set<string>();
      const seenCursors = new Set<string>();
      let discoveredCount = 0;
      let requestCount = 0;
      let nextCursor: string | undefined = undefined;

      while (true) {
        if (requestCount >= 1_000) throw oauthMalformed("page_pagination");
        requestCount += 1;
        const pagesUrl = new URL(`/${apiVersion}/me/accounts`, graphOrigin);
        pagesUrl.searchParams.set("fields", "id,name,access_token,tasks,picture,link");
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

        discoveredCount += pagesBody.data.length;
        if (discoveredCount > 1_000) {
          throw oauthMalformed("page_list");
        }

        for (const value of pagesBody.data) {
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
            tasks.some((task) => typeof task !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(task))
          ) {
            throw oauthMalformed("page_tasks");
          }
          if (identifiers.has(id)) {
            continue;
          }
          identifiers.add(id);

          const picture = record(page?.picture);
          const pictureData = record(picture?.data);
          const rawAvatar =
            pictureData?.url ?? (typeof page?.picture === "string" ? page.picture : undefined);
          const avatarUrl = secureUrl(rawAvatar);
          const username = facebookVanityHandle(page?.link);

          if (tasks.includes("CREATE_CONTENT") || tasks.includes("PROFILE_PLUS_CREATE_CONTENT")) {
            eligible.push({
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

      return { accounts: eligible };
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
        return submitFinish(context, credentials, videoId, description);
      } catch (cause) {
        if (!(cause instanceof ProviderAdapterError)) throw cause;
        if (
          cause.failure.classification === "ambiguous" ||
          cause.failure.classification === "timeout" ||
          cause.failure.classification === "transient"
        ) {
          return unknownResult(cause.failure, operationId("upload_submitted", videoId));
        }
        return {
          failure: cause.failure,
          outcome: "confirmed_failure",
          providerOperationId: operationId("uploaded", videoId),
        };
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
        scopes: [...publishingScopes],
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
