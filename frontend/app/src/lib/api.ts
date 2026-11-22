import { createMeltiplyClient, type MeltiplyClient } from "@meltiply/contracts/client";
import type { components, operations } from "@meltiply/contracts/schema";
import { Effect } from "effect";

import type {
  AnalyticsDashboardQueryParams,
  AnalyticsPostsQueryParams,
  AuditQueryParams,
  CalendarQueryParams,
  CompleteUploadInput,
  CreateBrandProfileInput,
  CreatePostInput,
  CreateQueueInput,
  CreateUploadPartsInput,
  CreateUploadSessionInput,
  DiscoverySource,
  OAuthSelectionConfirmRequest,
  Platform,
  PlatformQueryParams,
  PostQueryParams,
  PublishingPreferencesUpdate,
  QueueQueryParams,
  SchedulePostInput,
  UpdateBrandProfileInput,
  UpdateDistributionInput,
  UpdatePostInput,
  UpdateQueueInput,
  WorkspaceRole,
} from "@/types";
import { applyAuthJwt } from "./auth-token";
import { getApiBaseUrl, type PublicEnvSource } from "./env";
import { reportFrontendApiError } from "./frontend-telemetry";
import { createMutationKey } from "./mutation-idempotency";

const apiVersionPrefix = "/api/v1";
const absoluteUrlPattern = /^[a-z][a-z\d+\-.]*:\/\//i;
const unknownErrorCode = "unknown_error";

type ErrorEnvelope = components["schemas"]["ErrorEnvelope"];
type ErrorDetail = components["schemas"]["ErrorDetail"];

type ApiResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

type SuccessStatus = 200 | 201 | 202;
type JsonResponse<Op extends keyof operations> = {
  [S in SuccessStatus & keyof operations[Op]["responses"]]: operations[Op]["responses"][S] extends {
    content: { "application/json": infer Body };
  }
    ? Body
    : never;
}[SuccessStatus & keyof operations[Op]["responses"]];
type HasNoContent<Op extends keyof operations> = 204 extends keyof operations[Op]["responses"]
  ? true
  : false;
/**
 * Derives the resolved payload type of an OpenAPI operation directly from the
 * generated schema: JSON 2xx bodies become the payload, pure 204 endpoints become
 * `void`, and mixed 202/204 endpoints (such as `cancelDistribution`) become
 * `Body | undefined`.
 */
type OperationSuccess<Op extends keyof operations> = [JsonResponse<Op>] extends [never]
  ? void
  : HasNoContent<Op> extends true
    ? JsonResponse<Op> | undefined
    : JsonResponse<Op>;

let cachedClient: { baseUrl: string; value: MeltiplyClient } | undefined;

/**
 * Fetch implementation bound to the generated OpenAPI client. Stamps the
 * in-memory bearer JWT and forces `credentials: "same-origin"` so callers
 * cannot override credential handling.
 */
const runtimeFetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  applyAuthJwt(headers);
  return globalThis.fetch(input, { ...init, credentials: "same-origin", headers });
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
   * Constructs an `ApiError` from a non-ok HTTP Response and parsed ErrorEnvelope
   * payload, reporting one `api-error` telemetry event.
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
  }
}

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
 * Builds the `X-Workspace-ID` selection header when a non-blank workspace UUID
 * is provided; omitting it targets the caller's personal workspace.
 */
function workspaceHeaders(workspaceId: string | null) {
  const selected = workspaceId?.trim();
  return selected ? { "X-Workspace-ID": selected } : {};
}

function mutationKey(key?: string) {
  return key ?? createMutationKey();
}

/**
 * Lifts a generated OpenAPI client call into an Effect whose success type is
 * derived from `operations[Op]` in `@meltiply/contracts/schema`.
 *
 * The thunk keeps execution lazy for retries and interruption. The fiber abort
 * signal cancels in-flight requests unless the caller supplied an explicit
 * `options.signal`. Non-2xx responses fail with typed `ApiError`; transport
 * rejections propagate as defects.
 */
function unwrapOp<Op extends keyof operations>(
  execute: (signal: AbortSignal) => Promise<ApiResult<OperationSuccess<Op>>>,
  signal?: AbortSignal,
): Effect.Effect<OperationSuccess<Op>, ApiError> {
  return Effect.flatMap(
    Effect.promise((fiberSignal) => execute(signal ?? fiberSignal)),
    (result) =>
      result.response.ok
        ? Effect.succeed(result.data as OperationSuccess<Op>)
        : Effect.fail(new ApiError(result.response, result.error)),
  );
}

/** Lifts a non-OpenAPI fetch (such as signed object-storage reads) into an Effect. */
function unwrapBinary(
  execute: (signal: AbortSignal) => Promise<ApiResult<Blob>>,
  signal?: AbortSignal,
): Effect.Effect<Blob, ApiError> {
  return Effect.flatMap(
    Effect.promise((fiberSignal) => execute(signal ?? fiberSignal)),
    (result) =>
      result.response.ok && result.data !== undefined
        ? Effect.succeed(result.data)
        : Effect.fail(new ApiError(result.response, result.error)),
  );
}

function client() {
  const baseUrl = getApiBaseUrl();
  if (cachedClient?.baseUrl === baseUrl) {
    return cachedClient.value;
  }

  const value = createMeltiplyClient(baseUrl, runtimeFetch);
  cachedClient = { baseUrl, value };
  return value;
}

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

/** Builds an absolute `/api/v1` URL from a relative API path and optional env overrides. */
export function apiUrl(path: ApiPath, source?: PublicEnvSource) {
  const normalizedPath = normalizeApiPath(path);
  const versionPrefix = normalizedPath.startsWith(apiVersionPrefix) ? "" : apiVersionPrefix;

  return `${getApiBaseUrl(source)}${versionPrefix}${normalizedPath}`;
}

/** Fetches the authenticated user's profile and active organization context. */
export function getCurrentUser(workspaceId: string | null, options?: ApiRequestOptions) {
  return unwrapOp<"getCurrentUser">(
    (signal) =>
      client().GET("/users/me", {
        headers: workspaceHeaders(workspaceId),
        signal,
      }),
    options?.signal,
  );
}

/** Lists active Brand Profiles in the selected workspace. */
export function listBrandProfiles(workspaceId: string | null, options?: ApiRequestOptions) {
  return unwrapOp<"listBrandProfiles">(
    (signal) =>
      client().GET("/brand-profiles", {
        headers: workspaceHeaders(workspaceId),
        signal,
      }),
    options?.signal,
  );
}

/** Creates a Brand Profile in the active workspace (admin only). */
export function createBrandProfile(
  workspaceId: string | null,
  input: CreateBrandProfileInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"createBrandProfile">(
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

/** Updates a Brand Profile's name or color (admin only). */
export function updateBrandProfile(
  workspaceId: string | null,
  profileId: string,
  input: UpdateBrandProfileInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"updateBrandProfile">(
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

/** Permanently deletes a Brand Profile and its owned records (admin only). */
export function deleteBrandProfile(
  workspaceId: string | null,
  profileId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"deleteBrandProfile">(
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

/** Lists paginated Posts with attachments, saved targets, and Channel outcomes. */
export function listPosts(
  workspaceId: string | null,
  params?: PostQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"listPosts">(
    (signal) =>
      client().GET("/posts", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/** Lists one bounded page of recurring publishing Queues for a Brand Profile. */
export function listQueues(
  workspaceId: string | null,
  params: QueueQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"listQueues">(
    (signal) =>
      client().GET("/queues", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/** Reads the workspace's publishing timezone, signature templates, and notifications. */
export function getPublishingPreferences(workspaceId: string | null, options?: ApiRequestOptions) {
  return unwrapOp<"getPublishingPreferences">(
    (signal) =>
      client().GET("/publishing-preferences", {
        headers: workspaceHeaders(workspaceId),
        signal,
      }),
    options?.signal,
  );
}

/** Replaces the complete workspace publishing-preference document atomically. */
export function updatePublishingPreferences(
  workspaceId: string | null,
  input: PublishingPreferencesUpdate,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"updatePublishingPreferences">(
    (signal) =>
      client().PUT("/publishing-preferences", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: { header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) } },
        signal,
      }),
    options?.signal,
  );
}

/** Creates a recurring publishing Queue with a stable idempotency key. */
export function createQueue(
  workspaceId: string | null,
  input: CreateQueueInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"createQueue">(
    (signal) =>
      client().POST("/queues", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: { header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) } },
        signal,
      }),
    options?.signal,
  );
}

/** Updates a Queue's future slot configuration without moving existing reservations. */
export function updateQueue(
  workspaceId: string | null,
  id: string,
  input: UpdateQueueInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"updateQueue">(
    (signal) =>
      client().PATCH("/queues/{queue_id}", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          path: { queue_id: id },
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Retires an idle Queue; pending or in-flight memberships fail with a conflict. */
export function deleteQueue(
  workspaceId: string | null,
  id: string,
  brandProfileId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"deleteQueue">(
    (signal) =>
      client().DELETE("/queues/{queue_id}", {
        body: { brand_profile_id: brandProfileId },
        headers: workspaceHeaders(workspaceId),
        params: {
          path: { queue_id: id },
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Cancels editable pending Channel intents and releases a Post's Queue slot. */
export function removePostFromQueue(
  workspaceId: string | null,
  queueId: string,
  postId: string,
  brandProfileId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"removePostFromQueue">(
    (signal) =>
      client().DELETE("/queues/{queue_id}/posts/{post_id}", {
        body: { brand_profile_id: brandProfileId },
        headers: workspaceHeaders(workspaceId),
        params: {
          path: { queue_id: queueId, post_id: postId },
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Fetches one Post with its ordered attachments, saved targets, and Channel outcomes. */
export function getPost(workspaceId: string | null, id: string, options?: ApiRequestOptions) {
  return unwrapOp<"getPost">(
    (signal) =>
      client().GET("/posts/{post_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { post_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/** Creates a nonempty draft Post; retries with the same idempotency key return the same Post. */
export function createPost(
  workspaceId: string | null,
  input: CreatePostInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"createPost">(
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

/** Saves a Post's draft content, ordered attachments, and saved per-Channel targets. */
export function updatePost(
  workspaceId: string | null,
  id: string,
  input: UpdatePostInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"updatePost">(
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

/** Schedules a Post to its target Channels, or publishes immediately when `scheduled_at` is null. */
export function schedulePost(
  workspaceId: string | null,
  id: string,
  input: SchedulePostInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"schedulePost">(
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

/** Soft-deletes a Post owned by `brandProfileId` while keeping delivered history immutable. */
export function deletePost(
  workspaceId: string | null,
  id: string,
  brandProfileId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"deletePost">(
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

/** Fetches Asset metadata and processing status by ID. */
export function getAsset(workspaceId: string | null, id: string, options?: ApiRequestOptions) {
  return unwrapOp<"getAsset">(
    (signal) =>
      client().GET("/assets/{asset_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { asset_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/** Requests a short-lived presigned preview URL for an Asset. */
export function getAssetPreviewUrl(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"getAssetPreviewUrl">(
    (signal) =>
      client().GET("/assets/{asset_id}/preview-url", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { asset_id: id } },
        signal,
      }),
    options?.signal,
  );
}

function getAssetDownloadUrl(workspaceId: string | null, id: string, options?: ApiRequestOptions) {
  return unwrapOp<"getAssetDownloadUrl">(
    (signal) =>
      client().GET("/assets/{asset_id}/download-url", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { asset_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/** Downloads original Asset bytes via its signed URL with credentials omitted. */
export function getAssetBlob(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
): Effect.Effect<Blob, ApiError> {
  return Effect.flatMap(getAssetDownloadUrl(workspaceId, id, options), ({ url }) =>
    unwrapBinary(async (signal) => {
      const response = await globalThis.fetch(url, { credentials: "omit", signal });
      return response.ok ? { response, data: await response.blob() } : { response };
    }, options?.signal),
  );
}

/** Creates a single-part or multipart upload session for a media file. */
export function createUploadSession(
  workspaceId: string | null,
  input: CreateUploadSessionInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"createUploadSession">(
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

/** Fetches the current state and completed parts of an upload session. */
export function getUploadSession(
  workspaceId: string | null,
  sessionId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"getUploadSession">(
    (signal) =>
      client().GET("/asset-upload-sessions/{session_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { session_id: sessionId } },
        signal,
      }),
    options?.signal,
  );
}

/** Requests presigned upload URLs for a batch of multipart part numbers. */
export function createUploadPartUrls(
  workspaceId: string | null,
  sessionId: string,
  input: CreateUploadPartsInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"createUploadPartUrls">(
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

/** Completes an upload session and queues the resulting Asset for verification. */
export function completeUploadSession(
  workspaceId: string | null,
  sessionId: string,
  input: CompleteUploadInput = {},
  options?: ApiRequestOptions,
) {
  return unwrapOp<"completeUploadSession">(
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

/** Aborts an upload session and cleans up partial chunks in object storage. */
export function abortUploadSession(
  workspaceId: string | null,
  sessionId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"abortUploadSession">(
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

/** Lists connected social platform accounts in the workspace. */
export function listPlatforms(
  workspaceId: string | null,
  params?: PlatformQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"listPlatformAccounts">(
    (signal) =>
      client().GET("/platforms", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/** Lists deployment-defined publishing and media capabilities across supported platforms. */
export function listPlatformCapabilities(workspaceId: string | null, options?: ApiRequestOptions) {
  return unwrapOp<"listPlatformCapabilities">(
    (signal) =>
      client().GET("/platforms/capabilities", {
        headers: workspaceHeaders(workspaceId),
        signal,
      }),
    options?.signal,
  );
}

/** Initiates a provider OAuth handshake and returns the external authorization URL. */
export function startPlatformOAuth(
  workspaceId: string | null,
  platform: Platform,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"startPlatformOAuth">(
    (signal) =>
      client().GET("/platforms/{platform}/connect", {
        headers: { ...workspaceHeaders(workspaceId), Accept: "application/json" },
        params: { path: { platform } },
        signal,
      }),
    options?.signal,
  );
}

/** Reads an owner-bound OAuth account-selection ticket without exposing credentials. */
export function getOAuthSelection(
  workspaceId: string | null,
  selectionId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"getOAuthSelection">(
    (signal) =>
      client().GET("/oauth-selections/{selection_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { selection_id: selectionId } },
        signal,
      }),
    options?.signal,
  );
}

/** Confirms one candidate account from an active OAuth selection ticket. */
export function confirmOAuthSelection(
  workspaceId: string | null,
  selectionId: string,
  input: OAuthSelectionConfirmRequest,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"confirmOAuthSelection">(
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

/** Discards an unconfirmed OAuth selection ticket. */
export function cancelOAuthSelection(
  workspaceId: string | null,
  selectionId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"cancelOAuthSelection">(
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

/** Fetches live creator publishing requirements for a connected platform account. */
export function getPlatformPublishingRequirements(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"getPlatformPublishingRequirements">(
    (signal) =>
      client().GET("/platforms/{account_id}/publishing-requirements", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { account_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/** Disconnects a platform account from the workspace and revokes its tokens. */
export function disconnectPlatform(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"disconnectPlatformAccount">(
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

export type BroadcastInfo = OperationSuccess<"getBroadcast">;

/** Reads no-store encoder credentials on explicit writer demand; never cache the result. */
export function getBroadcast(workspaceId: string | null, id: string, options?: ApiRequestOptions) {
  return unwrapOp<"getBroadcast">(
    (signal) =>
      client().GET("/distributions/{distribution_id}/broadcast", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { distribution_id: id } },
        signal,
        cache: "no-store",
      }),
    options?.signal,
  );
}

/** Ends an active live broadcast with a stable idempotency key. */
export function endBroadcast(workspaceId: string | null, id: string, options?: ApiRequestOptions) {
  return unwrapOp<"endBroadcast">(
    (signal) =>
      client().POST("/distributions/{distribution_id}/broadcast/end", {
        headers: workspaceHeaders(workspaceId),
        params: {
          path: { distribution_id: id },
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Fetches status and attempt details for one Distribution. */
export function getDistribution(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"getDistribution">(
    (signal) =>
      client().GET("/distributions/{distribution_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { distribution_id: id } },
        signal,
      }),
    options?.signal,
  );
}

/** Reschedules or updates content overrides for a pending Distribution. */
export function updateScheduledDistribution(
  workspaceId: string | null,
  id: string,
  input: UpdateDistributionInput,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"updateScheduledDistribution">(
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

/** Cancels a scheduled or queued Distribution before provider delivery. */
export function cancelDistribution(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"cancelDistribution">(
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

/** Re-enqueues a failed Distribution while preserving idempotency. */
export function retryDistribution(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"retryDistribution">(
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

/** Lists Calendar events representing scheduled and published Distributions in a range. */
export function getCalendar(
  workspaceId: string | null,
  params: CalendarQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"listCalendarEvents">(
    (signal) =>
      client().GET("/calendar", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/** Lists Workspace members with role, lifecycle status, and join date. */
export function listWorkspaceMembers(workspaceId: string, options?: ApiRequestOptions) {
  return unwrapOp<"listWorkspaceMembers">(
    (signal) =>
      client().GET("/workspaces/{workspaceId}/members", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { workspaceId } },
        signal,
      }),
    options?.signal,
  );
}

/** Fetches stored-snapshot Analytics dashboard aggregates for a cohort window. */
export function getAnalyticsDashboard(
  workspaceId: string | null,
  params: AnalyticsDashboardQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"getAnalyticsDashboard">(
    (signal) =>
      client().GET("/analytics/dashboard", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/** Lists pending, unexpired Workspace invitations. */
export function listWorkspaceInvitations(workspaceId: string, options?: ApiRequestOptions) {
  return unwrapOp<"listWorkspaceInvitations">(
    (signal) =>
      client().GET("/workspaces/{workspaceId}/invitations", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { workspaceId } },
        signal,
      }),
    options?.signal,
  );
}

/** Fetches ranked per-Post Analytics rows for a published cohort window. */
export function getAnalyticsPosts(
  workspaceId: string | null,
  params: AnalyticsPostsQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"getAnalyticsPosts">(
    (signal) =>
      client().GET("/analytics/posts", {
        headers: workspaceHeaders(workspaceId),
        params: { query: params },
        signal,
      }),
    options?.signal,
  );
}

/** Reads up to 500 chronological stored Analytics snapshots for one Distribution. */
export function getDistributionAnalytics(
  workspaceId: string | null,
  id: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"getDistributionAnalytics">(
    (signal) =>
      client().GET("/analytics/{distribution_id}", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { distribution_id: id }, query: { limit: 500 } },
        signal,
      }),
    options?.signal,
  );
}

/** Invites an email address to the Workspace with an assignable role. */
export function createWorkspaceInvitation(
  workspaceId: string,
  input: { email: string; role: WorkspaceRole },
  options?: ApiRequestOptions,
) {
  return unwrapOp<"createWorkspaceInvitation">(
    (signal) =>
      client().POST("/workspaces/{workspaceId}/invitations", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { workspaceId },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Rotates an invitation token and resends the acceptance email. */
export function resendWorkspaceInvitation(
  workspaceId: string,
  invitationId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"resendWorkspaceInvitation">(
    (signal) =>
      client().POST("/workspaces/{workspaceId}/invitations/{invitationId}/resend", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { invitationId, workspaceId },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Revokes a pending Workspace invitation and frees its reserved Seat. */
export function revokeWorkspaceInvitation(
  workspaceId: string,
  invitationId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"revokeWorkspaceInvitation">(
    (signal) =>
      client().DELETE("/workspaces/{workspaceId}/invitations/{invitationId}", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { invitationId, workspaceId },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Updates a Workspace member's role. */
export function updateWorkspaceMember(
  workspaceId: string,
  memberId: string,
  role: WorkspaceRole,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"updateWorkspaceMember">(
    (signal) =>
      client().PATCH("/workspaces/{workspaceId}/members/{memberId}", {
        body: { role },
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { memberId, workspaceId },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Removes a member from the Workspace and frees their Seat. */
export function removeWorkspaceMember(
  workspaceId: string,
  memberId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"removeWorkspaceMember">(
    (signal) =>
      client().DELETE("/workspaces/{workspaceId}/members/{memberId}", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { memberId, workspaceId },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Renames the shared Workspace. */
export function updateWorkspaceName(
  workspaceId: string,
  input: { name: string },
  options?: ApiRequestOptions,
) {
  return unwrapOp<"updateWorkspace">(
    (signal) =>
      client().PATCH("/workspaces/{workspaceId}", {
        body: input,
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { workspaceId },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Reads installation Seat usage, shared Workspace metadata, and Installation Owner. */
export function getInstallation(workspaceId: string, options?: ApiRequestOptions) {
  return unwrapOp<"getInstallation">(
    (signal) =>
      client().GET("/installation", {
        headers: workspaceHeaders(workspaceId),
        signal,
      }),
    options?.signal,
  );
}

/** Suspends a member account, revoking active sessions and freeing their Seat. */
export function suspendInstallationMember(
  workspaceId: string,
  memberId: string,
  reason: string | undefined,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"suspendInstallationMember">(
    (signal) =>
      client().POST("/installation/members/{memberId}/suspend", {
        body: reason === undefined ? {} : { reason },
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { memberId },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Reactivates a suspended member when a Seat is available. */
export function reactivateInstallationMember(
  workspaceId: string,
  memberId: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"reactivateInstallationMember">(
    (signal) =>
      client().POST("/installation/members/{memberId}/reactivate", {
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { memberId },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Permanently deletes a member account after matching email confirmation. */
export function deleteInstallationMember(
  workspaceId: string,
  memberId: string,
  confirmEmail: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"deleteInstallationMember">(
    (signal) =>
      client().DELETE("/installation/members/{memberId}", {
        body: { confirm_email: confirmEmail },
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
          path: { memberId },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Transfers installation ownership to an active Workspace Admin after password verification. */
export function transferInstallationOwnership(
  workspaceId: string,
  targetUserId: string,
  password: string,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"transferInstallationOwnership">(
    (signal) =>
      client().POST("/installation/ownership-transfer", {
        body: { password, target_user_id: targetUserId },
        headers: workspaceHeaders(workspaceId),
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Lists reverse-chronological Workspace audit log entries. */
export function listWorkspaceAudit(
  workspaceId: string,
  params: AuditQueryParams,
  options?: ApiRequestOptions,
) {
  return unwrapOp<"listWorkspaceAudit">(
    (signal) =>
      client().GET("/workspaces/{workspaceId}/audit", {
        headers: workspaceHeaders(workspaceId),
        params: { path: { workspaceId }, query: params },
        signal,
      }),
    options?.signal,
  );
}

/** Inspects a Workspace invitation token before sign-in. */
export function getInvitationPreview(token: string, options?: ApiRequestOptions) {
  return unwrapOp<"getWorkspaceInvitation">(
    (signal) =>
      client().GET("/workspace-invitations/{token}", {
        params: { path: { token } },
        signal,
      }),
    options?.signal,
  );
}

/** Accepts a Workspace invitation for the authenticated account. */
export function acceptWorkspaceInvitation(token: string, options?: ApiRequestOptions) {
  return unwrapOp<"acceptWorkspaceInvitation">(
    (signal) =>
      client().POST("/workspace-invitations/{token}/accept", {
        params: { path: { token } },
        signal,
      }),
    options?.signal,
  );
}

/** Reads Installation Owner onboarding progress; upgrades report `not_applicable`. */
export function getOnboarding(options?: ApiRequestOptions) {
  return unwrapOp<"getOnboarding">(
    (signal) => client().GET("/onboarding", { signal }),
    options?.signal,
  );
}

/** Persists the reached onboarding screen idempotently. */
export function saveOnboarding(
  input: { step: "improvement" | "ready" },
  options?: ApiRequestOptions,
) {
  return unwrapOp<"saveOnboarding">(
    (signal) =>
      client().PATCH("/onboarding", {
        body: input,
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Marks onboarding complete idempotently without renaming the Workspace. */
export function completeOnboarding(options?: ApiRequestOptions) {
  return unwrapOp<"completeOnboarding">(
    (signal) =>
      client().POST("/onboarding/complete", {
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Reads the installation improvement-reporting policy and effective outbound state. */
export function getReportingPolicy(options?: ApiRequestOptions) {
  return unwrapOp<"getReportingPolicy">(
    (signal) => client().GET("/installation/reporting", { signal }),
    options?.signal,
  );
}

/** Updates installation usage and diagnostics reporting preferences (Owner only). */
export function updateReportingPreferences(
  input: { usage: boolean; diagnostics: boolean },
  options?: ApiRequestOptions,
) {
  return unwrapOp<"updateReportingPreferences">(
    (signal) =>
      client().PUT("/installation/reporting", {
        body: input,
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}

/** Reads the one-time installation discovery-source answer and delivery state (Owner only). */
export function getReportingFeedback(options?: ApiRequestOptions) {
  return unwrapOp<"getReportingFeedback">(
    (signal) => client().GET("/installation/reporting/feedback", { signal }),
    options?.signal,
  );
}

/** Submits the one-time installation discovery-source answer (Owner only). */
export function submitReportingFeedback(
  input: { discovery_source: DiscoverySource },
  options?: ApiRequestOptions,
) {
  return unwrapOp<"submitReportingFeedback">(
    (signal) =>
      client().POST("/installation/reporting/feedback", {
        body: input,
        params: {
          header: { "Idempotency-Key": mutationKey(options?.idempotencyKey) },
        },
        signal,
      }),
    options?.signal,
  );
}
