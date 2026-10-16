import { hasCookieConsent } from "@meltiply/ui/cookie-consent";

import { Effect, Exit, Fiber, type Cause } from "effect";

import {
  abortUploadSession,
  completeUploadSession,
  createUploadPartUrls,
  createUploadSession,
  getUploadSession,
  type ApiRequestOptions,
} from "./api";
import { runQueryEffect } from "./effect";
import { createMutationKey } from "./mutation-idempotency";
import type {
  Asset,
  CompletedPart,
  CompleteUploadInput,
  CreateUploadPartsInput,
  CreateUploadPartsResponse,
  CreateUploadSessionInput,
  UploadSession,
  UploadSessionDetailResponse,
  UploadSessionResponse,
} from "@/types";

type SignedRequest = NonNullable<UploadSession["single_upload"]>;
type SignedPart = CreateUploadPartsResponse["parts"][number];

/**
 * Effect-returning upload API seam consumed by the orchestrator.
 * The error channel is `unknown` because the orchestrator treats every failure
 * generically (retry/stop propagation), which also keeps test fakes free to
 * fail with plain errors instead of constructing `ApiError`s.
 *
 * The first argument of every member is the explicit Workspace selection
 * (`null` targets the personal workspace) forwarded to `lib/api.ts`, which
 * sends it as `x-workspace-id`. Authentication stays ambient: the HttpOnly
 * Better Auth session cookie travels with the same-origin request, so no
 * credential ever passes through this seam.
 */
export interface UploadApi {
  abortUploadSession: (
    workspaceId: string | null,
    sessionId: string,
    options?: ApiRequestOptions,
  ) => Effect.Effect<void, unknown>;
  completeUploadSession: (
    workspaceId: string | null,
    sessionId: string,
    input?: CompleteUploadInput,
    options?: ApiRequestOptions,
  ) => Effect.Effect<Asset, unknown>;
  createUploadPartUrls: (
    workspaceId: string | null,
    sessionId: string,
    input: CreateUploadPartsInput,
    options?: ApiRequestOptions,
  ) => Effect.Effect<CreateUploadPartsResponse, unknown>;
  createUploadSession: (
    workspaceId: string | null,
    input: CreateUploadSessionInput,
    options?: ApiRequestOptions,
  ) => Effect.Effect<UploadSessionResponse, unknown>;
  getUploadSession: (
    workspaceId: string | null,
    sessionId: string,
    options?: ApiRequestOptions,
  ) => Effect.Effect<UploadSessionDetailResponse, unknown>;
}

export type AssetUploadStatus =
  | "creating"
  | "uploading"
  | "paused"
  | "offline"
  | "completing"
  | "processing"
  | "complete"
  | "cancelled"
  | "failed";

interface FileFingerprint {
  lastModified: number;
  name: string;
  size: number;
  type: string;
}

export interface ResumableUpload {
  assetId: string;
  completedParts: CompletedPart[];
  expiresAt: string;
  file: FileFingerprint;
  sessionId: string;
  strategy: UploadSession["strategy"];
  version: 1;
}

export interface UploadAssetFileOptions {
  api?: UploadApi;
  /**
   * Active Brand Profile UUID that will own the uploaded Asset; required because
   * `CreateUploadSessionRequest.brand_profile_id` is mandatory on the contract.
   */
  brandProfileId: string;
  file: File;
  onProgress?: (percent: number) => void;
  /**
   * Reports the durable Asset id as soon as the upload session exists, before any
   * byte is transferred. Callers that must persist ownership of an upload that is
   * still in flight (the Post composer attaching a pending upload to a saved draft)
   * need that id while `result` is still pending. Throwing from this callback is
   * ignored so a subscriber bug can never fail an upload.
   */
  onSessionStart?: (assetId: string) => void;
  onStatusChange?: (status: AssetUploadStatus) => void;
  resumeSessionId?: string;
  storage?: Storage | null;
  workspaceId: string | null;
}

export interface AssetUploadTask {
  cancel(): Promise<void>;
  pause(): void;
  resume(): void;
  readonly result: Promise<Asset>;
}

const defaultApi: UploadApi = {
  abortUploadSession,
  completeUploadSession,
  createUploadPartUrls,
  createUploadSession,
  getUploadSession,
};

const resumeKeyPrefix = "meltiply.upload.v1.";
const pendingCreateKeyPrefix = "meltiply.upload.create.v1.";
const pendingCreateMaxAgeMs = 24 * 60 * 60 * 1_000;
const maximumPartUrlBatch = 100;
const maximumUploadAttempts = 3;

class DirectUploadError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "DirectUploadError";
  }
}

class UploadCancelledError extends Error {
  constructor() {
    super("Upload was cancelled");
    this.name = "UploadCancelledError";
  }
}

interface UploadStopState {
  reason?: Cause.Cause<unknown>;
  stopped: boolean;
}

type UploadStopReader = () => UploadStopState;

interface PendingUploadCreation {
  createdAt: number;
  file: FileFingerprint;
  idempotencyKey: string;
  version: 1;
}

/**
 * Returns localStorage only after functional consent, catching browser security
 * errors; uploads proceed without optional recovery when storage is unavailable.
 */
function browserStorage(): Storage | null {
  if (!hasCookieConsent("functional")) return null;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Extracts identifying attributes of a local file to form a stable fingerprint.
 *
 * @param file Local `File` object selected by the user.
 * @returns Fingerprint object containing name, size, type, and modification timestamp.
 */
function fingerprint(file: File): FileFingerprint {
  return {
    lastModified: file.lastModified,
    name: file.name,
    size: file.size,
    type: file.type,
  };
}

/**
 * Checks whether a candidate fingerprint exactly matches the properties of a local file.
 *
 * @param candidate Stored fingerprint record.
 * @param file Local file to compare.
 * @returns `true` if all identifying attributes match.
 */
function matchesFileFingerprint(candidate: FileFingerprint, file: File): boolean {
  return (
    candidate.lastModified === file.lastModified &&
    candidate.name === file.name &&
    candidate.size === file.size &&
    candidate.type === file.type
  );
}

/**
 * Validates whether a selected local file matches the fingerprint of an active resumable upload.
 *
 * @param record Persisted resumable upload record.
 * @param file Local file selected by the user.
 * @returns `true` if the file matches the recorded upload session.
 */
function matchesResumableFile(record: ResumableUpload, file: File): boolean {
  return matchesFileFingerprint(record.file, file);
}

/**
 * Generates the localStorage key for tracking in-flight session creation idempotency.
 *
 * @param file Local file being uploaded.
 * @returns Prefixed storage key containing the file fingerprint.
 */
function pendingCreateStorageKey(file: File): string {
  return `${pendingCreateKeyPrefix}${encodeURIComponent(JSON.stringify(fingerprint(file)))}`;
}

/**
 * Type guard verifying if an object is a valid `PendingUploadCreation` descriptor.
 *
 * @param value Arbitrary value from storage.
 * @returns `true` if the value conforms to the schema.
 */
function isPendingUploadCreation(value: unknown): value is PendingUploadCreation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.createdAt === "number" &&
    typeof record.idempotencyKey === "string" &&
    typeof record.file === "object" &&
    record.file !== null
  );
}

/**
 * Reads pending upload creation state only after functional consent, expiring items older than 24 hours.
 * @param file Local file being uploaded.
 * @param storage Browser storage instance or null.
 * @returns Stored pending creation record or `null` if missing or expired.
 */
function pendingUploadCreation(file: File, storage: Storage | null): PendingUploadCreation | null {
  if (!storage || !hasCookieConsent("functional")) return null;
  const key = pendingCreateStorageKey(file);
  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPendingUploadCreation(parsed)) {
      storage.removeItem(key);
      return null;
    }
    if (Date.now() - parsed.createdAt > pendingCreateMaxAgeMs) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

/**
 * Caches an in-flight upload session creation idempotency key only after
 * functional consent. Without consent, the request uses an in-memory key.
 *
 * @param file Local file being uploaded.
 * @param idempotencyKey Generated UUID for the creation request.
 * @param storage Browser storage instance or null.
 */
function savePendingUploadCreation(
  file: File,
  idempotencyKey: string,
  storage: Storage | null,
): void {
  if (!storage || !hasCookieConsent("functional")) return;
  const record: PendingUploadCreation = {
    createdAt: Date.now(),
    file: fingerprint(file),
    idempotencyKey,
    version: 1,
  };
  try {
    storage.setItem(pendingCreateStorageKey(file), JSON.stringify(record));
  } catch {
    // Storage quota exceeded or disabled; ignore.
  }
}

/**
 * Removes pending upload creation state after server acknowledgement; deletion
 * remains permitted after consent withdrawal.
 *
 * @param file Local file being uploaded.
 * @param storage Browser storage instance or null.
 */
function discardPendingUploadCreation(file: File, storage: Storage | null): void {
  storage?.removeItem(pendingCreateStorageKey(file));
}

/**
 * Type guard asserting whether an object conforms to the `ResumableUpload` schema.
 *
 * @param value Arbitrary value from storage.
 * @returns `true` if the value conforms to the schema.
 */
function isResumableUpload(value: unknown): value is ResumableUpload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.assetId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.expiresAt === "string" &&
    Array.isArray(record.completedParts) &&
    typeof record.file === "object" &&
    record.file !== null
  );
}

/**
 * Lists resumable upload records only after functional consent, sorted by expiry.
 * @param storage Browser storage instance or null.
 * @returns Array of active resumable upload records.
 */
export function listResumableUploads(
  storage: Storage | null = browserStorage(),
): ResumableUpload[] {
  if (!storage || !hasCookieConsent("functional")) return [];
  const records: ResumableUpload[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(resumeKeyPrefix)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isResumableUpload(parsed)) records.push(parsed);
    } catch {
      // Ignore malformed records.
    }
  }
  return records.sort((left, right) => right.expiresAt.localeCompare(left.expiresAt));
}

/**
 * Removes a resumable upload record by session ID; removal is allowed after consent withdrawal.
 * @param sessionId Upload session ID.
 * @param storage Browser storage instance or null.
 */
function discardResumableUpload(
  sessionId: string,
  storage: Storage | null = browserStorage(),
): void {
  storage?.removeItem(`${resumeKeyPrefix}${sessionId}`);
}

/**
 * Persists an active resumable upload record only while functional consent is
 * enabled; the upload continues if recovery storage is unavailable.
 * @param record Upload session state to persist.
 * @param storage Browser storage instance or null.
 */
function saveResumableUpload(record: ResumableUpload, storage: Storage | null): void {
  if (storage && hasCookieConsent("functional")) {
    storage.setItem(`${resumeKeyPrefix}${record.sessionId}`, JSON.stringify(record));
  }
}

/**
 * Constructs the standard `CreateUploadSessionInput` payload from a local `File` object.
 *
 * @param file Local file selected by the user.
 * @param brandProfileId Active Brand Profile UUID that will own the uploaded Asset.
 * @returns Input payload for the create upload session API.
 */
function sessionInput(file: File, brandProfileId: string): CreateUploadSessionInput {
  const isVideo = file.type.startsWith("video/");
  return {
    asset_type: isVideo ? "video" : "image",
    brand_profile_id: brandProfileId,
    content_type: file.type,
    file_size: file.size,
    filename: file.name,
    title: file.name.replace(/\.[^.]+$/, "") || file.name,
  };
}

/**
 * Executes an HTTP PUT request using XMLHttpRequest to upload a binary blob directly to
 * signed R2/S3 storage, tracking transfer progress and capturing returned ETag headers.
 *
 * Lifted into `Effect.callback` so fiber interruption aborts the in-flight XHR
 * through the returned cleanup effect; the callback's own `signal` is unused
 * because `xhr.abort()` is the actual cancellation mechanism.
 *
 * @param request Signed upload descriptor with target URL and pre-signed headers.
 * @param body Binary payload (full file or multipart chunk).
 * @param onProgress Callback receiving total bytes loaded so far.
 * @param track Registration hook allowing callers to cancel or abort in-flight requests.
 * @returns Effect resolving to the response ETag header value, or `null` if omitted.
 */
function sendSignedRequest(
  request: SignedRequest | SignedPart,
  body: Blob,
  onProgress: (loaded: number) => void,
  track: (xhr: XMLHttpRequest | null) => void,
): Effect.Effect<string | null, DirectUploadError> {
  return Effect.callback<string | null, DirectUploadError>((resume) => {
    const xhr = new XMLHttpRequest();
    track(xhr);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      track(null);
      if (xhr.status < 200 || xhr.status >= 300) {
        resume(
          Effect.fail(new DirectUploadError(`Upload failed with status ${xhr.status}`, xhr.status)),
        );
        return;
      }
      onProgress(body.size);
      resume(Effect.succeed(xhr.getResponseHeader("ETag")));
    };
    xhr.onerror = () => {
      track(null);
      resume(Effect.fail(new DirectUploadError("Upload failed because of a network error", null)));
    };
    xhr.onabort = () => {
      track(null);
      resume(Effect.fail(new DirectUploadError("Upload was interrupted", null)));
    };
    xhr.open(request.method, request.url);
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.toLowerCase() !== "content-length") {
        xhr.setRequestHeader(name, value);
      }
    }
    xhr.send(body);
    return Effect.sync(() => {
      xhr.abort();
      track(null);
    });
  });
}

/**
 * Stateful browser controller managing resilient single-part or multipart asset uploads.
 * Handles pause/resume, automatic network offline/online recovery, URL expiration refreshes,
 * and consent-gated optional local recovery state.
 *
 * The upload lifecycle is an Effect program executed through the approved
 * `runQueryEffect` boundary: `cancel()` aborts an `AbortController` whose signal
 * interrupts the program fiber, which in turn aborts in-flight XHRs via
 * `Effect.callback` cleanup and unblocks paused waiters. Upload operations remain
 * available without functional consent; recovery storage is rechecked on access
 * and stops immediately when consent is withdrawn.
 */
class BrowserAssetUploadTask implements AssetUploadTask {
  readonly result: Promise<Asset>;
  readonly #abortController = new AbortController();
  readonly #activeRequests = new Set<XMLHttpRequest>();
  readonly #api: UploadApi;
  readonly #file: File;
  readonly #onProgress: (percent: number) => void;
  readonly #onSessionStart: (assetId: string) => void;
  readonly #onStatusChange: (status: AssetUploadStatus) => void;
  readonly #resumeSessionId?: string;
  readonly #providedStorage: Storage | null | undefined;
  readonly #workspaceId: string | null;
  readonly #brandProfileId: string;
  readonly #waiters = new Set<() => void>();
  #cancelled = false;
  #manualPause = false;
  #offline = false;
  #serverAbort?: Promise<void>;
  #sessionId?: string;

  /**
   * Initializes the upload task, sets up browser online/offline listeners, and kicks off
   * the Effect upload program through the `runQueryEffect` boundary.
   *
   * @param options Task configuration including file, workspace selection, and event callbacks.
   */
  constructor(options: UploadAssetFileOptions) {
    this.#api = options.api ?? defaultApi;
    this.#file = options.file;
    this.#onProgress = options.onProgress ?? (() => undefined);
    this.#onStatusChange = options.onStatusChange ?? (() => undefined);
    this.#onSessionStart = options.onSessionStart ?? (() => undefined);
    this.#resumeSessionId = options.resumeSessionId;
    this.#providedStorage = options.storage;
    this.#workspaceId = options.workspaceId;
    this.#brandProfileId = options.brandProfileId;
    this.#offline = typeof navigator !== "undefined" && navigator.onLine === false;
    if (typeof window !== "undefined") {
      window.addEventListener("offline", this.#handleOffline);
      window.addEventListener("online", this.#handleOnline);
    }
    this.result = runQueryEffect(this.#program(), {
      signal: this.#abortController.signal,
    })
      .catch(async (cause: unknown) => {
        if (this.#cancelled || cause instanceof UploadCancelledError) {
          if (this.#sessionId) await this.cancel();
          this.#status("cancelled");
          throw cause instanceof UploadCancelledError ? cause : new UploadCancelledError();
        }
        this.#status("failed");
        throw cause;
      })
      .finally(() => {
        if (typeof window !== "undefined") {
          window.removeEventListener("offline", this.#handleOffline);
          window.removeEventListener("online", this.#handleOnline);
        }
      });
  }

  /**
   * Resolves optional recovery storage at each access, so in-flight uploads
   * immediately stop using it after withdrawal and can use it after acceptance.
   *
   * @returns The explicit storage override or consented browser localStorage.
   */
  #storageForAccess(): Storage | null {
    if (!hasCookieConsent("functional")) return null;
    return this.#providedStorage === undefined ? browserStorage() : this.#providedStorage;
  }

  /**
   * Manually pauses the upload task, aborting any active XHR transfers and updating status to 'paused'.
   */
  pause(): void {
    if (this.#cancelled || this.#manualPause) return;
    this.#manualPause = true;
    this.#abortActiveRequests();
    this.#status("paused");
  }

  /**
   * Resumes an upload that was paused manually, waking pending workers and updating status.
   */
  resume(): void {
    if (this.#cancelled || !this.#manualPause) return;
    this.#manualPause = false;
    this.#wake();
    this.#status(this.#offline ? "offline" : "uploading");
  }

  /**
   * Cancels the upload task: interrupts the Effect program fiber (which aborts
   * in-flight XHRs and wakes paused waiters), removes the local resume record,
   * and notifies the API to abort the server-side session.
   *
   * @returns Promise that resolves once server abort notifications complete.
   */
  async cancel(): Promise<void> {
    if (!this.#cancelled) {
      this.#cancelled = true;
      this.#abortController.abort(new UploadCancelledError());
      this.#abortActiveRequests();
      this.#wake();
    }
    if (this.#sessionId && !this.#serverAbort) {
      discardResumableUpload(this.#sessionId, this.#storageForAccess());
      this.#serverAbort = runQueryEffect(
        this.#api.abortUploadSession(this.#workspaceId, this.#sessionId, {
          idempotencyKey: `upload-abort-${this.#sessionId}`,
        }),
      ).then(
        () => undefined,
        () => undefined,
      );
      await this.#serverAbort;
    }
    this.#status("cancelled");
  }

  /**
   * Browser event listener invoked when network connectivity is lost, pausing in-flight requests.
   */
  readonly #handleOffline = () => {
    if (this.#cancelled) return;
    this.#offline = true;
    this.#abortActiveRequests();
    this.#status("offline");
  };

  /**
   * Browser event listener invoked when network connectivity is restored, waking blocked workers.
   */
  readonly #handleOnline = () => {
    if (this.#cancelled) return;
    this.#offline = false;
    this.#wake();
    this.#status(this.#manualPause ? "paused" : "uploading");
  };

  /**
   * Emits status transition events to the configured task subscriber.
   *
   * @param status Current lifecycle state of the upload task.
   */
  #status(status: AssetUploadStatus): void {
    this.#onStatusChange(status);
  }

  /**
   * Aborts all active XMLHttpRequest instances registered in the task and clears the tracking set.
   */
  #abortActiveRequests(): void {
    for (const xhr of this.#activeRequests) xhr.abort();
    this.#activeRequests.clear();
  }

  /**
   * Tracks active XMLHttpRequest instances or removes completed ones from the active set.
   *
   * @param xhr Active XMLHttpRequest instance, or `null` when a request completes.
   */
  #registerRequest(xhr: XMLHttpRequest | null): void {
    if (xhr) this.#activeRequests.add(xhr);
    else {
      for (const candidate of this.#activeRequests) {
        if (candidate.readyState === XMLHttpRequest.DONE) {
          this.#activeRequests.delete(candidate);
        }
      }
    }
  }

  /**
   * Resolves and clears all pending waiters blocked on pause/offline conditions.
   */
  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  /**
   * Effect that suspends while the task is paused or offline, resuming when a
   * waiter fires, and fails with the sibling stop reason or
   * `UploadCancelledError` when the task can no longer proceed.
   *
   * @param stop Optional callback to inspect sibling failure state.
   * @returns Effect resolving once the task may run, or failing with the stop reason.
   */
  #waitUntilRunnable(stop?: UploadStopReader): Effect.Effect<void, unknown> {
    const loop = (): Effect.Effect<void, unknown> => {
      const state = stop?.();
      if (state?.stopped && state.reason) return Effect.failCause(state.reason);
      if (this.#cancelled) return Effect.fail(new UploadCancelledError());
      if (!this.#manualPause && !this.#offline) return Effect.void;
      return Effect.callback<void, unknown>((resume) => {
        const waiter = () => resume(Effect.void);
        this.#waiters.add(waiter);
        return Effect.sync(() => {
          this.#waiters.delete(waiter);
        });
      }).pipe(Effect.andThen(() => loop()));
    };
    return Effect.suspend(loop);
  }

  /**
   * Executes a direct binary upload with automatic exponential backoff retry and URL refresh on expiry.
   *
   * Runs inside the Effect runtime: `Effect.sleep` backoff is interruptible by
   * task cancellation, and each attempt re-checks pause/offline state through
   * `#waitUntilRunnable` before touching the network.
   *
   * @param initialRequest Initial signed upload request or part descriptor.
   * @param refreshRequest Effect returning refreshed signed parameters if expired or failed.
   * @param body Payload chunk or complete file blob.
   * @param onProgress Callback receiving cumulative uploaded bytes for this transfer.
   * @param stop Optional callback inspecting sibling failure states.
   * @returns Effect resolving to the uploaded asset/part ETag.
   */
  #sendWithRetry(
    initialRequest: SignedRequest | SignedPart,
    refreshRequest: () => Effect.Effect<SignedRequest | SignedPart, unknown>,
    body: Blob,
    onProgress: (loaded: number) => void,
    stop?: UploadStopReader,
  ): Effect.Effect<string | null, unknown> {
    const loop = (
      request: SignedRequest | SignedPart,
      attempt: number,
      refreshedForExpiry: boolean,
    ): Effect.Effect<string | null, unknown> =>
      this.#waitUntilRunnable(stop).pipe(
        Effect.andThen(() => {
          if (!refreshedForExpiry && new Date(request.expires_at).getTime() <= Date.now() + 5_000) {
            return Effect.flatMap(refreshRequest(), (refreshed) => {
              const state = stop?.();
              if (state?.stopped && state.reason) return Effect.failCause(state.reason);
              return loop(refreshed, attempt, true);
            });
          }
          return Effect.flatMap(
            Effect.exit(
              sendSignedRequest(request, body, onProgress, (xhr) => this.#registerRequest(xhr)),
            ),
            (exit) => {
              if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
              const state = stop?.();
              if (state?.stopped && state.reason) return Effect.failCause(state.reason);
              if (this.#cancelled) return Effect.fail(new UploadCancelledError());
              if (this.#manualPause || this.#offline) {
                onProgress(0);
                return loop(request, attempt, refreshedForExpiry);
              }
              const nextAttempt = attempt + 1;
              if (nextAttempt >= maximumUploadAttempts) return Effect.failCause(exit.cause);
              onProgress(0);
              return Effect.sleep(250 * 2 ** (nextAttempt - 1)).pipe(
                Effect.andThen(() => this.#waitUntilRunnable(stop)),
                Effect.andThen(() =>
                  Effect.flatMap(refreshRequest(), (refreshed) => {
                    const refreshedState = stop?.();
                    if (refreshedState?.stopped && refreshedState.reason)
                      return Effect.failCause(refreshedState.reason);
                    return loop(refreshed, nextAttempt, true);
                  }),
                ),
              );
            },
          );
        }),
      );

    return Effect.suspend(() => loop(initialRequest, 0, false));
  }

  /**
   * Executes a single-shot PUT upload for files smaller than the multipart threshold.
   *
   * @param session Active upload session with single upload signed URL.
   * @returns Effect resolving once the file body is uploaded.
   */
  #singleUpload(session: UploadSession): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      const initial = session.single_upload;
      if (!initial) {
        return Effect.fail(new Error("The upload session omitted its signed upload request"));
      }
      let request = initial;
      const refresh = () =>
        Effect.flatMap(this.#api.getUploadSession(this.#workspaceId, session.id), (detail) => {
          if (!detail.upload_session.single_upload) {
            return Effect.fail(
              new Error("The refreshed upload session omitted its signed request"),
            );
          }
          request = detail.upload_session.single_upload;
          return Effect.succeed(request);
        });
      return this.#sendWithRetry(request, refresh, this.#file, (loaded) => {
        this.#onProgress(Math.min(100, Math.round((loaded / this.#file.size) * 100)));
      });
    });
  }

  /**
   * Executes a parallel multipart upload, slicing the file into chunks, requesting pre-signed part URLs,
   * uploading chunks up to `max_parallel_parts`, and recording completed ETags.
   *
   * Part workers run as forked child fibers bounded by `max_parallel_parts`. A
   * sibling failure records the stop state, aborts in-flight XHRs, and wakes
   * waiters so the other workers unwind; `Fiber.awaitAll` then lets the
   * original failure (not an interrupt) surface as the program's error.
   *
   * @param session Active upload session containing multipart configuration.
   * @param completedParts Previously completed parts if resuming.
   * @param persist Callback to persist progress updates to local storage.
   * @returns Effect resolving to all completed parts with ETags sorted by part number.
   */
  #multipartUpload(
    session: UploadSession,
    completedParts: CompletedPart[],
    persist: (parts: CompletedPart[]) => void,
  ): Effect.Effect<CompletedPart[], unknown> {
    return Effect.gen(
      function* (this: BrowserAssetUploadTask) {
        const multipart = session.multipart;
        if (!multipart) {
          return yield* Effect.fail(new Error("The upload session omitted multipart instructions"));
        }
        const completed = new Map(completedParts.map((part) => [part.part_number, part]));
        const loadedByPart = new Map<number, number>();
        for (const partNumber of completed.keys()) {
          loadedByPart.set(
            partNumber,
            Math.min(multipart.part_size, this.#file.size - (partNumber - 1) * multipart.part_size),
          );
        }
        const reportProgress = (partNumber: number, loaded: number) => {
          loadedByPart.set(partNumber, loaded);
          const totalLoaded = [...loadedByPart.values()].reduce((sum, value) => sum + value, 0);
          this.#onProgress(Math.min(100, Math.round((totalLoaded / this.#file.size) * 100)));
        };
        reportProgress(0, 0);

        const missing = Array.from(
          { length: multipart.part_count },
          (_, index) => index + 1,
        ).filter((partNumber) => !completed.has(partNumber));
        const signedParts: SignedPart[] = [];
        for (let index = 0; index < missing.length; index += maximumPartUrlBatch) {
          const partNumbers = missing.slice(index, index + maximumPartUrlBatch);
          const response = yield* this.#api.createUploadPartUrls(
            this.#workspaceId,
            session.id,
            { part_numbers: partNumbers },
            {
              idempotencyKey: `upload-parts-${session.id}-${partNumbers[0]}-${partNumbers.at(-1)}`,
            },
          );
          signedParts.push(...response.parts);
        }

        let nextPartIndex = 0;
        const stopState: UploadStopState = { stopped: false };
        const stop = () => stopState;
        const failSiblings = (cause: Cause.Cause<unknown>) => {
          if (stopState.stopped) return;
          stopState.reason = cause;
          stopState.stopped = true;
          this.#abortActiveRequests();
          this.#wake();
        };
        const worker: Effect.Effect<void, unknown> = Effect.suspend(() => {
          const loop = (): Effect.Effect<void, unknown> => {
            if (stopState.stopped) return Effect.void;
            const signedPart = signedParts[nextPartIndex++];
            if (!signedPart) return Effect.void;
            const start = (signedPart.part_number - 1) * multipart.part_size;
            const body = this.#file.slice(
              start,
              Math.min(this.#file.size, start + multipart.part_size),
            );
            const refresh = () =>
              Effect.flatMap(
                this.#api.createUploadPartUrls(
                  this.#workspaceId,
                  session.id,
                  { part_numbers: [signedPart.part_number] },
                  {
                    idempotencyKey: `upload-part-refresh-${session.id}-${signedPart.part_number}-${createMutationKey()}`,
                  },
                ),
                (response) => {
                  const refreshed = response.parts[0];
                  if (!refreshed) {
                    return Effect.fail(new Error("The part URL refresh returned no URL"));
                  }
                  return Effect.succeed(refreshed);
                },
              );
            return this.#sendWithRetry(
              signedPart,
              refresh,
              body,
              (loaded) => reportProgress(signedPart.part_number, loaded),
              stop,
            ).pipe(
              Effect.andThen((etag) => {
                if (!etag) {
                  return Effect.fail(
                    new Error(`Upload part ${signedPart.part_number} did not return an ETag`),
                  );
                }
                completed.set(signedPart.part_number, {
                  etag,
                  part_number: signedPart.part_number,
                });
                persist(
                  [...completed.values()].sort(
                    (left, right) => left.part_number - right.part_number,
                  ),
                );
                return loop();
              }),
            );
          };
          return loop().pipe(
            Effect.catchCause((cause) => {
              failSiblings(cause);
              return Effect.failCause(cause);
            }),
          );
        });

        const parallelism = Math.min(multipart.max_parallel_parts, signedParts.length);
        const fibers = yield* Effect.forEach(
          Array.from({ length: parallelism }, () => worker),
          (unit) => Effect.forkChild(unit),
        );
        yield* Fiber.awaitAll(fibers);
        if (stopState.stopped && stopState.reason) return yield* Effect.failCause(stopState.reason);
        return [...completed.values()].sort((left, right) => left.part_number - right.part_number);
      }.bind(this),
    );
  }

  /**
   * Retrieves an existing upload session when resuming, or provisions a new upload session via the API.
   * Persists optional recovery data only while functional consent is enabled, then
   * notifies `onSessionStart` with the durable Asset id so callers can track an
   * upload that is still transferring bytes even when browser recovery is disabled.
   *
   * @returns Effect resolving to the upload session detail response and initialized resumable upload record.
   */
  #loadSession(): Effect.Effect<
    {
      detail: UploadSessionDetailResponse | UploadSessionResponse;
      record: ResumableUpload;
    },
    unknown
  > {
    return Effect.gen(
      function* (this: BrowserAssetUploadTask) {
        this.#status(this.#resumeSessionId ? "uploading" : "creating");
        let detail: UploadSessionDetailResponse | UploadSessionResponse;
        if (this.#resumeSessionId) {
          const existing = listResumableUploads(this.#storageForAccess()).find(
            (record) => record.sessionId === this.#resumeSessionId,
          );
          if (!existing || !matchesResumableFile(existing, this.#file)) {
            return yield* Effect.fail(
              new Error("Select the same local file to resume this upload"),
            );
          }
          detail = yield* this.#api.getUploadSession(this.#workspaceId, this.#resumeSessionId);
        } else {
          const pending = pendingUploadCreation(this.#file, this.#storageForAccess());
          const idempotencyKey = pending?.idempotencyKey ?? `upload-create-${createMutationKey()}`;
          if (!pending) {
            savePendingUploadCreation(this.#file, idempotencyKey, this.#storageForAccess());
          }
          detail = yield* this.#api.createUploadSession(
            this.#workspaceId,
            sessionInput(this.#file, this.#brandProfileId),
            {
              idempotencyKey,
            },
          );
        }
        const session = detail.upload_session;
        if (session.file_size !== this.#file.size || session.content_type !== this.#file.type) {
          return yield* Effect.fail(
            new Error("The selected file does not match the upload session"),
          );
        }
        const local = listResumableUploads(this.#storageForAccess()).find(
          (candidate) => candidate.sessionId === session.id,
        );
        const serverParts =
          "uploaded_parts" in detail
            ? detail.uploaded_parts.map((part) => ({
                etag: part.etag,
                part_number: part.part_number,
              }))
            : [];
        const record: ResumableUpload = {
          assetId: session.asset_id,
          completedParts:
            local && matchesResumableFile(local, this.#file) ? local.completedParts : serverParts,
          expiresAt: session.expires_at,
          file: fingerprint(this.#file),
          sessionId: session.id,
          strategy: session.strategy,
          version: 1,
        };
        saveResumableUpload(record, this.#storageForAccess());
        try {
          // Subscriber failures are ignored — a synchronous throw lands in the
          // catch, and a callback that returns a rejected promise (legal for a
          // `(assetId) => void` subscriber) is swallowed by the trailing
          // `.catch` so it can never fail or cancel the upload.
          void Promise.resolve(this.#onSessionStart(session.asset_id)).catch(() => undefined);
        } catch {
          // Ignored per the contract documented on `onSessionStart`.
        }
        if (!this.#resumeSessionId) {
          discardPendingUploadCreation(this.#file, this.#storageForAccess());
        }
        return { detail, record };
      }.bind(this),
    );
  }

  /**
   * The complete upload lifecycle as an Effect program: session setup, file
   * transfer, and completion, with status transitions emitted at each step.
   * Typed failures mark the task `failed` (or `cancelled` for
   * `UploadCancelledError`); fiber interruption marks it `cancelled`.
   *
   * @returns Effect resolving to the finalized `Asset` record.
   */
  #program(): Effect.Effect<Asset, unknown> {
    return Effect.gen(
      function* (this: BrowserAssetUploadTask) {
        const { detail, record } = yield* this.#loadSession();
        const session = detail.upload_session;
        this.#sessionId = session.id;
        yield* this.#waitUntilRunnable();
        this.#status("uploading");
        let parts: CompletedPart[] | undefined;
        if (session.strategy === "single") {
          yield* this.#singleUpload(session);
        } else {
          parts = yield* this.#multipartUpload(session, record.completedParts, (completedParts) => {
            record.completedParts = completedParts;
            saveResumableUpload(record, this.#storageForAccess());
          });
        }
        yield* this.#waitUntilRunnable();
        this.#status("completing");
        const asset = yield* this.#api.completeUploadSession(
          this.#workspaceId,
          session.id,
          parts ? { parts } : {},
          { idempotencyKey: `upload-complete-${session.id}` },
        );
        discardResumableUpload(session.id, this.#storageForAccess());
        this.#status(asset.status === "processing" ? "processing" : "complete");
        return asset;
      }.bind(this),
    ).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          this.#status(error instanceof UploadCancelledError ? "cancelled" : "failed");
        }),
      ),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          this.#status("cancelled");
        }),
      ),
    );
  }
}

/**
 * Factory creating an `AssetUploadTask` instance to handle managed file uploads with pause/resume support.
 *
 * @param options Upload options including the file, workspace selection, and progress listeners.
 * @returns Configured asset upload task.
 */
export function createAssetUpload(options: UploadAssetFileOptions): AssetUploadTask {
  return new BrowserAssetUploadTask(options);
}

/**
 * Convenience helper that initiates an upload task and returns its resulting `Asset` promise.
 *
 * @param options Upload options including the file, workspace selection, and progress listeners.
 * @returns Resolves with the completed or processing asset.
 */
export function uploadAssetFile(options: UploadAssetFileOptions): Promise<Asset> {
  return createAssetUpload(options).result;
}
