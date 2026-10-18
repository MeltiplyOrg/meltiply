import { InvalidRequestError } from "@meltiply/domain";
import { Effect } from "effect";

import { normalizeSegment } from "./keys";
import type {
  ObjectUrlSigner,
  SignedMultipartPartRequest,
  SignedObjectRequest,
  SignedObjectWriteRequest,
  SignedUploadRequest,
} from "./object-store";

/**
 * Shared AWS Signature Version 4 machinery for every object-storage provider
 * Meltiply can talk to.
 *
 * R2 and generic S3-compatible origins differ only in endpoint, region, and
 * bucket addressing style, so the canonical request, signing-key derivation,
 * and presigned-URL construction live here once. Both provider signers are thin
 * configurations of this class, which keeps a signature byte-identical no
 * matter which origin an operator selected.
 */

/** How the bucket is placed in the request target. */
type BucketAddressing = "path" | "virtual";

/** Resolved, validated origin + bucket placement the signer signs against. */
interface SigV4Target {
  addressing: BucketAddressing;
  bucket: string;
  host: string;
  origin: string;
  pathPrefix: string;
}

const encoder = new TextEncoder();
const maximumPresignSeconds = 7 * 24 * 60 * 60;
const maximumEndpointPathPrefixLength = 128;

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
 * Validates every segment of an object key before it reaches a request target.
 *
 * Rejecting traversal and control characters here means both the presigned URL
 * and the header-signed request URL agree on exactly one canonical path, and
 * `new URL()` can never normalize a caller-supplied key into a different one.
 *
 * @param key - Raw object key.
 * @returns The key with each segment trimmed.
 * @throws {TypeError} If any segment is empty, `.`, `..`, or contains control characters.
 */
function normalizeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => normalizeSegment("key", segment))
    .join("/");
}

/**
 * Canonicalizes an object key for SigV4 by percent-encoding each path segment.
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
 * Computes the SHA-256 hex digest of raw, non-shared bytes using WebCrypto.
 *
 * @param value - Buffer or bounded byte view to hash without copying its payload.
 * @returns 64-character lowercase hex digest.
 */
async function sha256Bytes(value: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", value));
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
 * Computes an HMAC-SHA256 signature for a UTF-8 string using a raw key buffer.
 *
 * @param key - Raw HMAC key bytes.
 * @param value - Message string to sign.
 * @returns Promise resolving to raw signature bytes in an ArrayBuffer.
 */
async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  return signHmac(await importHmacKey(key), value);
}

/**
 * Derives the AWS SigV4 signing key for a given date stamp using sequential HMAC-SHA256 operations.
 * Derivation path: "AWS4" + secret -> dateKey -> region -> service -> "aws4_request".
 *
 * @param secretAccessKey - Provider API token secret access key.
 * @param date - UTC date stamp string in YYYYMMDD format.
 * @param region - Signing region (`auto` for R2).
 * @param service - Signing service name, `s3` for object storage.
 * @returns Promise resolving to the derived CryptoKey for signing canonical requests.
 */
async function deriveSigningKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Promise<CryptoKey> {
  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
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
 * Normalizes an optional endpoint path prefix used by origins that serve the
 * bucket under a route instead of the bare host root.
 *
 * The prefix is kept separate from `endpoint` so origin validation stays strict,
 * yet the prefix can still take part in the canonical URI (a local Wrangler
 * runtime serves the bucket at `/cdn-cgi/local/r2/s3/<bucket>/<key>`). It is
 * rejected unless it is a bounded sequence of ordinary path segments, which
 * keeps it from smuggling traversal, empty segments, or a trailing slash that
 * would produce a double slash in the signed canonical path. Boundary slashes
 * are scanned once so even oversized invalid prefixes take linear time.
 *
 * @param name - Option name used in error messages.
 * @param value - Raw prefix, possibly with a leading slash, possibly empty.
 * @returns Prefix normalized to either `""` or `/segment[/segment…]`.
 * @throws {TypeError} If the prefix exceeds the length limit or contains an invalid segment.
 */
function normalizeEndpointPathPrefix(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed[start] === "/") start += 1;
  while (end > start && trimmed[end - 1] === "/") end -= 1;
  const withoutLeadingSlash = trimmed.slice(start, end);
  if (!withoutLeadingSlash) {
    throw new TypeError(`${name} must not be only slashes`);
  }
  if (withoutLeadingSlash.length > maximumEndpointPathPrefixLength) {
    throw new TypeError(`${name} must be at most ${maximumEndpointPathPrefixLength} characters`);
  }
  const segments = withoutLeadingSlash.split("/").map((segment) => normalizeSegment(name, segment));
  return `/${segments.join("/")}`;
}

/**
 * Resolves and validates the signed origin for a provider.
 *
 * The endpoint must be an origin — no credentials, path, query, or fragment —
 * so the signed host is exactly what an operator configured and a caller can
 * never redirect a signed request elsewhere. HTTPS is required unless the
 * origin is loopback or the caller explicitly opted into the development-only
 * `allowInsecureEndpoint`, which is what lets a local S3-compatible runtime
 * reachable only over plain HTTP be signed without weakening production
 * defaults.
 */
function resolveTarget(options: {
  addressing: BucketAddressing;
  allowInsecureEndpoint?: boolean;
  bucket: string;
  endpoint: string;
  endpointPathPrefix?: string;
}): SigV4Target {
  const bucket = normalizeSegment("bucket", options.bucket);
  const endpoint = new URL(options.endpoint);
  const loopbackHttpEndpoint =
    endpoint.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname);
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
  const host = options.addressing === "virtual" ? `${bucket}.${endpoint.host}` : endpoint.host;
  return {
    addressing: options.addressing,
    bucket,
    host,
    origin: `${endpoint.protocol}//${host}`,
    pathPrefix: normalizeEndpointPathPrefix("endpointPathPrefix", options.endpointPathPrefix),
  };
}

export interface SigV4SignerOptions {
  accessKeyId: string;
  /** Development-only: accept a plain-HTTP origin (see {@link resolveTarget}). */
  allowInsecureEndpoint?: boolean;
  addressing: BucketAddressing;
  bucket: string;
  endpoint: string;
  endpointPathPrefix?: string;
  now?: () => Date;
  region: string;
  secretAccessKey: string;
}

/** Canonical target plus signed header block produced for a worker-issued request. */
export interface SignedRequest {
  headers: Record<string, string>;
  url: URL;
}

/**
 * AWS SigV4 signer for one resolved origin.
 *
 * Serves both directions Meltiply needs:
 * 1. `presign*` — presigned URLs handed to browsers and the native processor,
 *    where the credential travels in the query string.
 * 2. `prepareRequest` — header-signed requests the worker itself issues
 *    against an S3-compatible API (metadata reads, ranged reads, deletes,
 *    server-side copies, and multipart lifecycle calls).
 */
export class SigV4Signer {
  readonly #accessKeyId: string;
  readonly #now: () => Date;
  readonly #region: string;
  readonly #secretAccessKey: string;
  readonly #target: SigV4Target;
  #signingKeyDate: string | undefined;
  #signingKey: Promise<CryptoKey> | undefined;

  /**
   * @param options - Credentials, resolved origin, bucket placement, and signing region.
   * @throws {TypeError} When credentials, bucket, region, or endpoint are invalid.
   */
  constructor(options: SigV4SignerOptions) {
    this.#accessKeyId = required("accessKeyId", options.accessKeyId);
    this.#region = required("region", options.region);
    this.#secretAccessKey = required("secretAccessKey", options.secretAccessKey);
    this.#target = resolveTarget(options);
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Caches and returns the derived signing key for the given UTC date stamp.
   *
   * One derivation per day per signer keeps a burst of presigned requests from
   * repeating four HMAC rounds each.
   *
   * @param date - Date stamp in YYYYMMDD format.
   * @returns Promise resolving to the cached or newly derived signing CryptoKey.
   */
  #signingKeyFor(date: string): Promise<CryptoKey> {
    if (!this.#signingKey || this.#signingKeyDate !== date) {
      this.#signingKeyDate = date;
      this.#signingKey = deriveSigningKey(this.#secretAccessKey, date, this.#region, "s3");
    }
    return this.#signingKey;
  }

  /**
   * Builds the canonical URI for one object key, including the optional path
   * prefix and, for path addressing, the bucket segment.
   */
  #canonicalUri(key: string): string {
    const base =
      this.#target.addressing === "virtual"
        ? canonicalKey(key)
        : `/${encode(this.#target.bucket)}${canonicalKey(key)}`;
    return `${this.#target.pathPrefix}${base}`;
  }

  /**
   * Builds the absolute URL for one object key with an optional query map.
   *
   * @param key - Object key.
   * @param query - Raw query parameters; left untouched by the caller.
   * @returns URL whose pathname is the canonical URI this signer signs.
   */
  objectUrl(key: string, query?: ReadonlyMap<string, string>): URL {
    const url = new URL(`${this.#target.origin}${this.#canonicalUri(normalizeKey(key))}`);
    for (const [name, value] of query ?? []) {
      url.searchParams.set(name, value);
    }
    return url;
  }

  /**
   * Builds the `x-amz-copy-source` value for a server-side copy.
   *
   * The S3 copy API always names the bucket in the path, even under
   * virtual-hosted addressing, so this is derived from the bucket rather than
   * from {@link objectUrl}. The leading slash is the AWS-specified form that
   * S3, MinIO, and Ceph all accept; an origin that rejects it is
   * non-conformant, and dropping the slash to satisfy one would break every
   * conforming origin.
   *
   * The bundled gateway does not implement server-side copy. The external
   * `S3_CHECK_ENDPOINT` mode of `bun run storage:s3:check` verifies this against
   * MinIO, including source-ETag and destination-absence guards.
   *
   * @param key - Source object key.
   * @returns Encoded, bucket-qualified source path.
   */
  copySource(key: string): string {
    return `${this.#target.pathPrefix}/${encode(this.#target.bucket)}${canonicalKey(normalizeKey(key))}`;
  }

  /**
   * Signs one worker-issued request with the `Authorization` header scheme.
   *
   * The payload digest is computed from the request body whenever there is
   * one, which is what generic S3-compatible origins require; bodyless calls
   * use the standard empty-payload digest. `host` is taken from the resolved
   * URL rather than a caller-supplied header, so a signed request can never be
   * replayed against another origin.
   *
   * @param input - Method, object key, query map, extra headers, and optional non-shared body view.
   * @returns Absolute request URL plus the complete signed header set.
   */
  prepareRequest(input: {
    body?: Uint8Array<ArrayBuffer> | null;
    headers?: Readonly<Record<string, string>>;
    key: string;
    method: string;
    query?: ReadonlyMap<string, string>;
  }): Promise<SignedRequest> {
    return this.#sign(this.objectUrl(input.key, input.query), input);
  }

  /**
   * Signs a request addressed at the bucket itself rather than an object, which
   * is what CreateBucket and HeadBucket require.
   *
   * Kept separate from {@link prepareRequest} because the bucket path is not an
   * object key and must not be run through key validation.
   *
   * @param method - HTTP method, normally `PUT` for CreateBucket.
   * @returns Absolute bucket URL plus the complete signed header set.
   */
  prepareBucketRequest(method: string): Promise<SignedRequest> {
    // Path-style naming keeps the bucket in the path; virtual-hosted addressing
    // has already moved it into the host, leaving the bare prefix.
    const segment = this.#target.addressing === "virtual" ? "" : `/${encode(this.#target.bucket)}`;
    return this.#sign(new URL(`${this.#target.origin}${this.#target.pathPrefix}${segment}`), {
      method,
    });
  }

  /**
   * Signs the supplied URL and headers, deriving every SigV4 input from them.
   *
   * @param url - Absolute request URL, whose query is canonicalized as given.
   * @param input - Method, extra headers, and optional non-shared body view.
   * @returns Absolute request URL plus the complete signed header set.
   */
  async #sign(
    url: URL,
    input: {
      body?: Uint8Array<ArrayBuffer> | null;
      headers?: Readonly<Record<string, string>>;
      method: string;
    },
  ): Promise<SignedRequest> {
    const now = timestamp(this.#now());
    const payloadHash = input.body
      ? await sha256Bytes(input.body)
      : await sha256Bytes(new ArrayBuffer(0));
    const headers = new Map<string, string>();
    for (const [rawName, rawValue] of Object.entries(input.headers ?? {})) {
      headers.set(rawName.trim().toLowerCase(), rawValue.trim().replace(/\s+/g, " "));
    }
    headers.set("host", url.host);
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", now.value);
    const canonicalHeaders = [...headers]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}:${value}\n`)
      .join("");
    const signedHeaders = [...headers.keys()].sort().join(";");
    const canonicalRequest = [
      input.method,
      url.pathname,
      canonicalQuery(new Map(url.searchParams)),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const signature = hex(
      await signHmac(
        await this.#signingKeyFor(now.date),
        [
          "AWS4-HMAC-SHA256",
          now.value,
          `${now.date}/${this.#region}/s3/aws4_request`,
          await sha256(canonicalRequest),
        ].join("\n"),
      ),
    );
    return {
      headers: {
        ...Object.fromEntries(headers),
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${now.date}/${this.#region}/s3/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      url,
    };
  }

  /**
   * Core SigV4 presigning implementation for GET and PUT URLs.
   *
   * @param method - HTTP method ("GET" | "PUT").
   * @param request - Object request options.
   * @param operationParameters - Extra query parameters (e.g. partNumber, uploadId).
   * @param requiredHeaders - Extra headers bound into the signature; must be non-empty when provided.
   * @returns Signed URL string including all authentication query parameters.
   * @throws {TypeError} On invalid expiry, key segment, required-header entry, or an `expiresAt` deadline that elapsed before signing.
   */
  async presign(
    method: "GET" | "PUT",
    request: SignedObjectRequest,
    operationParameters = new Map<string, string>(),
    requiredHeaders?: Readonly<Record<string, string>>,
  ): Promise<string> {
    validateExpiry(request.expiresInSeconds);
    const key = normalizeKey(request.key);
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
    const scope = `${now.date}/${this.#region}/s3/aws4_request`;
    const headers = normalizedHeaders(this.#target.host, request, requiredHeaders);
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
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}:${value}\n`)
      .join("");
    const path = this.#canonicalUri(key);
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
    const signature = hex(await signHmac(await this.#signingKeyFor(now.date), stringToSign));
    parameters.set("X-Amz-Signature", signature);
    return `${this.#target.origin}${path}?${canonicalQuery(parameters)}`;
  }
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
 * @param host - Signed request host name.
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

/**
 * Shared {@link ObjectUrlSigner} implementation over a {@link SigV4Signer}.
 *
 * Subclasses only fix the endpoint, region, and addressing style; every
 * presigned capability (download, single-part upload, multipart part, and the
 * create-only exact-object write) is derived here so providers cannot drift
 * apart in what they grant.
 */
export abstract class SigV4UrlSigner implements ObjectUrlSigner {
  protected readonly signer: SigV4Signer;

  /**
   * @param options - Fully resolved SigV4 signer configuration.
   */
  protected constructor(options: SigV4SignerOptions) {
    this.signer = new SigV4Signer(options);
  }

  /**
   * Generates a presigned PUT URL for direct single-part asset uploads.
   *
   * @param request - Upload signing request with key, contentType, contentLength, and expiry.
   * @returns Complete presigned HTTPS URL string with SigV4 query authentication.
   */
  signUpload(request: SignedUploadRequest): Promise<string> {
    return this.signer.presign("PUT", request);
  }

  /**
   * Generates a presigned PUT URL for uploading one part of a multipart upload session.
   *
   * @param request - Multipart part request with partNumber (1-10000), uploadId, and size.
   * @returns Complete presigned HTTPS part upload URL.
   * @throws {TypeError} When partNumber is outside 1..10000 or uploadId is blank.
   */
  async signMultipartPart(request: SignedMultipartPartRequest): Promise<string> {
    if (
      !Number.isInteger(request.partNumber) ||
      request.partNumber < 1 ||
      request.partNumber > 10_000
    ) {
      throw new TypeError("partNumber must be between 1 and 10000");
    }
    return this.signer.presign(
      "PUT",
      request,
      new Map([
        ["partNumber", String(request.partNumber)],
        ["uploadId", required("uploadId", request.uploadId)],
      ]),
    );
  }

  /**
   * Generates a short-lived presigned GET URL for downloading or previewing an object.
   *
   * @param request - Download request with key, expiry, and optional downloadFilename.
   * @returns Presigned HTTPS GET URL.
   */
  signDownload(request: SignedObjectRequest): Promise<string> {
    return this.signer.presign("GET", request);
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
    return this.signer.presign("PUT", request, undefined, request.requiredHeaders);
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
