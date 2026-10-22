import { createMeltiplyClient, type MeltiplyClient } from "@meltiply/contracts/client";
import type { components } from "@meltiply/contracts/schema";
import { Effect } from "effect";

import type {
  AnalyticsPostsQueryParams,
  AnalyticsPostsResponse,
  AnalyticsSummary,
  AnalyticsSummaryQueryParams,
  Asset,
  BrandProfile,
  BrandProfileListResponse,
  CalendarQueryParams,
  CalendarResponse,
  CompleteUploadInput,
  CreateBrandProfileInput,
  CreatePostInput,
  CreateUploadPartsInput,
  CreateUploadPartsResponse,
  CreateUploadSessionInput,
  Distribution,
  DistributionListResponse,
  DistributionQueryParams,
  OAuthSelection,
  OAuthSelectionConfirmRequest,
  Platform,
  PlatformAccountsResponse,
  AnalyticsDashboard,
  AnalyticsDashboardQueryParams,
  PlatformCapabilitiesResponse,
  PlatformQueryParams,
  Post,
  PostListResponse,
  PostQueryParams,
  PublishingRequirements,
  SchedulePostInput,
  SignedUrlResponse,
  UpdateBrandProfileInput,
  UpdateDistributionInput,
  UpdatePostInput,
  UploadSessionDetailResponse,
  UploadSessionResponse,
  UserProfile,
} from "@/types";
import { applyAuthJwt } from "./auth-token";
import { getApiBaseUrl, type PublicEnvSource } from "./env";
import { reportFrontendApiError, reportFrontendError } from "./frontend-telemetry";
import { createMutationKey } from "./mutation-idempotency";

const apiVersionPrefix = "/api/v1";
const absoluteUrlPattern = /^[a-z][a-z\d+\-.]*:\/\//i;
const unknownErrorCode = "unknown_error";

type ErrorEnvelope = components["schemas"]["ErrorEnvelope"];
type ErrorDetail = components["schemas"]["ErrorDetail"];
type OAuthStartResponse = components["schemas"]["OAuthStartResponse"];

type ApiResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};
let cachedClient: { baseUrl: string; value: MeltiplyClient } | undefined;

/**
 * Fetch implementation bound to the generated OpenAPI client.
 * Merges caller-supplied headers (whether carried on a `Request` input or via
 * `init`), stamps `Authorization: Bearer <jwt>` from the in-memory holder when
 * one is held, and forces `credentials: "omit"` so the Better Auth session
 * cookie never reaches `/api/v1` — the bearer JWT is the only credential the
 * public API accepts. Callers cannot upgrade credential mode.
 */
const runtimeFetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  applyAuthJwt(headers);
  return globalThis.fetch(input, { ...init, credentials: "omit", headers });
};

export type ApiPath = string;
export type NormalizedApiPath = `/${string}`;

export interface ApiRequestOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  readonly _tag = "ApiError";
  readonly code: string;
  readonly details: ErrorDetail[];
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly retryable: boolean;
  readonly status: number;

  /**
   * Constructs an `ApiError` from a failed HTTP Response and optional parsed ErrorEnvelope payload.
   * Dispatches frontend telemetry and captures request ID, retry headers, and error codes.
   *
   * @param response The non-ok Fetch Response object.
   * @param payload Parsed JSON error payload or raw response body.
   */
  constructor(response: Response, payload: unknown) {
    const envelope = isErrorEnvelope(payload) ? payload : null;
    const message =
      envelope?.error.message ?? `Request failed with status ${response.status || "unknown"}`;

    super(message);
    this.name = "ApiError";
    this.code = envelope?.error.code ?? unknownErrorCode;
    this.details = envelope?.error.details ?? [];
    this.requestId = envelope?.error.request_id ?? response.headers.get("x-request-id");
    this.retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
    this.retryable = envelope?.error.retryable ?? response.status >= 500;
    this.status = response.status;
    reportFrontendApiError({
      code: this.code,
      requestId: this.requestId,
      retryable: this.retryable,
      status: this.status,
    });
    reportFrontendError(this, "api-error");
  }
}

/**
 * Type guard checking whether a value conforms to the standard OpenAPI `ErrorEnvelope` schema.
 *
 * @param value Arbitrary payload to inspect.
 * @returns `true` if value is a valid `ErrorEnvelope`.
 */
function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== "object" || !("error" in value)) {
    return false;
  }

  const error = value.error;
  if (!error || typeof error !== "object") {
    return false;
  }

  return (
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string" &&
    "request_id" in error &&
    typeof error.request_id === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean" &&
    "details" in error &&
    Array.isArray(error.details)
  );
}

/**
 * Parses an HTTP `Retry-After` header value into seconds from the present moment.
 * Supports both integer seconds and HTTP date strings.
 *
 * @param value Header value string or null.
 * @returns Non-negative seconds to wait, or `null` if header is absent or invalid.
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

/**
 * Builds the request-scoped workspace selection header for one API call.
 * The `X-Workspace-ID` header carries an explicit workspace UUID chosen by the
 * caller; the server verifies membership before resolving the actor. A null or
 * blank value omits the header so the request resolves to the caller's personal
 * workspace. No module-global workspace state exists: selection is per request.
 *
 * @param workspaceId Workspace UUID for this request, or null for the personal workspace.
 * @returns Header record containing `X-Workspace-ID` when a workspace is selected.
 */
function workspaceHeaders(workspaceId: string | null) {
  const selected = workspaceId?.trim();
  return selected ? { "X-Workspace-ID": selected } : {};
}

/**
 * Resolves or generates a UUID idempotency key for state-mutating requests.
 *
 * @param key Optional user-provided or tracker-provided idempotency key.
 * @returns Verified idempotency key string.
 */
function mutationKey(key?: string) {
  return key ?? createMutationKey();
}

/**
 * Lifts one generated OpenAPI client operation into an Effect.
 *
 * The thunk keeps the request lazy: the fetch fires when the Effect executes,
 * not when the operation is constructed, so retries and interruption behave
 * correctly. `Effect.promise` supplies an AbortSignal bound to fiber
 * interruption, which is forwarded to the client so cancelling a query aborts
 * the in-flight request. A caller-supplied `options.signal` (e.g. an upload
 * task's own AbortController) takes precedence when present. Non-2xx responses
 * fail with a typed `ApiError`; transport rejections (network failures, aborts)
 * surface as defects so they are never misclassified as typed API errors.
 *
 * @param execute Operation factory receiving the fiber-bound AbortSignal.
 * @param signal Optional caller-provided abort signal override.
 * @returns Effect resolving to response data or failing with `ApiError`.
 */
function unwrap<T>(
  execute: (signal: AbortSignal) => Promise<ApiResult<T>>,
  signal?: AbortSignal,
): Effect.Effect<T, ApiError> {
  return Effect.flatMap(
    Effect.promise((fiberSignal) => execute(signal ?? fiberSignal)),
    (result) =>
      result.response.ok
        ? Effect.succeed(result.data as T)
        : Effect.fail(new ApiError(result.response, result.error)),
  );
}

/**
 * Returns a cached singleton instance of the generated OpenAPI Meltiply client.
 * Recreates the client instance if the configured base URL changes.
 *
 * @returns Initialized OpenAPI client.
 */
function client() {
  const baseUrl = getApiBaseUrl();
  if (cachedClient?.baseUrl === baseUrl) {
    return cachedClient.value;
  }

  const value = createMeltiplyClient(baseUrl, runtimeFetch);
  cachedClient = { baseUrl, value };
  return value;
}

/**
 * Normalizes and validates an API endpoint path relative to the API root.
 * Ensures the path begins with `/` and is not an absolute URL.
 *
 * @param path Relative API path string.
 * @returns Normalized API path starting with `/`.
 */
function normalizeApiPath(path: ApiPath): NormalizedApiPath {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("API path is required");
  }
  const trimmed = path.trim();
  if (absoluteUrlPattern.test(trimmed)) {
    throw new Error("Use a relative API path, not an absolute URL");
  }
  return (trimmed.startsWith("/") ? trimmed : `/${trimmed}`) as NormalizedApiPath;
}

/**
 * Builds a complete absolute URL for an API endpoint, automatically prefixing `/api/v1`
 * if not already included in the relative path.
 *
 * @param path Endpoint path relative to API root.
 * @param source Optional environment variable overrides.
 * @returns Complete absolute API endpoint URL.
 */
export function apiUrl(path: ApiPath, source?: PublicEnvSource) {
  const normalizedPath = normalizeApiPath(path);
  const versionPrefix = normalizedPath.startsWith(apiVersionPrefix) ? "" : apiVersionPrefix;

  return `${getApiBaseUrl(source)}${versionPrefix}${normalizedPath}`;
}

/**
 * Fetches the profile and active organization context for the authenticated user.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the user profile and organization details.
 */
export function getCurrentUser(workspaceId: string | null, options?: ApiRequestOptions) {
  return unwrap<UserProfile>(
    (signal) =>
      client().GET("/users/me", {
        headers: workspaceHeaders(workspaceId),
        signal,
      }),
    options?.signal,
  );
}

/**
 * Lists the active Brand Profiles in the active workspace, ordered by name.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the active brand profile list response.
 */
export function listBrandProfiles(workspaceId: string | null, options?: ApiRequestOptions) {
  return unwrap<BrandProfileListResponse>(
    (signal) =>
      client().GET("/brand-profiles", {
        headers: workspaceHeaders(workspaceId),
        signal,
      }),
    options?.signal,
  );
}

/**
 * Lists soft-deleted Brand Profiles awaiting the 7-day purge. Workspace admins only.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the soft-deleted brand profile list response.
 */
export function listDeletedBrandProfiles(workspaceId: string | null, options?: ApiRequestOptions) {
  return unwrap<BrandProfileListResponse>(
    (signal) =>
      client().GET("/brand-profiles/deleted", {
        headers: workspaceHeaders(workspaceId),
        signal,
      }),
    options?.signal,
  );
}

/**
 * Creates a Brand Profile in the active workspace. Workspace admins only.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param input Profile name and fixed-palette color label.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the created Brand Profile.
 */
export function createBrandProfile(
  workspaceId: string | null,
  input: CreateBrandProfileInput,
  options?: ApiRequestOptions,
) {
  return unwrap<BrandProfile>(
    (signal) =>
      client().POST("/brand-profiles", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Renames or recolors an existing Brand Profile. Workspace admins only.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param profileId Brand Profile UUID within the active workspace.
 * @param input Partial name/color patch.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the updated Brand Profile.
 */
export function updateBrandProfile(
  workspaceId: string | null,
  profileId: string,
  input: UpdateBrandProfileInput,
  options?: ApiRequestOptions,
) {
  return unwrap<BrandProfile>(
    (signal) =>
      client().PATCH("/brand-profiles/{profile_id}", {
        headers: workspaceHeaders(workspaceId),
        params: {
          path: { profile_id: profileId },
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        body: input,
        signal,
      }),
    options?.signal,
  );
}

/**
 * Soft-deletes a Brand Profile. Workspace admins only.
 *
 * Deletion cancels scheduled work, locally disconnects the profile's channels,
 * blocks new work, and schedules an idempotent purge after 7 days.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param profileId Brand Profile UUID within the active workspace.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the soft-deleted Brand Profile.
 */
export function deleteBrandProfile(
  workspaceId: string | null,
  profileId: string,
  options?: ApiRequestOptions,
) {
  return unwrap<BrandProfile>(
    (signal) =>
      client().DELETE("/brand-profiles/{profile_id}", {
        headers: workspaceHeaders(workspaceId),
        params: {
          path: { profile_id: profileId },
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Restores a soft-deleted Brand Profile before its purge. Workspace admins only.
 * Channels stay disconnected and cancelled distributions are not revived.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param profileId Brand Profile UUID within the active workspace.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the restored active Brand Profile.
 */
export function restoreBrandProfile(
  workspaceId: string | null,
  profileId: string,
  options?: ApiRequestOptions,
) {
  return unwrap<BrandProfile>(
    (signal) =>
      client().POST("/brand-profiles/{profile_id}/restore", {
        headers: workspaceHeaders(workspaceId),
        params: {
          path: { profile_id: profileId },
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Lists Posts in stable identity order, each carrying its ordered attachments,
 * saved target settings, and independent per-Channel publication outcomes.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param params Optional filters: lifecycle `status` (draft|active), owning
 *   Brand Profile, and the limit/offset window. Omitting `brand_profile_id`
 *   requests the read-only workspace aggregate.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the paginated Post list response.
 */
export function listPosts(
  workspaceId: string | null,
  params?: PostQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrap<PostListResponse>(
    (signal) =>
      client().GET("/posts", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Hydrates one Post with its ordered attachments, saved target settings, and
 * per-Channel outcomes. Composer editing keys off this identity rather than
 * reconstructing a composition from Asset and timestamp pairings.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Unique Post identifier.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the complete Post entity.
 */
export function getPost(workspaceId: string | null, id: string, options?: ApiRequestOptions) {
  return unwrap<Post>(
    (signal) =>
      client().GET("/posts/{post_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { post_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Creates one nonempty authoritative draft Post. The request must carry
 * `default_text` or at least one ordered `attachment_ids` entry so opening a
 * composer never persists an empty Post. Saving the same composition again is
 * an `updatePost` call on the returned id, not another create, and the
 * idempotency key makes a repeated create of one payload return the same Post.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param input Owning Brand Profile, default content, ordered attachment ids,
 *   and optional saved per-Channel targets.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the created draft Post.
 */
export function createPost(
  workspaceId: string | null,
  input: CreatePostInput,
  options?: ApiRequestOptions,
) {
  return unwrap<Post>(
    (signal) =>
      client().POST("/posts", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: { header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Saves the same Post's draft surface: default text, the whole ordered
 * attachment set, and the saved per-Channel targets. No target Channel is
 * required, attachments may still be uploading or processing, and already
 * claimed or published Distribution outcomes are never rewritten.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Post identifier being saved.
 * @param input Owning Brand Profile plus the fields to change.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the saved Post.
 */
export function updatePost(
  workspaceId: string | null,
  id: string,
  input: UpdatePostInput,
  options?: ApiRequestOptions,
) {
  return unwrap<Post>(
    (signal) =>
      client().PATCH("/posts/{post_id}", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { post_id: id },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Schedules the Post to its target Channels, or publishes immediately when
 * `scheduled_at` is null. Repeating one scheduling intent cannot create a
 * second Post or duplicate Distribution rows, and only still-editable pending
 * outcomes are created or updated.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Post identifier being scheduled.
 * @param input Owning Brand Profile, required publication instant (null =
 *   immediate), and optional target replacement defining the pending diff.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the Post with updated pending outcomes.
 */
export function schedulePost(
  workspaceId: string | null,
  id: string,
  input: SchedulePostInput,
  options?: ApiRequestOptions,
) {
  return unwrap<Post>(
    (signal) =>
      client().POST("/posts/{post_id}/schedule", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { post_id: id },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Soft-deletes a Post: its draft surface and pending publications stop, its
 * attachment references are released into the orphan grace period, and
 * already-delivered Channel copies remain immutable history.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Post identifier to delete.
 * @param brandProfileId Selected Brand Profile; the server rejects another profile or an aggregate selection.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the deleted Post snapshot.
 */
export function deletePost(
  workspaceId: string | null,
  id: string,
  brandProfileId: string,
  options?: ApiRequestOptions,
) {
  return unwrap<Post>(
    (signal) =>
      client().DELETE("/posts/{post_id}", {
        body: { brand_profile_id: brandProfileId },
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { post_id: id },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Fetches detailed metadata for a specific asset by ID.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Unique asset identifier.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the complete Asset entity.
 */
export function getAsset(workspaceId: string | null, id: string, options?: ApiRequestOptions) {
  return unwrap<Asset>(
    (signal) =>
      client().GET("/assets/{asset_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { asset_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Requests a short-lived presigned URL to stream or preview the asset's media file.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Unique asset identifier.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the presigned preview URL response.
 */
export function getAssetPreviewUrl(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrap<SignedUrlResponse>(
    (signal) =>
      client().GET("/assets/{asset_id}/preview-url", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { asset_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Requests a secure presigned URL configured for direct browser download of the original asset media.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Unique asset identifier.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the presigned download URL response.
 */
export function getAssetDownloadUrl(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrap<SignedUrlResponse>(
    (signal) =>
      client().GET("/assets/{asset_id}/download-url", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { asset_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Reads original Asset bytes through its authorized, short-lived download URL.
 * Workspace/id select the source Asset; object storage receives no API bearer
 * header or cookies. Non-2xx downloads fail with ApiError, while transport/body
 * failures follow the canonical adapter defect boundary. Cancellation covers
 * both URL acquisition and the binary transfer.
 */
export function getAssetBlob(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
): Effect.Effect<Blob, ApiError> {
  return Effect.flatMap(getAssetDownloadUrl(workspaceId, id, options), ({ url }) =>
    unwrap<Blob>(async (signal) => {
      const response = await globalThis.fetch(url, { credentials: "omit", signal });
      return response.ok ? { response, data: await response.blob() } : { response };
    }, options?.signal),
  );
}

/**
 * Initiates an upload session for a media file, determining single or multipart upload strategy.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param input File metadata including filename, file size, MIME type, and asset title.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the upload session configuration and initial presigned upload URLs.
 */
export function createUploadSession(
  workspaceId: string | null,
  input: CreateUploadSessionInput,
  options?: ApiRequestOptions,
) {
  return unwrap<UploadSessionResponse>(
    (signal) =>
      client().POST("/asset-upload-sessions", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Retrieves the current state and progress of an active upload session.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param sessionId Upload session ID.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the upload session details and list of completed parts.
 */
export function getUploadSession(
  workspaceId: string | null,
  sessionId: string,
  options?: ApiRequestOptions,
) {
  return unwrap<UploadSessionDetailResponse>(
    (signal) =>
      client().GET("/asset-upload-sessions/{session_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { session_id: sessionId } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Requests signed upload URLs for specific part numbers in a multipart upload session.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param sessionId Multipart upload session ID.
 * @param input Array of part numbers to generate URLs for.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the array of signed part upload URLs.
 */
export function createUploadPartUrls(
  workspaceId: string | null,
  sessionId: string,
  input: CreateUploadPartsInput,
  options?: ApiRequestOptions,
) {
  return unwrap<CreateUploadPartsResponse>(
    (signal) =>
      client().POST("/asset-upload-sessions/{session_id}/parts", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { session_id: sessionId },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Completes an upload session after all parts have finished uploading, triggering server verification.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param sessionId Upload session ID.
 * @param input Completed parts list with part numbers and ETags.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the resulting Asset entity in processing or ready status.
 */
export function completeUploadSession(
  workspaceId: string | null,
  sessionId: string,
  input: CompleteUploadInput = {},
  options?: ApiRequestOptions,
) {
  return unwrap<Asset>(
    (signal) =>
      client().POST("/asset-upload-sessions/{session_id}/complete", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { session_id: sessionId },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Aborts an upload session and cleans up partially uploaded chunks from R2 storage.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param sessionId Upload session ID to abort.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving once the session is aborted.
 */
export function abortUploadSession(
  workspaceId: string | null,
  sessionId: string,
  options?: ApiRequestOptions,
) {
  return unwrap<void>(
    (signal) =>
      client().DELETE("/asset-upload-sessions/{session_id}", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { session_id: sessionId },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Lists connected social platform accounts for the active organization.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param params Optional `brand_profile_id` filter; omitted returns every account in the workspace.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the connected platform accounts response.
 */
export function listPlatforms(
  workspaceId: string | null,
  params?: PlatformQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrap<PlatformAccountsResponse>(
    (signal) =>
      client().GET("/platforms", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Lists global publishing and media capabilities for all supported social platforms.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the platform capabilities specifications.
 */
export function listPlatformCapabilities(workspaceId: string | null, options?: ApiRequestOptions) {
  return unwrap<PlatformCapabilitiesResponse>(
    (signal) =>
      client().GET("/platforms/capabilities", {
        headers: workspaceHeaders(workspaceId),
        signal,
      }),
    options?.signal,
  );
}

/**
 * Initiates the OAuth authorization handshake for a social media provider.
 *
 * The `brandProfileId` is pinned into durable OAuth state at initiation so the
 * callback can verify the profile still belongs to the active workspace; the
 * new channel is owned by this Brand Profile.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param platform Target social platform to connect.
 * @param brandProfileId Active Brand Profile UUID that will own the connected channel.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the response containing the external provider OAuth authorization URL.
 */
export function startPlatformOAuth(
  workspaceId: string | null,
  platform: Platform,
  brandProfileId: string,
  options?: ApiRequestOptions,
) {
  return unwrap<OAuthStartResponse>(
    (signal) =>
      client().GET("/platforms/{platform}/connect", {
        headers: { ...workspaceHeaders(workspaceId), Accept: "application/json" },
        params: { path: { platform }, query: { brand_profile_id: brandProfileId } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Reads an owner-bound ticket's public Page choices without exposing credentials.
 * Uses the scoped transport (null selects the server's default Workspace); expired or foreign
 * tickets fail with ApiError. The returned Effect observes the optional abort signal.
 */
export function getOAuthSelection(
  workspaceId: string | null,
  selectionId: string,
  options?: ApiRequestOptions,
) {
  return unwrap<OAuthSelection>(
    (signal) =>
      client().GET("/oauth-selections/{selection_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { selection_id: selectionId } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Saves only the supplied candidate account ID from an active, owner-bound selection.
 * Uses a supplied/generated idempotency key and abort signal; the Effect returns void on 204
 * and preserves API failures such as expired tickets, conflicting choices, or plan limits.
 */
export function confirmOAuthSelection(
  workspaceId: string | null,
  selectionId: string,
  input: OAuthSelectionConfirmRequest,
  options?: ApiRequestOptions,
) {
  return unwrap<void>(
    (signal) =>
      client().POST("/oauth-selections/{selection_id}/confirm", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { selection_id: selectionId },
        },
        body: input,
        signal,
      }),
    options?.signal,
  );
}

/**
 * Discards an unconfirmed owner-bound ticket using the shared scoped, idempotent transport.
 * The Effect returns void on 204; in-flight confirmations cannot be reported as cancelled.
 */
export function cancelOAuthSelection(
  workspaceId: string | null,
  selectionId: string,
  options?: ApiRequestOptions,
) {
  return unwrap<void>(
    (signal) =>
      client().DELETE("/oauth-selections/{selection_id}", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { selection_id: selectionId },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Fetches dynamic creator publishing requirements (e.g. TikTok privacy settings, creator profile)
 * for a connected platform account.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Platform account ID.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the publishing requirements and privacy configuration.
 */
export function getPlatformPublishingRequirements(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrap<PublishingRequirements>(
    (signal) =>
      client().GET("/platforms/{account_id}/publishing-requirements", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { account_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Disconnects a platform account from the workspace and revokes tokens.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Platform account ID to disconnect.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving once the account is disconnected.
 */
export function disconnectPlatform(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrap<void>(
    (signal) =>
      client().DELETE("/platforms/{account_id}", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { account_id: id },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Retrieves a paginated list of publication distributions across connected platforms.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param params Query parameters (status, platform, limit, cursor).
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the paginated distribution list response.
 */
export function listDistributions(
  workspaceId: string | null,
  params?: DistributionQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrap<DistributionListResponse>(
    (signal) =>
      client().GET("/distributions", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Fetches status, logs, and attempts for a specific distribution intent.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Distribution identifier.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the distribution entity.
 */
export function getDistribution(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrap<Distribution>(
    (signal) =>
      client().GET("/distributions/{distribution_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { distribution_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Updates the scheduled publication time or content overrides for a pending distribution.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Distribution identifier.
 * @param input Updated schedule time and text overrides.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the updated distribution record.
 */
export function updateScheduledDistribution(
  workspaceId: string | null,
  id: string,
  input: UpdateDistributionInput,
  options?: ApiRequestOptions,
) {
  return unwrap<Distribution>(
    (signal) =>
      client().PATCH("/distributions/{distribution_id}", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { distribution_id: id },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Requests cancellation of a scheduled or queued distribution before provider delivery.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Distribution identifier.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the cancelled distribution record.
 */
export function cancelDistribution(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrap<Distribution | undefined>(
    (signal) =>
      client().DELETE("/distributions/{distribution_id}", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { distribution_id: id },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Retries a failed distribution intent, preserving the original idempotency guarantees.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param id Distribution identifier.
 * @param options Request options with optional idempotency key.
 * @returns Effect resolving to the re-enqueued distribution record.
 */
export function retryDistribution(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrap<Distribution>(
    (signal) =>
      client().POST("/distributions/{distribution_id}/retry", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { distribution_id: id },
        },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Fetches calendar events representing scheduled and published distributions within a date range.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param params Date range query parameters (start, end).
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the calendar events list response.
 */
export function getCalendar(
  workspaceId: string | null,
  params: CalendarQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrap<CalendarResponse>(
    (signal) =>
      client().GET("/calendar", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Reads the workspace's platform-level analytics for a published cohort.
 *
 * The window is a rolling pair of UTC instants; `brand_profile_id` omitted is
 * the read-only All Brand Profiles aggregate. The response carries per-platform
 * sums, published destination counts, coverage, and sync freshness.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param params Cohort bounds plus optional Platform and Brand Profile scope.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the summary response.
 */
export function getAnalyticsSummary(
  workspaceId: string | null,
  params: AnalyticsSummaryQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrap<AnalyticsSummary>(
    (signal) =>
      client().GET("/analytics", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Reads the dashboard's daily series, best-time cells, format and platform
 * breakdowns, follower history, and engagement accumulation.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param params Cohort bounds plus optional Platform, account, format, and Brand Profile scope.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the stored-snapshot dashboard aggregates.
 */
export function getAnalyticsDashboard(
  workspaceId: string | null,
  params: AnalyticsDashboardQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrap<AnalyticsDashboard>(
    (signal) =>
      client().GET("/analytics/dashboard", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/**
 * Reads the ranked per-Post analytics rows for a published cohort.
 *
 * Ranking uses the requested stored metric; each row carries its platforms,
 * unsupported subset, destination count, and latest sync time so unsupported or
 * unsynced values are never rendered as measured zero.
 *
 * @param workspaceId Workspace UUID to scope this request to, or null for the personal workspace.
 * @param params Cohort bounds, optional Platform/Brand Profile scope, ranking
 *   metric, and limit/offset pagination.
 * @param options Request options including optional abort signal.
 * @returns Effect resolving to the ranked Posts and pagination metadata.
 */
export function getAnalyticsPosts(
  workspaceId: string | null,
  params: AnalyticsPostsQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrap<AnalyticsPostsResponse>(
    (signal) =>
      client().GET("/analytics/posts", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}
