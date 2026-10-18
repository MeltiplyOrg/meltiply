/**
 * `@meltiply/storage` — object storage for Meltiply.
 *
 * The package is organized around three seams:
 *
 * - `object-store` defines the provider-neutral contract every store implements
 *   and the shared Effect surface derived from it.
 * - `r2` and `s3` are the two adapters; both sign with the same SigV4 core, so a
 *   provider switch changes where bytes live, never what Meltiply may do.
 * - `provider` resolves `OBJECT_STORAGE_PROVIDER` and constructs the store and
 *   signer workers use, which is the only place provider selection happens.
 */
export { readyObjectKey, stagingObjectKey } from "./keys";
export type {
  ConfiguredObjectStore,
  EffectMultipartUpload,
  MultipartUpload,
  ObjectBody,
  ObjectMetadata,
  ObjectStore,
  ObjectUrlSigner,
  ObjectWriteUrlSigner,
  SignedMultipartPartRequest,
  SignedObjectRequest,
  SignedObjectWriteRequest,
  SignedUploadRequest,
  UploadedPart,
} from "./object-store";
export type { SignedRequest } from "./sigv4";
export {
  createR2SignerFromEnv,
  R2ObjectStore,
  R2SigV4Signer,
  type R2BucketLike,
  type R2SigV4SignerOptions,
  type R2SignerEnv,
} from "./r2";
export {
  S3ObjectStore,
  S3SigV4Signer,
  type S3ObjectStoreOptions,
  type S3SigV4SignerOptions,
} from "./s3";
export {
  createObjectStoreFromEnv,
  createObjectUrlSignerFromEnv,
  objectStorageBindings,
  objectStorageProvider,
  type ObjectStorageBindingStatus,
  type ObjectStorageEnv,
  type ObjectStorageProvider,
} from "./provider";
export {
  createStorageServiceLive,
  createStorageServiceTest,
  type CreateStorageServiceLiveOptions,
  StorageService,
  type StorageServiceShape,
} from "./service";
