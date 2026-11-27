import { errorMessage, InvalidRequestError, isLoopbackHostname } from "@meltiply/domain";
import { Effect } from "effect";

import { bytesToHex } from "./encoding";
import { normalizeSegment } from "./keys";
import type {
  ObjectUrlSigner,
  SignedMultipartPartRequest,
  SignedObjectRequest,
  SignedObjectWriteRequest,
  SignedUploadRequest,
} from "./object-store";

const unescapedUriCharactersPattern = /[!'()*]/g;
const timestampSeparatorsPattern = /[:-]|\.\d{3}/g;
const whitespacePattern = /\s+/g;
const headerNamePattern = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const unsafeDownloadFilenamePattern = /[\u0000-\u001f\u007f"\\/]+/g;

type BucketAddressing = "path" | "virtual";

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

function required(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    unescapedUriCharactersPattern,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function normalizeKey(key: string): string {
  return key
    .split("/")
    .map((segment) => normalizeSegment("key", segment))
    .join("/");
}

function canonicalKey(key: string): string {
  return `/${key.split("/").map(encode).join("/")}`;
}

async function sha256Bytes(value: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", value));
}

function sha256(value: string): Promise<string> {
  return sha256Bytes(encoder.encode(value));
}

async function importHmacKey(key: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(key);
  return crypto.subtle.importKey("raw", keyBytes.buffer, { hash: "SHA-256", name: "HMAC" }, false, [
    "sign",
  ]);
}

function signHmac(key: CryptoKey, value: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  return signHmac(await importHmacKey(key), value);
}

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

function timestamp(now: Date): { date: string; value: string } {
  const value = now.toISOString().replace(timestampSeparatorsPattern, "");
  return { date: value.slice(0, 8), value };
}

function asciiCompare(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

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

export function validateSigV4Endpoint(rawEndpoint: string, allowInsecureEndpoint?: boolean): URL {
  const endpoint = new URL(rawEndpoint);
  const allowedHttpEndpoint =
    endpoint.protocol === "http:" &&
    (allowInsecureEndpoint === true || isLoopbackHostname(endpoint.hostname));
  if (endpoint.protocol !== "https:" && !allowedHttpEndpoint) {
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
  return endpoint;
}

function resolveTarget(options: {
  addressing: BucketAddressing;
  allowInsecureEndpoint?: boolean;
  bucket: string;
  endpoint: string;
  endpointPathPrefix?: string;
}): SigV4Target {
  const bucket = normalizeSegment("bucket", options.bucket);
  const endpoint = validateSigV4Endpoint(options.endpoint, options.allowInsecureEndpoint);
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

export class SigV4Signer {
  readonly #accessKeyId: string;
  readonly #now: () => Date;
  readonly #region: string;
  readonly #secretAccessKey: string;
  readonly #target: SigV4Target;
  #signingKeyDate: string | undefined;
  #signingKey: Promise<CryptoKey> | undefined;

  constructor(options: SigV4SignerOptions) {
    this.#accessKeyId = required("accessKeyId", options.accessKeyId);
    this.#region = required("region", options.region);
    this.#secretAccessKey = required("secretAccessKey", options.secretAccessKey);
    this.#target = resolveTarget(options);
    this.#now = options.now ?? (() => new Date());
  }

  #signingKeyFor(date: string): Promise<CryptoKey> {
    if (!this.#signingKey || this.#signingKeyDate !== date) {
      this.#signingKeyDate = date;
      this.#signingKey = deriveSigningKey(this.#secretAccessKey, date, this.#region, "s3");
    }
    return this.#signingKey;
  }

  #canonicalUri(key: string): string {
    const base =
      this.#target.addressing === "virtual"
        ? canonicalKey(key)
        : `/${encode(this.#target.bucket)}${canonicalKey(key)}`;
    return `${this.#target.pathPrefix}${base}`;
  }

  objectUrl(key: string, query?: ReadonlyMap<string, string>): URL {
    const url = new URL(`${this.#target.origin}${this.#canonicalUri(normalizeKey(key))}`);
    for (const [name, value] of query ?? []) {
      url.searchParams.set(name, value);
    }
    return url;
  }

  copySource(key: string): string {
    return `${this.#target.pathPrefix}/${encode(this.#target.bucket)}${canonicalKey(normalizeKey(key))}`;
  }

  prepareRequest(input: {
    body?: Uint8Array<ArrayBuffer> | null;
    headers?: Readonly<Record<string, string>>;
    key: string;
    method: string;
    query?: ReadonlyMap<string, string>;
  }): Promise<SignedRequest> {
    return this.#sign(this.objectUrl(input.key, input.query), input);
  }

  prepareBucketRequest(method: string): Promise<SignedRequest> {
    const segment = this.#target.addressing === "virtual" ? "" : `/${encode(this.#target.bucket)}`;
    return this.#sign(new URL(`${this.#target.origin}${this.#target.pathPrefix}${segment}`), {
      method,
    });
  }

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
      headers.set(rawName.trim().toLowerCase(), rawValue.trim().replace(whitespacePattern, " "));
    }
    headers.set("host", url.host);
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", now.value);
    const sortedEntries = [...headers].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const canonicalHeaders = sortedEntries.map(([name, value]) => `${name}:${value}\n`).join("");
    const signedHeaders = sortedEntries.map(([name]) => name).join(";");
    const canonicalRequest = [
      input.method,
      url.pathname,
      canonicalQuery(new Map(url.searchParams)),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const signature = bytesToHex(
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

  async presign(
    method: "GET" | "PUT",
    request: SignedObjectRequest,
    operationParameters = new Map<string, string>(),
    requiredHeaders?: Readonly<Record<string, string>>,
  ): Promise<string> {
    validateExpiry(request.expiresInSeconds);
    const key = normalizeKey(request.key);
    const signingInstant = this.#now();
    const now = timestamp(signingInstant);
    let expiresInSeconds = request.expiresInSeconds;
    if (request.expiresAt !== undefined) {
      const remainingSeconds = Math.floor(
        (request.expiresAt.getTime() - signingInstant.getTime()) / 1_000,
      );
      if (!(remainingSeconds >= 1)) {
        throw new TypeError("expiresAt has already elapsed");
      }
      expiresInSeconds = Math.min(request.expiresInSeconds, remainingSeconds);
    }
    const scope = `${now.date}/${this.#region}/s3/aws4_request`;
    const headers = normalizedHeaders(this.#target.host, request, requiredHeaders);
    const sortedHeaders = [...headers].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const signedHeaders = sortedHeaders.map(([name]) => name).join(";");
    const canonicalHeaders = sortedHeaders.map(([name, value]) => `${name}:${value}\n`).join("");
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
    const signature = bytesToHex(await signHmac(await this.#signingKeyFor(now.date), stringToSign));
    parameters.set("X-Amz-Signature", signature);
    return `${this.#target.origin}${path}?${canonicalQuery(parameters)}`;
  }
}

function validateExpiry(expiresInSeconds: number): void {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > maximumPresignSeconds
  ) {
    throw new TypeError(`expiresInSeconds must be between 1 and ${maximumPresignSeconds}`);
  }
}

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
      if (!headerNamePattern.test(name)) {
        throw new TypeError("requiredHeaders contains an invalid header name");
      }
      if (name === "host") {
        throw new TypeError("requiredHeaders must not override host");
      }
      const value = required(`requiredHeaders["${name}"]`, rawValue).replace(
        whitespacePattern,
        " ",
      );
      headers.set(name, value);
    }
  }
  return headers;
}

function downloadDisposition(filename: string): string {
  const normalized = filename.trim().replace(unsafeDownloadFilenamePattern, "_").slice(0, 180);
  if (!normalized) throw new TypeError("downloadFilename is required");
  return `attachment; filename="${normalized}"`;
}

export abstract class SigV4UrlSigner implements ObjectUrlSigner {
  protected readonly signer: SigV4Signer;

  protected constructor(options: SigV4SignerOptions) {
    this.signer = new SigV4Signer(options);
  }

  signUpload(request: SignedUploadRequest): Promise<string> {
    return this.signer.presign("PUT", request);
  }

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

  signDownload(request: SignedObjectRequest): Promise<string> {
    return this.signer.presign("GET", request);
  }

  signObjectWrite(request: SignedObjectWriteRequest): Promise<string> {
    return this.signer.presign("PUT", request, undefined, request.requiredHeaders);
  }

  signUploadEffect(request: SignedUploadRequest): Effect.Effect<string, InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) =>
        new InvalidRequestError({
          message: errorMessage(cause, "Failed to sign upload URL"),
        }),
      try: () => this.signUpload(request),
    });
  }

  signMultipartPartEffect(
    request: SignedMultipartPartRequest,
  ): Effect.Effect<string, InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) =>
        new InvalidRequestError({
          message: errorMessage(cause, "Failed to sign multipart part URL"),
        }),
      try: () => this.signMultipartPart(request),
    });
  }

  signDownloadEffect(request: SignedObjectRequest): Effect.Effect<string, InvalidRequestError> {
    return Effect.tryPromise({
      catch: (cause) =>
        new InvalidRequestError({
          message: errorMessage(cause, "Failed to sign download URL"),
        }),
      try: () => this.signDownload(request),
    });
  }
}
