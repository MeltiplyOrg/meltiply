import { assertValidByteRange, bytesToHex } from "./encoding";
import type { MultipartUpload, ObjectBody, ObjectMetadata, UploadedPart } from "./object-store";
import { EffectObjectStore } from "./object-store";
import type { SigV4Signer } from "./sigv4";
import { SigV4UrlSigner } from "./sigv4";

const weakEtagPrefixPattern = /^W\//;
const etagQuotesPattern = /^"|"$/g;
const xmlTextPatterns = {
  Code: /<Code>([\s\S]*?)<\/Code>/,
  UploadId: /<UploadId>([\s\S]*?)<\/UploadId>/,
};

const defaultRegion = "us-east-1";

const preconditionStatuses = new Set([404, 409, 412]);

function unquoteEtag(value: string | null): string {
  return (value ?? "").replace(weakEtagPrefixPattern, "").replace(etagQuotesPattern, "");
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlText(xml: string, tag: keyof typeof xmlTextPatterns): string | null {
  const match = xmlTextPatterns[tag].exec(xml);
  const text = match?.[1];
  return text === undefined
    ? null
    : text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&");
}

async function toBytes(
  value: ArrayBuffer | ArrayBufferView | Blob,
): Promise<Uint8Array<ArrayBuffer>> {
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return new Uint8Array(value);
}

function checksumHex(value: string | null): string | null {
  if (!value) return null;
  try {
    return bytesToHex(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

function quoteEtag(etag: string): string {
  return `"${unquoteEtag(etag)}"`;
}

function contentLength(headers: Headers): number {
  const size = Number(headers.get("content-length") ?? "0");
  return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

function metadataFromHeaders(key: string, headers: Headers): ObjectMetadata {
  const lastModified = headers.get("last-modified");
  const parsedDate = lastModified ? new Date(lastModified) : null;
  return {
    contentType: headers.get("content-type"),
    customMetadata: null,
    etag: unquoteEtag(headers.get("etag")),
    key,
    sha256: checksumHex(headers.get("x-amz-checksum-sha256")),
    size: contentLength(headers),
    uploadedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date(0),
    version: headers.get("x-amz-version-id"),
  };
}

/** Configuration for the S3-compatible SigV4 signer. */
export interface S3SigV4SignerOptions {
  accessKeyId: string;
  /**
   * Development-only: accept a plain-HTTP origin. Provider construction derives
   * this solely from `ENVIRONMENT === "local" | "test"`, never from a
   * configurable operator flag, so a deployed environment can only sign HTTPS.
   */
  allowInsecureEndpoint?: boolean;
  bucket: string;
  /** Origin only (no path, query, or fragment), e.g. `https://minio.internal:9000`. */
  endpoint: string;
  endpointPathPrefix?: string;
  /**
   * Put the bucket in the request path (`/bucket/key`) instead of the host
   * (`bucket.host/key`). Defaults to true, which is what MinIO, Ceph, and
   * other self-hosted origins require; AWS endpoints want `false`.
   */
  forcePathStyle?: boolean;
  now?: () => Date;
  /** Signing region; defaults to `us-east-1`. Set the origin's region when different. */
  region?: string;
  secretAccessKey: string;
}

/**
 * Presigned URL signer for any S3-compatible origin.
 *
 * Shares the SigV4 core with the R2 signer, so an upload, download, multipart
 * part, or create-only write capability is byte-compatible with what the
 * provider actually verifies.
 */
export class S3SigV4Signer extends SigV4UrlSigner {
  constructor(options: S3SigV4SignerOptions) {
    const protocol = new URL(options.endpoint).protocol;
    if (protocol !== "https:" && !(options.allowInsecureEndpoint && protocol === "http:")) {
      throw new TypeError("S3 endpoint must use HTTPS outside local or test environments");
    }
    super({
      accessKeyId: options.accessKeyId,
      ...(options.allowInsecureEndpoint ? { allowInsecureEndpoint: true } : {}),
      addressing: options.forcePathStyle === false ? "virtual" : "path",
      bucket: options.bucket,
      endpoint: options.endpoint,
      ...(options.endpointPathPrefix ? { endpointPathPrefix: options.endpointPathPrefix } : {}),
      ...(options.now ? { now: options.now } : {}),
      region: options.region ?? defaultRegion,
      secretAccessKey: options.secretAccessKey,
    });
  }

  /**
   * Signer for requests the worker issues itself against this origin.
   *
   * Presigned capabilities are for external consumers (browsers, the native
   * processor); the object store needs the header-authenticated form to read
   * metadata, copy objects, and drive multipart uploads without a public URL.
   */
  requestSigner(): SigV4Signer {
    return this.signer;
  }
}

/** Configuration for {@link S3ObjectStore}; identical to the signer options. */
export type S3ObjectStoreOptions = S3SigV4SignerOptions & {
  /** Fetch implementation override; defaults to the runtime global. */
  fetch?: typeof fetch;
};

/**
 * Object store backed by an S3-compatible REST API.
 *
 * Each operation mirrors the R2 adapter's contract exactly, including the two
 * conditions promotion depends on: the source copy is pinned to a known ETag and
 * the destination is only written when absent, so a rewritten staging object can
 * never be promoted and a replayed copy adopts the bytes an interrupted attempt
 * already wrote.
 */
export class S3ObjectStore extends EffectObjectStore {
  readonly #fetch: typeof fetch;
  readonly #signer: S3SigV4Signer;

  constructor(options: S3ObjectStoreOptions) {
    super();
    this.#signer = new S3SigV4Signer(options);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Issues one signed S3 request.
   *
   * `host` is dropped from the wire headers because the runtime derives it from
   * the URL, while the signed header block still contains the value the origin
   * will see. The bounded, non-shared payload view is hashed and sent without copying.
   */
  async #send(input: {
    body?: Uint8Array<ArrayBuffer>;
    headers?: Readonly<Record<string, string>>;
    key: string;
    method: string;
    query?: Readonly<Record<string, string>>;
  }): Promise<Response> {
    const signed = await this.#signer.requestSigner().prepareRequest({
      ...(input.body ? { body: input.body } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      key: input.key,
      method: input.method,
      ...(input.query ? { query: new Map(Object.entries(input.query)) } : {}),
    });
    const headers = new Headers(signed.headers);
    headers.delete("host");
    try {
      return await this.#fetch(signed.url.toString(), {
        headers,
        method: input.method,
        ...(input.body ? { body: input.body } : {}),
      });
    } catch (cause) {
      throw new Error("object storage transport failed", { cause });
    }
  }

  #expectOk(response: Response, action: string): void {
    if (!response.ok) {
      throw new Error(`${action} failed with status ${response.status}`);
    }
  }

  /** Releases an unread response body so the connection can be reused. */
  async #discard(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    const response = await this.#send({ key, method: "HEAD" });
    if (response.status === 404) {
      await this.#discard(response);
      return null;
    }
    this.#expectOk(response, "object metadata request");
    return metadataFromHeaders(key, response.headers);
  }

  async read(key: string): Promise<ObjectBody | null> {
    const response = await this.#send({ key, method: "GET" });
    if (response.status === 404) {
      await this.#discard(response);
      return null;
    }
    this.#expectOk(response, "object read");
    if (!response.body) {
      throw new TypeError("object body is unavailable");
    }
    return {
      body: response.body,
      contentType: response.headers.get("content-type"),
      size: contentLength(response.headers),
    };
  }

  async readRange(key: string, offset: number, maximumBytes: number): Promise<Uint8Array | null> {
    assertValidByteRange(offset, maximumBytes);
    const response = await this.#send({
      headers: { range: `bytes=${offset}-${offset + maximumBytes - 1}` },
      key,
      method: "GET",
    });
    if (response.status === 404 || response.status === 416) {
      await this.#discard(response);
      return null;
    }
    this.#expectOk(response, "object range read");
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Deletes an object from the bucket.
   *
   * A 404 is a success: deleting an already-removed key is a bucket no-op on
   * R2, and retention sweeps rely on that to retry an interrupted reclaim.
   */
  async delete(key: string): Promise<void> {
    const response = await this.#send({ key, method: "DELETE" });
    if (response.status === 404) {
      await this.#discard(response);
      return;
    }
    this.#expectOk(response, "object delete");
    await this.#discard(response);
  }

  /**
   * Copies an object inside the bucket using the origin's server-side copy API.
   *
   * The bytes never enter the worker, matching the R2 promotion path. The
   * source generation is pinned with `x-amz-copy-source-if-match`, and a
   * create-only destination is enforced both by probing for an existing object
   * (so a replay adopts it instead of failing) and by sending `If-None-Match: *`
   * on the copy itself.
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
    if (options.ifDestinationAbsent && (await this.head(destinationKey))) {
      return null;
    }
    const response = await this.#send({
      headers: {
        ...(options.contentType ? { "content-type": options.contentType } : {}),
        ...(options.contentType ? { "x-amz-metadata-directive": "REPLACE" } : {}),
        ...(options.ifDestinationAbsent ? { "if-none-match": "*" } : {}),
        ...(options.ifSourceEtagMatches
          ? { "x-amz-copy-source-if-match": quoteEtag(options.ifSourceEtagMatches) }
          : {}),
        "x-amz-copy-source": this.#signer.requestSigner().copySource(sourceKey),
      },
      key: destinationKey,
      method: "PUT",
    });
    if (!response.ok) {
      await this.#discard(response);
      if (preconditionStatuses.has(response.status)) return null;
      throw new Error(`object copy failed with status ${response.status}`);
    }
    const result = await response.text();
    if (!result.includes("<CopyObjectResult") || xmlText(result, "Code")) {
      throw new Error("object copy returned an S3 error or malformed result");
    }
    return this.head(destinationKey);
  }

  async createMultipartUpload(key: string, contentType: string): Promise<MultipartUpload> {
    const response = await this.#send({
      headers: { "content-type": contentType },
      key,
      method: "POST",
      query: { uploads: "" },
    });
    this.#expectOk(response, "multipart upload creation");
    const uploadId = xmlText(await response.text(), "UploadId");
    if (!uploadId) {
      throw new Error("multipart upload creation returned no UploadId");
    }
    return this.#session(key, uploadId);
  }

  /**
   * Resumes an in-flight S3 multipart upload session using its known uploadId.
   *
   * No request is issued: the handle is a pure function of the key and id, so a
   * redelivered job can re-drive an upload the worker started earlier.
   */
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    return this.#session(key, uploadId);
  }

  #session(key: string, uploadId: string): MultipartUpload {
    return {
      abort: async () => {
        const response = await this.#send({
          key,
          method: "DELETE",
          query: { uploadId },
        });
        if (response.status === 404) {
          await this.#discard(response);
          return;
        }
        this.#expectOk(response, "multipart upload abort");
        await this.#discard(response);
      },
      complete: async (parts) => {
        const body = new TextEncoder().encode(
          `<CompleteMultipartUpload>${parts
            .map(
              (part) =>
                `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`,
            )
            .join("")}</CompleteMultipartUpload>`,
        );
        const response = await this.#send({
          body,
          headers: { "content-type": "application/xml" },
          key,
          method: "POST",
          query: { uploadId },
        });
        this.#expectOk(response, "multipart upload completion");
        const result = await response.text();
        if (!result.includes("<CompleteMultipartUploadResult") || xmlText(result, "Code")) {
          throw new Error("multipart upload completion returned an S3 error or malformed result");
        }
        const metadata = await this.head(key);
        if (!metadata) {
          throw new Error("completed multipart upload produced no object");
        }
        return metadata;
      },
      uploadId,
      uploadPart: async (partNumber, value) => {
        const response = await this.#send({
          body: await toBytes(value),
          key,
          method: "PUT",
          query: { partNumber: String(partNumber), uploadId },
        });
        this.#expectOk(response, "multipart part upload");
        const etag = unquoteEtag(response.headers.get("etag"));
        await this.#discard(response);
        if (!etag) {
          throw new Error("multipart part upload returned no ETag");
        }
        return { etag, partNumber } satisfies UploadedPart;
      },
    };
  }
}
