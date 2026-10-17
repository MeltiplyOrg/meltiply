import { normalizeSegment } from "./keys";
import { SigV4UrlSigner } from "./sigv4";
import type { MultipartUpload, ObjectBody, ObjectMetadata, UploadedPart } from "./object-store";
import { EffectObjectStore } from "./object-store";

/**
 * Minimal shape of the Cloudflare R2 bucket binding Meltiply depends on.
 *
 * Declared structurally so the adapter can be unit-tested without workerd and so
 * a self-hosted binding shim only has to implement what Meltiply calls.
 */
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

/** Wraps a native R2 multipart handle in Meltiply's provider-neutral contract. */
function multipart(upload: R2MultipartUploadLike): MultipartUpload {
  return {
    abort: () => upload.abort(),
    complete: async (parts) => metadata(await upload.complete(parts)),
    uploadId: upload.uploadId,
    uploadPart: (partNumber, value) => upload.uploadPart(partNumber, value),
  };
}

/**
 * Cloudflare R2 implementation of the object store.
 *
 * Promotion from the upload-writable `staging/` namespace to the protected
 * ready key is the store's security-critical operation, so the copy stays
 * inside the bucket: the source generation is pinned by ETag and the
 * destination is written only when absent.
 */
export class R2ObjectStore extends EffectObjectStore {
  /**
   * Initializes the object store wrapping a Cloudflare R2 bucket binding.
   *
   * @param bucket - R2 bucket or mock instance.
   */
  constructor(private readonly bucket: R2BucketLike) {
    super();
  }

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
   * Streams a whole object for relay to an authenticated caller.
   *
   * @param key - Storage object key.
   * @returns Streaming body plus content type and size, or null when absent.
   * @throws {TypeError} If the object exposes no readable body stream.
   */
  async read(key: string): Promise<ObjectBody | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    if (!object.body) {
      throw new TypeError("object body is unavailable");
    }
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType ?? null,
      size: object.size,
    };
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
    return multipart(
      await this.bucket.createMultipartUpload(key, { httpMetadata: { contentType } }),
    );
  }

  /**
   * Resumes an in-flight R2 multipart upload session using its known uploadId.
   *
   * @param key - Destination object key.
   * @param uploadId - Active multipart upload ID.
   * @returns MultipartUpload controller handle.
   */
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    return multipart(this.bucket.resumeMultipartUpload(key, uploadId));
  }
}

/**
 * Configuration for the R2 SigV4 signer.
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

/**
 * Presigned URL signer for Cloudflare R2.
 *
 * R2 is addressed path-style under the account's public endpoint and signed in
 * the `auto` region, which are the only differences from a generic
 * S3-compatible origin.
 */
export class R2SigV4Signer extends SigV4UrlSigner {
  /**
   * @param options - Signer configuration including credentials, bucket, endpoint, and optional endpoint path prefix.
   * @throws {TypeError} If required options are missing, the endpoint is not an allowed origin, or the path prefix is invalid.
   */
  constructor(options: R2SigV4SignerOptions) {
    super({
      accessKeyId: options.accessKeyId,
      ...(options.allowInsecureEndpoint ? { allowInsecureEndpoint: true } : {}),
      addressing: "path",
      bucket: options.bucket,
      // The account id becomes part of the signed host when no explicit endpoint
      // is configured, so it is validated as a path segment: an empty or
      // traversing value would otherwise mint URLs pointing at another origin.
      endpoint:
        options.endpoint ??
        `https://${normalizeSegment("accountId", options.accountId)}.r2.cloudflarestorage.com`,
      ...(options.endpointPathPrefix ? { endpointPathPrefix: options.endpointPathPrefix } : {}),
      ...(options.now ? { now: options.now } : {}),
      region: "auto",
      secretAccessKey: options.secretAccessKey,
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
 * Builds the R2 SigV4 signer from plain worker environment bindings.
 *
 * The development-only permission to sign a plain-HTTP origin is derived here
 * from `ENVIRONMENT === "local" | "test"` alone, so no configuration value can
 * turn it on in a deployed environment. Credentials are validated eagerly so a
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
