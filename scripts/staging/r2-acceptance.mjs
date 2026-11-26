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
import { stableJson } from "../lib/stable-json.mjs";
import { loadReleaseInputs, redactError } from "../release/release-lib.mjs";

const lineBreakPattern = /[\r\n]/;
const uuidPattern = /[0-9a-f-]{36}/gi;
const signedUrlPattern = /https:\/\/[^\s?]+\?[^\s]+/g;

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

function requiredString(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function optionValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

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

export function prepareR2AcceptanceOptions(parsed, { iac, spec }, repoRoot = REPO_ROOT) {
  if (spec.environment !== "staging") {
    throw new Error("staging R2 acceptance requires a staging release input");
  }
  assertIacState(iac, "active", spec);
  const expectedConfirmation = `r2 staging ${spec.git_sha}`;
  if (parsed.apply && parsed.confirm !== expectedConfirmation) {
    throw new Error(`--apply requires --confirm ${JSON.stringify(expectedConfirmation)}`);
  }
  return Object.freeze({
    apiOrigin: spec.app_url,
    apply: parsed.apply,
    browserOrigin: spec.app_url,
    bucketName: iac.assets_bucket,
    gitSha: spec.git_sha,
    iacOutputsSha256: sha256(stableJson(iac)),
    multipartBytes: parsed.multipartBytes,
    outputPath: parsed.outputPath,
    pollTimeoutMs: parsed.pollTimeoutMs,
    r2Origin: `https://${spec.runtime.r2_account_id}.r2.cloudflarestorage.com`,
    releaseId: spec.release_id,
    releaseInputSha256: sha256(stableJson(spec)),
    releaseSpec: spec,
    repoRoot,
  });
}

function safeIdentifier(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

function headerTokens(value) {
  return new Set(
    (value ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

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

async function timedFetch(fetchImpl, url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  return fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function transferTimeoutForBytes(bytes) {
  return Math.min(
    MAXIMUM_TRANSFER_TIMEOUT_MS,
    Math.max(
      REQUEST_TIMEOUT_MS,
      Math.ceil((bytes / MINIMUM_TRANSFER_BYTES_PER_SECOND) * 1_000) + TRANSFER_GRACE_MS,
    ),
  );
}

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
      lineBreakPattern.test(value)
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
        `API ${method} ${path.replaceAll(uuidPattern, "{id}")} failed (${response.status}, ${code})`,
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

const VALID_1X1_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function pngFixture() {
  return new Uint8Array(Buffer.from(VALID_1X1_PNG_BASE64, "base64"));
}

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

function markResourceClean(resources, assetId) {
  const index = resources.findIndex((resource) => resource.assetId === assetId);
  if (index >= 0) resources.splice(index, 1);
}

function pruneCleanResources(resources) {
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    const resource = resources[index];
    if (!resource.assetId && !resource.sessionId) resources.splice(index, 1);
  }
}

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

async function deleteAsset(apiRequest, assetId, key, options, dependencies) {
  await apiRequest("deleteAsset", "DELETE", `/assets/${assetId}`, {
    expected: [202, 204],
    idempotencyKey: key,
  });
  await pollDeleted(apiRequest, assetId, options, dependencies);
}

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

async function verifyAcceptanceIdentity(apiRequest, environment) {
  const expectedUserId = requiredString(
    environment.MELTIPLY_STAGING_ACCEPTANCE_USER_ID,
    "MELTIPLY_STAGING_ACCEPTANCE_USER_ID",
  );
  const expectedOrganizationId = requiredString(
    environment.MELTIPLY_STAGING_ACCEPTANCE_ORG_ID,
    "MELTIPLY_STAGING_ACCEPTANCE_ORG_ID",
  );
  if (!UUID_PATTERN.test(expectedUserId) || !UUID_PATTERN.test(expectedOrganizationId)) {
    throw new Error("staging acceptance identity IDs must be UUIDs");
  }
  const currentUser = await apiRequest("getCurrentUser", "GET", "/users/me");
  if (
    currentUser.value?.id !== expectedUserId ||
    currentUser.value?.active_organization?.id !== expectedOrganizationId
  ) {
    throw new Error("the bearer token is not the dedicated staging acceptance identity");
  }
  return { organization_id: expectedOrganizationId, user_id: expectedUserId };
}

function safeError(error, environment) {
  let message = redactError(error, environment);
  const secrets = [environment.MELTIPLY_STAGING_BEARER_TOKEN]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.replace(signedUrlPattern, "[SIGNED_URL]");
}

function sorted(values) {
  return [...values].sort();
}

function safeResources(resources) {
  return resources
    .map((resource) => ({
      ...(resource.assetId ? { asset_id: resource.assetId } : {}),
      ...(resource.sessionId ? { session_id: resource.sessionId } : {}),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

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

function writeAttemptEvidence(options, evidence) {
  return writeEvidence(dirname(options.outputPath), basename(options.outputPath), evidence);
}

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
  try {
    await verifyReleaseCheckout({
      repoRoot: dependencies.repoRoot,
      runCommand: dependencies.runCommand,
      spec: options.releaseSpec,
    });
    checkoutVerified = true;
    apiRequest = makeApiClient(runOptions, dependencies, apiRequestIds, operations);
    health = await verifyStagingTarget(apiRequest, runOptions);
    identity = await verifyAcceptanceIdentity(apiRequest, dependencies.environment);
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
