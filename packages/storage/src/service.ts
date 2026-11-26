import { Context, Effect, Layer } from "effect";
import {
  type InvalidRequestError,
  type NotFoundError,
  StorageUnavailableError,
} from "@meltiply/domain";

import {
  toStorageError,
  type ConfiguredObjectStore,
  type EffectMultipartUpload,
  type ObjectMetadata,
  type ObjectUrlSigner,
  type SignedMultipartPartRequest,
  type SignedObjectRequest,
  type SignedUploadRequest,
} from "./object-store";

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

export class StorageService extends Context.Service<StorageService, StorageServiceShape>()(
  "StorageService",
) {}

export interface CreateStorageServiceLiveOptions {
  signer?: ObjectUrlSigner;
  store?: ConfiguredObjectStore;
  storageUnavailableError?: StorageUnavailableError;
}

/** Store and signer fail independently: a missing one fails only its own operations. */
export function createStorageServiceLive(
  options: CreateStorageServiceLiveOptions,
): Layer.Layer<StorageService> {
  const { signer, store } = options;
  const unavailable =
    options.storageUnavailableError ??
    new StorageUnavailableError({ message: "Object storage is not configured." });
  const withStore = <A, E>(
    run: (configured: ConfiguredObjectStore) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | StorageUnavailableError> =>
    store ? run(store) : Effect.fail(unavailable);
  const withSigner = (
    run: (configured: ObjectUrlSigner) => Promise<string>,
    fallback: string,
  ): Effect.Effect<string, InvalidRequestError | StorageUnavailableError> =>
    signer
      ? Effect.tryPromise({
          catch: (cause) => toStorageError(cause, fallback),
          try: () => run(signer),
        })
      : Effect.fail(unavailable);

  return Layer.succeed(StorageService, {
    createMultipartUpload: (key, contentType) =>
      withStore((configured) => configured.createMultipartUploadEffect(key, contentType)),
    delete: (key) => withStore((configured) => configured.deleteEffect(key)),
    getMetadata: (key) => withStore((configured) => configured.getMetadataEffect(key)),
    head: (key) => withStore((configured) => configured.headEffect(key)),
    readPrefix: (key, maximumBytes) =>
      withStore((configured) => configured.readPrefixEffect(key, maximumBytes)),
    readRange: (key, offset, maximumBytes) =>
      withStore((configured) => configured.readRangeEffect(key, offset, maximumBytes)),
    resumeMultipartUpload: (key, uploadId) =>
      withStore((configured) => configured.resumeMultipartUploadEffect(key, uploadId)),
    signDownload: (request) =>
      withSigner((configured) => configured.signDownload(request), "Failed to sign download URL"),
    signMultipartPart: (request) =>
      withSigner(
        (configured) => configured.signMultipartPart(request),
        "Failed to sign multipart part URL",
      ),
    signUpload: (request) =>
      withSigner((configured) => configured.signUpload(request), "Failed to sign upload URL"),
  });
}

/** In-memory doubles for every operation unless overridden. */
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
