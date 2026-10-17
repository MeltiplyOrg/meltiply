import type { components } from "@meltiply/contracts/schema";
import type { OAuthSelectionCandidate } from "@meltiply/contracts";
import type { SessionClaims } from "@meltiply/auth";
import { DatabaseError, oauthCallbackPath, type Platform } from "@meltiply/domain";
import { Cause, Effect, type Layer } from "effect";
import {
  createProviderRegistryFromEnvironment,
  createProviderServiceLive,
  failureDiagnostic,
  ProviderAdapterError,
  ProviderService,
  type OAuthConnection,
  type OAuthExchangeResult,
  type ProviderPublicationRequirements,
  type ProviderPublishOptions,
  type ProviderRegistry,
  type TikTokPrivacyLevel,
  type TikTokPublishOptions,
  type YouTubePrivacyStatus,
  type YouTubePublishOptions,
} from "@meltiply/providers";
import { errorDiagnostic, log } from "@meltiply/observability";
import { createObjectStoreFromEnv, type ConfiguredObjectStore } from "@meltiply/storage";
import type { Context, Hono } from "hono";
import { CoreApiError, type CoreApiService } from "./core-types";
import type { BrandProfileApiService } from "./brand-profile-service";
import type { AssetApiService } from "./asset-types";
import type { PostApiService, PostTargetInput } from "./post-types";
import type { StorageService } from "./effect/services/storage";
import { scheduleInboxCommentSync } from "./inbox-comment-sync";
import type { ApiWorkerEnv, ApiWorkerEnvironment, OAuthStateStub } from "./env";
import { tokenCipherFor } from "./token-credentials";
import {
  registerWorkspaceLifecycleRoutes,
  type WorkspaceLifecycleDependencies,
} from "./workspace-lifecycle";
import { errorResponse, jsonResponse } from "./responses";
import {
  booleanParam,
  brandProfileColorField,
  brandProfileDescriptionField,
  brandProfileNameField,
  completedPartsField,
  dateField,
  dateRange,
  enumParam,
  idempotencyKey,
  integerParam,
  jsonBody,
  OAUTH_ROUTING_KEY_PATTERN,
  onlyKeys,
  optionalDateParam,
  optionalStringField,
  partNumbersField,
  platformParam,
  positiveIntegerField,
  postTextField,
  postTitleField,
  POST_STATUS_VALUES,
  REPLY_STATUS_VALUES,
  stringArrayField,
  stringField,
  TIKTOK_PRIVACY_LEVELS,
  uuidArrayField,
  uuidParam,
  validateDateSpan,
} from "./validation";
import { idempotencyHeaders } from "./idempotent-response";
import { runRouteEffect } from "./effect/runtime";
import { fromPromise } from "./effect/route";
import type { OAuthConnectionOwner } from "./oauth-connection";

type Schemas = components["schemas"];

export interface CoreRouteDependencies {
  assetService?: AssetApiService;
  brandProfileService?: BrandProfileApiService;
  coreService?: CoreApiService;
  postService?: PostApiService;
  providerRegistry?: ProviderRegistry;
  publicationRequirements?: PublicationRequirementsReader;
  revokeOAuthConnection?: OAuthConnectionRevoker;
  saveOAuthConnection?: OAuthConnectionSaver;
  storageServiceLayer?:
    | Layer.Layer<StorageService, never, never>
    | ((env: ApiWorkerEnv) => Layer.Layer<StorageService, never, never>);
  workspaceLifecycle?: WorkspaceLifecycleDependencies;
}

type OAuthConnectionRevoker = (
  env: ApiWorkerEnv,
  session: SessionClaims,
  accountId: string,
  registry: ProviderRegistry,
) => Effect.Effect<void, unknown, ProviderService>;

type OAuthConnectionSaver = (
  env: ApiWorkerEnv,
  platform: Platform,
  owner: OAuthConnectionOwner,
  connection: OAuthConnection,
) => Effect.Effect<void, CoreApiError | DatabaseError>;

type PublicationRequirementsReader = (
  env: ApiWorkerEnv,
  session: SessionClaims,
  accountId: string,
  requestId: string,
  registry: ProviderRegistry,
) => Effect.Effect<ProviderPublicationRequirements, CoreApiError | DatabaseError, ProviderService>;

/**
 * Retrieves the unique request identifier stored on the Hono execution context.
 *
 * @param c - Hono request context.
 * @returns Request ID string (from `X-Request-ID` or generated).
 */
function requestId(c: Context<ApiWorkerEnvironment>): string {
  return c.get("requestId");
}

/**
 * Parses the optional Brand Profile query selector shared by aggregate read routes.
 *
 * Omission preserves the read-only workspace aggregate; a supplied selector
 * must be a canonical UUID before it reaches a scoped service query.
 *
 * @param c - Hono request context carrying the query string.
 * @returns Selected Brand Profile UUID, or undefined for the aggregate view.
 * @throws {CoreApiError} 400 if the supplied selector is not a UUID.
 */
function optionalBrandProfileParam(c: Context<ApiWorkerEnvironment>): string | undefined {
  const value = c.req.query("brand_profile_id");
  return value ? uuidParam(value, "brand_profile_id") : undefined;
}

/**
 * Computes a quoted SHA-256 hex digest ETag header value for a JSON-serializable payload.
 *
 * @param body - JSON-serializable response data object.
 * @returns Quoted hex string formatted for HTTP `ETag` headers.
 */
async function entityTag(body: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(body)),
  );
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `"${hexadecimal}"`;
}

/**
 * Compares an incoming HTTP `If-None-Match` header value against the current ETag.
 *
 * Handles wildcard `*`, comma-separated values, and strips weak validator prefixes (`W/`).
 *
 * @param header - Content of the client's `If-None-Match` header.
 * @param current - Current unquoted or quoted ETag value.
 * @returns `true` if the ETag matches; otherwise `false`.
 */
function entityTagMatches(header: string | undefined, current: string): boolean {
  return (
    header?.split(",").some((candidate) => {
      const value = candidate.trim();
      return value === "*" || value.replace(/^W\//, "") === current;
    }) ?? false
  );
}

/**
 * Produces an HTTP 200 JSON response or 304 Not Modified based on `If-None-Match` validation.
 *
 * Computes an ETag digest of the response body and attaches standard tracing headers.
 *
 * @param c - Hono request context.
 * @param body - Response body payload.
 * @returns HTTP 304 empty response if cached, or HTTP 200 JSON response.
 */
async function conditionalJsonResponse(
  c: Context<ApiWorkerEnvironment>,
  body: unknown,
): Promise<Response> {
  const etag = await entityTag(body);
  if (entityTagMatches(c.req.header("If-None-Match"), etag)) {
    return new Response(null, {
      headers: { ETag: etag, "X-Request-ID": requestId(c) },
      status: 304,
    });
  }
  return jsonResponse(body, 200, requestId(c), { ETag: etag });
}

/**
 * Resolves an explicit StorageService Layer from route dependencies if configured.
 *
 * Prefers the injected storageServiceLayer dependency (e.g. for testing doubles).
 * When unconfigured, returns undefined allowing AssetApiService.withStorage to self-provide.
 *
 * @param env - Worker environment bindings.
 * @param dependencies - Route dependencies containing optional storage layer override.
 * @returns Configured Layer providing StorageService, or undefined.
 */
function resolveStorageLayer(
  env: ApiWorkerEnv,
  dependencies: CoreRouteDependencies,
): Layer.Layer<StorageService, unknown, never> | undefined {
  if (dependencies.storageServiceLayer) {
    return typeof dependencies.storageServiceLayer === "function"
      ? dependencies.storageServiceLayer(env)
      : dependencies.storageServiceLayer;
  }
  return undefined;
}

/**
 * Conditionally provides a StorageService Layer to an Effect program if one was resolved.
 *
 * @param program - Effect route program.
 * @param layer - Optional StorageService Layer.
 * @returns Effect program with layer applied if present.
 */
function withStorageLayer<A, E, R>(
  program: Effect.Effect<A, E, R>,
  layer: Layer.Layer<StorageService, unknown, never> | undefined,
): Effect.Effect<A, E, R> {
  return layer ? (program.pipe(Effect.provide(layer)) as Effect.Effect<A, E, R>) : program;
}

/**
 * YouTube `privacy_status` values accepted at the request boundary; mirrors the
 * `YouTubePrivacyStatus` contract enum for runtime validation.
 */
const YOUTUBE_PRIVACY_STATUSES: Record<YouTubePrivacyStatus, true> = {
  private: true,
  public: true,
  unlisted: true,
};

/**
 * Validates and normalizes platform-specific publishing options from an HTTP request body.
 *
 * Delegates each whitelisted provider subtree (`tiktok`, `youtube`) to a strict parser
 * that rejects unknown keys and malformed values before the request reaches scheduling.
 * Cross-platform compatibility is enforced later by `validatePublishInput` at the
 * distribution service seam, where the target platform is known.
 *
 * @param body - Raw request payload record.
 * @returns Structured `ProviderPublishOptions` or undefined if omitted.
 * @throws {CoreApiError} 400 `validation_error` if option keys or types violate schema rules.
 */
function providerOptionsField(body: Record<string, unknown>): ProviderPublishOptions | undefined {
  const value = body.provider_options;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreApiError(400, "validation_error", "provider_options must be an object.");
  }
  const options = value as Record<string, unknown>;
  onlyKeys(options, ["tiktok", "youtube"]);
  return {
    ...(options.tiktok !== undefined ? { tiktok: tiktokOptionsField(options.tiktok) } : {}),
    ...(options.youtube !== undefined ? { youtube: youtubeOptionsField(options.youtube) } : {}),
  };
}

/**
 * Validates and normalizes the `provider_options.tiktok` subtree.
 *
 * Enforces the strict key whitelist, the creator privacy-level enum, boolean
 * interaction flags, and the mandatory music-usage confirmation TikTok requires.
 *
 * @param value - Raw `provider_options.tiktok` value from the request payload.
 * @returns Normalized `TikTokPublishOptions` with camelCase fields.
 * @throws {CoreApiError} 400 `validation_error` if option keys or types violate schema rules.
 */
function tiktokOptionsField(value: unknown): TikTokPublishOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreApiError(400, "validation_error", "provider_options.tiktok must be an object.");
  }
  const tiktok = value as Record<string, unknown>;
  onlyKeys(tiktok, [
    "privacy_level",
    "allow_comment",
    "allow_duet",
    "allow_stitch",
    "brand_content",
    "brand_organic",
    "is_ai_generated",
    "music_usage_confirmed",
  ]);
  const privacyLevel = tiktok.privacy_level;
  const booleanKeys = [
    "allow_comment",
    "allow_duet",
    "allow_stitch",
    "brand_content",
    "brand_organic",
    "is_ai_generated",
  ] as const;
  if (
    typeof privacyLevel !== "string" ||
    !TIKTOK_PRIVACY_LEVELS.has(privacyLevel as TikTokPrivacyLevel) ||
    booleanKeys.some((key) => typeof tiktok[key] !== "boolean") ||
    tiktok.music_usage_confirmed !== true
  ) {
    throw new CoreApiError(400, "validation_error", "provider_options.tiktok is invalid.");
  }
  return {
    allowComment: tiktok.allow_comment as boolean,
    allowDuet: tiktok.allow_duet as boolean,
    allowStitch: tiktok.allow_stitch as boolean,
    brandContent: tiktok.brand_content as boolean,
    brandOrganic: tiktok.brand_organic as boolean,
    isAiGenerated: tiktok.is_ai_generated as boolean,
    musicUsageConfirmed: true,
    privacyLevel: privacyLevel as TikTokPrivacyLevel,
  };
}

/**
 * Validates and normalizes the `provider_options.youtube` subtree.
 *
 * Requires the explicit `made_for_kids` COPPA declaration whenever YouTube options
 * are supplied and accepts an optional `privacy_status` visibility enum; the
 * provider adapter applies its established public default when it is omitted.
 * Enum membership uses `Object.hasOwn` so inherited `Object.prototype` names
 * (e.g. `toString`, `constructor`) can never satisfy the whitelist.
 *
 * @param value - Raw `provider_options.youtube` value from the request payload.
 * @returns Normalized `YouTubePublishOptions` with camelCase fields.
 * @throws {CoreApiError} 400 `validation_error` if option keys or types violate schema rules.
 */
function youtubeOptionsField(value: unknown): YouTubePublishOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreApiError(400, "validation_error", "provider_options.youtube must be an object.");
  }
  const youtube = value as Record<string, unknown>;
  onlyKeys(youtube, ["made_for_kids", "privacy_status"]);
  const privacyStatus = youtube.privacy_status;
  if (
    typeof youtube.made_for_kids !== "boolean" ||
    (privacyStatus !== undefined &&
      (typeof privacyStatus !== "string" ||
        !Object.hasOwn(YOUTUBE_PRIVACY_STATUSES, privacyStatus)))
  ) {
    throw new CoreApiError(400, "validation_error", "provider_options.youtube is invalid.");
  }
  return {
    madeForKids: youtube.made_for_kids,
    ...(privacyStatus !== undefined
      ? { privacyStatus: privacyStatus as YouTubePrivacyStatus }
      : {}),
  };
}

/**
 * Converts provider publication requirements domain entity into the API schema representation.
 *
 * Formats creator details, privacy level arrays, and video duration constraints.
 *
 * @param value - Internal domain provider publication requirements.
 * @returns OpenAPI-compliant `PublishingRequirements` response schema.
 */
function publishingRequirementsBody(
  value: ProviderPublicationRequirements,
): Schemas["PublishingRequirements"] {
  return {
    comment_allowed: value.commentAllowed,
    creator: {
      avatar_url: value.creatorAvatarUrl ?? null,
      display_name: value.creatorDisplayName,
      username: value.creatorUsername,
    },
    duet_allowed: value.duetAllowed,
    max_video_duration_sec: value.maxVideoDurationSeconds,
    platform: value.platform,
    privacy_levels: [...value.privacyLevels],
    stitch_allowed: value.stitchAllowed,
  };
}

/**
 * Parses one saved per-Channel target from a Post create, save, or schedule
 * request body.
 *
 * The target mirrors what a Channel will publish: optional caption overrides,
 * hashtags, provider options, and an ordered attachment subset. `attachment_ids`
 * distinguishes three states: omitted or `null` inherits the Post's own
 * attachments, an array overrides both membership and order, and `[]` publishes
 * that Channel as text only without splitting the Post identity.
 *
 * @param body - Raw target definition object.
 * @returns Validated target settings.
 * @throws {CoreApiError} 400 `validation_error` if the payload violates the target contract.
 */
function postTarget(body: Record<string, unknown>): PostTargetInput {
  onlyKeys(body, [
    "platform_account_id",
    "title_override",
    "description_override",
    "hashtags",
    "provider_options",
    "attachment_ids",
  ]);
  return {
    attachmentIds: uuidArrayField(body, "attachment_ids"),
    descriptionOverride: optionalStringField(body, "description_override"),
    hashtags: stringArrayField(body, "hashtags"),
    platformAccountId: uuidParam(stringField(body, "platform_account_id"), "platform_account_id"),
    providerOptions: providerOptionsField(body),
    titleOverride: optionalStringField(body, "title_override"),
  };
}

/**
 * Parses the ordered target array of a Post request body.
 *
 * An empty array explicitly saves a draft without Channels or clears its saved
 * target choices; scheduling enforces its separate nonempty intent requirement.
 * At most twenty targets keeps each composition transaction bounded.
 *
 * @param body - Parsed JSON body carrying an optional `targets` member.
 * @returns Validated targets, or `undefined` when the member was omitted.
 * @throws {CoreApiError} 400 `validation_error` when the member is not an array of up to 20 targets.
 */
function postTargets(body: Record<string, unknown>): PostTargetInput[] | undefined {
  const value = body.targets;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CoreApiError(400, "validation_error", "targets must be an array.");
  }
  if (value.length > 20) {
    throw new CoreApiError(400, "validation_error", "targets must contain at most 20 entries.");
  }
  return value.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new CoreApiError(400, "validation_error", "Each target must be an object.");
    }
    return postTarget(target as Record<string, unknown>);
  });
}

/**
 * Parses the editable composition members of a Post create or draft-save body.
 *
 * `brand_profile_id` is mandatory on every mutation: it is the scope proof that
 * a composer edit belongs to the selected Brand Profile rather than the
 * workspace-wide aggregate view, which stays read-only.
 *
 * @param body - Raw JSON request body.
 * @returns Validated composition fields shared by create and draft save.
 * @throws {CoreApiError} 400 `validation_error` on unknown keys or malformed members.
 */
function postComposition(body: Record<string, unknown>): {
  attachmentIds?: string[];
  brandProfileId: string;
  defaultText?: string;
  targets?: PostTargetInput[];
  title?: string;
} {
  onlyKeys(body, ["brand_profile_id", "title", "default_text", "attachment_ids", "targets"]);
  return {
    attachmentIds: uuidArrayField(body, "attachment_ids") ?? undefined,
    brandProfileId: uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"),
    defaultText: postTextField(body, "default_text"),
    targets: postTargets(body),
    title: postTitleField(body, "title"),
  };
}

/**
 * Obtains a Durable Object stub for managing OAuth state and CSRF tokens.
 *
 * Partitions Durable Object instances by deterministic organization routing key.
 *
 * @param env - Worker environment bindings containing `OAUTH_STATE` namespace.
 * @param routingKey - Deterministic routing key derived from organization ID.
 * @returns Durable Object stub instance.
 * @throws {CoreApiError} 503 `service_unavailable` if `OAUTH_STATE` namespace binding is missing.
 */
function oauthStateStub(env: ApiWorkerEnv, routingKey: string): OAuthStateStub {
  if (!env.OAUTH_STATE) {
    throw new CoreApiError(503, "service_unavailable", "OAuth state storage is unavailable.");
  }
  return env.OAUTH_STATE.getByName(routingKey);
}

/**
 * Constructs the canonical public OAuth callback URL for a given social platform provider.
 *
 * Enforces HTTPS scheme unless running in local development mode against localhost.
 *
 * @param env - Worker environment bindings containing `PUBLIC_API_URL`.
 * @param provider - Social platform identifier (e.g. `'tiktok'`, `'youtube'`).
 * @returns Fully qualified OAuth redirect URI.
 * @throws {CoreApiError} 503 `service_unavailable` if `PUBLIC_API_URL` is missing or insecure.
 */
function oauthCallbackUrl(env: ApiWorkerEnv, provider: Platform): string {
  if (!env.PUBLIC_API_URL) {
    throw new CoreApiError(503, "service_unavailable", "The public API URL is unavailable.");
  }
  const target = new URL(oauthCallbackPath(provider), env.PUBLIC_API_URL);
  if (
    target.protocol !== "https:" &&
    !(env.ENVIRONMENT !== "staging" && target.hostname === "localhost")
  ) {
    throw new CoreApiError(503, "service_unavailable", "The public API URL is not secure.");
  }
  return target.toString();
}

/**
 * Encodes a byte array into a URL-safe Base64 string without padding.
 *
 * Converts `+` to `-`, `/` to `_`, and strips trailing `=` characters.
 *
 * @param bytes - Byte buffer to encode.
 * @returns URL-safe Base64 string.
 */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generates a cryptographically random URL-safe Base64 string of the specified byte length.
 *
 * @param length - Number of random bytes to generate.
 * @returns URL-safe Base64 string.
 */
function randomBase64Url(length: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}

/**
 * Computes a deterministic 16-byte SHA-256 routing key from an organization ID.
 *
 * Used to route OAuth initiation and callback requests to the identical Durable Object instance.
 *
 * @param organizationId - Unique tenant organization identifier.
 * @returns Base64URL-encoded routing key.
 */
export async function oauthStateRoutingKey(organizationId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(organizationId));
  return base64Url(new Uint8Array(digest).slice(0, 16));
}

/**
 * Computes the S256 PKCE code challenge from a code verifier string.
 *
 * Computes SHA-256 digest of the verifier and returns its URL-safe Base64 encoding.
 *
 * @param verifier - PKCE code verifier string.
 * @returns PKCE S256 code challenge string.
 */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/**
 * Route prefix serving verified-domain provider media.
 * Exported so `app.ts` mounts its authentication and flow-ledger exemptions on the
 * exact same prefix instead of duplicating the literal; the Automation Worker keeps
 * its own byte-identical copy in `workers/automation/src/provider-media.ts` because
 * separate worker bundles cannot share source modules. The Automation Worker signs
 * `<PUBLIC_API_URL>/api/v1/provider-media/<key>?expires=<unix>&signature=<b64url>` URLs;
 * this route verifies the HMAC before streaming the private R2 object. Operators point
 * `TIKTOK_MEDIA_URL_PREFIX` at this prefix on the verified API domain so the TikTok
 * adapter's pathname-prefix check accepts emitted URLs.
 */
export const providerMediaRoutePrefix = "/api/v1/provider-media/";

/**
 * Canonical signing payload bound into every provider-media URL signature.
 * The versioned domain-separation prefix keeps these HMACs distinct from any other
 * `TOKEN_ENCRYPTION_KEY`-derived MAC; expiry and object key are the only signed fields,
 * so a valid signature proves the Automation Worker authorized read access to exactly
 * that key until exactly that second.
 *
 * @param expiresAtSeconds - Unix seconds after which the URL stops verifying.
 * @param key - R2 object key the bearer may read.
 * @returns Canonical `v1\n<expires>\n<key>` payload string.
 */
function providerMediaPayload(expiresAtSeconds: number, key: string): string {
  return `meltiply-provider-media-v1\n${expiresAtSeconds}\n${key}`;
}

/**
 * Decodes an unpadded Base64url string into bytes.
 *
 * @param value - Base64url text from the `signature` query parameter.
 * @returns Decoded bytes, or undefined when the text is not well-formed Base64url.
 */
function base64UrlDecode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Verifies a provider-media bearer signature in constant time via WebCrypto.
 * Returns true only when `signature` is the HMAC-SHA256 of the canonical payload under
 * `TOKEN_ENCRYPTION_KEY`. Missing key material or malformed input returns false rather
 * than throwing so the route can deny every failure mode with one response.
 *
 * @param env - Worker environment containing TOKEN_ENCRYPTION_KEY.
 * @param expiresAtSeconds - Signed expiry claim from the URL.
 * @param key - Signed object key claim from the URL path.
 * @param signature - Base64url HMAC-SHA256 digest from the `signature` query parameter.
 * @returns Whether the signature authenticates the expiry and key claims.
 */
async function verifyProviderMediaSignature(
  env: ApiWorkerEnv,
  expiresAtSeconds: number,
  key: string,
  signature: string,
): Promise<boolean> {
  const secret = env.TOKEN_ENCRYPTION_KEY;
  const digest = base64UrlDecode(signature);
  if (!secret || !digest || digest.length !== 32) return false;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    // `digest` is typed over `ArrayBufferLike`, but BufferSource requires an
    // `ArrayBuffer`-backed view; slice() copies the exact decoded bytes into one.
    digest.slice(),
    new TextEncoder().encode(providerMediaPayload(expiresAtSeconds, key)),
  );
}

/**
 * Decodes and validates the object key embedded after the provider-media route prefix.
 * Each path segment is percent-decoded independently; the decoded key must keep the asset
 * storage shape (at least three segments, none empty, `.`, `..`, or containing control,
 * slash, or backslash characters) so a signed URL can only ever address a well-formed
 * asset object — never an arbitrary bucket key. Hyphens are legal: canonical storage
 * keys are `<org-uuid>/<asset-uuid>/<file>` and UUID segments are hyphenated.
 *
 * @param pathname - Raw request path beginning with providerMediaRoutePrefix.
 * @returns Decoded object key, or undefined when the path is malformed.
 */
function providerMediaKey(pathname: string): string | undefined {
  const suffix = pathname.slice(providerMediaRoutePrefix.length);
  if (!suffix) return undefined;
  const segments: string[] = [];
  for (const encoded of suffix.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      // Decoded separators would let one segment smuggle extra path depth past the
      // split, and control characters can hide traversal in downstream tooling.
      /[/\\\p{Cc}]/u.test(segment)
    ) {
      return undefined;
    }
    segments.push(segment);
  }
  return segments.length >= 3 ? segments.join("/") : undefined;
}

/**
 * Constructs a browser redirect to the real Channels route with OAuth outcome and
 * provider query parameters.
 *
 * Appends `oauth` status code and `provider` query parameters.
 *
 * @param env - Worker environment bindings containing `FRONTEND_URL`.
 * @param provider - Social platform provider identifier.
 * @param outcome - Result status code string (e.g. `'success'` or error code).
 * @returns Fully qualified frontend redirection URL string.
 * @throws {CoreApiError} 503 `service_unavailable` if `FRONTEND_URL` is missing.
 */
function frontendRedirect(
  env: ApiWorkerEnv,
  provider: Platform,
  outcome: string,
  extraParams?: Record<string, string>,
): string {
  if (!env.FRONTEND_URL) {
    throw new CoreApiError(
      503,
      "service_unavailable",
      "The frontend redirect target is unavailable.",
    );
  }
  const target = new URL("/channels", env.FRONTEND_URL);
  target.searchParams.set("oauth", outcome);
  target.searchParams.set("provider", provider);
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      target.searchParams.set(key, value);
    }
  }
  return target.toString();
}

/**
 * Preserves provider classification and request facts alongside the shared
 * sanitized error envelope. Original causes and stacks reach operator logs
 * without changing the frontend outcome or exposing OAuth credentials.
 */
function oauthExchangeDiagnostic(failure: unknown) {
  return {
    ...errorDiagnostic(failure),
    ...(failure instanceof ProviderAdapterError ? failureDiagnostic(failure) : {}),
  };
}

/**
 * Chooses the frontend OAuth outcome for a failed authorization-code exchange.
 * A provider failure whose code ends in `_selection_required` means the account
 * authorized fine but exposed no single publishable destination (e.g. YouTube
 * channel ambiguity), which is an actionable user decision rather than a
 * provider malfunction. Routing it to the generic `provider_error` message
 * hides the one action that would fix it.
 *
 * @param failure - Squashed Effect failure from the exchange.
 * @returns `selection_required` for destination-selection failures, otherwise `provider_error`.
 */
function oauthExchangeOutcome(failure: unknown): string {
  return failure instanceof ProviderAdapterError &&
    failure.failure.code.endsWith("_selection_required")
    ? "selection_required"
    : "provider_error";
}

/**
 * Mounts the complete Meltiply Core API HTTP routes onto the Hono application router.
 *
 * Registers REST endpoints for platform accounts, OAuth connect flows, publication requirements,
 * Posts and their per-Channel publication outcomes, content calendar, analytics, audience comment
 * inbox, asset upload sessions and per-Asset reads. Assets are reachable only
 * through Post attachments and the scoped upload/preview/download helpers, and publication targets
 * are created only by scheduling a Post.
 * Throwing request validators run through the typed bridge before application calls,
 * preserving their public 400 errors rather than turning them into Effect defects.
 *
 * @param app - Hono application instance.
 * @param dependencies - Optional service dependency overrides for unit testing.
 */
export function registerCoreRoutes(
  app: Hono<ApiWorkerEnvironment>,
  dependencies: CoreRouteDependencies = {},
): void {
  let providerRegistry = dependencies.providerRegistry;
  const registry = (): ProviderRegistry => {
    if (!providerRegistry) {
      throw new Error("provider registry was not initialized");
    }
    return providerRegistry;
  };
  app.use("*", async (c, next) => {
    providerRegistry ??= createProviderRegistryFromEnvironment(c.env);
    await next();
  });

  let servicePromise: Promise<CoreApiService> | undefined;
  let assetServicePromise: Promise<AssetApiService> | undefined;
  let brandProfileServicePromise: Promise<BrandProfileApiService> | undefined;
  const service = async (): Promise<CoreApiService> => {
    if (dependencies.coreService) {
      return dependencies.coreService;
    }
    servicePromise ??= import("./core-service").then((module) =>
      module.createCoreApiService(registry().capabilities()),
    );
    return servicePromise;
  };
  const assets = async (): Promise<AssetApiService> => {
    if (dependencies.assetService) {
      return dependencies.assetService;
    }
    assetServicePromise ??= import("./asset-service").then((module) =>
      module.createAssetApiService(),
    );
    return assetServicePromise;
  };
  const brandProfiles = async (): Promise<BrandProfileApiService> => {
    if (dependencies.brandProfileService) {
      return dependencies.brandProfileService;
    }
    brandProfileServicePromise ??= import("./brand-profile-service").then((module) =>
      module.createBrandProfileService(),
    );
    return brandProfileServicePromise;
  };
  let postServicePromise: Promise<PostApiService> | undefined;
  const posts = async (): Promise<PostApiService> => {
    if (dependencies.postService) {
      return dependencies.postService;
    }
    postServicePromise ??= import("./post-service").then((module) =>
      module.createPostApiService(registry().capabilities()),
    );
    return postServicePromise;
  };

  app.get("/api/v1/brand-profiles", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const brandProfileService = yield* fromPromise(brandProfiles);
        const profiles = yield* brandProfileService.listBrandProfiles(c.env, c.get("actor").claims);
        return jsonResponse({ profiles }, 200, requestId(c));
      }),
    ),
  );

  app.post("/api/v1/brand-profiles", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["name", "description", "color"]));
        const name = yield* fromPromise(() => brandProfileNameField(body, "name"));
        const description = yield* fromPromise(() =>
          brandProfileDescriptionField(body, "description"),
        );
        const color = yield* fromPromise(() => brandProfileColorField(body, "color"));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const brandProfileService = yield* fromPromise(brandProfiles);
        const result = yield* brandProfileService.createBrandProfile(
          c.env,
          c.get("actor").claims,
          { color, description, name },
          key,
        );
        return jsonResponse(result.value, 201, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.get("/api/v1/brand-profiles/deleted", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const brandProfileService = yield* fromPromise(brandProfiles);
        const profiles = yield* brandProfileService.listDeletedBrandProfiles(
          c.env,
          c.get("actor").claims,
        );
        return jsonResponse({ profiles }, 200, requestId(c));
      }),
    ),
  );

  app.get("/api/v1/brand-profiles/:profileId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const profileId = yield* fromPromise(() =>
          uuidParam(c.req.param("profileId"), "profile_id"),
        );
        const brandProfileService = yield* fromPromise(brandProfiles);
        const profile = yield* brandProfileService.getBrandProfile(
          c.env,
          c.get("actor").claims,
          profileId,
        );
        return jsonResponse(profile, 200, requestId(c));
      }),
    ),
  );

  app.patch("/api/v1/brand-profiles/:profileId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const profileId = yield* fromPromise(() =>
          uuidParam(c.req.param("profileId"), "profile_id"),
        );
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["name", "description", "color"]));
        const name =
          body.name !== undefined
            ? yield* fromPromise(() => brandProfileNameField(body, "name"))
            : undefined;
        const description =
          body.description !== undefined
            ? yield* fromPromise(() => brandProfileDescriptionField(body, "description"))
            : undefined;
        const color =
          body.color !== undefined
            ? yield* fromPromise(() => brandProfileColorField(body, "color"))
            : undefined;
        if (name === undefined && description === undefined && color === undefined) {
          return yield* Effect.fail(
            new CoreApiError(
              400,
              "validation_error",
              "At least one of name, description, or color must be provided.",
            ),
          );
        }
        const key = yield* fromPromise(() => idempotencyKey(c));
        const brandProfileService = yield* fromPromise(brandProfiles);
        const result = yield* brandProfileService.updateBrandProfile(
          c.env,
          c.get("actor").claims,
          profileId,
          { color, description, name },
          key,
        );
        return jsonResponse(result.value, 200, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.delete("/api/v1/brand-profiles/:profileId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const profileId = yield* fromPromise(() =>
          uuidParam(c.req.param("profileId"), "profile_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const brandProfileService = yield* fromPromise(brandProfiles);
        const result = yield* brandProfileService.deleteBrandProfile(
          c.env,
          c.get("actor").claims,
          profileId,
          key,
        );
        return jsonResponse(result.value, 200, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.post("/api/v1/brand-profiles/:profileId/restore", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const profileId = yield* fromPromise(() =>
          uuidParam(c.req.param("profileId"), "profile_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const brandProfileService = yield* fromPromise(brandProfiles);
        const result = yield* brandProfileService.restoreBrandProfile(
          c.env,
          c.get("actor").claims,
          profileId,
          key,
        );
        return jsonResponse(result.value, 200, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );
  const saveConnection: OAuthConnectionSaver =
    dependencies.saveOAuthConnection ??
    ((env, selected, owner, connection) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof CoreApiError
            ? cause
            : new DatabaseError({
                cause,
                message: "The OAuth connection could not be stored.",
              }),
        try: () => import("./oauth-connection"),
      }).pipe(
        Effect.flatMap((module) =>
          module.saveOAuthConnectionEffect(env, selected, owner, connection),
        ),
      ));
  const revokeConnection: OAuthConnectionRevoker =
    dependencies.revokeOAuthConnection ??
    ((env, session, accountId, registry) =>
      Effect.tryPromise(() => import("./oauth-revoke")).pipe(
        Effect.flatMap((module) =>
          module.revokeOAuthConnectionEffect(env, session, accountId, registry),
        ),
      ));
  const readPublicationRequirements: PublicationRequirementsReader =
    dependencies.publicationRequirements ??
    ((env, session, accountId, providerRequestId, registry) =>
      Effect.tryPromise({
        catch: (cause) =>
          cause instanceof CoreApiError
            ? cause
            : new DatabaseError({
                cause,
                message: "The publication requirements could not be retrieved.",
              }),
        try: () => import("./publication-requirements"),
      }).pipe(
        Effect.flatMap((module) =>
          module.getPublicationRequirementsEffect(
            env,
            session,
            accountId,
            providerRequestId,
            registry,
          ),
        ),
      ));

  // Verified-domain provider media: a public surface authenticated by the URL's HMAC
  // bearer credential rather than a user session (the auth middleware exempts this
  // prefix). The signature is verified in constant time and the expiry checked before
  // any object storage access, so invalid, expired, or tampered URLs never reach
  // storage; the object stays private and streams only to a bearer the Automation
  // Worker authorized for exactly this key until exactly that second. The read goes
  // through the configured provider store, so delivery works on R2 and on any
  // S3-compatible origin alike.
  app.get(`${providerMediaRoutePrefix}*`, async (c) => {
    const key = providerMediaKey(c.req.path);
    const expires = c.req.query("expires");
    const signature = c.req.query("signature");
    const expiresAt = expires && /^\d{1,15}$/.test(expires) ? Number(expires) : NaN;
    if (
      !key ||
      !signature ||
      !Number.isSafeInteger(expiresAt) ||
      !(await verifyProviderMediaSignature(c.env, expiresAt, key, signature)) ||
      expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      return errorResponse(
        requestId(c),
        403,
        "media_url_invalid",
        "The media URL is invalid or has expired.",
      );
    }
    let store: ConfiguredObjectStore | undefined;
    try {
      store = createObjectStoreFromEnv(c.env);
    } catch {
      return errorResponse(
        requestId(c),
        503,
        "service_unavailable",
        "Asset storage is unavailable.",
      );
    }
    const object = await store.read(key);
    if (!object) {
      return errorResponse(requestId(c), 404, "not_found", "The media object was not found.");
    }
    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(object.size),
        "Content-Type": object.contentType ?? "application/octet-stream",
        "X-Request-ID": requestId(c),
      },
      status: 200,
    });
  });

  app.post("/api/v1/asset-upload-sessions", (c) => {
    const storageLayer = resolveStorageLayer(c.env, dependencies);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const body = yield* fromPromise(() => jsonBody(c));
          yield* fromPromise(() =>
            onlyKeys(body, [
              "asset_type",
              "brand_profile_id",
              "filename",
              "content_type",
              "file_size",
              "title",
            ]),
          );
          if (body.asset_type !== "image" && body.asset_type !== "video") {
            return yield* Effect.fail(
              new CoreApiError(400, "validation_error", "asset_type must be image or video."),
            );
          }
          const key = yield* fromPromise(() => idempotencyKey(c));
          const assetService = yield* fromPromise(assets);
          const assetType = body.asset_type;
          const input = yield* fromPromise(
            () =>
              ({
                asset_type: assetType,
                brand_profile_id: uuidParam(
                  stringField(body, "brand_profile_id"),
                  "brand_profile_id",
                ),
                content_type: stringField(body, "content_type"),
                file_size: positiveIntegerField(body, "file_size"),
                filename: stringField(body, "filename"),
                title: stringField(body, "title"),
              }) satisfies Parameters<AssetApiService["createUploadSession"]>[2],
          );
          const result = yield* assetService.createUploadSession(
            c.env,
            c.get("actor").claims,
            input,
            key,
            requestId(c),
          );
          return jsonResponse(result.value, 201, requestId(c), {
            ...idempotencyHeaders(result.replayed),
          });
        }),
        storageLayer,
      ),
    );
  });

  app.get("/api/v1/asset-upload-sessions/:sessionId", (c) => {
    const storageLayer = resolveStorageLayer(c.env, dependencies);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const sessionId = yield* fromPromise(() =>
            uuidParam(c.req.param("sessionId"), "session_id"),
          );
          const assetService = yield* fromPromise(assets);
          const sessionResult = yield* assetService.getUploadSession(
            c.env,
            c.get("actor").claims,
            sessionId,
          );
          return jsonResponse(sessionResult, 200, requestId(c));
        }),
        storageLayer,
      ),
    );
  });

  app.delete("/api/v1/asset-upload-sessions/:sessionId", (c) => {
    const storageLayer = resolveStorageLayer(c.env, dependencies);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const sessionId = yield* fromPromise(() =>
            uuidParam(c.req.param("sessionId"), "session_id"),
          );
          const key = yield* fromPromise(() => idempotencyKey(c));
          const assetService = yield* fromPromise(assets);
          const result = yield* assetService.abortUploadSession(
            c.env,
            c.get("actor").claims,
            sessionId,
            key,
          );
          return new Response(null, {
            headers: {
              ...idempotencyHeaders(result.replayed),
              "X-Request-ID": requestId(c),
            },
            status: 204,
          });
        }),
        storageLayer,
      ),
    );
  });

  app.post("/api/v1/asset-upload-sessions/:sessionId/parts", (c) => {
    const storageLayer = resolveStorageLayer(c.env, dependencies);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const body = yield* fromPromise(() => jsonBody(c));
          yield* fromPromise(() => onlyKeys(body, ["part_numbers"]));
          const sessionId = yield* fromPromise(() =>
            uuidParam(c.req.param("sessionId"), "session_id"),
          );
          const partNumbers = yield* fromPromise(() => partNumbersField(body));
          const key = yield* fromPromise(() => idempotencyKey(c));
          const assetService = yield* fromPromise(assets);
          const urls = yield* assetService.createUploadPartUrls(
            c.env,
            c.get("actor").claims,
            sessionId,
            { part_numbers: partNumbers },
            key,
          );
          return jsonResponse(urls, 200, requestId(c));
        }),
        storageLayer,
      ),
    );
  });

  app.post("/api/v1/asset-upload-sessions/:sessionId/complete", (c) => {
    const storageLayer = resolveStorageLayer(c.env, dependencies);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const body = yield* fromPromise(() => jsonBody(c, true));
          yield* fromPromise(() => onlyKeys(body, ["parts"]));
          const sessionId = yield* fromPromise(() =>
            uuidParam(c.req.param("sessionId"), "session_id"),
          );
          const parts = yield* fromPromise(() => completedPartsField(body));
          const key = yield* fromPromise(() => idempotencyKey(c));
          const assetService = yield* fromPromise(assets);
          const result = yield* assetService.completeUploadSession(
            c.env,
            c.get("actor").claims,
            sessionId,
            { parts },
            key,
            requestId(c),
          );
          return jsonResponse(result.value, 202, requestId(c), {
            ...idempotencyHeaders(result.replayed),
          });
        }),
        storageLayer,
      ),
    );
  });

  app.get("/api/v1/assets/:assetId/download-url", (c) => {
    const storageLayer = resolveStorageLayer(c.env, dependencies);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const assetId = yield* fromPromise(() => uuidParam(c.req.param("assetId"), "asset_id"));
          const assetService = yield* fromPromise(assets);
          const result = yield* assetService.getAssetDownloadUrl(
            c.env,
            c.get("actor").claims,
            assetId,
          );
          return jsonResponse(result, 200, requestId(c));
        }),
        storageLayer,
      ),
    );
  });

  app.get("/api/v1/assets/:assetId/preview-url", (c) => {
    const storageLayer = resolveStorageLayer(c.env, dependencies);
    return runRouteEffect(
      c,
      withStorageLayer(
        Effect.gen(function* () {
          const assetId = yield* fromPromise(() => uuidParam(c.req.param("assetId"), "asset_id"));
          const assetService = yield* fromPromise(assets);
          const result = yield* assetService.getAssetPreviewUrl(
            c.env,
            c.get("actor").claims,
            assetId,
          );
          return jsonResponse(result, 200, requestId(c));
        }),
        storageLayer,
      ),
    );
  });

  app.get("/api/v1/assets/:assetId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const assetId = yield* fromPromise(() => uuidParam(c.req.param("assetId"), "asset_id"));
        const assetService = yield* fromPromise(assets);
        const result = yield* assetService.getAsset(c.env, c.get("actor").claims, assetId);
        return jsonResponse(result, 200, requestId(c));
      }),
    ),
  );

  app.get("/api/v1/platforms/capabilities", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const core = yield* fromPromise(service);
        const capabilities = yield* fromPromise(() => core.platformCapabilities());
        return jsonResponse({ capabilities }, 200, requestId(c));
      }),
    ),
  );

  app.get("/api/v1/platforms", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const core = yield* fromPromise(service);
        const accounts = yield* core.listPlatformAccounts(
          c.env,
          c.get("actor").claims,
          brandProfileId,
        );
        return jsonResponse({ accounts }, 200, requestId(c));
      }),
    ),
  );

  app.get("/api/v1/platforms/:accountId/publishing-requirements", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const accountId = yield* fromPromise(() =>
          uuidParam(c.req.param("accountId"), "account_id"),
        );
        const requirements = yield* readPublicationRequirements(
          c.env,
          c.get("actor").claims,
          accountId,
          requestId(c),
          registry(),
        );
        return jsonResponse(publishingRequirementsBody(requirements), 200, requestId(c));
      }).pipe(Effect.provide(createProviderServiceLive(registry()))),
    ),
  );

  app.get("/api/v1/platforms/:platform/connect", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const selected = yield* fromPromise(() => platformParam(c.req.param("platform")));
        const core = yield* fromPromise(service);
        const capability = core
          .platformCapabilities()
          .find((candidate) => candidate.platform === selected);
        if (!capability?.connect_available) {
          return yield* Effect.fail(
            new CoreApiError(
              422,
              "unsupported_capability",
              `${selected} connection is not available.`,
            ),
          );
        }
        const adapter = registry().get(selected);
        if (!adapter?.authorizationUrl || !adapter.exchangeAuthorizationCode) {
          return yield* Effect.fail(
            new CoreApiError(503, "provider_unavailable", `${selected} OAuth is not configured.`),
          );
        }
        const actor = c.get("actor");
        // Actor resolution already proved membership, so the resolved
        // workspace id is the authoritative OAuth state tenant — no
        // client-supplied organization header may substitute for it.
        const organizationId = actor.workspace.id;
        const brandProfileId = yield* fromPromise(() =>
          uuidParam(c.req.query("brand_profile_id") ?? "", "brand_profile_id"),
        );
        // The selected Brand Profile must exist in this workspace and be
        // active before any OAuth state is created: the contract pins the
        // connected Channel to this profile, so a missing or foreign profile
        // stays not-found while a soft-deleted one (still visible to admins
        // through RLS) rejects with the documented 409 conflict.
        const brandProfileService = yield* fromPromise(brandProfiles);
        const profile = yield* brandProfileService.getBrandProfile(
          c.env,
          actor.claims,
          brandProfileId,
        );
        if (profile.deleted_at !== null) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "brand_profile_deleted",
              "The brand profile is deleted and cannot accept new data.",
            ),
          );
        }
        const routingKey = yield* fromPromise(() => oauthStateRoutingKey(organizationId));
        const state = `${routingKey}.${randomBase64Url(32)}`;
        const verifier = randomBase64Url(32);
        const redirectUri = oauthCallbackUrl(c.env, selected);
        yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).create(state, {
            brand_profile_id: brandProfileId,
            expires_at: Date.now() + 10 * 60 * 1_000,
            organization_id: organizationId,
            pkce_verifier: verifier,
            provider: selected,
            redirect_path: "/channels",
            user_id: actor.userId,
          }),
        );
        const challenge = yield* fromPromise(() => pkceChallenge(verifier));
        const authorizationUrl = new URL(
          adapter.authorizationUrl({
            codeChallenge: challenge,
            redirectUri,
            state,
          }),
        );
        if (authorizationUrl.protocol !== "https:") {
          return yield* Effect.fail(
            new CoreApiError(
              503,
              "provider_unavailable",
              `${selected} OAuth returned an insecure authorization URL.`,
            ),
          );
        }
        if (c.req.header("Accept")?.includes("application/json")) {
          return jsonResponse(
            { authorization_url: authorizationUrl.toString() },
            200,
            requestId(c),
          );
        }
        return Response.redirect(authorizationUrl.toString(), 307);
      }),
    ),
  );

  app.get("/api/v1/platforms/:platform/callback", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const selected = yield* fromPromise(() => platformParam(c.req.param("platform")));
        // Redirect targets are built inside fromPromise so a missing FRONTEND_URL
        // surfaces as a typed 503 service unavailable failure.
        const redirectTo = (outcome: string) =>
          fromPromise(() => Response.redirect(frontendRedirect(c.env, selected, outcome), 302));
        const state = c.req.query("state")?.trim() ?? "";
        if (state.length < 16) {
          return yield* Effect.fail(
            new CoreApiError(400, "invalid_request", "A valid OAuth state is required."),
          );
        }
        const routingKey = state.split(".", 1)[0] ?? "";
        if (!OAUTH_ROUTING_KEY_PATTERN.test(routingKey)) {
          return yield* redirectTo("state_invalid");
        }
        const record = yield* fromPromise(() => oauthStateStub(c.env, routingKey).consume(state));
        if (
          !record ||
          record.provider !== selected ||
          record.expires_at <= Date.now() ||
          record.redirect_path !== "/channels"
        ) {
          return yield* redirectTo("state_invalid");
        }
        if (c.req.query("error")) {
          return yield* redirectTo("consent_denied");
        }
        if (!c.req.query("code")) {
          return yield* redirectTo("missing_code");
        }
        const adapter = registry().get(selected);
        if (!adapter?.exchangeAuthorizationCode || !record.pkce_verifier) {
          return yield* redirectTo("provider_unavailable");
        }
        const codeVerifier = record.pkce_verifier;
        const authorizationCode = c.req.query("code")!;
        // Configuration resolution shares the exchange redirect boundary: a consumed
        // callback must return a failure redirect on either failure, with the outcome
        // chosen from the provider failure so the banner stays actionable.
        const exchanged: OAuthExchangeResult | Response = yield* Effect.gen(function* () {
          const redirectUri = yield* fromPromise(() => oauthCallbackUrl(c.env, selected));
          const service = yield* ProviderService;
          return yield* service.exchangeAuthorizationCode(
            selected,
            {
              operationId: "completePlatformOAuth",
              requestId: requestId(c),
            },
            {
              code: authorizationCode,
              codeVerifier,
              redirectUri,
            },
          );
        }).pipe(
          Effect.catchCause((cause) => {
            const failure = Cause.squash(cause);
            const outcome = oauthExchangeOutcome(failure);
            return fromPromise(() => {
              log(
                "warn",
                {
                  environment: c.env.ENVIRONMENT,
                  request_id: requestId(c),
                  service: "api",
                  trace_id: c.get("traceId"),
                  user_id: record.user_id,
                  version: c.env.VERSION,
                },
                {
                  error_code: "provider_exchange_failed",
                  event: "oauth_exchange_failed",
                  message: `${selected} OAuth exchange failed`,
                  outcome,
                  provider: selected,
                  retry_class: "none",
                  ...oauthExchangeDiagnostic(failure),
                },
              );
              return Response.redirect(frontendRedirect(c.env, selected, outcome), 302);
            });
          }),
        );
        if (exchanged instanceof Response) return exchanged;
        if ("accounts" in exchanged) {
          const cipher = tokenCipherFor(c.env);
          const selectionId = `${routingKey}.${randomBase64Url(32)}`;
          yield* fromPromise(() =>
            oauthStateStub(c.env, routingKey).createSelection(selectionId, {
              brand_profile_id: record.brand_profile_id,
              expires_at: Date.now() + 10 * 60 * 1_000,
              id: selectionId,
              organization_id: record.organization_id,
              platform: selected,
              user_id: record.user_id,
            }),
          );
          const BATCH_SIZE = 50;
          for (let i = 0; i < exchanged.accounts.length; i += BATCH_SIZE) {
            const chunk = exchanged.accounts.slice(i, i + BATCH_SIZE);
            const candidates: OAuthSelectionCandidate[] = [];
            for (const account of chunk) {
              const sealed = yield* Effect.tryPromise({
                catch: (cause) =>
                  new DatabaseError({
                    cause,
                    message: "Failed to encrypt candidate OAuth connection.",
                  }),
                try: () => cipher.encrypt(JSON.stringify(account)),
              });
              candidates.push({
                account: {
                  avatar_url: account.account.avatarUrl ?? null,
                  display_name: account.account.displayName ?? null,
                  id: account.account.id,
                  username: account.account.username ?? null,
                },
                encryptedConnection: sealed,
              });
            }
            yield* fromPromise(() =>
              oauthStateStub(c.env, routingKey).appendSelectionCandidates(selectionId, candidates),
            );
          }
          yield* fromPromise(() =>
            oauthStateStub(c.env, routingKey).finalizeSelection(selectionId),
          );
          return yield* fromPromise(() =>
            Response.redirect(
              frontendRedirect(c.env, selected, "select_account", {
                selection_id: selectionId,
              }),
              302,
            ),
          );
        }
        const persisted: Response | undefined = yield* saveConnection(
          c.env,
          selected,
          {
            brandProfileId: record.brand_profile_id,
            organizationId: record.organization_id,
            userId: record.user_id,
          },
          exchanged,
        ).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) =>
            fromPromise(() => {
              log(
                "error",
                {
                  environment: c.env.ENVIRONMENT,
                  request_id: requestId(c),
                  service: "api",
                  trace_id: c.get("traceId"),
                  version: c.env.VERSION,
                },
                {
                  error_code: "connection_persist_failed",
                  event: "oauth_connection_persist_failed",
                  outcome: "internal_error",
                  provider: selected,
                  retry_class: "client_retry",
                  ...errorDiagnostic(Cause.squash(cause)),
                },
              );
              return Response.redirect(frontendRedirect(c.env, selected, "connection_failed"), 302);
            }),
          ),
        );
        if (persisted instanceof Response) return persisted;
        return yield* redirectTo("connected");
      }).pipe(Effect.provide(createProviderServiceLive(registry()))),
    ),
  );

  app.delete("/api/v1/platforms/:accountId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const accountId = yield* fromPromise(() =>
          uuidParam(c.req.param("accountId"), "account_id"),
        );
        const disconnectKey = yield* fromPromise(() => idempotencyKey(c));
        // Remote revoke is best-effort: a failed upstream revoke logs a warning
        // and does not block local disconnect.
        yield* revokeConnection(c.env, c.get("actor").claims, accountId, registry()).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              log(
                "warn",
                {
                  environment: c.env.ENVIRONMENT,
                  request_id: requestId(c),
                  service: "api",
                  trace_id: c.get("traceId"),
                  version: c.env.VERSION,
                },
                {
                  error_code: "provider_revoke_failed",
                  event: "oauth_remote_revoke_failed",
                  outcome: "ignored",
                  retry_class: "none",
                  ...errorDiagnostic(Cause.squash(cause)),
                },
              ),
            ),
          ),
        );
        const core = yield* fromPromise(service);
        const result = yield* core.disconnectPlatform(
          c.env,
          c.get("actor").claims,
          accountId,
          disconnectKey,
        );
        return new Response(null, {
          headers: {
            ...idempotencyHeaders(result.replayed),
            "X-Request-ID": requestId(c),
          },
          status: 204,
        });
      }).pipe(Effect.provide(createProviderServiceLive(registry()))),
    ),
  );

  app.get("/api/v1/oauth-selections/:selectionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const selectionId = c.req.param("selectionId")?.trim() ?? "";
        if (selectionId.length < 16 || selectionId.length > 256) {
          return yield* Effect.fail(
            new CoreApiError(
              404,
              "not_found",
              "The OAuth account selection does not exist or has expired.",
            ),
          );
        }
        const actor = c.get("actor");
        const routingKey = yield* fromPromise(() => oauthStateRoutingKey(actor.workspace.id));
        if (selectionId.includes(".")) {
          const keyPart = selectionId.split(".", 1)[0] ?? "";
          if (OAUTH_ROUTING_KEY_PATTERN.test(keyPart) && keyPart !== routingKey) {
            return yield* Effect.fail(
              new CoreApiError(
                404,
                "not_found",
                "The OAuth account selection does not exist or has expired.",
              ),
            );
          }
        }
        const selection = yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).getSelection(selectionId, {
            organizationId: actor.workspace.id,
            userId: actor.userId,
          }),
        );
        if (!selection) {
          return yield* Effect.fail(
            new CoreApiError(
              404,
              "not_found",
              "The OAuth account selection does not exist or has expired.",
            ),
          );
        }
        return jsonResponse(selection, 200, requestId(c));
      }),
    ),
  );

  app.post("/api/v1/oauth-selections/:selectionId/confirm", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const selectionId = c.req.param("selectionId")?.trim() ?? "";
        if (selectionId.length < 16 || selectionId.length > 256) {
          return yield* Effect.fail(
            new CoreApiError(
              404,
              "not_found",
              "The OAuth account selection does not exist or has expired.",
            ),
          );
        }
        const key = yield* fromPromise(() => idempotencyKey(c));
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["account_id"]));
        const rawAccountId = yield* fromPromise(() => stringField(body, "account_id"));
        const accountId = rawAccountId.trim();
        if (!accountId || accountId.length > 255) {
          return yield* Effect.fail(
            new CoreApiError(
              400,
              "invalid_request",
              "account_id must be a non-empty string under 255 characters.",
            ),
          );
        }
        const actor = c.get("actor");
        const routingKey = yield* fromPromise(() => oauthStateRoutingKey(actor.workspace.id));
        if (selectionId.includes(".")) {
          const keyPart = selectionId.split(".", 1)[0] ?? "";
          if (OAUTH_ROUTING_KEY_PATTERN.test(keyPart) && keyPart !== routingKey) {
            return yield* Effect.fail(
              new CoreApiError(
                404,
                "not_found",
                "The OAuth account selection does not exist or has expired.",
              ),
            );
          }
        }
        const claim = yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).claimSelection(
            selectionId,
            accountId,
            {
              organizationId: actor.workspace.id,
              userId: actor.userId,
            },
            key,
          ),
        );
        if (claim.status === "not_found") {
          return yield* Effect.fail(
            new CoreApiError(
              404,
              "not_found",
              "The OAuth account selection does not exist or has expired.",
            ),
          );
        }
        if (claim.status === "replayed") {
          return new Response(null, {
            headers: {
              ...idempotencyHeaders(true),
              "X-Request-ID": requestId(c),
            },
            status: 204,
          });
        }
        if (claim.status === "invalid_account") {
          return yield* Effect.fail(new CoreApiError(400, "invalid_request", claim.message));
        }
        if (claim.status === "conflict") {
          return yield* Effect.fail(new CoreApiError(409, "invalid_state", claim.message));
        }
        const cipher = tokenCipherFor(c.env);
        const plaintext = yield* Effect.tryPromise({
          catch: () =>
            new CoreApiError(
              500,
              "internal_error",
              "Failed to decrypt OAuth connection credentials.",
            ),
          try: () => cipher.decrypt(claim.encryptedConnection),
        });
        const connection: OAuthConnection = yield* Effect.try({
          catch: () =>
            new CoreApiError(500, "internal_error", "Invalid connection credentials payload."),
          try: () => {
            const parsed = JSON.parse(plaintext) as OAuthConnection;
            if (!parsed.accessToken || !parsed.account?.id || parsed.account.id !== accountId) {
              throw new TypeError("Invalid connection credentials payload.");
            }
            return parsed;
          },
        });
        yield* saveConnection(
          c.env,
          claim.platform as Platform,
          {
            brandProfileId: claim.brandProfileId,
            organizationId: claim.organizationId,
            userId: claim.userId,
          },
          connection,
        ).pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const failure = Cause.squash(cause);
              if (failure instanceof CoreApiError) {
                yield* fromPromise(() =>
                  oauthStateStub(c.env, routingKey).releaseSelectionClaim(
                    selectionId,
                    claim.claimToken,
                  ),
                );
              }
              return yield* Effect.failCause(cause);
            }),
          ),
        );
        const completed = yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).completeSelection(
            selectionId,
            accountId,
            claim.claimToken,
            key,
          ),
        );
        if (!completed) {
          return yield* Effect.fail(
            new CoreApiError(
              409,
              "invalid_state",
              "The selection confirmation could not be finalized. Please restart authorization.",
            ),
          );
        }
        return new Response(null, {
          headers: {
            ...idempotencyHeaders(false),
            "X-Request-ID": requestId(c),
          },
          status: 204,
        });
      }),
    ),
  );

  app.delete("/api/v1/oauth-selections/:selectionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const selectionId = c.req.param("selectionId")?.trim() ?? "";
        if (selectionId.length < 16 || selectionId.length > 256) {
          return yield* Effect.fail(
            new CoreApiError(
              404,
              "not_found",
              "The OAuth account selection does not exist or has expired.",
            ),
          );
        }
        const key = yield* fromPromise(() => idempotencyKey(c));
        const actor = c.get("actor");
        const routingKey = yield* fromPromise(() => oauthStateRoutingKey(actor.workspace.id));
        if (selectionId.includes(".")) {
          const keyPart = selectionId.split(".", 1)[0] ?? "";
          if (OAUTH_ROUTING_KEY_PATTERN.test(keyPart) && keyPart !== routingKey) {
            return yield* Effect.fail(
              new CoreApiError(
                404,
                "not_found",
                "The OAuth account selection does not exist or has expired.",
              ),
            );
          }
        }
        const result = yield* fromPromise(() =>
          oauthStateStub(c.env, routingKey).cancelSelection(
            selectionId,
            {
              organizationId: actor.workspace.id,
              userId: actor.userId,
            },
            key,
          ),
        );
        if (result.status === "not_found") {
          return yield* Effect.fail(
            new CoreApiError(
              404,
              "not_found",
              "The OAuth account selection does not exist or has expired.",
            ),
          );
        }
        if (result.status === "conflict") {
          return yield* Effect.fail(new CoreApiError(409, "invalid_state", result.message));
        }
        return new Response(null, {
          headers: {
            ...idempotencyHeaders(false),
            "X-Request-ID": requestId(c),
          },
          status: 204,
        });
      }),
    ),
  );

  app.get("/api/v1/posts", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const status = yield* fromPromise(() =>
          enumParam(c.req.query("status"), "status", POST_STATUS_VALUES),
        );
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 20, 1, 100),
        );
        const offset = yield* fromPromise(() =>
          integerParam(c.req.query("offset"), "offset", 0, 0, 1_000_000),
        );
        const postService = yield* fromPromise(posts);
        const result = yield* postService.listPosts(c.env, c.get("actor").claims, {
          ...(brandProfileId ? { brandProfileId } : {}),
          limit,
          offset,
          ...(status ? { status } : {}),
        });
        return jsonResponse(result, 200, requestId(c));
      }),
    ),
  );

  app.post("/api/v1/posts", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const body = yield* fromPromise(() => jsonBody(c));
        const input = yield* fromPromise(() => postComposition(body));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const postService = yield* fromPromise(posts);
        const result = yield* postService.createPost(
          c.env,
          c.get("actor").claims,
          input,
          key,
          requestId(c),
        );
        return jsonResponse(result.value, 201, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.get("/api/v1/posts/:postId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
        const postService = yield* fromPromise(posts);
        const post = yield* postService.getPost(c.env, c.get("actor").claims, postId);
        return yield* fromPromise(() => conditionalJsonResponse(c, post));
      }),
    ),
  );

  app.patch("/api/v1/posts/:postId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        const input = yield* fromPromise(() => postComposition(body));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const postService = yield* fromPromise(posts);
        const result = yield* postService.updatePost(
          c.env,
          c.get("actor").claims,
          postId,
          input,
          key,
          requestId(c),
        );
        return jsonResponse(result.value, 200, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.delete("/api/v1/posts/:postId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
        // Deletion is scoped like every other Post mutation: the body must name
        // the Brand Profile expected to own the Post so the workspace-wide
        // aggregate view can never select one implicitly.
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["brand_profile_id"]));
        const input = {
          brandProfileId: yield* fromPromise(() =>
            uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"),
          ),
        };
        const key = yield* fromPromise(() => idempotencyKey(c));
        const postService = yield* fromPromise(posts);
        const result = yield* postService.deletePost(
          c.env,
          c.get("actor").claims,
          postId,
          input,
          key,
          requestId(c),
        );
        return jsonResponse(result.value, 200, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.post("/api/v1/posts/:postId/schedule", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const postId = yield* fromPromise(() => uuidParam(c.req.param("postId"), "post_id"));
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["brand_profile_id", "scheduled_at", "targets"]));
        const input = yield* fromPromise(() => ({
          brandProfileId: uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"),
          // `null` means publish immediately, so it must survive parsing as a
          // real null rather than being coerced to an absent or invalid date.
          scheduledAt: body.scheduled_at === null ? null : dateField(body, "scheduled_at"),
          targets: postTargets(body),
        }));
        const key = yield* fromPromise(() => idempotencyKey(c));
        const postService = yield* fromPromise(posts);
        const result = yield* postService.schedulePost(
          c.env,
          c.get("actor").claims,
          postId,
          input,
          key,
          requestId(c),
        );
        return jsonResponse(result.value, 200, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.get("/api/v1/distributions", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const platformValue = c.req.query("platform");
        const postId = c.req.query("post_id");
        const start = yield* fromPromise(() => optionalDateParam(c.req.query("start"), "start"));
        const end = yield* fromPromise(() => optionalDateParam(c.req.query("end"), "end"));
        if (start && end && end < start) {
          return yield* Effect.fail(
            new CoreApiError(400, "invalid_range", "end must be at or after start."),
          );
        }
        const status = yield* fromPromise(() =>
          enumParam(
            c.req.query("status"),
            "status",
            new Set<Schemas["DistributionStatus"]>([
              "scheduled",
              "queued",
              "processing",
              "awaiting_provider",
              "published",
              "failed",
              "cancel_requested",
              "cancelled",
              "needs_reconciliation",
            ]),
          ),
        );
        const validatedPostId = postId
          ? yield* fromPromise(() => uuidParam(postId, "post_id"))
          : undefined;
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 20, 1, 100),
        );
        const offset = yield* fromPromise(() =>
          integerParam(c.req.query("offset"), "offset", 0, 0, 1_000_000),
        );
        const validatedPlatform = platformValue
          ? yield* fromPromise(() => platformParam(platformValue))
          : undefined;
        const core = yield* fromPromise(service);
        const distributions = yield* core.listDistributions(c.env, c.get("actor").claims, {
          ...(validatedPostId ? { postId: validatedPostId } : {}),
          ...(brandProfileId ? { brandProfileId } : {}),
          end,
          limit,
          offset,
          ...(validatedPlatform ? { platform: validatedPlatform } : {}),
          ...(status ? { status } : {}),
          start,
        });
        return jsonResponse(distributions, 200, requestId(c));
      }),
    ),
  );

  app.get("/api/v1/distributions/:distributionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const core = yield* fromPromise(service);
        const distribution = yield* core.getDistribution(
          c.env,
          c.get("actor").claims,
          distributionId,
        );
        return yield* fromPromise(() => conditionalJsonResponse(c, distribution));
      }),
    ),
  );

  app.patch("/api/v1/distributions/:distributionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() =>
          onlyKeys(body, ["scheduled_at", "title_override", "description_override", "hashtags"]),
        );
        const scheduledAt =
          body.scheduled_at === undefined
            ? undefined
            : yield* fromPromise(() => dateField(body, "scheduled_at"));
        const patch = {
          ...(scheduledAt !== undefined ? { scheduledAt } : {}),
          ...(body.title_override !== undefined
            ? {
                titleOverride: yield* fromPromise(() =>
                  optionalStringField(body, "title_override"),
                ),
              }
            : {}),
          ...(body.description_override !== undefined
            ? {
                descriptionOverride: yield* fromPromise(() =>
                  optionalStringField(body, "description_override"),
                ),
              }
            : {}),
          ...(body.hashtags !== undefined
            ? {
                hashtags: yield* fromPromise(() => stringArrayField(body, "hashtags")),
              }
            : {}),
        };
        const key = yield* fromPromise(() => idempotencyKey(c));
        const core = yield* fromPromise(service);
        const result = yield* core.updateDistribution(
          c.env,
          c.get("actor").claims,
          distributionId,
          patch,
          key,
        );
        return jsonResponse(result.value, 200, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.delete("/api/v1/distributions/:distributionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const core = yield* fromPromise(service);
        const result = yield* core.cancelDistribution(
          c.env,
          c.get("actor").claims,
          distributionId,
          key,
          requestId(c),
        );
        if (result.status === 204) {
          return new Response(null, {
            headers: {
              ...idempotencyHeaders(result.replayed),
              "X-Request-ID": requestId(c),
            },
            status: 204,
          });
        }
        return jsonResponse(result.value, 202, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.post("/api/v1/distributions/:distributionId/retry", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const key = yield* fromPromise(() => idempotencyKey(c));
        const core = yield* fromPromise(service);
        const result = yield* core.retryDistribution(
          c.env,
          c.get("actor").claims,
          distributionId,
          key,
          requestId(c),
        );
        return jsonResponse(result.value, 202, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  app.get("/api/v1/calendar", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const requested = yield* fromPromise(() =>
          dateRange(c.req.query("start"), c.req.query("end"), 63),
        );
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 500, 1, 1_000),
        );
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const core = yield* fromPromise(service);
        const events = yield* core.calendar(
          c.env,
          c.get("actor").claims,
          requested.start,
          requested.end,
          limit,
          brandProfileId,
        );
        return jsonResponse({ events }, 200, requestId(c));
      }),
    ),
  );

  app.get("/api/v1/analytics", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const requested = yield* fromPromise(() =>
          dateRange(c.req.query("start"), c.req.query("end"), 366),
        );
        const platformValue = c.req.query("platform");
        const platform = platformValue
          ? yield* fromPromise(() => platformParam(platformValue))
          : undefined;
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const core = yield* fromPromise(service);
        const summary = yield* core.summaryAnalytics(c.env, c.get("actor").claims, {
          ...requested,
          ...(platform ? { platform } : {}),
          ...(brandProfileId ? { brandProfileId } : {}),
        });
        return jsonResponse(summary, 200, requestId(c));
      }),
    ),
  );

  app.get("/api/v1/analytics/:distributionId", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const distributionId = yield* fromPromise(() =>
          uuidParam(c.req.param("distributionId"), "distribution_id"),
        );
        const start = yield* fromPromise(() => optionalDateParam(c.req.query("start"), "start"));
        const end = yield* fromPromise(() => optionalDateParam(c.req.query("end"), "end"));
        if (start && end) {
          yield* fromPromise(() => validateDateSpan(start, end, 366));
        }
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 100, 1, 500),
        );
        const core = yield* fromPromise(service);
        const snapshots = yield* core.distributionAnalytics(
          c.env,
          c.get("actor").claims,
          distributionId,
          {
            end,
            limit,
            start,
          },
        );
        return jsonResponse({ snapshots }, 200, requestId(c));
      }),
    ),
  );

  app.get("/api/v1/inbox", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const platformValue = c.req.query("platform");
        const distributionIdValue = c.req.query("distribution_id");
        const replyStatus = yield* fromPromise(() =>
          enumParam(c.req.query("reply_status"), "reply_status", REPLY_STATUS_VALUES),
        );
        const distributionId = distributionIdValue
          ? yield* fromPromise(() => uuidParam(distributionIdValue, "distribution_id"))
          : undefined;
        const brandProfileId = yield* fromPromise(() => optionalBrandProfileParam(c));
        const platform = platformValue
          ? yield* fromPromise(() => platformParam(platformValue))
          : undefined;
        const limit = yield* fromPromise(() =>
          integerParam(c.req.query("limit"), "limit", 20, 1, 100),
        );
        const offset = yield* fromPromise(() =>
          integerParam(c.req.query("offset"), "offset", 0, 0, 1_000_000),
        );
        const unreplied = yield* fromPromise(() =>
          booleanParam(c.req.query("unreplied"), "unreplied"),
        );
        const core = yield* fromPromise(service);
        const inbox = yield* core.inbox(c.env, c.get("actor").claims, {
          ...(distributionId ? { distributionId } : {}),
          ...(brandProfileId ? { brandProfileId } : {}),
          limit,
          offset,
          ...(platform ? { platform } : {}),
          ...(replyStatus ? { replyStatus } : {}),
          unreplied,
        });
        // Distributions past the demand-driven age threshold have no scheduled
        // Comment sync; this open is what fetches their Comments. The resolved
        // actor already proved workspace membership, so the workspace id is
        // passed directly instead of re-resolving it in the background.
        scheduleInboxCommentSync(c, c.get("actor").workspace.id, distributionId);
        return jsonResponse(inbox, 200, requestId(c));
      }),
    ),
  );

  app.post("/api/v1/inbox/:commentId/reply", (c) =>
    runRouteEffect(
      c,
      Effect.gen(function* () {
        const commentId = yield* fromPromise(() =>
          uuidParam(c.req.param("commentId"), "comment_id"),
        );
        const body = yield* fromPromise(() => jsonBody(c));
        yield* fromPromise(() => onlyKeys(body, ["brand_profile_id", "text"]));
        const replyBrandProfileId = yield* fromPromise(() =>
          uuidParam(stringField(body, "brand_profile_id"), "brand_profile_id"),
        );
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 5_000) {
          return yield* Effect.fail(
            new CoreApiError(
              400,
              "validation_error",
              "Reply text must contain between 1 and 5,000 characters.",
            ),
          );
        }
        const key = yield* fromPromise(() => idempotencyKey(c));
        const core = yield* fromPromise(service);
        const result = yield* core.replyToComment(
          c.env,
          c.get("actor").claims,
          commentId,
          replyBrandProfileId,
          text,
          key,
          requestId(c),
        );
        return jsonResponse(result.value, 202, requestId(c), {
          ...idempotencyHeaders(result.replayed),
        });
      }),
    ),
  );

  registerWorkspaceLifecycleRoutes(app, dependencies.workspaceLifecycle);
}
