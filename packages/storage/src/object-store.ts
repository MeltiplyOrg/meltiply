import { Effect } from "effect";
import {
  errorMessage,
  InvalidRequestError,
  NotFoundError,
  StorageUnavailableError,
} from "@meltiply/domain";

export interface ObjectMetadata {
  contentType: string | null;
  customMetadata?: Record<string, string> | null;
  etag: string;
  key: string;
  sha256?: string | null;
  size: number;
  uploadedAt: Date;
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
  read?(key: string): Promise<ObjectBody | null>;
  readRange?(key: string, offset: number, maximumBytes: number): Promise<Uint8Array | null>;
  readPrefix(key: string, maximumBytes: number): Promise<Uint8Array | null>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}

export interface SignedObjectRequest {
  contentLength?: number;
  contentType?: string;
  downloadFilename?: string;
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
  contentType?: string;
  expiresAt?: Date;
  expiresInSeconds: number;
  key: string;
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
export function toStorageError(
  cause: unknown,
  fallback: string,
): InvalidRequestError | StorageUnavailableError {
  const message = errorMessage(cause, fallback);
  if (cause instanceof TypeError || cause instanceof RangeError) {
    return new InvalidRequestError({ message });
  }
  return new StorageUnavailableError({ message });
}

function wrapMultipartUpload(upload: MultipartUpload): EffectMultipartUpload {
  return {
    abort: () =>
      Effect.tryPromise({
        catch: (cause) =>
          new StorageUnavailableError({
            message: errorMessage(cause, "Failed to abort multipart upload"),
          }),
        try: async () => upload.abort(),
      }),
    complete: (parts) =>
      Effect.tryPromise({
        catch: (cause) =>
          new StorageUnavailableError({
            message: errorMessage(cause, "Failed to complete multipart upload"),
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
  abstract resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;

  readPrefix(key: string, maximumBytes: number): Promise<Uint8Array | null> {
    return this.readRange(key, 0, maximumBytes);
  }

  headEffect(
    key: string,
  ): Effect.Effect<ObjectMetadata | null, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => toStorageError(cause, "Failed to query object metadata"),
      try: async () => this.head(key),
    });
  }

  getMetadataEffect(
    key: string,
  ): Effect.Effect<ObjectMetadata, NotFoundError | StorageUnavailableError | InvalidRequestError> {
    return this.headEffect(key).pipe(
      Effect.flatMap((meta) => {
        if (!meta) {
          return Effect.fail(
            new NotFoundError({
              message: `Storage object not found: ${key}`,
            }),
          );
        }
        return Effect.succeed(meta);
      }),
    );
  }

  deleteEffect(key: string): Effect.Effect<void, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => toStorageError(cause, "Failed to delete storage object"),
      try: async () => this.delete(key),
    });
  }

  readPrefixEffect(
    key: string,
    maximumBytes: number,
  ): Effect.Effect<Uint8Array | null, StorageUnavailableError | InvalidRequestError> {
    return this.readRangeEffect(key, 0, maximumBytes);
  }

  readEffect(
    key: string,
  ): Effect.Effect<ObjectBody | null, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => toStorageError(cause, "Failed to read storage object"),
      try: async () => this.read(key),
    });
  }

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

  createMultipartUploadEffect(
    key: string,
    contentType: string,
  ): Effect.Effect<EffectMultipartUpload, StorageUnavailableError | InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) => toStorageError(cause, "Failed to initiate multipart upload"),
      try: async () => wrapMultipartUpload(await this.createMultipartUpload(key, contentType)),
    });
  }

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
