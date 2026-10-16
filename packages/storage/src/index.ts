import { Context, Effect, Layer } from "effect";
import { InvalidRequestError, NotFoundError, StorageUnavailableError } from "@meltiply/domain";

export interface ObjectMetadata {
  contentType: string | null;
  /** User metadata R2 exposes alongside the object; promotion copies carry the source provenance here. */
  customMetadata?: Record<string, string> | null;
  etag: string;
  key: string;
  /** Hex SHA-256 digest reported by R2 for the object; absent unless the write carried a checksum. */
  sha256?: string | null;
  size: number;
  uploadedAt: Date;
  /** Immutable object version reported by R2. */
  version?: string | null;
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
   * elapsed when signing starts is rejected instead of being stretched into
   * a late grant.
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
interface R2ObjectLike {
  checksums?: { sha256?: ArrayBuffer } | null;
  customMetadata?: Record<string, string> | null;
  etag: string;
  httpMetadata?: { contentType?: string };
  key: string;
  size: number;
  uploaded: Date;
  version?: string;
}

interface R2ObjectBodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream | null;
}

interface R2MultipartUploadLike {
  abort(): Promise<void>;
  complete(parts: readonly UploadedPart[]): Promise<R2ObjectLike>;
  uploadId: string;
  uploadPart(
    partNumber: number,
    value: ArrayBuffer | ArrayBufferView | Blob,
  ): Promise<UploadedPart>;
}

export interface R2BucketLike {
  createMultipartUpload(
    key: string,
    options: { httpMetadata: { contentType: string } },
  ): Promise<R2MultipartUploadLike>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  get(
    key: string,
    options: {
      onlyIf?: { etagMatches?: string };
      range?: { length: number; offset: number };
    },
  ): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  /**
   * Object writes back a streamed copy. Required because `copyObject` is the
   * only promotion primitive, and it exists on every real R2 binding.
   */
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | Blob,
    options?: {
      httpMetadata?: { contentType: string };
      onlyIf?: { etagDoesNotMatch?: string };
    },
  ): Promise<R2ObjectLike | null>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
}

const invalidSegment = /(^\.{1,2}$)|[\\/\u0000-\u001f\u007f]/;

/**
 * Validates and normalizes an object key path segment.
 * Rejects empty strings, directory traversal segments ("." or ".."), slashes, and control characters.
 *
 * @param name - Segment parameter name for error reporting.
 * @param value - Raw segment string value.
 * @returns Trimmed, valid path segment string.
 * @throws {TypeError} If segment is invalid, empty, or contains prohibited characters.
 */
function normalizeSegment(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || invalidSegment.test(normalized)) {
    throw new TypeError(`${name} must be a non-empty path segment`);
  }
  return normalized;
}

/**
 * Constructs the upload-writable staging R2 object key for an in-flight upload session.
 *
 * Uploads always land under the bucket-root `staging/` namespace so a bucket
 * lifecycle rule can expire abandoned staging bytes, while every publishable
 * object lives under the protected `<orgId>/<assetId>/` namespace.
 *
 * @param organizationId - Tenant organization UUID segment.
 * @param assetId - Asset UUID segment.
 * @param sessionId - Upload session UUID segment, keeping concurrent retries of one asset distinct.
 * @param filename - Sanitized single-segment filename.
 * @returns `staging/<orgId>/<assetId>/<sessionId>/<filename>`.
 */
export function stagingObjectKey(
  organizationId: string,
  assetId: string,
  sessionId: string,
  filename: string,
): string {
  return [
    "staging",
    normalizeSegment("organizationId", organizationId),
    normalizeSegment("assetId", assetId),
    normalizeSegment("sessionId", sessionId),
    normalizeSegment("filename", filename),
  ].join("/");
}

/**
 * Constructs a protected, publish-ready R2 object key for an asset object.
 *
 * Ready keys keep `<orgId>/<assetId>/<name>` so object ownership stays
 * verifiable from the key alone; staging keys can never be signed for preview,
 * download, or Provider delivery.
 *
 * @param organizationId - Tenant organization UUID segment.
 * @param assetId - Asset UUID segment.
 * @param name - Object name segment (`original`, `rendition-optimized`, `thumbnail`, …).
 * @returns `<orgId>/<assetId>/<name>`.
 */
export function readyObjectKey(organizationId: string, assetId: string, name: string): string {
  return [
    normalizeSegment("organizationId", organizationId),
    normalizeSegment("assetId", assetId),
    normalizeSegment("name", name),
  ].join("/");
}

/**
 * Maps an R2ObjectLike instance to a standardized ObjectMetadata descriptor.
 *
 * @param value - Raw R2 object metadata from Cloudflare storage.
 * @returns ObjectMetadata with normalized contentType, etag, size, uploadedAt, and the optional version/checksum/custom metadata R2 reported.
 */
function metadata(value: R2ObjectLike): ObjectMetadata {
  const sha256 = value.checksums?.sha256;
  return {
    contentType: value.httpMetadata?.contentType ?? null,
    customMetadata: value.customMetadata ?? null,
    etag: value.etag,
    key: value.key,
    sha256: sha256 ? hex(sha256) : null,
    size: value.size,
    uploadedAt: new Date(value.uploaded),
    version: value.version ?? null,
  };
}

export class R2ObjectStore implements ObjectStore {
  /**
   * Initializes the object store wrapping a Cloudflare R2 bucket binding.
   *
   * @param bucket - R2 bucket or mock instance.
   */
  constructor(private readonly bucket: R2BucketLike) {}

  /**
   * Retrieves metadata for an object without reading its body.
   *
   * @param key - Storage object key.
   * @returns ObjectMetadata if found, or null if the object does not exist.
   */
  async head(key: string): Promise<ObjectMetadata | null> {
    const object = await this.bucket.head(key);
    return object ? metadata(object) : null;
  }

  /**
   * Copies an object inside the bucket using a streamed conditional GET and PUT.
   *
   * Byte-for-byte promotion of a staging upload to a protected ready key never
   * buffers the object in the worker: the source body stream feeds the
   * destination write directly. `ifSourceEtagMatches` pins the source
   * generation so a staging key rewritten by a still-valid upload grant cannot
   * be promoted, and `ifDestinationAbsent` makes a replayed copy adopt the
   * destination a crashed attempt already wrote.
   *
   * @param sourceKey - Existing source object key.
   * @param destinationKey - Destination object key; left untouched when it already exists.
   * @param options - `ifSourceEtagMatches` required source ETag guard, `contentType` written metadata, `ifDestinationAbsent` destination guard.
   * @returns Metadata of the copy, or `null` when the source is absent/Etag-mismatched or the destination already exists.
   * @throws {TypeError} If the matched object exposes no readable body stream.
   */
  async copyObject(
    sourceKey: string,
    destinationKey: string,
    options: {
      contentType?: string;
      ifDestinationAbsent?: boolean;
      ifSourceEtagMatches?: string;
    } = {},
  ): Promise<ObjectMetadata | null> {
    const source = await this.bucket.get(sourceKey, {
      onlyIf: { etagMatches: options.ifSourceEtagMatches },
    });
    if (!source) return null;
    if (!source.body) {
      throw new TypeError("source object body is unavailable");
    }
    const copied = await this.bucket.put(destinationKey, source.body, {
      ...(options.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
      ...(options.ifDestinationAbsent ? { onlyIf: { etagDoesNotMatch: "*" } } : {}),
    });
    return copied ? metadata(copied) : null;
  }

  /**
   * Deletes an object from the bucket.
   *
   * @param key - Storage object key to delete.
   */
  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  /**
   * Reads the first N bytes of an object, useful for MIME sniffing and magic-number validation.
   *
   * @param key - Storage object key.
   * @param maximumBytes - Number of prefix bytes to read (up to 1 MiB).
   * @returns Byte buffer if the object exists, or null.
   */
  async readPrefix(key: string, maximumBytes: number): Promise<Uint8Array | null> {
    return this.readRange(key, 0, maximumBytes);
  }

  /**
   * Reads a bounded slice of an object by byte offset and maximum length.
   *
   * @param key - Storage object key.
   * @param offset - Non-negative start byte offset.
   * @param maximumBytes - Length of slice to read (between 1 and 1,048,576 bytes).
   * @returns Byte buffer if found, or null.
   * @throws {RangeError} If offset or maximumBytes are outside safe bounds.
   */
  async readRange(key: string, offset: number, maximumBytes: number): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError("offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024) {
      throw new RangeError("maximumBytes must be between 1 and 1048576");
    }
    const object = await this.bucket.get(key, {
      range: { length: maximumBytes, offset },
    });
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  /**
   * Initiates an R2 multipart upload session for large assets.
   *
   * @param key - Destination object key.
   * @param contentType - MIME content type of the upload.
   * @returns MultipartUpload controller handle for uploading parts, completing, or aborting.
   */
  async createMultipartUpload(key: string, contentType: string): Promise<MultipartUpload> {
    const upload = await this.bucket.createMultipartUpload(key, {
      httpMetadata: { contentType },
    });
    return {
      abort: () => upload.abort(),
      complete: async (parts) => metadata(await upload.complete(parts)),
      uploadId: upload.uploadId,
      uploadPart: (partNumber, value) => upload.uploadPart(partNumber, value),
    };
  }

  /**
   * Resumes an in-flight R2 multipart upload session using its known uploadId.
   *
   * @param key - Destination object key.
   * @param uploadId - Active multipart upload ID.
   * @returns MultipartUpload controller handle.
   */
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    const upload = this.bucket.resumeMultipartUpload(key, uploadId);
    return {
      abort: () => upload.abort(),
      complete: async (parts) => metadata(await upload.complete(parts)),
      uploadId: upload.uploadId,
      uploadPart: (partNumber, value) => upload.uploadPart(partNumber, value),
    };
  }

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
      catch: (cause) => {
        const message = cause instanceof Error ? cause.message : "Failed to query object metadata";
        if (cause instanceof TypeError || cause instanceof RangeError) {
          return new InvalidRequestError({ message });
        }
        return new StorageUnavailableError({ message });
      },
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
      catch: (cause) => {
        const message = cause instanceof Error ? cause.message : "Failed to delete storage object";
        if (cause instanceof TypeError || cause instanceof RangeError) {
          return new InvalidRequestError({ message });
        }
        return new StorageUnavailableError({ message });
      },
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
      catch: (cause) => {
        const message =
          cause instanceof Error ? cause.message : "Failed to read storage object range";
        if (cause instanceof TypeError || cause instanceof RangeError) {
          return new InvalidRequestError({ message });
        }
        return new StorageUnavailableError({ message });
      },
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
      catch: (cause) => {
        const message =
          cause instanceof Error ? cause.message : "Failed to initiate multipart upload";
        if (cause instanceof TypeError || cause instanceof RangeError) {
          return new InvalidRequestError({ message });
        }
        return new StorageUnavailableError({ message });
      },
      try: async () => wrapMultipartUpload(await this.createMultipartUpload(key, contentType)),
    });
  }

  /**
   * Resumes an in-flight multipart upload session as a typed Effect.
   * Enters the Effect error boundary before touching the R2 binding so a
   * synchronous throw from resumeMultipartUpload becomes a typed failure
   * instead of escaping as a defect. resume("k","u") → Effect(handle).
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
      catch: (cause) => {
        const message =
          cause instanceof Error ? cause.message : "Failed to resume multipart upload";
        if (cause instanceof TypeError || cause instanceof RangeError) {
          return new InvalidRequestError({ message });
        }
        return new StorageUnavailableError({ message });
      },
      try: () => wrapMultipartUpload(this.resumeMultipartUpload(key, uploadId)),
    });
  }
}

/**
 * Adapts a Promise-based MultipartUpload handle into an EffectMultipartUpload handle.
 * Converts part upload, completion, and abort operations to typed Effects.
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
        catch: (cause) => {
          const message =
            cause instanceof Error ? cause.message : "Failed to upload multipart part";
          if (cause instanceof TypeError || cause instanceof RangeError) {
            return new InvalidRequestError({ message });
          }
          return new StorageUnavailableError({ message });
        },
        try: async () => upload.uploadPart(partNumber, value),
      }),
  };
}

/**
 * Configuration for the shared R2 SigV4 signer.
 *
 * `endpoint` stays an origin (no path, query, credentials, or fragment) so the
 * signed host is exactly what the operator configured; `endpointPathPrefix`
 * carries any path prefix separately so it can be part of the canonical URI
 * without weakening origin-only validation. `allowInsecureEndpoint` is the
 * explicit development-only switch that permits a plain-HTTP origin; it
 * defaults to false so production can only ever sign HTTPS URLs.
 */
export interface R2SigV4SignerOptions {
  accessKeyId: string;
  accountId: string;
  /**
   * Development-only: accept a plain-HTTP origin. Never set this from
   * configuration in production; `createR2SignerFromEnv` derives it solely
   * from `ENVIRONMENT === "local" | "test"`.
   */
  allowInsecureEndpoint?: boolean;
  bucket: string;
  endpoint?: string;
  /** Path prefix prepended to `/<bucket>/<key>`, e.g. `/cdn-cgi/local/r2/s3`. */
  endpointPathPrefix?: string;
  now?: () => Date;
  secretAccessKey: string;
}

const encoder = new TextEncoder();
const maximumPresignSeconds = 7 * 24 * 60 * 60;

/**
 * Asserts that a string setting or argument is non-empty after trimming.
 *
 * @param name - Setting name for error message.
 * @param value - Candidate string value.
 * @returns Trimmed string value.
 * @throws {TypeError} If value is empty or blank.
 */
function required(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

/**
 * URI encodes a string adhering strictly to AWS SigV4 URL-encoding specifications.
 * Extends encodeURIComponent by percent-encoding characters `!'()*`.
 *
 * @param value - String to URL encode.
 * @returns Strictly encoded string.
 */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Canonicalizes an S3 object key for SigV4 signing by encoding each path segment.
 *
 * @param key - Raw object key.
 * @returns Slash-prefixed canonical key path.
 */
function canonicalKey(key: string): string {
  return `/${key.split("/").map(encode).join("/")}`;
}

/**
 * Converts an ArrayBuffer to a lowercase hexadecimal string.
 *
 * @param value - Binary buffer to represent as hex.
 * @returns Lowercase hex string.
 */
function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Computes the SHA-256 hex digest of a UTF-8 string using WebCrypto digest.
 *
 * @param value - Input string to hash.
 * @returns Promise resolving to a 64-character lowercase hex digest.
 */
async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/**
 * Computes an HMAC-SHA256 signature for a UTF-8 string using a raw key buffer.
 *
 * @param key - Raw HMAC key bytes.
 * @param value - Message string to sign.
 * @returns Promise resolving to raw signature bytes in an ArrayBuffer.
 */
async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await importHmacKey(key);
  return signHmac(cryptoKey, value);
}

/**
 * Imports raw key bytes into an unextractable HMAC-SHA256 WebCrypto CryptoKey.
 *
 * @param key - Raw key bytes.
 * @returns Promise resolving to the HMAC CryptoKey.
 */
async function importHmacKey(key: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(key);
  return crypto.subtle.importKey("raw", keyBytes.buffer, { hash: "SHA-256", name: "HMAC" }, false, [
    "sign",
  ]);
}

/**
 * Signs a UTF-8 string with an imported HMAC CryptoKey.
 *
 * @param key - WebCrypto HMAC key.
 * @param value - Message text to sign.
 * @returns Promise resolving to signature bytes.
 */
function signHmac(key: CryptoKey, value: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

/**
 * Derives the AWS SigV4 signing key for a given date stamp using sequential HMAC-SHA256 operations.
 * Derivation path: "AWS4" + secret -> dateKey -> region ("auto") -> service ("s3") -> "aws4_request".
 *
 * @param secretAccessKey - R2 API token secret access key.
 * @param date - UTC date stamp string in YYYYMMDD format.
 * @returns Promise resolving to the derived CryptoKey for signing canonical requests.
 */
async function deriveSigningKey(secretAccessKey: string, date: string): Promise<CryptoKey> {
  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, "auto");
  const serviceKey = await hmac(regionKey, "s3");
  return importHmacKey(await hmac(serviceKey, "aws4_request"));
}

/**
 * Formats a Date into ISO-8601 basic format strings for SigV4 headers and credentials.
 *
 * @param now - Current date/time timestamp.
 * @returns Object with 8-character `date` (YYYYMMDD) and 16-character `value` (YYYYMMDDTHHMMSSZ).
 */
function timestamp(now: Date): { date: string; value: string } {
  const value = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { date: value.slice(0, 8), value };
}

/**
 * Compares two strings in strict ASCII byte order for canonical SigV4 query parameter sorting.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative if left < right, positive if left > right, 0 if identical.
 */
function asciiCompare(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * Generates an AWS SigV4 canonical query string from a parameter map.
 * Encodes keys and values, sorts by byte order, and joins with '&'.
 *
 * @param parameters - Map of raw query parameter key-value pairs.
 * @returns Sorted, canonical query string.
 */
function canonicalQuery(parameters: ReadonlyMap<string, string>): string {
  return [...parameters]
    .map(([name, value]) => [encode(name), encode(value)] as const)
    .sort(
      ([leftName, leftValue], [rightName, rightValue]) =>
        asciiCompare(leftName, rightName) || asciiCompare(leftValue, rightValue),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/**
 * Constructs normalized lowercase HTTP headers map for SigV4 signing.
 * Always includes 'host', conditionally includes 'content-length' and 'content-type',
 * then merges any caller-required headers so their names enter `X-Amz-SignedHeaders`.
 *
 * Required headers are canonicalized identically to the built-ins (lowercased
 * name, trimmed and whitespace-collapsed value, no control characters) and may
 * not redefine `host`, because the signed host must stay the configured origin.
 * An empty map is rejected so a caller cannot believe it obtained create-only
 * semantics without actually binding them.
 *
 * @param host - Request host name (e.g. account.r2.cloudflarestorage.com).
 * @param request - Signed object request options.
 * @param requiredHeaders - Extra headers to bind into the signature.
 * @returns Readonly map of lowercase header names to normalized values.
 * @throws {TypeError} On invalid contentLength/contentType, an empty required-header map, a `host` override, or a malformed header name/value.
 */
function normalizedHeaders(
  host: string,
  request: SignedObjectRequest,
  requiredHeaders?: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const headers = new Map<string, string>([["host", host]]);
  if (request.contentLength !== undefined) {
    if (!Number.isSafeInteger(request.contentLength) || request.contentLength <= 0) {
      throw new TypeError("contentLength must be a positive safe integer");
    }
    headers.set("content-length", String(request.contentLength));
  }
  if (request.contentType !== undefined) {
    headers.set("content-type", required("contentType", request.contentType));
  }
  if (requiredHeaders !== undefined) {
    const entries = Object.entries(requiredHeaders);
    if (entries.length === 0) {
      throw new TypeError("requiredHeaders must not be empty");
    }
    for (const [rawName, rawValue] of entries) {
      const name = rawName.trim().toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
        throw new TypeError("requiredHeaders contains an invalid header name");
      }
      if (name === "host") {
        throw new TypeError("requiredHeaders must not override host");
      }
      const value = required(`requiredHeaders["${name}"]`, rawValue).replace(/\s+/g, " ");
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * Validates that presigned URL expiration is an integer between 1 second and 7 days.
 *
 * @param expiresInSeconds - Presigned URL lifetime in seconds.
 * @throws {TypeError} If expiry is outside allowable bounds.
 */
function validateExpiry(expiresInSeconds: number): void {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > maximumPresignSeconds
  ) {
    throw new TypeError(`expiresInSeconds must be between 1 and ${maximumPresignSeconds}`);
  }
}

/**
 * Generates a safe Content-Disposition attachment header value for download requests.
 * Sanitizes control characters and quotes, truncating to 180 characters.
 *
 * @param filename - Intended download filename.
 * @returns Formatted Content-Disposition header string.
 * @throws {TypeError} If filename is missing or empty after trimming.
 */
function downloadDisposition(filename: string): string {
  const normalized = filename
    .trim()
    .replace(/[\u0000-\u001f\u007f"\\/]+/g, "_")
    .slice(0, 180);
  if (!normalized) throw new TypeError("downloadFilename is required");
  return `attachment; filename="${normalized}"`;
}

const maximumEndpointPathPrefixLength = 128;

/**
 * Normalizes an optional endpoint path prefix used by S3-compatible origins
 * that serve the bucket under a route instead of the bare host root.
 *
 * The prefix is kept separate from `endpoint` so origin validation stays strict,
 * yet the prefix can still take part in the canonical URI (a local Wrangler
 * runtime serves the bucket at `/cdn-cgi/local/r2/s3/<bucket>/<key>`). It is
 * rejected unless it is a bounded sequence of ordinary path segments, which
 * keeps it from smuggling traversal, empty segments, or a trailing slash that
 * would produce a double slash in the signed canonical path.
 *
 * @param name - Option name used in error messages.
 * @param value - Raw prefix, possibly with a leading slash, possibly empty.
 * @returns Prefix normalized to either `""` or `/segment[/segment…]`.
 * @throws {TypeError} If the prefix exceeds the length limit or contains an invalid segment.
 */
function normalizeEndpointPathPrefix(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  const withoutLeadingSlash = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!withoutLeadingSlash) {
    throw new TypeError(`${name} must not be only slashes`);
  }
  if (withoutLeadingSlash.length > maximumEndpointPathPrefixLength) {
    throw new TypeError(`${name} must be at most ${maximumEndpointPathPrefixLength} characters`);
  }
  const segments = withoutLeadingSlash.split("/").map((segment) => normalizeSegment(name, segment));
  return `/${segments.join("/")}`;
}

export class R2SigV4Signer implements ObjectUrlSigner {
  readonly #accessKeyId: string;
  readonly #bucket: string;
  readonly #host: string;
  readonly #now: () => Date;
  readonly #origin: string;
  readonly #pathPrefix: string;
  readonly #secretAccessKey: string;
  #signingKeyDate: string | undefined;
  #signingKey: Promise<CryptoKey> | undefined;

  /**
   * Initializes the AWS SigV4 presigner for Cloudflare R2 object storage.
   *
   * The endpoint must be an origin — no credentials, path, query, or fragment —
   * so the signed host is exactly what an operator configured and a caller can
   * never redirect a signed request elsewhere. HTTPS is required unless the
   * origin is loopback or the caller explicitly opted into the
   * development-only `allowInsecureEndpoint`, which is what lets a local
   * S3-compatible runtime reachable only over plain HTTP be signed without
   * weakening production defaults. Any path prefix is supplied separately
   * through `endpointPathPrefix` so it can take part in the canonical URI while
   * origin validation stays strict.
   *
   * @param options - Signer configuration including credentials, bucket, endpoint, and optional endpoint path prefix.
   * @throws {TypeError} If required options are missing, the endpoint is not an allowed origin, or the path prefix is invalid.
   */
  constructor(options: R2SigV4SignerOptions) {
    this.#accessKeyId = required("accessKeyId", options.accessKeyId);
    this.#bucket = normalizeSegment("bucket", options.bucket);
    const accountId = normalizeSegment("accountId", options.accountId);
    const endpoint = new URL(options.endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`);
    const loopbackHttpEndpoint =
      endpoint.protocol === "http:" &&
      ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname);
    if (
      endpoint.protocol !== "https:" &&
      !loopbackHttpEndpoint &&
      options.allowInsecureEndpoint !== true
    ) {
      throw new TypeError(
        "endpoint must use HTTPS unless it is loopback-only or insecure endpoints are explicitly allowed",
      );
    }
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/"
    ) {
      throw new TypeError("endpoint must not include credentials, a path, query, or fragment");
    }
    this.#host = endpoint.host;
    this.#origin = endpoint.origin;
    this.#pathPrefix = normalizeEndpointPathPrefix(
      "endpointPathPrefix",
      options.endpointPathPrefix,
    );
    this.#secretAccessKey = required("secretAccessKey", options.secretAccessKey);
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Caches and returns the derived signing key for the given UTC date stamp.
   *
   * @param date - Date stamp in YYYYMMDD format.
   * @returns Promise resolving to the cached or newly derived signing CryptoKey.
   */
  #signingKeyFor(date: string): Promise<CryptoKey> {
    if (!this.#signingKey || this.#signingKeyDate !== date) {
      this.#signingKeyDate = date;
      this.#signingKey = deriveSigningKey(this.#secretAccessKey, date);
    }
    return this.#signingKey;
  }

  /**
   * Generates a presigned PUT URL for direct single-part asset uploads.
   *
   * @param request - Upload signing request with key, contentType, contentLength, and expiry.
   * @returns Complete presigned HTTPS URL string with SigV4 query authentication.
   */
  signUpload(request: SignedUploadRequest): Promise<string> {
    return this.#sign("PUT", request);
  }

  /**
   * Generates a presigned PUT URL for uploading one part of a multipart upload session.
   *
   * @param request - Multipart part request with partNumber (1-10000), uploadId, and size.
   * @returns Complete presigned HTTPS part upload URL.
   */
  async signMultipartPart(request: SignedMultipartPartRequest): Promise<string> {
    if (
      !Number.isInteger(request.partNumber) ||
      request.partNumber < 1 ||
      request.partNumber > 10_000
    ) {
      throw new TypeError("partNumber must be between 1 and 10000");
    }
    return this.#sign(
      "PUT",
      request,
      new Map([
        ["partNumber", String(request.partNumber)],
        ["uploadId", required("uploadId", request.uploadId)],
      ]),
    );
  }

  /**
   * Generates a short-lived presigned GET URL for downloading or previewing an asset.
   *
   * @param request - Download request with key, expiry, and optional downloadFilename.
   * @returns Presigned HTTPS GET URL.
   */
  signDownload(request: SignedObjectRequest): Promise<string> {
    return this.#sign("GET", request);
  }

  /**
   * Generates a short-lived presigned PUT URL for one exact object key.
   *
   * Unlike `signUpload`, no `content-length` is signed, so the grant is usable
   * for output whose size is only known once it has been produced. The caller
   * must therefore verify the written object's real size and checksum before
   * treating the upload as complete.
   *
   * Passing `requiredHeaders` binds those headers into the signature, turning
   * the grant into a create-only write (`{"if-none-match": "*"}`): a consumer
   * that omits the header is rejected by the origin, and one that sends it
   * against an existing key gets a precondition failure instead of silently
   * overwriting an earlier attempt's bytes.
   *
   * @param request - Exact key, optional content type, optional required headers, and expiry in seconds.
   * @returns Presigned PUT URL scoped to that single key.
   * @throws {TypeError} On an invalid expiry, key segment, or required-header entry.
   */
  signObjectWrite(request: SignedObjectWriteRequest): Promise<string> {
    return this.#sign("PUT", request, undefined, request.requiredHeaders);
  }

  /**
   * Core SigV4 signing implementation for GET and PUT presigned URLs.
   * Constructs canonical request, string-to-sign, and calculates HMAC-SHA256 signature.
   *
   * `requiredHeaders` are folded into the canonical headers before signing, so
   * their names appear in `X-Amz-SignedHeaders` and the origin rejects a
   * request that does not carry them. The configured endpoint path prefix is
   * prepended to the canonical path so origins that serve the bucket under a
   * route still verify the signature, while `host` stays the signed origin.
   *
   * @param method - HTTP method ("GET" | "PUT").
   * @param request - Object request options.
   * @param operationParameters - Extra query parameters (e.g. partNumber, uploadId).
   * @param requiredHeaders - Extra headers bound into the signature; must be non-empty when provided.
   * @returns Signed URL string including all authentication query parameters.
   * @throws {TypeError} On invalid expiry, key segment, required-header entry, or an `expiresAt` deadline that elapsed before signing.
   */
  async #sign(
    method: "GET" | "PUT",
    request: SignedObjectRequest,
    operationParameters = new Map<string, string>(),
    requiredHeaders?: Readonly<Record<string, string>>,
  ): Promise<string> {
    validateExpiry(request.expiresInSeconds);
    const key = request.key
      .split("/")
      .map((segment) => normalizeSegment("key", segment))
      .join("/");
    // The signing instant is captured once so the X-Amz-Date credential scope
    // and the absolute-deadline clamp below agree on the same instant: a TTL
    // computed against an earlier clock than the signature's own date would
    // let a late signature outlive the caller's persisted deadline.
    const signingInstant = this.#now();
    const now = timestamp(signingInstant);
    let expiresInSeconds = request.expiresInSeconds;
    if (request.expiresAt !== undefined) {
      // Whole-second flooring keeps the grant strictly inside the deadline:
      // X-Amz-Date is itself truncated to seconds, so trunc(instant) +
      // floor(deadline - instant) can never exceed the deadline.
      const remainingSeconds = Math.floor(
        (request.expiresAt.getTime() - signingInstant.getTime()) / 1_000,
      );
      if (!(remainingSeconds >= 1)) {
        // An elapsed or malformed deadline is a hard failure rather than a
        // stretched grant: callers persist write holds, so minting a URL past
        // them would recreate bytes after their charge was released.
        throw new TypeError("expiresAt has already elapsed");
      }
      // The deadline only ever narrows the grant: the shorter of the
      // requested TTL and the remaining deadline wins, so a far-future
      // expiresAt can never widen a small expiresInSeconds.
      expiresInSeconds = Math.min(request.expiresInSeconds, remainingSeconds);
    }
    const scope = `${now.date}/auto/s3/aws4_request`;
    const headers = normalizedHeaders(this.#host, request, requiredHeaders);
    const signedHeaders = [...headers.keys()].sort().join(";");
    const parameters = new Map(operationParameters);
    if (request.downloadFilename !== undefined) {
      parameters.set("response-content-disposition", downloadDisposition(request.downloadFilename));
      parameters.set("response-content-type", "application/octet-stream");
    }
    parameters.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    parameters.set("X-Amz-Credential", `${this.#accessKeyId}/${scope}`);
    parameters.set("X-Amz-Date", now.value);
    parameters.set("X-Amz-Expires", String(expiresInSeconds));
    parameters.set("X-Amz-SignedHeaders", signedHeaders);

    const canonicalHeaders = [...headers]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}:${value.trim().replace(/\s+/g, " ")}\n`)
      .join("");
    const path = `${this.#pathPrefix}/${encode(this.#bucket)}${canonicalKey(key)}`;
    const query = canonicalQuery(parameters);
    const canonicalRequest = [
      method,
      path,
      query,
      canonicalHeaders,
      signedHeaders,
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      now.value,
      scope,
      await sha256(canonicalRequest),
    ].join("\n");
    const signingKey = await this.#signingKeyFor(now.date);
    const signature = hex(await signHmac(signingKey, stringToSign));
    parameters.set("X-Amz-Signature", signature);
    return `${this.#origin}${path}?${canonicalQuery(parameters)}`;
  }

  /**
   * Generates a presigned PUT URL as a typed Effect for direct single-part asset uploads.
   *
   * @param request - Upload signing request with key, contentType, contentLength, and expiry.
   * @returns Effect resolving to complete presigned HTTPS URL string with SigV4 query authentication.
   */
  signUploadEffect(request: SignedUploadRequest): Effect.Effect<string, InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) =>
        new InvalidRequestError({
          message: cause instanceof Error ? cause.message : "Failed to sign upload URL",
        }),
      try: () => this.signUpload(request),
    });
  }

  /**
   * Generates a presigned PUT URL as a typed Effect for uploading one part of a multipart upload session.
   *
   * @param request - Multipart part request with partNumber (1-10000), uploadId, and size.
   * @returns Effect resolving to complete presigned HTTPS part upload URL.
   */
  signMultipartPartEffect(
    request: SignedMultipartPartRequest,
  ): Effect.Effect<string, InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) =>
        new InvalidRequestError({
          message: cause instanceof Error ? cause.message : "Failed to sign multipart part URL",
        }),
      try: () => this.signMultipartPart(request),
    });
  }

  /**
   * Generates a short-lived presigned GET URL as a typed Effect for downloading or previewing an asset.
   *
   * @param request - Download request with key, expiry, and optional downloadFilename.
   * @returns Effect resolving to presigned HTTPS GET URL.
   */
  signDownloadEffect(request: SignedObjectRequest): Effect.Effect<string, InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) =>
        new InvalidRequestError({
          message: cause instanceof Error ? cause.message : "Failed to sign download URL",
        }),
      try: () => this.signDownload(request),
    });
  }
}

/**
 * Credential, endpoint, and environment bindings every worker needs to presign
 * R2 URLs. `R2_ENDPOINT` is operator configuration only; the development-only
 * permission to sign a plain-HTTP origin is derived from `ENVIRONMENT`, never
 * from a configurable flag.
 */
export interface R2SignerEnv {
  /** Worker environment label; only `local`/`test` may sign a plain-HTTP origin. */
  ENVIRONMENT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  /**
   * Trusted S3-compatible origin. Must be an origin with no path; plain HTTP is
   * accepted only for loopback hosts or when `ENVIRONMENT` is `local`/`test`.
   * Omit to sign the account's public R2 endpoint.
   */
  R2_ENDPOINT?: string;
  /**
   * Optional path prefix prepended to `/<bucket>/<key>` and to the signed
   * canonical URI, for origins that serve the bucket under a route (a local
   * runtime serves it at `/cdn-cgi/local/r2/s3`). Ignored without `R2_ENDPOINT`.
   */
  R2_ENDPOINT_PATH_PREFIX?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

/**
 * Builds the R2 SigV4 signer shared by upload, media-processing, and Provider
 * media jobs, from plain worker environment bindings.
 *
 * Centralizing construction keeps the optional endpoint wiring identical across
 * workers: a local stack that serves the same R2 bucket through a signed
 * S3-compatible route only needs the two endpoint variables set, while
 * production omits them and keeps the account's public endpoint. The
 * development-only permission to sign a plain-HTTP origin is derived here from
 * `ENVIRONMENT === "local" | "test"` alone, so no configuration value can turn
 * it on in a deployed environment. Credentials are validated eagerly so a
 * misconfigured worker fails closed instead of signing nothing.
 *
 * @param env - Worker bindings carrying the R2 credentials and optional endpoint settings.
 * @param now - Optional clock override for deterministic tests.
 * @returns Configured signer for exact-object GET, upload, and write grants.
 * @throws {TypeError} When any credential is missing or the endpoint/prefix is untrusted.
 */
export function createR2SignerFromEnv(env: R2SignerEnv, now?: () => Date): R2SigV4Signer {
  if (
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_ACCOUNT_ID ||
    !env.R2_BUCKET_NAME ||
    !env.R2_SECRET_ACCESS_KEY
  ) {
    throw new TypeError("R2 signing credentials are incomplete");
  }
  const developmentEnvironment = env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";
  return new R2SigV4Signer({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    accountId: env.R2_ACCOUNT_ID,
    allowInsecureEndpoint: developmentEnvironment,
    bucket: env.R2_BUCKET_NAME,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    ...(env.R2_ENDPOINT ? { endpoint: env.R2_ENDPOINT } : {}),
    ...(env.R2_ENDPOINT && env.R2_ENDPOINT_PATH_PREFIX
      ? { endpointPathPrefix: env.R2_ENDPOINT_PATH_PREFIX }
      : {}),
    ...(now ? { now } : {}),
  });
}

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
 * Effect service tag for Cloudflare R2 object storage and URL signing.
 */
export class StorageService extends Context.Service<StorageService, StorageServiceShape>()(
  "StorageService",
) {}

export interface CreateStorageServiceLiveOptions {
  bucket?: R2BucketLike;
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
 * Creates a live production Layer for StorageService backed by Cloudflare R2.
 * Wraps native R2 bucket bindings and SigV4 URL signer with typed Effects.
 * Bucket and signer availability are independent: signing needs credentials, not a
 * bucket binding. Missing object storage fails lazily with the supplied configuration
 * error (or the shared default), preserving caller validation order.
 *
 * @param options - Live configuration containing the R2 bucket and optional URL signer or credentials.
 * @returns Layer providing production StorageService.
 */
export function createStorageServiceLive(
  options: CreateStorageServiceLiveOptions,
): Layer.Layer<StorageService, never, never> {
  const store = options.bucket ? new R2ObjectStore(options.bucket) : undefined;
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
      store ? store.createMultipartUploadEffect(key, contentType) : storageUnavailable(),
    delete: (key) => (store ? store.deleteEffect(key) : storageUnavailable()),
    getMetadata: (key) => (store ? store.getMetadataEffect(key) : storageUnavailable()),
    head: (key) => (store ? store.headEffect(key) : storageUnavailable()),
    readPrefix: (key, maximumBytes) =>
      store ? store.readPrefixEffect(key, maximumBytes) : storageUnavailable(),
    readRange: (key, offset, maximumBytes) =>
      store ? store.readRangeEffect(key, offset, maximumBytes) : storageUnavailable(),
    resumeMultipartUpload: (key, uploadId) =>
      store ? store.resumeMultipartUploadEffect(key, uploadId) : storageUnavailable(),
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
 * Replaces live Cloudflare R2 bucket interactions with in-memory test doubles.
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
