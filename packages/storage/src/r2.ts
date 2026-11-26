import { assertValidByteRange, bytesToHex } from "./encoding";
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

function metadata(value: R2ObjectLike): ObjectMetadata {
  const sha256 = value.checksums?.sha256;
  return {
    contentType: value.httpMetadata?.contentType ?? null,
    customMetadata: value.customMetadata ?? null,
    etag: value.etag,
    key: value.key,
    sha256: sha256 ? bytesToHex(sha256) : null,
    size: value.size,
    uploadedAt: new Date(value.uploaded),
    version: value.version ?? null,
  };
}

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
  constructor(private readonly bucket: R2BucketLike) {
    super();
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    const object = await this.bucket.head(key);
    return object ? metadata(object) : null;
  }

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
    if (!source.body) return null;
    const copied = await this.bucket.put(destinationKey, source.body, {
      ...(options.contentType ? { httpMetadata: { contentType: options.contentType } } : {}),
      ...(options.ifDestinationAbsent ? { onlyIf: { etagDoesNotMatch: "*" } } : {}),
    });
    return copied ? metadata(copied) : null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

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

  async readRange(key: string, offset: number, maximumBytes: number): Promise<Uint8Array | null> {
    assertValidByteRange(offset, maximumBytes);
    const object = await this.bucket.get(key, {
      range: { length: maximumBytes, offset },
    });
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<MultipartUpload> {
    return multipart(
      await this.bucket.createMultipartUpload(key, { httpMetadata: { contentType } }),
    );
  }

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
  allowInsecureEndpoint?: boolean;
  bucket: string;
  endpoint?: string;
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
  constructor(options: R2SigV4SignerOptions) {
    super({
      accessKeyId: options.accessKeyId,
      ...(options.allowInsecureEndpoint ? { allowInsecureEndpoint: true } : {}),
      addressing: "path",
      bucket: options.bucket,
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
  ENVIRONMENT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ENDPOINT?: string;
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
