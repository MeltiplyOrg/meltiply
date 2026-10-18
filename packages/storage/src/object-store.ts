import { Effect } from "effect";
import { InvalidRequestError, NotFoundError, StorageUnavailableError } from "@meltiply/domain";

export interface ObjectMetadata {
  contentType: string | null;
  /** User metadata the provider exposes alongside the object; promotion copies carry the source provenance here. */
  customMetadata?: Record<string, string> | null;
  etag: string;
  key: string;
  /** Hex SHA-256 digest reported for the object; absent unless the write carried a checksum. */
  sha256?: string | null;
  size: number;
  uploadedAt: Date;
  /** Immutable object version reported by the provider; absent on S3 without versioning. */
  version?: string | null;
}

/**
 * Whole-object read result: the streaming body plus the physical facts a caller
 * must forward when relaying the object (Content-Length and Content-Type).
 */
export interface ObjectBody {
  body: ReadableStream;
  contentType: string | null;
  size: number;
}

export interface MultipartUpload {
  abort(): Promise<void>;
  complete(parts: readonly UploadedPart[]): Promise<ObjectMetadata>;
  uploadPart(
    partNumber: number,
    value: ArrayBuffer | ArrayBufferView | Blob,
  ): Promise<UploadedPart>;
  uploadId: string;
}

export interface UploadedPart {
  etag: string;
  partNumber: number;
}

export interface EffectMultipartUpload {
  readonly abort: () => Effect.Effect<void, StorageUnavailableError>;
  readonly complete: (
    parts: readonly UploadedPart[],
  ) => Effect.Effect<ObjectMetadata, StorageUnavailableError>;
  readonly uploadId: string;
  readonly uploadPart: (
    partNumber: number,
    value: ArrayBuffer | ArrayBufferView | Blob,
  ) => Effect.Effect<UploadedPart, StorageUnavailableError | InvalidRequestError>;
}

export interface ObjectStore {
  /**
   * Copies an object inside the bucket without buffering it in the worker.
   *
   * The source read is conditional (`ifSourceEtagMatches`) so a stale or
   * rewritten staging object can never be promoted, and the destination write
   * is conditional (`ifDestinationAbsent`) so a replayed copy adopts the object
   * a previous attempt already wrote instead of duplicating work.
   *
   * Required rather than optional: promoting verified upload bytes out of the
   * staging namespace is the store's core job, so a store that cannot copy
   * cannot fulfill the contract and must fail at wiring time instead of
   * silently skipping the promotion step.
   *
   * @param sourceKey - Existing source object key.
   * @param destinationKey - Destination object key; never written when present.
   * @param options - `ifSourceEtagMatches` conditional source ETag, `contentType` written metadata, `ifDestinationAbsent` guards the destination.
   * @returns Metadata of the copied object, or `null` when the source ETag did not match or the destination already exists.
   */
  copyObject(
    sourceKey: string,
    destinationKey: string,
    options?: {
      contentType?: string;
      ifDestinationAbsent?: boolean;
      ifSourceEtagMatches?: string;
    },
  ): Promise<ObjectMetadata | null>;
  createMultipartUpload(key: string, contentType: string): Promise<MultipartUpload>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<ObjectMetadata | null>;
  /**
   * Opens the whole object for streaming. Optional on the interface because
   * injected test doubles only implement what their scenario exercises; every
   * store the provider factory constructs implements it.
   */
  read?(key: string): Promise<ObjectBody | null>;
  readRange?(key: string, offset: number, maximumBytes: number): Promise<Uint8Array | null>;
  readPrefix(key: string, maximumBytes: number): Promise<Uint8Array | null>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}

export interface SignedObjectRequest {
  contentLength?: number;
  contentType?: string;
  downloadFilename?: string;
  /**
   * Absolute instant the signed URL must not outlive.
   *
   * The signer captures its own clock once at signing time and clamps
   * `expiresInSeconds` to the remaining time on this deadline, so a signature
   * computed late — after the caller paused — can never mint a URL that
   * outlives a deadline the caller already persisted (e.g. an
   * `asset_objects.write_hold_until`). An `expiresAt` that has already
   * elapsed when signing starts is rejected instead of being stretched into a
   * late grant.
   */
  expiresAt?: Date;
  expiresInSeconds: number;
  key: string;
}

export interface ObjectUrlSigner {
  signDownload(request: SignedObjectRequest): Promise<string>;
  signMultipartPart(request: SignedMultipartPartRequest): Promise<string>;
  signUpload(request: SignedUploadRequest): Promise<string>;
}

/**
 * Signer that can also mint the create-only exact-object write grant media
 * processing depends on.
 *
 * Kept separate from {@link ObjectUrlSigner} because a caller that only issues
 * browser capabilities has no use for it, and forcing an unused method on
 * injected signers would be noise.
 */
export interface ObjectWriteUrlSigner extends ObjectUrlSigner {
  signObjectWrite(request: SignedObjectWriteRequest): Promise<string>;
}

export type SignedUploadRequest = Required<
  Omit<SignedObjectRequest, "downloadFilename" | "expiresAt">
> &
  Pick<SignedObjectRequest, "expiresAt">;

export interface SignedMultipartPartRequest extends SignedUploadRequest {
  partNumber: number;
  uploadId: string;
}

/**
 * Exact-object write grant for objects whose size is unknown until they exist.
 *
 * Media processing output length is only known after the native engine runs, so
 * the grant binds method, key, and expiry but omits `content-length`; the
 * consumer must therefore verify the committed object's real size and checksum
 * before trusting it.
 */
export interface SignedObjectWriteRequest {
  /** Optional signed content type; omit when the writer picks the format. */
  contentType?: string;
  /**
   * Absolute instant the grant must not outlive. The signer clamps
   * `expiresInSeconds` to the time remaining on this deadline measured at
   * signing time and rejects an already-elapsed deadline, so a delayed
   * signature can never mint a write capability past a persisted
   * `asset_objects.write_hold_until`.
   */
  expiresAt?: Date;
  /** Presigned lifetime in seconds, between 1 and 604800. */
  expiresInSeconds: number;
  /** Exact object key the grant may write; no other key is reachable. */
  key: string;
  /**
   * Extra headers bound into the SigV4 signature, e.g.
   * `{ "if-none-match": "*" }` for a create-only output write. Names are
   * lowercased and canonicalized exactly like `content-type`/`content-length`;
   * `host` may not be overridden. Must be non-empty when present.
   */
  requiredHeaders?: Readonly<Record<string, string>>;
}

/**
 * Maps a store rejection onto the shared storage error taxonomy.
 *
 * `TypeError` and `RangeError` are raised by the stores themselves for
 * caller-supplied arguments (bad key segments, out-of-range reads), so they
 * are invalid requests; every other failure is infrastructure and stays
 * retryable as `StorageUnavailableError`.
 */
function toStorageError(
  cause: unknown,
  fallback: string,
): InvalidRequestError | StorageUnavailableError {
  const message = cause instanceof Error ? cause.message : fallback;
  if (cause instanceof TypeError || cause instanceof RangeError) {
    return new InvalidRequestError({ message });
  }
  return new StorageUnavailableError({ message });
}

/**
 * Adapts a Promise-based MultipartUpload handle into an EffectMultipartUpload handle.
 *
 * @param upload - Raw MultipartUpload handle from the storage driver.
 * @returns EffectMultipartUpload handle returning typed Effects.
 */
function wrapMultipartUpload(upload: MultipartUpload): EffectMultipartUpload {
  return {
    abort: () =>
      Effect.tryPromise({
        catch: (cause) =>
          new StorageUnavailableError({
            message: cause instanceof Error ? cause.message : "Failed to abort multipart upload",
          }),
        try: async () => upload.abort(),
      }),
    complete: (parts) =>
      Effect.tryPromise({
        catch: (cause) =>
          new StorageUnavailableError({
            message: cause instanceof Error ? cause.message : "Failed to complete multipart upload",
          }),
        try: async () => upload.complete(parts),
      }),
    uploadId: upload.uploadId,
    uploadPart: (partNumber, value) =>
      Effect.tryPromise({
        catch: (cause) => toStorageError(cause, "Failed to upload multipart part"),
        try: async () => upload.uploadPart(partNumber, value),
      }),
  };
}

/**
 * Shared Effect surface for every {@link ObjectStore} implementation.
 *
 * Provider adapters (R2 binding, S3 REST) only implement the Promise-based
 * `ObjectStore` contract; this base class derives the typed Effect operations
 * from it so error mapping, multipart wrapping, and NotFound semantics live in
 * exactly one place instead of being copied per provider.
 */
export abstract class EffectObjectStore implements ObjectStore {
  abstract copyObject(
    sourceKey: string,
    destinationKey: string,
    options?: {
      contentType?: string;
      ifDestinationAbsent?: boolean;
      ifSourceEtagMatches?: string;
    },
  ): Promise<ObjectMetadata | null>;
  abstract createMultipartUpload(key: string, contentType: string): Promise<MultipartUpload>;
  abstract delete(key: string): Promise<void>;
  abstract head(key: string): Promise<ObjectMetadata | null>;
  abstract read(key: string): Promise<ObjectBody | null>;
  abstract readRange(key: string, offset: number, maximumBytes: number): Promise<Uint8Array | null>;
  abstract readPrefix(key: string, maximumBytes: number): Promise<Uint8Array | null>;
  abstract resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;

  /**
   * Retrieves metadata for an object as a typed Effect, returning null if missing.
   *
   * @param key - Storage object key.
   * @returns Effect resolving to ObjectMetadata if found, or null.
   */
  headEffect(
    key: string,
  ): Effect.Effect<ObjectMetadata | null, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => toStorageError(cause, "Failed to query object metadata"),
      try: async () => this.head(key),
    });
  }

  /**
   * Retrieves metadata for an object as a typed Effect, failing with NotFoundError if not found.
   * Distinguishes non-existent objects from transient storage unavailability.
   *
   * @param key - Storage object key.
   * @returns Effect resolving to ObjectMetadata, or failing with NotFoundError.
   */
  getMetadataEffect(
    key: string,
  ): Effect.Effect<ObjectMetadata, NotFoundError | StorageUnavailableError | InvalidRequestError> {
    return this.headEffect(key).pipe(
      Effect.flatMap((meta) => {
        if (!meta) {
          return Effect.fail(
            new NotFoundError({
              entityId: key,
              entityType: "storage_object",
              message: `Storage object not found: ${key}`,
            }),
          );
        }
        return Effect.succeed(meta);
      }),
    );
  }

  /**
   * Deletes an object from the bucket as a typed Effect.
   *
   * @param key - Storage object key to delete.
   * @returns Effect resolving on successful deletion.
   */
  deleteEffect(key: string): Effect.Effect<void, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => toStorageError(cause, "Failed to delete storage object"),
      try: async () => this.delete(key),
    });
  }

  /**
   * Reads the first N bytes of an object as a typed Effect.
   *
   * @param key - Storage object key.
   * @param maximumBytes - Number of prefix bytes to read (up to 1 MiB).
   * @returns Effect resolving to byte buffer if object exists, or null.
   */
  readPrefixEffect(
    key: string,
    maximumBytes: number,
  ): Effect.Effect<Uint8Array | null, StorageUnavailableError | InvalidRequestError> {
    return this.readRangeEffect(key, 0, maximumBytes);
  }

  /**
   * Opens the whole object for streaming as a typed Effect.
   *
   * @param key - Storage object key.
   * @returns Effect resolving to the streaming body, or null when absent.
   */
  readEffect(
    key: string,
  ): Effect.Effect<ObjectBody | null, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => toStorageError(cause, "Failed to read storage object"),
      try: async () => this.read(key),
    });
  }

  /**
   * Reads a bounded slice of an object as a typed Effect.
   *
   * @param key - Storage object key.
   * @param offset - Non-negative start byte offset.
   * @param maximumBytes - Length of slice to read (between 1 and 1,048,576 bytes).
   * @returns Effect resolving to byte buffer if found, or null.
   */
  readRangeEffect(
    key: string,
    offset: number,
    maximumBytes: number,
  ): Effect.Effect<Uint8Array | null, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => toStorageError(cause, "Failed to read storage object range"),
      try: async () => this.readRange(key, offset, maximumBytes),
    });
  }

  /**
   * Initiates a multipart upload session as a typed Effect.
   *
   * @param key - Destination object key.
   * @param contentType - MIME content type of the upload.
   * @returns Effect resolving to EffectMultipartUpload handle.
   */
  createMultipartUploadEffect(
    key: string,
    contentType: string,
  ): Effect.Effect<EffectMultipartUpload, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => toStorageError(cause, "Failed to initiate multipart upload"),
      try: async () => wrapMultipartUpload(await this.createMultipartUpload(key, contentType)),
    });
  }

  /**
   * Resumes an in-flight multipart upload session as a typed Effect.
   *
   * Enters the Effect error boundary before touching the provider so a
   * synchronous throw from `resumeMultipartUpload` becomes a typed failure
   * instead of escaping as a defect. `resume("k","u")` resolves to the handle.
   *
   * @param key - Destination object key.
   * @param uploadId - Active multipart upload ID.
   * @returns Effect resolving to the EffectMultipartUpload controller handle.
   */
  resumeMultipartUploadEffect(
    key: string,
    uploadId: string,
  ): Effect.Effect<EffectMultipartUpload, StorageUnavailableError | InvalidRequestError> {
    return Effect.try({
      catch: (cause) => toStorageError(cause, "Failed to resume multipart upload"),
      try: () => wrapMultipartUpload(this.resumeMultipartUpload(key, uploadId)),
    });
  }
}

/**
 * Store the provider factory always returns.
 *
 * Both adapters implement the whole {@link EffectObjectStore} surface, so a
 * caller never has to narrow before reading metadata, streaming bytes, or
 * driving a multipart upload through Effects.
 */
export type ConfiguredObjectStore = EffectObjectStore;
