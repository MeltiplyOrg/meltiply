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

const filenameExtensionPattern = /\.[^.]+$/;

type SignedRequest = NonNullable<UploadSession["single_upload"]>;
type SignedPart = CreateUploadPartsResponse["parts"][number];

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
  brandProfileId: string;
  file: File;
  onProgress?: (percent: number) => void;
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

interface UploadOwner {
  brandProfileId: string;
  workspaceId: string | null;
}

interface PendingUploadCreation extends UploadOwner {
  createdAt: number;
  file: FileFingerprint;
  idempotencyKey: string;
  version: 1;
}

function browserStorage(): Storage | null {
  if (!hasCookieConsent("functional")) return null;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function fingerprint(file: File): FileFingerprint {
  return {
    lastModified: file.lastModified,
    name: file.name,
    size: file.size,
    type: file.type,
  };
}

function matchesFileFingerprint(candidate: FileFingerprint, file: File): boolean {
  return (
    candidate.lastModified === file.lastModified &&
    candidate.name === file.name &&
    candidate.size === file.size &&
    candidate.type === file.type
  );
}

function isFileFingerprint(value: unknown): value is FileFingerprint {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.lastModified === "number" &&
    typeof record.name === "string" &&
    typeof record.size === "number" &&
    typeof record.type === "string"
  );
}

function isCompletedPart(value: unknown): value is CompletedPart {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.etag === "string" && typeof record.part_number === "number";
}

function pendingCreateStorageKey(file: File): string {
  return `${pendingCreateKeyPrefix}${encodeURIComponent(JSON.stringify(fingerprint(file)))}`;
}

function isPendingUploadCreation(value: unknown): value is PendingUploadCreation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.brandProfileId === "string" &&
    (typeof record.workspaceId === "string" || record.workspaceId === null) &&
    typeof record.createdAt === "number" &&
    typeof record.idempotencyKey === "string" &&
    isFileFingerprint(record.file)
  );
}

function pendingUploadCreation(
  file: File,
  owner: UploadOwner,
  storage: Storage | null,
): PendingUploadCreation | null {
  if (!storage || !hasCookieConsent("functional")) return null;
  const key = pendingCreateStorageKey(file);
  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isPendingUploadCreation(parsed) ||
      parsed.brandProfileId !== owner.brandProfileId ||
      parsed.workspaceId !== owner.workspaceId ||
      Date.now() - parsed.createdAt > pendingCreateMaxAgeMs
    ) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function savePendingUploadCreation(
  file: File,
  owner: UploadOwner,
  idempotencyKey: string,
  storage: Storage | null,
): void {
  if (!storage || !hasCookieConsent("functional")) return;
  const record: PendingUploadCreation = {
    ...owner,
    createdAt: Date.now(),
    file: fingerprint(file),
    idempotencyKey,
    version: 1,
  };
  try {
    storage.setItem(pendingCreateStorageKey(file), JSON.stringify(record));
  } catch {
    return;
  }
}

function discardPendingUploadCreation(file: File, storage: Storage | null): void {
  storage?.removeItem(pendingCreateStorageKey(file));
}

function isResumableUpload(value: unknown): value is ResumableUpload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.assetId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.expiresAt === "string" &&
    (record.strategy === "single" || record.strategy === "multipart") &&
    Array.isArray(record.completedParts) &&
    record.completedParts.every(isCompletedPart) &&
    isFileFingerprint(record.file)
  );
}

export function listResumableUploads(
  storage: Storage | null = browserStorage(),
): ResumableUpload[] {
  if (!storage || !hasCookieConsent("functional")) return [];
  const records: ResumableUpload[] = [];
  const expiredKeys: string[] = [];
  const now = Date.now();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(resumeKeyPrefix)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isResumableUpload(parsed)) continue;
      const expiresAtMs = Date.parse(parsed.expiresAt);
      if (Number.isNaN(expiresAtMs) || expiresAtMs <= now) {
        expiredKeys.push(key);
        continue;
      }
      records.push(parsed);
    } catch {
      continue;
    }
  }
  for (const key of expiredKeys) storage.removeItem(key);
  return records.sort((left, right) => right.expiresAt.localeCompare(left.expiresAt));
}

function discardResumableUpload(
  sessionId: string,
  storage: Storage | null = browserStorage(),
): void {
  storage?.removeItem(`${resumeKeyPrefix}${sessionId}`);
}

function saveResumableUpload(record: ResumableUpload, storage: Storage | null): void {
  if (storage && hasCookieConsent("functional")) {
    storage.setItem(`${resumeKeyPrefix}${record.sessionId}`, JSON.stringify(record));
  }
}

function sessionInput(file: File, brandProfileId: string): CreateUploadSessionInput {
  const isVideo = file.type.startsWith("video/");
  return {
    asset_type: isVideo ? "video" : "image",
    brand_profile_id: brandProfileId,
    content_type: file.type,
    file_size: file.size,
    filename: file.name,
    title: file.name.replace(filenameExtensionPattern, "") || file.name,
  };
}

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

  #storageForAccess(): Storage | null {
    if (!hasCookieConsent("functional")) return null;
    return this.#providedStorage === undefined ? browserStorage() : this.#providedStorage;
  }

  pause(): void {
    if (this.#cancelled || this.#manualPause) return;
    this.#manualPause = true;
    this.#abortActiveRequests();
    this.#status("paused");
  }

  resume(): void {
    if (this.#cancelled || !this.#manualPause) return;
    this.#manualPause = false;
    this.#wake();
    this.#status(this.#offline ? "offline" : "uploading");
  }

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

  readonly #handleOffline = () => {
    if (this.#cancelled) return;
    this.#offline = true;
    this.#abortActiveRequests();
    this.#status("offline");
  };

  readonly #handleOnline = () => {
    if (this.#cancelled) return;
    this.#offline = false;
    this.#wake();
    this.#status(this.#manualPause ? "paused" : "uploading");
  };

  #status(status: AssetUploadStatus): void {
    this.#onStatusChange(status);
  }

  #abortActiveRequests(): void {
    for (const xhr of this.#activeRequests) xhr.abort();
    this.#activeRequests.clear();
  }

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

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

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

  #sendWithRetry(
    initialRequest: SignedRequest | SignedPart,
    refreshRequest: (attempt: number) => Effect.Effect<SignedRequest | SignedPart, unknown>,
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
            return Effect.flatMap(refreshRequest(attempt), (refreshed) => {
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
                  Effect.flatMap(refreshRequest(nextAttempt), (refreshed) => {
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
            const refresh = (attempt: number) =>
              Effect.flatMap(
                this.#api.createUploadPartUrls(
                  this.#workspaceId,
                  session.id,
                  { part_numbers: [signedPart.part_number] },
                  {
                    idempotencyKey: `upload-part-refresh-${session.id}-${signedPart.part_number}-${attempt}`,
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
          if (!existing || !matchesFileFingerprint(existing.file, this.#file)) {
            return yield* Effect.fail(
              new Error("Select the same local file to resume this upload"),
            );
          }
          detail = yield* this.#api.getUploadSession(this.#workspaceId, this.#resumeSessionId);
        } else {
          const owner = { brandProfileId: this.#brandProfileId, workspaceId: this.#workspaceId };
          const pending = pendingUploadCreation(this.#file, owner, this.#storageForAccess());
          const idempotencyKey = pending?.idempotencyKey ?? `upload-create-${createMutationKey()}`;
          if (!pending) {
            savePendingUploadCreation(this.#file, owner, idempotencyKey, this.#storageForAccess());
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
            local && matchesFileFingerprint(local.file, this.#file)
              ? local.completedParts
              : serverParts,
          expiresAt: session.expires_at,
          file: fingerprint(this.#file),
          sessionId: session.id,
          strategy: session.strategy,
          version: 1,
        };
        saveResumableUpload(record, this.#storageForAccess());
        this.#notifySessionStart(session.asset_id);
        if (!this.#resumeSessionId) {
          discardPendingUploadCreation(this.#file, this.#storageForAccess());
        }
        return { detail, record };
      }.bind(this),
    );
  }

  #notifySessionStart(assetId: string): void {
    try {
      void Promise.resolve(this.#onSessionStart(assetId)).catch(() => undefined);
    } catch {
      return;
    }
  }

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
    );
  }
}

export function createAssetUpload(options: UploadAssetFileOptions): AssetUploadTask {
  return new BrowserAssetUploadTask(options);
}

export function uploadAssetFile(options: UploadAssetFileOptions): Promise<Asset> {
  return createAssetUpload(options).result;
}
