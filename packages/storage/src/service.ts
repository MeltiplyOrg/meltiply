import { Context, Effect, Layer } from "effect";
import { InvalidRequestError, type NotFoundError, StorageUnavailableError } from "@meltiply/domain";

import type {
  EffectMultipartUpload,
  EffectObjectStore,
  ObjectMetadata,
  ObjectUrlSigner,
  SignedMultipartPartRequest,
  SignedObjectRequest,
  SignedUploadRequest,
} from "./object-store";
import type { R2SigV4SignerOptions } from "./r2";
import { R2SigV4Signer } from "./r2";

/**
 * Service shape describing effectful cloud object storage and presigned URL operations.
 */
export interface StorageServiceShape {
  readonly createMultipartUpload: (
    key: string,
    contentType: string,
  ) => Effect.Effect<EffectMultipartUpload, StorageUnavailableError | InvalidRequestError>;
  readonly delete: (
    key: string,
  ) => Effect.Effect<void, StorageUnavailableError | InvalidRequestError>;
  readonly getMetadata: (
    key: string,
  ) => Effect.Effect<ObjectMetadata, NotFoundError | StorageUnavailableError | InvalidRequestError>;
  readonly head: (
    key: string,
  ) => Effect.Effect<ObjectMetadata | null, StorageUnavailableError | InvalidRequestError>;
  readonly readPrefix: (
    key: string,
    maximumBytes: number,
  ) => Effect.Effect<Uint8Array | null, StorageUnavailableError | InvalidRequestError>;
  readonly readRange: (
    key: string,
    offset: number,
    maximumBytes: number,
  ) => Effect.Effect<Uint8Array | null, StorageUnavailableError | InvalidRequestError>;
  readonly resumeMultipartUpload: (
    key: string,
    uploadId: string,
  ) => Effect.Effect<EffectMultipartUpload, StorageUnavailableError | InvalidRequestError>;
  readonly signDownload: (
    request: SignedObjectRequest,
  ) => Effect.Effect<string, InvalidRequestError | StorageUnavailableError>;
  readonly signMultipartPart: (
    request: SignedMultipartPartRequest,
  ) => Effect.Effect<string, InvalidRequestError | StorageUnavailableError>;
  readonly signUpload: (
    request: SignedUploadRequest,
  ) => Effect.Effect<string, InvalidRequestError | StorageUnavailableError>;
}

/**
 * Effect service tag for object storage and URL signing.
 */
export class StorageService extends Context.Service<StorageService, StorageServiceShape>()(
  "StorageService",
) {}

export interface CreateStorageServiceLiveOptions {
  /** Preconstructed provider store; omitted leaves object access failing closed. */
  store?: EffectObjectStore;
  signer?: ObjectUrlSigner | R2SigV4SignerOptions;
  storageUnavailableError?: StorageUnavailableError;
}

interface EffectUrlSigner {
  signDownloadEffect(request: SignedObjectRequest): Effect.Effect<string, InvalidRequestError>;
  signMultipartPartEffect(
    request: SignedMultipartPartRequest,
  ): Effect.Effect<string, InvalidRequestError>;
  signUploadEffect(request: SignedUploadRequest): Effect.Effect<string, InvalidRequestError>;
}

/**
 * Type guard checking if an ObjectUrlSigner also implements the typed Effect signing methods.
 * Refines the signer interface safely without unchecked type assertions.
 *
 * @param candidate - URL signer instance to inspect.
 * @returns True if candidate provides typed Effect signing methods.
 */
function isEffectUrlSigner(
  candidate: ObjectUrlSigner | undefined,
): candidate is ObjectUrlSigner & EffectUrlSigner {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "signUploadEffect" in candidate &&
    "signDownloadEffect" in candidate &&
    "signMultipartPartEffect" in candidate &&
    typeof (candidate as Record<string, unknown>).signUploadEffect === "function" &&
    typeof (candidate as Record<string, unknown>).signDownloadEffect === "function" &&
    typeof (candidate as Record<string, unknown>).signMultipartPartEffect === "function"
  );
}

/**
 * Maps a custom ObjectUrlSigner rejection to the shared storage error taxonomy.
 * Mirrors the native signer boundary: invalid signing input (TypeError/RangeError)
 * becomes InvalidRequestError, infrastructure or unexpected failures become
 * StorageUnavailableError. sign_fig("k") → InvalidRequestError | StorageUnavailableError.
 *
 * @param cause - Rejection reason thrown by the custom signer.
 * @param fallback - Message used when the cause carries no message.
 * @returns Typed domain error for the Effect failure channel.
 */
function toSignerError(
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
 * Creates a live production Layer for StorageService over a configured provider store.
 *
 * Store and signer availability are independent: signing needs credentials, not
 * an object store. A missing store fails lazily with the supplied configuration
 * error (or the shared default), preserving caller validation order.
 *
 * @param options - Live configuration containing the provider store and optional URL signer or R2 signer options.
 * @returns Layer providing production StorageService.
 */
export function createStorageServiceLive(
  options: CreateStorageServiceLiveOptions,
): Layer.Layer<StorageService, never, never> {
  const storageUnavailable = () =>
    Effect.fail(
      options.storageUnavailableError ??
        new StorageUnavailableError({
          message: "Object storage is not configured.",
        }),
    );
  let signer: ObjectUrlSigner | undefined;
  if (options.signer) {
    if ("signUpload" in options.signer) {
      signer = options.signer;
    } else {
      try {
        signer = new R2SigV4Signer(options.signer);
      } catch {
        // Signer remains undefined; signing calls will fail closed
      }
    }
  }

  const effectSigner = isEffectUrlSigner(signer) ? signer : undefined;

  const signerUnavailable = () =>
    Effect.fail(
      new StorageUnavailableError({
        message: "Object URL signer is not configured.",
      }),
    );

  const service: StorageServiceShape = {
    createMultipartUpload: (key, contentType) =>
      options.store
        ? options.store.createMultipartUploadEffect(key, contentType)
        : storageUnavailable(),
    delete: (key) => (options.store ? options.store.deleteEffect(key) : storageUnavailable()),
    getMetadata: (key) =>
      options.store ? options.store.getMetadataEffect(key) : storageUnavailable(),
    head: (key) => (options.store ? options.store.headEffect(key) : storageUnavailable()),
    readPrefix: (key, maximumBytes) =>
      options.store ? options.store.readPrefixEffect(key, maximumBytes) : storageUnavailable(),
    readRange: (key, offset, maximumBytes) =>
      options.store
        ? options.store.readRangeEffect(key, offset, maximumBytes)
        : storageUnavailable(),
    resumeMultipartUpload: (key, uploadId) =>
      options.store
        ? options.store.resumeMultipartUploadEffect(key, uploadId)
        : storageUnavailable(),
    signDownload: (request) => {
      if (!signer) return signerUnavailable();
      if (effectSigner) return effectSigner.signDownloadEffect(request);
      return Effect.tryPromise({
        catch: (cause) => toSignerError(cause, "Failed to sign download URL"),
        try: () => signer.signDownload(request),
      });
    },
    signMultipartPart: (request) => {
      if (!signer) return signerUnavailable();
      if (effectSigner) return effectSigner.signMultipartPartEffect(request);
      return Effect.tryPromise({
        catch: (cause) => toSignerError(cause, "Failed to sign multipart part URL"),
        try: () => signer.signMultipartPart(request),
      });
    },
    signUpload: (request) => {
      if (!signer) return signerUnavailable();
      if (effectSigner) return effectSigner.signUploadEffect(request);
      return Effect.tryPromise({
        catch: (cause) => toSignerError(cause, "Failed to sign upload URL"),
        try: () => signer.signUpload(request),
      });
    },
  };

  return Layer.succeed(StorageService, service);
}

/**
 * Creates a test Layer providing a stubbed or fake StorageService implementation.
 * Replaces live object storage with in-memory test doubles.
 *
 * @param impl - Optional partial method implementations for StorageServiceShape.
 * @returns Layer providing the configured test StorageService.
 */
export function createStorageServiceTest(
  impl?: Partial<StorageServiceShape>,
): Layer.Layer<StorageService, never, never> {
  const service: StorageServiceShape = {
    createMultipartUpload:
      impl?.createMultipartUpload ??
      ((key) =>
        Effect.succeed({
          abort: () => Effect.void,
          complete: (parts) =>
            Effect.succeed({
              contentType: "application/octet-stream",
              etag: "mock-etag-complete",
              key,
              size: parts.length * 1024,
              uploadedAt: new Date("2026-01-01"),
            }),
          uploadId: "mock-upload-id",
          uploadPart: (partNumber) =>
            Effect.succeed({
              etag: `mock-etag-part-${partNumber}`,
              partNumber,
            }),
        })),
    delete: impl?.delete ?? (() => Effect.void),
    getMetadata:
      impl?.getMetadata ??
      ((key) =>
        Effect.succeed({
          contentType: "application/octet-stream",
          etag: "mock-etag",
          key,
          size: 1024,
          uploadedAt: new Date("2026-01-01"),
        })),
    head:
      impl?.head ??
      ((key) =>
        Effect.succeed({
          contentType: "application/octet-stream",
          etag: "mock-etag",
          key,
          size: 1024,
          uploadedAt: new Date("2026-01-01"),
        })),
    readPrefix: impl?.readPrefix ?? (() => Effect.succeed(new Uint8Array([0x00, 0x01]))),
    readRange: impl?.readRange ?? (() => Effect.succeed(new Uint8Array([0x00, 0x01]))),
    resumeMultipartUpload:
      impl?.resumeMultipartUpload ??
      ((key, uploadId) =>
        Effect.succeed({
          abort: () => Effect.void,
          complete: () =>
            Effect.succeed({
              contentType: "application/octet-stream",
              etag: "mock-etag-resumed",
              key,
              size: 2048,
              uploadedAt: new Date("2026-01-01"),
            }),
          uploadId,
          uploadPart: (partNumber) =>
            Effect.succeed({
              etag: `mock-etag-part-${partNumber}`,
              partNumber,
            }),
        })),
    signDownload:
      impl?.signDownload ??
      ((request) => Effect.succeed(`https://mock-storage.local/download/${request.key}?sig=mock`)),
    signMultipartPart:
      impl?.signMultipartPart ??
      ((request) =>
        Effect.succeed(
          `https://mock-storage.local/part/${request.key}?partNumber=${request.partNumber}&uploadId=${request.uploadId}&sig=mock`,
        )),
    signUpload:
      impl?.signUpload ??
      ((request) => Effect.succeed(`https://mock-storage.local/upload/${request.key}?sig=mock`)),
  };

  return Layer.succeed(StorageService, service);
}
