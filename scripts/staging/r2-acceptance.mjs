#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runCommand } from "../release/command-runner.mjs";
import {
  assertIacState,
  sha256,
  verifyReleaseCheckout,
  writeEvidence,
} from "../release/release-guard.mjs";
import { readBoundedJsonResponse } from "../release/release-http.mjs";
import { loadReleaseInputs, redactError } from "../release/release-lib.mjs";

const MULTIPART_THRESHOLD_BYTES = 25 * 1024 * 1024;
const MINIMUM_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const MAXIMUM_MULTIPART_PART_BYTES = 16 * 1024 * 1024;
const DEFAULT_MULTIPART_BYTES = MULTIPART_THRESHOLD_BYTES + 1;
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MINIMUM_TRANSFER_BYTES_PER_SECOND = 1024 * 1024;
const TRANSFER_GRACE_MS = 30 * 1000;
const MAXIMUM_TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,99}$/;
const EVIDENCE_FILENAME_PATTERN = /^[a-z0-9][a-z0-9.-]*\.json$/;
const MAXIMUM_API_RESPONSE_BYTES = 1024 * 1024;
const ACCEPTANCE_PLANS = new Set(["agency", "creator"]);
const ACTIVE_BILLING_STATUSES = new Set(["active", "trialing"]);
const OPTION_NAMES = new Set([
  "--confirm",
  "--iac-outputs",
  "--input",
  "--multipart-bytes",
  "--output",
  "--poll-timeout-ms",
]);
const SAFE_SIGNED_HEADERS = new Set([
  "content-length",
  "content-type",
  "x-amz-checksum-crc32",
  "x-amz-checksum-crc32c",
  "x-amz-checksum-sha1",
  "x-amz-checksum-sha256",
]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Asserts that a string is defined, non-empty, and trims surrounding whitespace.
 *
 * @param {string|undefined|null} value - Candidate string value
 * @param {string} name - Field name for error message
 * @returns {string} Trimmed non-empty string
 * @throws {Error} If value is missing or empty after trimming
 */
function requiredString(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

/**
 * Asserts that a value parses to a positive safe integer within maximum bounds.
 *
 * @param {unknown} value - Candidate numeric value or string representation
 * @param {string} name - Field name for error message
 * @param {number} maximum - Upper bound inclusive
 * @returns {number} Parsed positive integer
 * @throws {Error} If value is not a safe integer or falls outside 1..maximum
 */
function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

/**
 * Extracts a non-flag option value following a specific CLI option switch.
 *
 * @param {Array<string>} args - Command line arguments
 * @param {number} index - Index of the option flag
 * @param {string} name - Option flag name
 * @returns {string} Option argument value
 * @throws {Error} If next argument is missing or starts with '--'
 */
function optionValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

/**
 * Parses and validates command-line arguments for the staging R2 acceptance probe.
 *
 * Enforces single-specification of options, validates --apply and --confirm mutual dependence,
 * asserts that multipart size exceeds 25 MiB threshold, and verifies safe JSON output filenames.
 *
 * @param {Array<string>} args - Process command-line arguments (process.argv.slice(2))
 * @returns {Readonly<{ apply: boolean, confirm: string|undefined, iacOutputsPath: string, inputPath: string, multipartBytes: number, outputPath: string, pollTimeoutMs: number }>} Validated immutable parsed arguments
 * @throws {Error} If options are duplicate, unknown, or values are invalid
 */
export function parseR2AcceptanceArguments(args) {
  const values = new Map();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      if (apply) throw new Error("--apply may be specified only once");
      apply = true;
      continue;
    }
    if (!OPTION_NAMES.has(argument)) {
      throw new Error(`unknown option: ${argument}`);
    }
    if (values.has(argument)) {
      throw new Error(`${argument} may be specified only once`);
    }
    values.set(argument, optionValue(args, index, argument));
    index += 1;
  }

  if (!apply && values.has("--confirm")) {
    throw new Error("--confirm is valid only with --apply");
  }
  const multipartBytes = positiveInteger(
    values.get("--multipart-bytes") ?? DEFAULT_MULTIPART_BYTES,
    "--multipart-bytes",
    MAX_MEDIA_BYTES,
  );
  if (multipartBytes <= MULTIPART_THRESHOLD_BYTES) {
    throw new Error("--multipart-bytes must exceed the 25 MiB multipart threshold");
  }

  const inputPath = resolve(requiredString(values.get("--input"), "--input"));
  const iacOutputsPath = resolve(requiredString(values.get("--iac-outputs"), "--iac-outputs"));
  const outputPath = resolve(values.get("--output") ?? ".release/r2-acceptance.json");
  if (!EVIDENCE_FILENAME_PATTERN.test(basename(outputPath))) {
    throw new Error("--output must end in a safe lowercase JSON filename");
  }

  return Object.freeze({
    apply,
    confirm: values.get("--confirm"),
    iacOutputsPath,
    inputPath,
    multipartBytes,
    outputPath,
    pollTimeoutMs: positiveInteger(
      values.get("--poll-timeout-ms") ?? DEFAULT_POLL_TIMEOUT_MS,
      "--poll-timeout-ms",
      30 * 60 * 1000,
    ),
  });
}

/**
 * Binds parsed CLI arguments to verified release inputs and IaC target configuration.
 *
 * Enforces active IaC state, validates exact confirmation phrase on --apply,
 * and compiles cryptographic SHA-256 hashes of release inputs and IaC outputs.
 *
 * @param {object} parsed - Parsed CLI options from parseR2AcceptanceArguments
 * @param {{ iac: object, spec: object }} inputs - Loaded release inputs and IaC state
 * @param {string} [repoRoot=REPO_ROOT] - Repository root directory path
 * @returns {Readonly<object>} Bound immutable R2 acceptance execution options
 * @throws {Error} If IaC state is not active or confirmation phrase mismatches
 */
export function prepareR2AcceptanceOptions(parsed, { iac, spec }, repoRoot = REPO_ROOT) {
  assertIacState(iac, "active", spec);
  const expectedConfirmation = `r2 staging ${spec.git_sha}`;
  if (parsed.apply && parsed.confirm !== expectedConfirmation) {
    throw new Error(`--apply requires --confirm ${JSON.stringify(expectedConfirmation)}`);
  }
  return Object.freeze({
    apiOrigin: spec.api_base_url,
    apply: parsed.apply,
    browserOrigin: spec.frontend_url,
    bucketName: iac.assets_bucket,
    gitSha: spec.git_sha,
    iacOutputsSha256: sha256(JSON.stringify(iac)),
    multipartBytes: parsed.multipartBytes,
    outputPath: parsed.outputPath,
    pollTimeoutMs: parsed.pollTimeoutMs,
    r2Origin: `https://${spec.runtime.r2_account_id}.r2.cloudflarestorage.com`,
    releaseId: spec.release_id,
    releaseInputSha256: sha256(JSON.stringify(spec)),
    releaseSpec: spec,
    repoRoot,
  });
}

/**
 * Validates whether a value conforms to safe alphanumeric request identifier constraints.
 *
 * @param {unknown} value - Candidate identifier string
 * @returns {string|undefined} Validated identifier string, or undefined if invalid
 */
function safeIdentifier(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Splits a comma-delimited HTTP header string into a normalized lowercase Set of token names.
 *
 * @param {string|null|undefined} value - Raw HTTP header value
 * @returns {Set<string>} Set of lowercase trimmed token strings
 */
function headerTokens(value) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Safely parses an API error response body to extract its machine-readable error code.
 *
 * @param {Response} response - HTTP response object
 * @returns {Promise<string>} Extracted safe error code or fallback description
 */
async function responseErrorCode(response) {
  try {
    const body = await readBoundedJsonResponse(
      response,
      MAXIMUM_API_RESPONSE_BYTES,
      "API response",
    );
    return safeIdentifier(body?.error?.code) ?? "unknown_error";
  } catch {
    return "invalid_error_response";
  }
}

/**
 * Executes an HTTP fetch request with an enforced timeout and disallows redirects.
 *
 * @param {typeof fetch} fetchImpl - HTTP client function
 * @param {URL|string} url - Target URL
 * @param {RequestInit} [init] - Fetch request options
 * @param {number} [timeoutMs=60000] - Timeout in milliseconds
 * @returns {Promise<Response>} HTTP response
 */
async function timedFetch(fetchImpl, url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  return fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Computes an adaptive request timeout based on expected payload size and minimum transfer speed.
 *
 * Ensures slow networks or large multipart chunk transfers do not trigger premature aborts
 * while strictly bounding maximum wait time to 10 minutes.
 *
 * @param {number} bytes - Payload size in bytes
 * @returns {number} Milliseconds to allow for transfer
 */
function transferTimeoutForBytes(bytes) {
  return Math.min(
    MAXIMUM_TRANSFER_TIMEOUT_MS,
    Math.max(
      REQUEST_TIMEOUT_MS,
      Math.ceil((bytes / MINIMUM_TRANSFER_BYTES_PER_SECOND) * 1_000) + TRANSFER_GRACE_MS,
    ),
  );
}

/**
 * Asserts that a signed R2 URL conforms strictly to security and domain invariants.
 *
 * Enforces HTTPS scheme, matching R2 storage origin, absence of embedded credentials/hashes,
 * presence of AWS signature parameter, exact target bucket name match, and non-root object key path.
 *
 * @param {string} value - Signed URL string to inspect
 * @param {{ bucketName: string, origin: string }} target - Expected bucket and origin context
 * @param {string} label - Operation classification for error diagnostics
 * @returns {URL} Parsed and validated URL instance
 * @throws {Error} If URL violates security invariants or targets an unexpected bucket/origin
 */
function validateTargetUrl(value, target, label) {
  const url = new URL(value);
  let bucket;
  try {
    bucket = decodeURIComponent(url.pathname.split("/")[1] ?? "");
  } catch {
    throw new Error(`API returned an unsafe signed ${label} URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== target.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.has("X-Amz-Signature") ||
    bucket !== target.bucketName ||
    url.pathname.split("/").filter(Boolean).length < 2
  ) {
    throw new Error(`API returned an unsafe signed ${label} URL`);
  }
  return url;
}

/**
 * Extracts and records a required tracing request ID from HTTP response headers.
 *
 * Searches for 'x-request-id', 'x-amz-request-id', or Cloudflare 'cf-ray' headers,
 * asserting that at least one valid identifier is present to support request tracing.
 *
 * @param {Response} response - HTTP response object
 * @param {string} service - Service name for error diagnostics ("API", "R2 CORS", "R2 PUT", etc.)
 * @param {Set<string>} [requestIds] - Optional accumulator set to collect unique request IDs
 * @returns {string} Validated request ID
 * @throws {Error} If response omits all recognized request tracking headers
 */
function requiredResponseRequestId(response, service, requestIds) {
  const requestId =
    safeIdentifier(response.headers.get("x-request-id")) ??
    safeIdentifier(response.headers.get("x-amz-request-id")) ??
    safeIdentifier(response.headers.get("cf-ray"));
  if (!requestId) {
    throw new Error(`${service} response omitted a safe request ID`);
  }
  requestIds?.add(requestId);
  return requestId;
}

/**
 * Validates the structure, headers, and lifetime of an API-generated signed PUT request.
 *
 * Verifies HTTP method is PUT, validates the target R2 URL, ensures only safe signed headers
 * are passed, and asserts that the signed expiration is strictly in the future.
 *
 * @param {object} request - Signed request descriptor returned from API
 * @param {{ bucketName: string, origin: string }} target - Expected R2 bucket and origin
 * @returns {URL} Validated signed target URL
 * @throws {Error} If request method, headers, or expiry timestamp are invalid
 */
function validateSignedRequest(request, target) {
  if (!request || request.method !== "PUT" || typeof request.url !== "string") {
    throw new Error("API returned an invalid signed PUT request");
  }
  const url = validateTargetUrl(request.url, target, "PUT");
  if (!request.headers || typeof request.headers !== "object" || Array.isArray(request.headers)) {
    throw new Error("API returned signed PUT request without headers");
  }
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      !SAFE_SIGNED_HEADERS.has(name.toLowerCase()) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value)
    ) {
      throw new Error("API returned an unsafe signed PUT header");
    }
  }
  const expiry = Date.parse(request.expires_at);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error("API returned an expired signed PUT request");
  }
  return url;
}

/**
 * Verifies that Cloudflare R2 responds correctly to a CORS preflight OPTIONS request.
 *
 * Sends an OPTIONS preflight for the signed PUT URL with the exact browser origin and
 * requested headers, asserting that R2 returns 200 OK, mirrors the exact staging browser origin,
 * permits the PUT method, and authorizes all signed request headers.
 *
 * @param {object} request - Signed PUT request descriptor
 * @param {string} browserOrigin - Expected frontend browser origin (e.g., https://staging.meltiply.com)
 * @param {{ bucketName: string, origin: string }} target - Expected R2 bucket and origin
 * @param {typeof fetch} [fetchImpl=fetch] - HTTP client implementation
 * @param {Set<string>} [requestIds] - Request ID accumulator set
 * @returns {Promise<{ requestId: string }>} Traced preflight request ID
 * @throws {Error} If CORS preflight fails, returns wrong origin, or disallows required headers/methods
 */
export async function verifySignedPutCors(
  request,
  browserOrigin,
  target,
  fetchImpl = fetch,
  requestIds,
) {
  const url = validateSignedRequest(request, target);
  const requestedHeaders = Object.keys(request.headers).map((name) => name.toLowerCase());
  const response = await timedFetch(fetchImpl, url, {
    headers: {
      "Access-Control-Request-Headers": requestedHeaders.join(","),
      "Access-Control-Request-Method": "PUT",
      Origin: browserOrigin,
    },
    method: "OPTIONS",
  });
  try {
    const requestId = requiredResponseRequestId(response, "R2 CORS", requestIds);
    if (!response.ok) {
      throw new Error(`R2 CORS preflight failed (${response.status})`);
    }
    if (response.headers.get("access-control-allow-origin") !== browserOrigin) {
      throw new Error("R2 CORS did not return the exact staging browser origin");
    }
    const methods = headerTokens(response.headers.get("access-control-allow-methods"));
    if (!methods.has("put")) throw new Error("R2 CORS does not allow PUT");
    const allowedHeaders = headerTokens(response.headers.get("access-control-allow-headers"));
    for (const header of requestedHeaders) {
      if (!allowedHeaders.has("*") && !allowedHeaders.has(header)) {
        throw new Error(`R2 CORS does not allow signed header ${header}`);
      }
    }
    return { requestId };
  } finally {
    await response.body?.cancel();
  }
}

/**
 * Uploads payload bytes to a signed R2 PUT URL and verifies CORS and ETag response headers.
 *
 * Transmits the binary body with an adaptive transfer timeout, asserting that the upload succeeds,
 * mirrors the browser origin in CORS headers, and exposes the required ETag header.
 *
 * @param {object} options - Upload options
 * @param {Uint8Array} options.body - Binary payload bytes to upload
 * @param {string} options.browserOrigin - Frontend origin for CORS verification
 * @param {{ bucketName: string, origin: string }} options.target - Expected R2 target configuration
 * @param {typeof fetch} [options.fetchImpl=fetch] - HTTP client implementation
 * @param {object} options.request - Signed request containing URL and headers
 * @param {Set<string>} [options.requestIds] - Request ID accumulator
 * @param {boolean} [options.requireEtag=false] - Whether an explicit ETag is strictly required (for multipart parts)
 * @returns {Promise<{ etag: string|null, requestId: string }>} Upload ETag and tracing request ID
 * @throws {Error} If upload fails, origin is omitted, or required ETag is missing
 */
export async function uploadSignedPart({
  body,
  browserOrigin,
  target,
  fetchImpl = fetch,
  request,
  requestIds,
  requireEtag = false,
}) {
  const url = validateSignedRequest(request, target);
  const response = await timedFetch(
    fetchImpl,
    url,
    {
      body,
      headers: { ...request.headers, Origin: browserOrigin },
      method: "PUT",
    },
    transferTimeoutForBytes(body.byteLength),
  );
  try {
    const requestId = requiredResponseRequestId(response, "R2 PUT", requestIds);
    if (!response.ok) {
      throw new Error(`signed R2 PUT failed (${response.status})`);
    }
    if (response.headers.get("access-control-allow-origin") !== browserOrigin) {
      throw new Error("signed R2 PUT omitted the exact CORS origin");
    }
    const exposed = headerTokens(response.headers.get("access-control-expose-headers"));
    if (!exposed.has("etag")) {
      throw new Error("signed R2 PUT does not expose ETag to the browser");
    }
    const etag = response.headers.get("etag");
    if (requireEtag && !etag) {
      throw new Error("multipart R2 PUT returned no ETag");
    }
    return {
      etag,
      requestId,
    };
  } finally {
    await response.body?.cancel();
  }
}

/**
 * Verifies that Cloudflare R2 enforces exact signed Content-Length limits by rejecting oversized uploads.
 *
 * Appends an extra byte to the payload and verifies that R2 immediately returns 403 Forbidden,
 * proving that presigned URL size constraints cannot be breached.
 *
 * @param {object} options - Size rejection probe options
 * @param {Uint8Array} options.body - Base payload bytes
 * @param {string} options.browserOrigin - Origin header value
 * @param {{ bucketName: string, origin: string }} options.target - Target R2 bucket and origin
 * @param {typeof fetch} options.fetchImpl - HTTP client implementation
 * @param {object} options.request - Signed request descriptor
 * @param {Set<string>} options.requestIds - Request ID accumulator
 * @returns {Promise<{ requestId: string }>} Traced request ID
 * @throws {Error} If R2 does not return 403 Forbidden
 */
async function verifySignedSizeRejection({
  body,
  browserOrigin,
  target,
  fetchImpl,
  request,
  requestIds,
}) {
  const url = validateSignedRequest(request, target);
  const oversized = new Uint8Array(body.byteLength + 1);
  oversized.set(body);
  const response = await timedFetch(fetchImpl, url, {
    body: oversized,
    headers: { ...request.headers, Origin: browserOrigin },
    method: "PUT",
  });
  try {
    const requestId = requiredResponseRequestId(response, "R2 PUT", requestIds);
    if (response.status !== 403) {
      throw new Error(`R2 signed-size rejection returned ${response.status}, expected 403`);
    }
    return { requestId };
  } finally {
    await response.body?.cancel();
  }
}

/**
 * Constructs an authenticated HTTP API client bound to the staging environment and release probe context.
 *
 * Injects the bearer token from the environment, sets standard headers and idempotency keys,
 * validates operation IDs, records attempted/completed operations, and decodes JSON responses with size bounds.
 *
 * @param {object} options - Probe execution options containing apiOrigin
 * @param {object} dependencies - Injected runtime dependencies containing environment and fetchImpl
 * @param {Set<string>} evidenceRequestIds - Set accumulating all server request IDs for audit evidence
 * @param {{ attempted: Set<string>, completed: Set<string> }} operations - Operation tracking object
 * @returns {(operationId: string, method: string, path: string, options?: { body?: unknown, expected?: Array<number>, idempotencyKey?: string }) => Promise<{ requestId: string, status: number, value: any }>} Bound API request function
 */
function makeApiClient(options, dependencies, evidenceRequestIds, operations) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const token = requiredString(
    dependencies.environment.MELTIPLY_STAGING_BEARER_TOKEN,
    "MELTIPLY_STAGING_BEARER_TOKEN",
  );

  return async function apiRequest(
    operationId,
    method,
    path,
    { body, expected = [200], idempotencyKey } = {},
  ) {
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      throw new Error("API operation ID is invalid");
    }
    operations.attempted.add(operationId);
    const url = new URL(`/api/v1${path}`, options.apiOrigin);
    const headers = {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    };
    const response = await timedFetch(fetchImpl, url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    });
    let requestId;
    try {
      requestId = requiredResponseRequestId(response, "API", evidenceRequestIds);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (!expected.includes(response.status)) {
      const code = await responseErrorCode(response);
      throw new Error(
        `API ${method} ${path.replaceAll(/[0-9a-f-]{36}/gi, "{id}")} failed (${response.status}, ${code})`,
      );
    }
    if (response.status === 204 || response.status === 404) {
      await response.body?.cancel();
      operations.completed.add(operationId);
      return { requestId, status: response.status, value: undefined };
    }
    const result = {
      requestId,
      status: response.status,
      value: await readBoundedJsonResponse(response, MAXIMUM_API_RESPONSE_BYTES, "API response"),
    };
    operations.completed.add(operationId);
    return result;
  };
}

/**
 * Generates a minimal valid 24-byte 1x1 pixel PNG binary image buffer.
 *
 * Used as test payload for single PUT upload and CORS acceptance tests.
 *
 * @returns {Uint8Array} Binary PNG file buffer
 */
function pngFixture() {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1);
  view.setUint32(20, 1);
  return bytes;
}

/**
 * Generates deterministically chunked binary bytes for a specific MP4 video part.
 *
 * Prepends a standard ISO base media file format ftyp box to part 1 and fills remaining
 * bytes with zeros up to the part size or file boundary.
 *
 * @param {number} partNumber - 1-based part index
 * @param {number} partSize - Configured chunk size in bytes
 * @param {number} fileSize - Total file size in bytes
 * @returns {Uint8Array} Binary payload buffer for the video part
 */
function videoPart(partNumber, partSize, fileSize) {
  const start = (partNumber - 1) * partSize;
  const length = Math.min(partSize, fileSize - start);
  const bytes = new Uint8Array(length);
  if (partNumber === 1) {
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 12);
    bytes.set(new TextEncoder().encode("ftyp"), 4);
  }
  return bytes;
}

/**
 * Downloads a presigned R2 object, verifies size constraints, and computes its SHA-256 digest.
 *
 * Streams response chunks while enforcing that total received bytes do not exceed expectedBytes,
 * calculating an incremental SHA-256 hash to verify end-to-end data integrity.
 *
 * @param {string} urlValue - Presigned download URL
 * @param {{ bucketName: string, origin: string }} target - Target bucket and origin
 * @param {number} expectedBytes - Expected object byte length
 * @param {typeof fetch} fetchImpl - HTTP client implementation
 * @param {Set<string>} [requestIds] - Request ID accumulator
 * @returns {Promise<{ bytes: number, requestId: string, sha256: string }>} Transferred byte count, traced request ID, and hex SHA-256 digest
 * @throws {Error} If download fails or exceeds expected size
 */
async function downloadDigest(urlValue, target, expectedBytes, fetchImpl, requestIds) {
  const url = validateTargetUrl(urlValue, target, "download");
  const response = await timedFetch(
    fetchImpl,
    url,
    { method: "GET" },
    transferTimeoutForBytes(expectedBytes),
  );
  try {
    const requestId = requiredResponseRequestId(response, "R2 download", requestIds);
    if (!response.ok || !response.body) {
      throw new Error(`signed R2 download failed (${response.status})`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > expectedBytes) {
      throw new Error("signed R2 download exceeded the expected object size");
    }
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > expectedBytes) {
        throw new Error("signed R2 download exceeded the expected object size");
      }
      digest.update(chunk);
    }
    return { bytes, requestId, sha256: digest.digest("hex") };
  } finally {
    if (!response.bodyUsed) await response.body?.cancel();
  }
}

/**
 * Polls the asset processing status until it reaches 'ready' or throws on failure/timeout.
 *
 * @param {Function} apiRequest - Authenticated API request client
 * @param {string} assetId - Target asset UUID
 * @param {object} options - Probe options containing pollTimeoutMs
 * @param {object} dependencies - Injected runtime dependencies (now, sleep)
 * @returns {Promise<object>} Ready asset record
 * @throws {Error} If processing enters 'failed' state or exceeds polling timeout
 */
async function pollAsset(apiRequest, assetId, options, dependencies) {
  const deadline = dependencies.now() + options.pollTimeoutMs;
  while (dependencies.now() < deadline) {
    const response = await apiRequest("getAsset", "GET", `/assets/${assetId}`);
    if (response.value.status === "ready") return response.value;
    if (response.value.status === "failed") {
      throw new Error("staging asset processing entered failed state");
    }
    await dependencies.sleep(1_000);
  }
  throw new Error("staging asset processing timed out");
}

/**
 * Polls an asset endpoint until it returns a 404 Not Found, confirming complete deletion.
 *
 * @param {Function} apiRequest - Authenticated API request client
 * @param {string} assetId - Target asset UUID
 * @param {object} options - Probe options containing pollTimeoutMs
 * @param {object} dependencies - Injected runtime dependencies (now, sleep)
 * @returns {Promise<void>} Resolves when asset is confirmed deleted
 * @throws {Error} If deletion polling times out before returning 404
 */
async function pollDeleted(apiRequest, assetId, options, dependencies) {
  const deadline = dependencies.now() + options.pollTimeoutMs;
  while (dependencies.now() < deadline) {
    const response = await apiRequest("getAsset", "GET", `/assets/${assetId}`, {
      expected: [200, 404],
    });
    if (response.status === 404) return;
    await dependencies.sleep(1_000);
  }
  throw new Error("staging asset deletion timed out");
}

/**
 * Constructs standard input payload parameters for creating an asset upload session.
 *
 * @param {object} options - Session parameters
 * @param {string} options.assetType - Asset category ("image" or "video")
 * @param {string} options.contentType - MIME type (e.g. "image/png", "video/mp4")
 * @param {number} options.fileSize - File size in bytes
 * @param {string} options.filename - Base filename
 * @param {string} options.releaseId - Release identifier for metadata tagging
 * @returns {object} Formatted asset upload session request body
 */
function uploadInput({ assetType, contentType, fileSize, filename, releaseId }) {
  return {
    asset_type: assetType,
    content_type: contentType,
    description: "Credential-gated real-R2 acceptance probe",
    file_size: fileSize,
    filename,
    tags: ["r2-acceptance"],
    title: `R2 acceptance ${releaseId}`,
  };
}

/**
 * Asserts structural and behavioral consistency of an upload session against request parameters.
 *
 * Validates selected upload strategy (single <= 25 MiB, multipart > 25 MiB), session status,
 * content type, file size, future expiration timestamp, and multipart chunking bounds.
 *
 * @param {object} asset - Associated asset record
 * @param {object} session - Created upload session object
 * @param {object} input - Original session creation input
 * @throws {Error} If session metadata or multipart chunk parameters violate invariants
 */
function validateUploadSession(asset, session, input) {
  const expectedStrategy = input.file_size <= MULTIPART_THRESHOLD_BYTES ? "single" : "multipart";
  if (
    session.asset_id !== asset.id ||
    session.strategy !== expectedStrategy ||
    session.status !== "created" ||
    session.content_type !== input.content_type ||
    session.file_size !== input.file_size ||
    !Number.isFinite(Date.parse(session.expires_at))
  ) {
    throw new Error("staging API returned inconsistent upload session metadata");
  }
  if (expectedStrategy === "single") {
    if (!session.single_upload || session.multipart !== null) {
      throw new Error("small staging upload did not select the single strategy");
    }
    return;
  }
  const multipart = session.multipart;
  if (
    session.single_upload !== null ||
    !multipart ||
    !Number.isSafeInteger(multipart.part_count) ||
    multipart.part_count < 2 ||
    multipart.part_count > 10_000 ||
    !Number.isSafeInteger(multipart.part_size) ||
    multipart.part_size < MINIMUM_MULTIPART_PART_BYTES ||
    multipart.part_size > MAXIMUM_MULTIPART_PART_BYTES ||
    multipart.part_size > input.file_size ||
    Math.ceil(input.file_size / multipart.part_size) !== multipart.part_count ||
    !Number.isSafeInteger(multipart.max_parallel_parts) ||
    multipart.max_parallel_parts < 1 ||
    multipart.max_parallel_parts > 16
  ) {
    throw new Error("staging API returned invalid multipart bounds");
  }
}

/**
 * Initiates an asset upload session with the staging API and registers created resources for cleanup.
 *
 * @param {Function} apiRequest - Authenticated API request client
 * @param {object} input - Session creation parameters from uploadInput
 * @param {string} idempotencyKey - Unique idempotency key for the request
 * @param {Array<{ assetId?: string, sessionId?: string }>} resources - Mutable accumulator for rollback tracking
 * @returns {Promise<{ asset: object, session: object }>} Created asset and upload session objects
 * @throws {Error} If API returns invalid UUIDs or session validation fails
 */
async function createSession(apiRequest, input, idempotencyKey, resources) {
  const response = await apiRequest("createUploadSession", "POST", "/asset-upload-sessions", {
    body: input,
    expected: [201],
    idempotencyKey,
  });
  const session = response.value?.upload_session;
  const asset = response.value?.asset;
  const resource = {
    assetId: UUID_PATTERN.test(asset?.id ?? "") ? asset.id : undefined,
    sessionId: UUID_PATTERN.test(session?.id ?? "") ? session.id : undefined,
  };
  if (resource.assetId || resource.sessionId) resources.push(resource);
  if (resource.sessionId === undefined || resource.assetId === undefined) {
    throw new Error("staging API returned invalid upload identifiers");
  }
  validateUploadSession(asset, session, input);
  return { asset, session };
}

/**
 * Removes a successfully deleted asset from the pending cleanup tracker.
 *
 * @param {Array<{ assetId?: string, sessionId?: string }>} resources - Cleanup tracker list
 * @param {string} assetId - Cleaned asset identifier
 */
function markResourceClean(resources, assetId) {
  const index = resources.findIndex((resource) => resource.assetId === assetId);
  if (index >= 0) resources.splice(index, 1);
}

/**
 * Filters out entries from the resources array whose identifiers have already been cleaned up.
 *
 * @param {Array<{ assetId?: string, sessionId?: string }>} resources - Mutable resources tracking array
 */
function pruneCleanResources(resources) {
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    const resource = resources[index];
    if (!resource.assetId && !resource.sessionId) resources.splice(index, 1);
  }
}

/**
 * Reversely iterates through outstanding asset upload sessions and assets to ensure total rollback cleanup.
 *
 * Attempts to abort any pending multipart sessions first (handling 409 conflict if already completed),
 * then deletes created assets and polls for 404 confirmation. Captures all encountered errors
 * to allow best-effort cleanup across all accumulated resources.
 *
 * @param {Function} apiRequest - Authenticated API request client
 * @param {Array<{ assetId?: string, sessionId?: string }>} resources - Tracking array of created resources
 * @param {object} options - Probe options with gitSha
 * @param {object} dependencies - Runtime dependencies (now, sleep)
 * @returns {Promise<Array<Error>>} Array of errors encountered during cleanup
 */
async function cleanupResources(apiRequest, resources, options, dependencies) {
  const errors = [];
  for (const resource of [...resources].reverse()) {
    let completedConflict = false;
    let abortFailed = false;
    if (resource.sessionId) {
      try {
        const response = await apiRequest(
          "abortUploadSession",
          "DELETE",
          `/asset-upload-sessions/${resource.sessionId}`,
          {
            expected: [204, 404, 409],
            idempotencyKey: `r2-cleanup-abort-${options.gitSha}-${resource.sessionId}`,
          },
        );
        completedConflict = response.status === 409;
        if (!completedConflict) resource.sessionId = undefined;
      } catch (error) {
        abortFailed = true;
        errors.push(error);
      }
    }
    if (resource.assetId) {
      try {
        const response = await apiRequest("deleteAsset", "DELETE", `/assets/${resource.assetId}`, {
          expected: [202, 204, 404],
          idempotencyKey: `r2-cleanup-delete-${options.gitSha}-${resource.assetId}`,
        });
        if (response.status === 202) {
          await pollDeleted(apiRequest, resource.assetId, options, dependencies);
        }
        resource.assetId = undefined;
        if (completedConflict && !abortFailed) resource.sessionId = undefined;
      } catch (error) {
        errors.push(error);
      }
    }
  }
  pruneCleanResources(resources);
  return errors;
}

/**
 * Deletes an asset via the API and polls until it is confirmed deleted (404).
 *
 * @param {Function} apiRequest - Authenticated API request client
 * @param {string} assetId - Asset UUID to delete
 * @param {string} key - Idempotency key for deletion
 * @param {object} options - Probe options
 * @param {object} dependencies - Runtime dependencies
 * @returns {Promise<void>}
 */
async function deleteAsset(apiRequest, assetId, key, options, dependencies) {
  await apiRequest("deleteAsset", "DELETE", `/assets/${assetId}`, {
    expected: [202, 204],
    idempotencyKey: key,
  });
  await pollDeleted(apiRequest, assetId, options, dependencies);
}

/**
 * Completes an upload session, polls for completion, downloads the object, verifies digest parity, and deletes it.
 *
 * Verifies end-to-end processing pipeline: session completion -> ready state -> presigned download URL
 * -> byte-for-byte stream digest verification -> asset deletion.
 *
 * @param {object} params - Completion parameters
 * @param {Function} params.apiRequest - Authenticated API request client
 * @param {string} params.assetId - Asset UUID
 * @param {Array<{ etag: string, part_number: number }>} [params.completedParts] - Multipart part descriptors
 * @param {object} params.dependencies - Runtime dependencies (fetchImpl, now, sleep)
 * @param {string} params.expectedDigest - Expected hex SHA-256 hash of object
 * @param {number} params.expectedSize - Expected byte length
 * @param {object} params.options - Probe options
 * @param {Set<string>} params.r2RequestIds - R2 request ID tracker
 * @param {Array<object>} params.resources - Cleanup tracker
 * @param {string} params.sessionId - Upload session ID
 * @returns {Promise<{ bytes: number, requestId: string, sha256: string }>} Download verification metrics
 * @throws {Error} If downloaded bytes or SHA-256 digest do not match expected values
 */
async function completeAndVerify({
  apiRequest,
  assetId,
  completedParts,
  dependencies,
  expectedDigest,
  expectedSize,
  options,
  r2RequestIds,
  resources,
  sessionId,
}) {
  await apiRequest(
    "completeUploadSession",
    "POST",
    `/asset-upload-sessions/${sessionId}/complete`,
    {
      body: completedParts ? { parts: completedParts } : {},
      expected: [202],
      idempotencyKey: `r2-complete-${options.gitSha}-${sessionId}`,
    },
  );
  await pollAsset(apiRequest, assetId, options, dependencies);
  const signed = await apiRequest("getAssetDownloadUrl", "GET", `/assets/${assetId}/download-url`);
  const downloaded = await downloadDigest(
    signed.value?.url,
    { bucketName: options.bucketName, origin: options.r2Origin },
    expectedSize,
    dependencies.fetchImpl,
    r2RequestIds,
  );
  if (downloaded.bytes !== expectedSize || downloaded.sha256 !== expectedDigest) {
    throw new Error("downloaded R2 object does not match the uploaded bytes");
  }
  await deleteAsset(
    apiRequest,
    assetId,
    `r2-delete-${options.gitSha}-${assetId}`,
    options,
    dependencies,
  );
  markResourceClean(resources, assetId);
  return downloaded;
}

/**
 * Executes the single-part upload test case verifying CORS preflight, signed size rejection, upload, completion, and deletion.
 *
 * @param {Function} apiRequest - Authenticated API client
 * @param {object} options - Probe options
 * @param {object} dependencies - Runtime dependencies
 * @param {Set<string>} r2RequestIds - R2 request ID tracker
 * @param {Array<object>} resources - Resource tracker
 * @returns {Promise<{ bytes: number, name: string }>} Test case execution summary
 */
async function singleUploadCase(apiRequest, options, dependencies, r2RequestIds, resources) {
  const bytes = pngFixture();
  const expectedDigest = createHash("sha256").update(bytes).digest("hex");
  const { asset, session } = await createSession(
    apiRequest,
    uploadInput({
      assetType: "image",
      contentType: "image/png",
      fileSize: bytes.byteLength,
      filename: `r2-${options.gitSha.slice(0, 12)}.png`,
      releaseId: options.releaseId,
    }),
    `r2-single-${options.gitSha}-${options.probeId}`,
    resources,
  );
  if (session.strategy !== "single" || !session.single_upload) {
    throw new Error("small staging upload did not select the single strategy");
  }
  const target = {
    bucketName: options.bucketName,
    origin: options.r2Origin,
  };
  await verifySignedPutCors(
    session.single_upload,
    options.browserOrigin,
    target,
    dependencies.fetchImpl,
    r2RequestIds,
  );
  await verifySignedSizeRejection({
    body: bytes,
    browserOrigin: options.browserOrigin,
    fetchImpl: dependencies.fetchImpl,
    request: session.single_upload,
    requestIds: r2RequestIds,
    target,
  });
  await uploadSignedPart({
    body: bytes,
    browserOrigin: options.browserOrigin,
    fetchImpl: dependencies.fetchImpl,
    request: session.single_upload,
    requestIds: r2RequestIds,
    target,
  });
  await completeAndVerify({
    apiRequest,
    assetId: asset.id,
    dependencies,
    expectedDigest,
    expectedSize: bytes.byteLength,
    options,
    r2RequestIds,
    resources,
    sessionId: session.id,
  });
  return {
    bytes: bytes.byteLength,
    name: "single-put-size-cors-head-download-delete",
  };
}

/**
 * Requests presigned PUT URLs for multipart upload parts in batches of up to 100 parts.
 *
 * Enforces that the API returns signed URLs for all requested parts and sorts them by part number.
 *
 * @param {Function} apiRequest - Authenticated API client
 * @param {object} session - Multipart upload session record
 * @param {string} gitSha - Current release Git SHA for idempotency keys
 * @param {Array<number>} [requestedParts] - Specific part numbers to sign, defaulting to all parts
 * @returns {Promise<Array<{ part_number: number, url: string, headers: Record<string, string> }>>} Sorted array of signed part descriptors
 * @throws {Error} If API fails to sign all requested parts
 */
async function signMultipartParts(apiRequest, session, gitSha, requestedParts) {
  const partNumbers =
    requestedParts ?? Array.from({ length: session.multipart.part_count }, (_, index) => index + 1);
  const signedParts = [];
  for (let index = 0; index < partNumbers.length; index += 100) {
    const batch = partNumbers.slice(index, index + 100);
    const response = await apiRequest(
      "createUploadPartUrls",
      "POST",
      `/asset-upload-sessions/${session.id}/parts`,
      {
        body: { part_numbers: batch },
        idempotencyKey: `r2-parts-${gitSha}-${session.id}-${batch[0]}-${batch.at(-1)}`,
      },
    );
    signedParts.push(...(response.value?.parts ?? []));
  }
  const returnedNumbers = signedParts
    .map((part) => part.part_number)
    .sort((left, right) => left - right);
  if (
    returnedNumbers.length !== partNumbers.length ||
    returnedNumbers.some((partNumber, index) => partNumber !== partNumbers[index])
  ) {
    throw new Error("staging API did not sign exactly the requested multipart parts");
  }
  return signedParts.sort((left, right) => left.part_number - right.part_number);
}

/**
 * Executes the multipart complete probe test case for large uploads exceeding 25 MiB.
 *
 * Exercises chunked video uploading across a sliding window of presigned part URLs,
 * uploads all binary chunks, completes the multipart session, polls ready state, downloads
 * the compiled object from R2, verifies bit-for-bit SHA-256 parity, and deletes the asset.
 *
 * @param {Function} apiRequest - Authenticated API client
 * @param {object} options - Probe options
 * @param {object} dependencies - Runtime dependencies
 * @param {Set<string>} r2RequestIds - R2 request ID tracker
 * @param {Array<object>} resources - Resource tracker
 * @returns {Promise<{ bytes: number, name: string }>} Test case execution summary
 */
async function multipartCompleteCase(apiRequest, options, dependencies, r2RequestIds, resources) {
  const { asset, session } = await createSession(
    apiRequest,
    uploadInput({
      assetType: "video",
      contentType: "video/mp4",
      fileSize: options.multipartBytes,
      filename: `r2-${options.gitSha.slice(0, 12)}.mp4`,
      releaseId: options.releaseId,
    }),
    `r2-multipart-${options.gitSha}-${options.probeId}`,
    resources,
  );
  if (session.strategy !== "multipart" || !session.multipart) {
    throw new Error("large staging upload did not select the multipart strategy");
  }
  const target = {
    bucketName: options.bucketName,
    origin: options.r2Origin,
  };
  // Keep only a few upload waves signed at once so long probes refresh URLs
  // without paying for one signing request per sequential part.
  const signingWindowParts = Math.min(100, session.multipart.max_parallel_parts * 4);
  const expected = createHash("sha256");
  const completedParts = [];
  let corsVerified = false;
  for (
    let firstPart = 1;
    firstPart <= session.multipart.part_count;
    firstPart += signingWindowParts
  ) {
    const requestedParts = Array.from(
      {
        length: Math.min(signingWindowParts, session.multipart.part_count - firstPart + 1),
      },
      (_, index) => firstPart + index,
    );
    const signedParts = await signMultipartParts(
      apiRequest,
      session,
      options.gitSha,
      requestedParts,
    );
    if (!corsVerified) {
      await verifySignedPutCors(
        signedParts[0],
        options.browserOrigin,
        target,
        dependencies.fetchImpl,
        r2RequestIds,
      );
      corsVerified = true;
    }
    for (const signedPart of signedParts) {
      const body = videoPart(
        signedPart.part_number,
        session.multipart.part_size,
        options.multipartBytes,
      );
      expected.update(body);
      const uploaded = await uploadSignedPart({
        body,
        browserOrigin: options.browserOrigin,
        fetchImpl: dependencies.fetchImpl,
        request: signedPart,
        requestIds: r2RequestIds,
        requireEtag: true,
        target,
      });
      completedParts.push({
        etag: uploaded.etag,
        part_number: signedPart.part_number,
      });
    }
  }
  await completeAndVerify({
    apiRequest,
    assetId: asset.id,
    completedParts,
    dependencies,
    expectedDigest: expected.digest("hex"),
    expectedSize: options.multipartBytes,
    options,
    r2RequestIds,
    resources,
    sessionId: session.id,
  });
  return {
    bytes: options.multipartBytes,
    name: "multipart-complete-head-download-delete",
  };
}

/**
 * Executes the multipart abort probe test case verifying cleanup and rejection of stale upload URLs.
 *
 * Initializes a multipart session, uploads an initial part, issues an abort request,
 * verifies that the session status becomes 'aborted', and asserts that subsequent PUT attempts
 * using the previously signed part URL are rejected by R2 with a 404 Not Found.
 *
 * @param {Function} apiRequest - Authenticated API client
 * @param {object} options - Probe options
 * @param {object} dependencies - Runtime dependencies
 * @param {Set<string>} r2RequestIds - R2 request ID tracker
 * @param {Array<object>} resources - Resource tracker
 * @returns {Promise<{ bytes: number, name: string }>} Test case execution summary
 */
async function multipartAbortCase(apiRequest, options, dependencies, r2RequestIds, resources) {
  const { asset, session } = await createSession(
    apiRequest,
    uploadInput({
      assetType: "video",
      contentType: "video/mp4",
      fileSize: options.multipartBytes,
      filename: `r2-abort-${options.gitSha.slice(0, 12)}.mp4`,
      releaseId: options.releaseId,
    }),
    `r2-abort-${options.gitSha}-${options.probeId}`,
    resources,
  );
  if (session.strategy !== "multipart" || !session.multipart) {
    throw new Error("abort probe did not select the multipart strategy");
  }
  const [signedPart] = await signMultipartParts(apiRequest, session, options.gitSha, [1]);
  const body = videoPart(1, session.multipart.part_size, options.multipartBytes);
  await uploadSignedPart({
    body,
    browserOrigin: options.browserOrigin,
    fetchImpl: dependencies.fetchImpl,
    request: signedPart,
    requestIds: r2RequestIds,
    requireEtag: true,
    target: {
      bucketName: options.bucketName,
      origin: options.r2Origin,
    },
  });
  await apiRequest("abortUploadSession", "DELETE", `/asset-upload-sessions/${session.id}`, {
    expected: [204],
    idempotencyKey: `r2-abort-${options.gitSha}-${session.id}`,
  });
  const detail = await apiRequest(
    "getUploadSession",
    "GET",
    `/asset-upload-sessions/${session.id}`,
  );
  if (detail.value?.upload_session?.status !== "aborted") {
    throw new Error("aborted multipart session did not remain aborted");
  }
  const staleResponse = await timedFetch(
    dependencies.fetchImpl,
    new URL(signedPart.url),
    {
      body,
      headers: { ...signedPart.headers, Origin: options.browserOrigin },
      method: "PUT",
    },
    transferTimeoutForBytes(body.byteLength),
  );
  try {
    requiredResponseRequestId(staleResponse, "R2 PUT", r2RequestIds);
    if (staleResponse.status !== 404) {
      throw new Error(`R2 stale part rejection returned ${staleResponse.status}, expected 404`);
    }
  } finally {
    await staleResponse.body?.cancel();
  }
  await deleteAsset(
    apiRequest,
    asset.id,
    `r2-delete-${options.gitSha}-${asset.id}`,
    options,
    dependencies,
  );
  markResourceClean(resources, asset.id);
  return {
    bytes: body.byteLength,
    name: "multipart-abort-stale-url-rejection",
  };
}

/**
 * Verifies that the API rejects asset upload requests exceeding the maximum media threshold with HTTP 413.
 *
 * @param {Function} apiRequest - Authenticated API client
 * @param {object} options - Probe options
 * @returns {Promise<{ bytes: number, name: string }>} Test case execution summary
 * @throws {Error} If API does not respond with status 413 Payload Too Large
 */
async function oversizedCase(apiRequest, options) {
  const response = await apiRequest("createUploadSession", "POST", "/asset-upload-sessions", {
    body: uploadInput({
      assetType: "video",
      contentType: "video/mp4",
      fileSize: MAX_MEDIA_BYTES + 1,
      filename: `r2-oversized-${options.gitSha.slice(0, 12)}.mp4`,
      releaseId: options.releaseId,
    }),
    expected: [413],
    idempotencyKey: `r2-oversized-${options.gitSha}-${options.probeId}`,
  });
  if (response.status !== 413) throw new Error("oversized upload was not rejected");
  return { bytes: MAX_MEDIA_BYTES + 1, name: "oversized-rejection" };
}

/**
 * Asserts that a value represents a non-negative safe integer for billing usage or limit counters.
 *
 * @param {unknown} value - Candidate metric value
 * @param {string} name - Field name for error reporting
 * @returns {number} Validated non-negative integer
 * @throws {Error} If value is not a safe integer or is negative
 */
function boundedUsageInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Verifies that the staging API health endpoint responds with expected environment and Git SHA.
 *
 * @param {Function} apiRequest - Authenticated API request client
 * @param {object} options - Probe options with gitSha
 * @returns {Promise<{ environment: string, version: string }>} Validated health report
 * @throws {Error} If health status is not ok or version/environment mismatch the release
 */
async function verifyStagingTarget(apiRequest, options) {
  const response = await apiRequest("getHealth", "GET", "/health");
  if (
    response.value?.status !== "ok" ||
    response.value?.environment !== "staging" ||
    response.value?.version !== options.gitSha
  ) {
    throw new Error("staging API health does not match the approved environment and git SHA");
  }
  return { environment: "staging", version: options.gitSha };
}

/**
 * Validates that the bearer token corresponds to the dedicated, paid staging acceptance identity.
 *
 * Verifies user ID, organization ID, active paid plan (agency/creator), active billing status,
 * and asserts that the organization possesses at least 2 upload credits and adequate storage quota.
 *
 * @param {Function} apiRequest - Authenticated API request client
 * @param {object} options - Probe options with multipartBytes
 * @param {Record<string, string | undefined>} environment - Process environment
 * @returns {Promise<{ identity: object, usage: object }>} Validated identity and baseline usage records
 * @throws {Error} If identity is not the dedicated paid probe or lacks sufficient quota
 */
async function verifyAcceptanceIdentity(apiRequest, options, environment) {
  const expectedUserId = requiredString(
    environment.MELTIPLY_STAGING_ACCEPTANCE_USER_ID,
    "MELTIPLY_STAGING_ACCEPTANCE_USER_ID",
  );
  const expectedOrganizationId = requiredString(
    environment.MELTIPLY_STAGING_ACCEPTANCE_ORG_ID,
    "MELTIPLY_STAGING_ACCEPTANCE_ORG_ID",
  );
  const expectedPlan = requiredString(
    environment.MELTIPLY_STAGING_ACCEPTANCE_PLAN,
    "MELTIPLY_STAGING_ACCEPTANCE_PLAN",
  );
  if (!UUID_PATTERN.test(expectedUserId) || !UUID_PATTERN.test(expectedOrganizationId)) {
    throw new Error("staging acceptance identity IDs must be UUIDs");
  }
  if (!ACCEPTANCE_PLANS.has(expectedPlan)) {
    throw new Error("MELTIPLY_STAGING_ACCEPTANCE_PLAN must be agency or creator");
  }

  const [currentUser, billing] = await Promise.all([
    apiRequest("getCurrentUser", "GET", "/users/me"),
    apiRequest("getBillingUsage", "GET", "/billing/usage"),
  ]);
  const organization = currentUser.value?.active_organization;
  if (
    currentUser.value?.id !== expectedUserId ||
    organization?.id !== expectedOrganizationId ||
    organization?.plan !== expectedPlan ||
    billing.value?.usage?.org_id !== expectedOrganizationId ||
    billing.value?.plan !== expectedPlan ||
    !ACTIVE_BILLING_STATUSES.has(billing.value?.billing_status)
  ) {
    throw new Error("the bearer token is not the dedicated paid staging acceptance identity");
  }

  const uploads = boundedUsageInteger(billing.value.usage.uploads, "billing usage uploads");
  const storageBytes = boundedUsageInteger(
    billing.value.usage.storage_bytes,
    "billing usage storage_bytes",
  );
  const maxUploads = boundedUsageInteger(
    billing.value.limits?.max_uploads,
    "billing limit max_uploads",
  );
  const maxStorageBytes = boundedUsageInteger(
    billing.value.limits?.max_storage_bytes,
    "billing limit max_storage_bytes",
  );
  if (maxUploads - uploads < 2) {
    throw new Error("the staging acceptance identity needs at least two upload credits");
  }
  if (maxStorageBytes - storageBytes < options.multipartBytes) {
    throw new Error("the staging acceptance identity lacks storage quota for the probe");
  }
  return {
    identity: {
      billing_status: billing.value.billing_status,
      organization_id: expectedOrganizationId,
      plan: expectedPlan,
      user_id: expectedUserId,
    },
    usage: {
      max_storage_bytes: maxStorageBytes,
      max_uploads: maxUploads,
      period_start: billing.value.usage.period_start,
      storage_bytes: storageBytes,
      uploads,
    },
  };
}

/**
 * Verifies that probe execution resulted in exactly +2 upload count increment and zero retained storage.
 *
 * Asserts that single and multipart uploads were recorded in billing metrics, but their subsequent
 * deletions successfully freed all consumed storage bytes.
 *
 * @param {Function} apiRequest - Authenticated API request client
 * @param {object} before - Baseline billing usage metrics
 * @param {object} identity - Expected organization identity
 * @returns {Promise<object>} Usage effect reconciliation summary
 * @throws {Error} If billing delta does not reflect exactly two uploads and zero net storage retention
 */
async function verifyUsageEffect(apiRequest, before, identity) {
  const response = await apiRequest("getBillingUsage", "GET", "/billing/usage");
  const after = response.value;
  const uploads = boundedUsageInteger(after?.usage?.uploads, "billing usage uploads");
  const storageBytes = boundedUsageInteger(
    after?.usage?.storage_bytes,
    "billing usage storage_bytes",
  );
  if (
    after?.usage?.org_id !== identity.organization_id ||
    after?.plan !== identity.plan ||
    after?.billing_status !== identity.billing_status ||
    after?.usage?.period_start !== before.period_start ||
    uploads !== before.uploads + 2 ||
    storageBytes !== before.storage_bytes
  ) {
    throw new Error(
      "staging billing usage did not record exactly two uploads and zero retained storage",
    );
  }
  return {
    after_storage_bytes: storageBytes,
    after_uploads: uploads,
    before_storage_bytes: before.storage_bytes,
    before_uploads: before.uploads,
    monthly_upload_delta: 2,
    period_start: before.period_start,
    remaining_uploads: before.max_uploads - uploads,
  };
}

/**
 * Redacts secrets, bearer tokens, and presigned R2 URLs from error messages.
 *
 * Prevents credential leaks to logs or evidence files during probe failures.
 *
 * @param {unknown} error - Error thrown during execution
 * @param {Record<string, string | undefined>} environment - Process environment containing secrets
 * @returns {string} Redacted error message
 */
function safeError(error, environment) {
  let message = redactError(error, environment);
  const secrets = [environment.MELTIPLY_STAGING_BEARER_TOKEN]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.replace(/https:\/\/[^\s?]+\?[^\s]+/g, "[SIGNED_URL]");
}

/**
 * Returns a sorted copy of an array of string values.
 *
 * @param {Iterable<string>} values - Input strings
 * @returns {Array<string>} Sorted array
 */
function sorted(values) {
  return [...values].sort();
}

/**
 * Sanitizes and deterministically sorts remaining resource IDs for inclusion in failure evidence.
 *
 * @param {Array<{ assetId?: string, sessionId?: string }>} resources - Unresolved resources
 * @returns {Array<object>} Sorted list of sanitized resource descriptors
 */
function safeResources(resources) {
  return resources
    .map((resource) => ({
      ...(resource.assetId ? { asset_id: resource.assetId } : {}),
      ...(resource.sessionId ? { session_id: resource.sessionId } : {}),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/**
 * Assembles the standard baseline metadata fields for R2 acceptance evidence records.
 *
 * @param {object} options - Probe options
 * @param {string} probeId - Unique UUID for this probe run
 * @param {string} startedAt - ISO 8601 start timestamp
 * @returns {object} Baseline evidence envelope
 */
function baseEvidence(options, probeId, startedAt) {
  return {
    acceptance_type: "real-r2",
    api_origin: options.apiOrigin,
    assets_bucket: options.bucketName,
    browser_origin: options.browserOrigin,
    environment: "staging",
    git_sha: options.gitSha,
    iac_outputs_sha256: options.iacOutputsSha256,
    kind: "acceptance",
    multipart_bytes: options.multipartBytes,
    probe_id: probeId,
    r2_origin: options.r2Origin,
    release_id: options.releaseId,
    release_input_sha256: options.releaseInputSha256,
    schemaVersion: 1,
    started_at: startedAt,
    transfer_timeout_ms: transferTimeoutForBytes(options.multipartBytes),
  };
}

/**
 * Persists acceptance probe execution evidence to the designated output file path.
 *
 * @param {object} options - Probe options containing outputPath
 * @param {object} evidence - JSON-serializable evidence payload
 * @returns {Promise<void>}
 */
function writeAttemptEvidence(options, evidence) {
  return writeEvidence(dirname(options.outputPath), basename(options.outputPath), evidence);
}

/**
 * Orchestrates the full Cloudflare R2 staging acceptance probe suite.
 *
 * When run in dry-run mode (without --apply), returns target metadata and ready status.
 * When applied, verifies git checkout cleanliness, validates API health and dedicated paid identity,
 * exercises single-part upload, multipart upload, multipart abort with stale URL rejection,
 * and oversized upload rejection, verifies billing and quota reconciliation, cleans up all
 * temporary assets/sessions, and records atomic private evidence.
 *
 * @param {object} options - Bound acceptance options from prepareR2AcceptanceOptions
 * @param {object} [injected={}] - Injectable runtime dependencies for testing
 * @returns {Promise<object>} Acceptance evidence record (dry-run or passed/failed probe report)
 * @throws {Error|AggregateError} If probe fails or resources fail to clean up
 */
export async function runR2Acceptance(options, injected = {}) {
  if (!options.apply) {
    return {
      api_origin: options.apiOrigin,
      assets_bucket: options.bucketName,
      browser_origin: options.browserOrigin,
      environment: "staging",
      git_sha: options.gitSha,
      iac_outputs_sha256: options.iacOutputsSha256,
      mode: "dry-run",
      multipart_bytes: options.multipartBytes,
      r2_origin: options.r2Origin,
      release_id: options.releaseId,
      release_input_sha256: options.releaseInputSha256,
      status: "ready",
    };
  }

  const dependencies = {
    environment: injected.environment ?? process.env,
    fetchImpl: injected.fetchImpl ?? fetch,
    now: injected.now ?? Date.now,
    randomUUID: injected.randomUUID ?? randomUUID,
    repoRoot: injected.repoRoot ?? options.repoRoot,
    runCommand: injected.runCommand ?? runCommand,
    sleep:
      injected.sleep ??
      ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))),
  };
  await rm(options.outputPath, { force: true });
  const probeId = dependencies.randomUUID();
  if (!UUID_PATTERN.test(probeId)) {
    throw new Error("the generated R2 acceptance probe ID is invalid");
  }
  const runOptions = Object.freeze({ ...options, probeId });
  const apiRequestIds = new Set();
  const r2RequestIds = new Set();
  const operations = { attempted: new Set(), completed: new Set() };
  const startedAt = new Date(dependencies.now()).toISOString();
  const cases = [];
  const resources = [];
  let apiRequest;
  let checkoutVerified = false;
  let health;
  let identity;
  let usageBefore;
  try {
    await verifyReleaseCheckout({
      repoRoot: dependencies.repoRoot,
      runCommand: dependencies.runCommand,
      spec: options.releaseSpec,
    });
    checkoutVerified = true;
    apiRequest = makeApiClient(runOptions, dependencies, apiRequestIds, operations);
    health = await verifyStagingTarget(apiRequest, runOptions);
    const acceptance = await verifyAcceptanceIdentity(
      apiRequest,
      runOptions,
      dependencies.environment,
    );
    identity = acceptance.identity;
    usageBefore = acceptance.usage;
    cases.push(
      await singleUploadCase(apiRequest, runOptions, dependencies, r2RequestIds, resources),
    );
    cases.push(
      await multipartCompleteCase(apiRequest, runOptions, dependencies, r2RequestIds, resources),
    );
    cases.push(
      await multipartAbortCase(apiRequest, runOptions, dependencies, r2RequestIds, resources),
    );
    cases.push(await oversizedCase(apiRequest, runOptions));
    const usage = await verifyUsageEffect(apiRequest, usageBefore, identity);
    if (resources.length > 0) {
      throw new Error("staging R2 acceptance left resources pending cleanup");
    }
    const evidence = {
      ...baseEvidence(runOptions, probeId, startedAt),
      api_request_ids: sorted(apiRequestIds),
      attemptedOperationIds: sorted(operations.attempted),
      cases: cases.map((entry) => ({ ...entry, status: "passed" })),
      checkout_verified: checkoutVerified,
      finished_at: new Date(dependencies.now()).toISOString(),
      health,
      identity,
      operationIds: sorted(operations.completed),
      r2_request_ids: sorted(r2RequestIds),
      result: "passed",
      status: "passed",
      usage,
    };
    await writeAttemptEvidence(runOptions, evidence);
    return evidence;
  } catch (error) {
    const cleanupErrors = apiRequest
      ? await cleanupResources(apiRequest, resources, runOptions, dependencies)
      : [];
    const message = safeError(error, dependencies.environment);
    const failedEvidence = {
      ...baseEvidence(runOptions, probeId, startedAt),
      api_request_ids: sorted(apiRequestIds),
      attemptedOperationIds: sorted(operations.attempted),
      cases: cases.map((entry) => ({ ...entry, status: "passed" })),
      checkout_verified: checkoutVerified,
      cleanup_error_count: cleanupErrors.length,
      error: { code: "r2_acceptance_failed", message },
      finished_at: new Date(dependencies.now()).toISOString(),
      ...(health ? { health } : {}),
      ...(identity ? { identity } : {}),
      operationIds: sorted(operations.completed),
      r2_request_ids: sorted(r2RequestIds),
      result: "failed",
      status: "failed",
      unresolved_resources: safeResources(resources),
    };
    try {
      await writeAttemptEvidence(runOptions, failedEvidence);
    } catch (evidenceError) {
      throw new AggregateError(
        [error, ...cleanupErrors, evidenceError],
        `${message}; failed to write private failure evidence`,
      );
    }
    const cleanupSuffix =
      cleanupErrors.length === 0
        ? ""
        : `; ${cleanupErrors.length} staging cleanup operation(s) also failed`;
    throw new Error(`${message}${cleanupSuffix}`, {
      cause: new AggregateError([error, ...cleanupErrors]),
    });
  }
}

/**
 * Command-line entrypoint for executing the R2 staging acceptance probe script.
 *
 * Parses arguments, loads inputs, runs the probe, and logs JSON results.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const parsed = parseR2AcceptanceArguments(process.argv.slice(2));
  if (parsed.apply) await rm(parsed.outputPath, { force: true });
  const inputs = await loadReleaseInputs({
    iacOutputsPath: parsed.iacOutputsPath,
    inputPath: parsed.inputPath,
  });
  const options = prepareR2AcceptanceOptions(parsed, inputs);
  const result = await runR2Acceptance(options);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(safeError(error, process.env));
    process.exitCode = 1;
  });
}

export const r2AcceptanceInternals = {
  DEFAULT_MULTIPART_BYTES,
  MAX_MEDIA_BYTES,
  pngFixture,
  safeError,
  transferTimeoutForBytes,
  videoPart,
};
