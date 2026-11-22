import { Context, Effect, Layer } from "effect";
import {
  type InvalidRequestError,
  errorMessage,
  type NotFoundError,
  StorageUnavailableError,
} from "@meltiply/domain";

import {
  toStorageError,
  type EffectMultipartUpload,
  type EffectObjectStore,
  type ObjectMetadata,
  type ObjectUrlSigner,
  type SignedMultipartPartRequest,
  type SignedObjectRequest,
  type SignedUploadRequest,
} from "./object-store";
import type { R2SigV4SignerOptions } from "./r2";
import { R2SigV4Signer } from "./r2";
import { SigV4UrlSigner } from "./sigv4";

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
  let signerInitError: string | undefined;
  if (options.signer) {
    if ("signUpload" in options.signer) {
      signer = options.signer;
    } else {
      try {
        signer = new R2SigV4Signer(options.signer);
      } catch (cause) {
        signerInitError = errorMessage(cause, "Object URL signer is not configured.");
      }
    }
  }

  const sigV4Signer = signer instanceof SigV4UrlSigner ? signer : undefined;

  const signerUnavailable = () =>
    Effect.fail(
      new StorageUnavailableError({
        message: signerInitError ?? "Object URL signer is not configured.",
      }),
    );

  const withStore = <A, E>(
    run: (store: EffectObjectStore) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | StorageUnavailableError> =>
    options.store ? run(options.store) : storageUnavailable();

  const service: StorageServiceShape = {
    createMultipartUpload: (key, contentType) =>
      withStore((store) => store.createMultipartUploadEffect(key, contentType)),
    delete: (key) => withStore((store) => store.deleteEffect(key)),
    getMetadata: (key) => withStore((store) => store.getMetadataEffect(key)),
    head: (key) => withStore((store) => store.headEffect(key)),
    readPrefix: (key, maximumBytes) =>
      withStore((store) => store.readPrefixEffect(key, maximumBytes)),
    readRange: (key, offset, maximumBytes) =>
      withStore((store) => store.readRangeEffect(key, offset, maximumBytes)),
    resumeMultipartUpload: (key, uploadId) =>
      withStore((store) => store.resumeMultipartUploadEffect(key, uploadId)),
    signDownload: (request) => {
      if (!signer) return signerUnavailable();
      if (sigV4Signer) return sigV4Signer.signDownloadEffect(request);
      return Effect.tryPromise({
        catch: (cause) => toStorageError(cause, "Failed to sign download URL"),
        try: () => signer.signDownload(request),
      });
    },
    signMultipartPart: (request) => {
      if (!signer) return signerUnavailable();
      if (sigV4Signer) return sigV4Signer.signMultipartPartEffect(request);
      return Effect.tryPromise({
        catch: (cause) => toStorageError(cause, "Failed to sign multipart part URL"),
        try: () => signer.signMultipartPart(request),
      });
    },
    signUpload: (request) => {
      if (!signer) return signerUnavailable();
      if (sigV4Signer) return sigV4Signer.signUploadEffect(request);
      return Effect.tryPromise({
        catch: (cause) => toStorageError(cause, "Failed to sign upload URL"),
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
