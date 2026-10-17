import type { MultipartUpload, ObjectBody, ObjectMetadata, UploadedPart } from "./object-store";
import { EffectObjectStore } from "./object-store";
import type { SigV4Signer } from "./sigv4";
import { SigV4UrlSigner } from "./sigv4";

/**
 * Generic S3-compatible object storage.
 *
 * Lets an operator point Meltiply at any origin that speaks the S3 REST API
 * (MinIO, Ceph RGW, Wasabi, Backblaze B2's S3 endpoint, or an on-premises
 * gateway) instead of Cloudflare R2, while keeping one behavior contract:
 * the same conditional promotion, the same create-only write capabilities, and
 * the same error taxonomy as the R2 adapter.
 *
 * Every worker-issued call is signed with the `Authorization` header scheme
 * against a real payload digest, and every presigned capability uses the same
 * shared SigV4 core the R2 signer uses, so switching provider changes where
 * bytes live, never what Meltiply is allowed to do with them.
 */

const defaultRegion = "us-east-1";

/** HTTP status codes that mean "the conditional write did not apply". */
const preconditionStatuses = new Set([404, 409, 412]);

/**
 * Normalizes an S3 ETag header into the unquoted form Meltiply compares.
 *
 * @param value - Raw `ETag` header value, quoted by the S3 protocol.
 * @returns The ETag without its surrounding double quotes.
 */
function unquoteEtag(value: string | null): string {
  return (value ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
}

/**
 * Escapes the three XML metacharacters so operator-independent byte values
 * (ETags, which may contain `&`) round-trip through a request body.
 *
 * @param value - Raw text value.
 * @returns Text safe to embed in XML element content.
 */
function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Extracts the text of the first `<tag>` element from an S3 XML response.
 *
 * S3 returns tiny fixed-shape documents (upload ids, copy results), so a
 * targeted extraction keeps the adapter dependency-free while still decoding
 * the five predefined entities.
 *
 * @param xml - Response body text.
 * @param tag - Element name to read.
 * @returns Decoded element text, or null when the element is absent.
 */
function xmlText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  const text = match?.[1];
  return text === undefined
    ? null
    : text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * Converts a multipart part payload into the bytes an S3 part upload carries.
 *
 * @param value - ArrayBuffer, typed-array view, or Blob supplied by the caller.
 * @returns The underlying bytes of the value.
 */
async function toBytes(value: ArrayBuffer | ArrayBufferView | Blob): Promise<Uint8Array> {
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

/**
 * Converts a base64 SHA-256 checksum header into the hex form Meltiply stores.
 *
 * @param value - Raw `x-amz-checksum-sha256` header, base64 encoded.
 * @returns Hex digest, or null when the header is absent or malformed.
 */
function checksumHex(value: string | null): string | null {
  if (!value) return null;
  try {
    return [...Uint8Array.from(atob(value), (character) => character.charCodeAt(0))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/**
 * Renders an ETag as the quoted entity-tag an HTTP `If-Match`-style header
 * requires.
 *
 * `ObjectMetadata.etag` stores the unquoted form both providers agree on, while
 * the S3 wire protocol always quotes entity tags, so a pinned promotion must
 * re-quote it. Idempotent: an already-quoted value passes through unchanged.
 *
 * @param etag - Unquoted (or quoted) ETag.
 * @returns The quoted entity-tag.
 */
function quoteEtag(etag: string): string {
  return `"${unquoteEtag(etag)}"`;
}

/**
 * Parses a `Content-Length` header into a byte count.
 *
 * @param headers - Response headers from the origin.
 * @returns The declared length, or 0 when the origin omitted or malformed it.
 */
function contentLength(headers: Headers): number {
  const size = Number(headers.get("content-length") ?? "0");
  return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

/**
 * Derives {@link ObjectMetadata} from the response headers of a `HEAD`, or of
 * the `HEAD` that follows a successful write.
 */
function metadataFromHeaders(key: string, headers: Headers): ObjectMetadata {
  const lastModified = headers.get("last-modified");
  return {
    contentType: headers.get("content-type"),
    customMetadata: null,
    etag: unquoteEtag(headers.get("etag")),
    key,
    sha256: checksumHex(headers.get("x-amz-checksum-sha256")),
    size: contentLength(headers),
    uploadedAt: lastModified ? new Date(lastModified) : new Date(0),
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
  /** Signing region; defaults to `us-east-1`, which every S3-compatible origin accepts. */
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
  /**
   * @param options - Endpoint, region, addressing style, bucket, and credentials.
   * @throws {TypeError} When the endpoint, bucket, region, or credentials are invalid.
   */
  constructor(options: S3SigV4SignerOptions) {
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
   *
   * @returns Header-signing signer bound to the same endpoint and credentials.
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

  /**
   * @param options - Endpoint, region, addressing style, bucket, credentials, and optional fetch override.
   * @throws {TypeError} When the configuration cannot produce a trusted signer.
   */
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
   * will see.
   */
  async #send(input: {
    body?: Uint8Array;
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
    return this.#fetch(signed.url.toString(), {
      headers,
      method: input.method,
      ...(input.body ? { body: input.body.slice().buffer } : {}),
    });
  }

  /**
   * Rejects any unsuccessful response that is not an expected precondition
   * outcome, so a caller never mistakes an origin error for "object absent".
   */
  #expectOk(response: Response, action: string): void {
    if (!response.ok) {
      throw new Error(`${action} failed with status ${response.status}`);
    }
  }

  /** Releases an unread response body so the connection can be reused. */
  async #discard(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  /**
   * Retrieves metadata for an object without reading its body.
   *
   * @param key - Storage object key.
   * @returns ObjectMetadata if found, or null if the origin reports 404.
   */
  async head(key: string): Promise<ObjectMetadata | null> {
    const response = await this.#send({ key, method: "HEAD" });
    if (response.status === 404) {
      await this.#discard(response);
      return null;
    }
    this.#expectOk(response, "object metadata request");
    return metadataFromHeaders(key, response.headers);
  }

  /**
   * Streams a whole object for relay to an authenticated caller.
   *
   * @param key - Storage object key.
   * @returns Streaming body plus content type and size, or null when absent.
   */
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
    const response = await this.#send({
      headers: { range: `bytes=${offset}-${offset + maximumBytes - 1}` },
      key,
      method: "GET",
    });
    // A range past the end of the object is answered with 416; there is nothing
    // to return, and the caller treats a missing slice exactly like R2 does.
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
   *
   * @param key - Storage object key to delete.
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
   *
   * @param sourceKey - Existing source object key.
   * @param destinationKey - Destination object key; left untouched when it already exists.
   * @param options - `ifSourceEtagMatches`, `contentType`, and `ifDestinationAbsent` guards.
   * @returns Metadata of the copied object, or `null` when a precondition rejected the copy.
   * @throws {Error} When the origin reports any other failure.
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
    await this.#discard(response);
    return this.head(destinationKey);
  }

  /**
   * Initiates an S3 multipart upload session for large assets.
   *
   * @param key - Destination object key.
   * @param contentType - MIME content type recorded with the upload.
   * @returns MultipartUpload controller handle for uploading parts, completing, or aborting.
   */
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
   *
   * @param key - Destination object key.
   * @param uploadId - Active multipart upload ID.
   * @returns MultipartUpload controller handle.
   */
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    return this.#session(key, uploadId);
  }

  /** Builds the request-scoped multipart handle for one key and upload id. */
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
        await this.#discard(response);
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
