import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const scriptPath = fileURLToPath(import.meta.url);
const contractRoot = resolve(dirname(scriptPath), "..");

const defaultPaths = {
  metadata: resolve(contractRoot, "operation-readiness.json"),
  openApi: resolve(contractRoot, "openapi.yaml"),
  output: resolve(contractRoot, "endpoint-readiness.md"),
};

const httpMethods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
const readinessStates = new Set(["specified", "worker-preview", "staging-ready", "accepted"]);
const evidenceKinds = ["release", "conformance", "smoke", "telemetry", "acceptance"];
const requiredEvidence = {
  specified: [],
  "worker-preview": ["release", "conformance"],
  "staging-ready": ["release", "conformance", "smoke", "telemetry"],
  accepted: ["release", "conformance", "smoke", "telemetry", "acceptance"],
};
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const maximumEvidenceBytes = 1024 * 1024;
const evidenceTimeoutMilliseconds = 10_000;

/**
 * Asserts whether a value is a non-null, non-array object record.
 * Used across schema and metadata validation to reject primitives and lists.
 * Returns true if value is a plain record object, false otherwise.
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Enforces strict object schema shape by rejecting unexpected property keys.
 * Fails closed against undocumented metadata fields or accidental typo keys.
 * Throws Error listing unexpected keys if value contains keys outside allowedKeys.
 */
function assertExactKeys(value, allowedKeys, subject) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${subject} has unsupported field(s): ${unexpected.sort().join(", ")}`);
  }
}

/**
 * Extracts and deduplicates all valid HTTP operations defined in an OpenAPI specification.
 * Validates that every path item operation has a non-empty string operationId without duplicates.
 * Returns an array of `{ method, operationId, path }` descriptor records sorted by path occurrence.
 * Throws Error if document is malformed or duplicate operationIds are found.
 */
export function collectOpenApiOperations(document) {
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new Error("OpenAPI document must contain a paths object");
  }

  const operations = [];
  const seen = new Set();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!httpMethods.has(method.toLowerCase())) continue;
      if (!isRecord(operation)) {
        throw new Error(`OpenAPI operation ${method.toUpperCase()} ${path} is invalid`);
      }
      const operationId = operation.operationId;
      if (typeof operationId !== "string" || operationId.trim() !== operationId) {
        throw new Error(
          `OpenAPI operation ${method.toUpperCase()} ${path} must have a non-empty operationId`,
        );
      }
      if (operationId.length === 0) {
        throw new Error(
          `OpenAPI operation ${method.toUpperCase()} ${path} must have a non-empty operationId`,
        );
      }
      if (seen.has(operationId)) {
        throw new Error(`OpenAPI operationId is duplicated: ${operationId}`);
      }
      seen.add(operationId);
      operations.push({ method: method.toUpperCase(), operationId, path });
    }
  }

  return operations;
}

/**
 * Validates an immutable external evidence artifact reference descriptor.
 * Enforces that reference is an object containing exact `{ url, digest }` keys,
 * where url is a credential-free HTTPS URL and digest is a lowercase sha256 hex string.
 * Throws Error if reference shape, URL format, protocol, or digest format is invalid.
 */
function validateEvidenceReference(reference, subject) {
  if (!isRecord(reference)) {
    throw new Error(`${subject} must be an object`);
  }
  assertExactKeys(reference, ["url", "digest"], subject);

  if (typeof reference.url !== "string") {
    throw new Error(`${subject}.url must be an HTTPS URL`);
  }
  let url;
  try {
    url = new URL(reference.url);
  } catch {
    throw new Error(`${subject}.url must be an HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    reference.url.includes("|")
  ) {
    throw new Error(`${subject}.url must be a credential-free HTTPS URL without a fragment`);
  }
  if (typeof reference.digest !== "string" || !sha256Pattern.test(reference.digest)) {
    throw new Error(
      `${subject}.digest must be a lowercase sha256:<64 hex characters> content digest`,
    );
  }
}

/**
 * Validates readiness metadata for a single OpenAPI operation against promotion criteria.
 * Verifies allowed keys, supported state ('specified'|'worker-preview'|'staging-ready'|'accepted'),
 * non-empty single-line gate text, and the presence of all required immutable evidence kinds.
 * Throws Error if metadata fields are invalid or required evidence references are missing.
 */
function validateOperationReadiness(operationId, readiness) {
  const subject = `readiness metadata for ${operationId}`;
  if (!isRecord(readiness)) {
    throw new Error(`${subject} must be an object`);
  }
  assertExactKeys(readiness, ["state", "evidenceAndGate", "promotionEvidence"], subject);

  if (typeof readiness.state !== "string" || !readinessStates.has(readiness.state)) {
    throw new Error(`${subject}.state is not a supported readiness state`);
  }
  if (
    typeof readiness.evidenceAndGate !== "string" ||
    readiness.evidenceAndGate.trim() !== readiness.evidenceAndGate ||
    readiness.evidenceAndGate.length === 0 ||
    /[\r\n|]/u.test(readiness.evidenceAndGate)
  ) {
    throw new Error(
      `${subject}.evidenceAndGate must be a non-empty, single-line Markdown table value`,
    );
  }

  const promotionEvidence = readiness.promotionEvidence;
  if (promotionEvidence !== undefined) {
    if (!isRecord(promotionEvidence)) {
      throw new Error(`${subject}.promotionEvidence must be an object`);
    }
    assertExactKeys(promotionEvidence, evidenceKinds, `${subject}.promotionEvidence`);
    for (const [kind, reference] of Object.entries(promotionEvidence)) {
      validateEvidenceReference(reference, `${subject}.promotionEvidence.${kind}`);
    }
  }

  const required = requiredEvidence[readiness.state];
  const missing = required.filter((kind) => !promotionEvidence?.[kind]);
  if (missing.length > 0) {
    throw new Error(
      `${operationId} cannot be ${readiness.state} without immutable ${missing.join(
        ", ",
      )} evidence`,
    );
  }
}

/**
 * Validates that the readiness metadata catalog strictly mirrors the OpenAPI contract.
 * Enforces schemaVersion 1, exact version match with openApi.info.version, and 1:1 bijective
 * mapping between OpenAPI operationIds and catalog operation entries.
 * Returns collected OpenAPI operations. Throws Error on version drift, missing, or extra IDs.
 */
export function validateReadinessCatalog(openApi, catalog) {
  if (!isRecord(catalog)) {
    throw new Error("readiness metadata must be an object");
  }
  assertExactKeys(
    catalog,
    ["schemaVersion", "contractVersion", "operations"],
    "readiness metadata",
  );
  if (catalog.schemaVersion !== 1) {
    throw new Error("readiness metadata schemaVersion must be 1");
  }
  if (!isRecord(openApi.info) || typeof openApi.info.version !== "string") {
    throw new Error("OpenAPI document must contain info.version");
  }
  if (catalog.contractVersion !== openApi.info.version) {
    throw new Error(
      `readiness contractVersion ${String(catalog.contractVersion)} does not match OpenAPI ${openApi.info.version}`,
    );
  }
  if (!isRecord(catalog.operations)) {
    throw new Error("readiness metadata operations must be an object");
  }

  const openApiOperations = collectOpenApiOperations(openApi);
  const operationIds = new Set(openApiOperations.map(({ operationId }) => operationId));
  const metadataIds = new Set(Object.keys(catalog.operations));
  const missing = [...operationIds].filter((operationId) => !metadataIds.has(operationId)).sort();
  const extra = [...metadataIds].filter((operationId) => !operationIds.has(operationId)).sort();
  if (missing.length > 0 || extra.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) details.push(`extra: ${extra.join(", ")}`);
    throw new Error(
      `readiness metadata must cover exactly every OpenAPI operationId (${details.join("; ")})`,
    );
  }

  for (const operationId of metadataIds) {
    validateOperationReadiness(operationId, catalog.operations[operationId]);
  }

  return openApiOperations;
}

/**
 * Resolves optional HTTP authorization headers for evidence artifact downloads.
 * Strictly checks that authorization is only attached when url matches the origin specified
 * in MELTIPLY_READINESS_EVIDENCE_AUTH_ORIGIN, preventing credential leakage to third parties.
 * Returns `{ authorization }` header record if origin matches, or undefined otherwise.
 */
function evidenceRequestHeaders(url, environment) {
  const authorization = environment.MELTIPLY_READINESS_EVIDENCE_AUTHORIZATION?.trim();
  if (!authorization) return undefined;
  if (/[\r\n]/u.test(authorization)) {
    throw new Error("MELTIPLY_READINESS_EVIDENCE_AUTHORIZATION must be one HTTP header value");
  }

  const configuredOrigin = environment.MELTIPLY_READINESS_EVIDENCE_AUTH_ORIGIN?.trim();
  if (!configuredOrigin) {
    throw new Error(
      "MELTIPLY_READINESS_EVIDENCE_AUTH_ORIGIN is required when evidence authorization is configured",
    );
  }
  let origin;
  try {
    const parsed = new URL(configuredOrigin);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== configuredOrigin ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error("invalid origin");
    }
    origin = parsed.origin;
  } catch {
    throw new Error("MELTIPLY_READINESS_EVIDENCE_AUTH_ORIGIN must be an HTTPS origin");
  }

  return new URL(url).origin === origin ? { authorization } : undefined;
}

/**
 * Reads an HTTP response body into memory with strict byte limit enforcement (1 MiB).
 * Prevents memory exhaustion during CI verification by inspecting Content-Length upfront
 * and terminating streaming readers early if byte count exceeds maximumEvidenceBytes.
 * Returns Uint8Array of downloaded bytes. Throws Error on invalid length or limit overflow.
 */
async function readBoundedEvidence(response, url) {
  const contentLength = response.headers?.get("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`evidence artifact has an invalid Content-Length: ${url}`);
    }
    if (length > maximumEvidenceBytes) {
      throw new Error(`evidence artifact exceeds ${maximumEvidenceBytes} bytes: ${url}`);
    }
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumEvidenceBytes) {
      throw new Error(`evidence artifact exceeds ${maximumEvidenceBytes} bytes: ${url}`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumEvidenceBytes) {
      await reader.cancel();
      throw new Error(`evidence artifact exceeds ${maximumEvidenceBytes} bytes: ${url}`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fetches, reads, and cryptographically verifies an immutable JSON evidence artifact.
 * Issues a timeout-bounded, redirect-denied HTTP request, calculates SHA-256 over received bytes,
 * asserts exact match against reference.digest, and parses valid UTF-8 JSON.
 * Returns parsed JSON artifact record. Throws Error on fetch failure, status error, or digest mismatch.
 */
async function fetchEvidenceArtifact(reference, fetchImplementation, environment) {
  let response;
  try {
    response = await fetchImplementation(reference.url, {
      headers: evidenceRequestHeaders(reference.url, environment),
      redirect: "error",
      signal: AbortSignal.timeout(evidenceTimeoutMilliseconds),
    });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`unable to fetch evidence artifact ${reference.url}${detail}`);
  }
  if (!response.ok) {
    throw new Error(`evidence artifact ${reference.url} returned HTTP ${response.status}`);
  }

  const bytes = await readBoundedEvidence(response, reference.url);
  const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actualDigest !== reference.digest) {
    throw new Error(`evidence artifact digest mismatch: ${reference.url}`);
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`evidence artifact is not valid UTF-8 JSON: ${reference.url}`);
  }
}

/**
 * Validates the contents and scope of a fetched evidence artifact record.
 * Asserts schemaVersion 1, matching evidence kind, passing result ('passed'),
 * and explicit inclusion of target operationId within artifact.operationIds.
 * Throws Error if artifact structure is invalid or does not certify operationId passing.
 */
function validateFetchedEvidence(artifact, kind, operationId, url) {
  if (!isRecord(artifact) || artifact.schemaVersion !== 1) {
    throw new Error(`evidence artifact has an unsupported schema: ${url}`);
  }
  if (artifact.kind !== kind) {
    throw new Error(`evidence artifact kind must be ${kind} for ${operationId}: ${url}`);
  }
  if (artifact.result !== "passed") {
    throw new Error(`evidence artifact result must be passed for ${operationId}: ${url}`);
  }
  if (
    !Array.isArray(artifact.operationIds) ||
    artifact.operationIds.some(
      (candidate) => typeof candidate !== "string" || candidate.length === 0,
    )
  ) {
    throw new Error(`evidence artifact operationIds must be strings: ${url}`);
  }
  if (!artifact.operationIds.includes(operationId)) {
    throw new Error(`evidence artifact does not cover operation ${operationId}: ${url}`);
  }
}

/**
 * Verifies all required promotion evidence artifacts for promoted OpenAPI operations in parallel.
 * Collects distinct artifact URLs across operations, downloads each artifact concurrently using a worker
 * pool (up to 4 workers), and verifies cryptographic digests and passing status for each required evidence kind.
 * Throws Error if evidence fetching fails, digests mismatch, or requirements are unsatisfied.
 */
export async function verifyPromotionEvidence(
  openApi,
  catalog,
  { environment = process.env, fetchImplementation = globalThis.fetch } = {},
) {
  const operations = validateReadinessCatalog(openApi, catalog);
  const artifacts = new Map();

  for (const { operationId } of operations) {
    const readiness = catalog.operations[operationId];
    for (const kind of requiredEvidence[readiness.state]) {
      const reference = readiness.promotionEvidence[kind];
      const key = `${reference.url}\n${reference.digest}`;
      const entry = artifacts.get(key) ?? { reference, requirements: [] };
      entry.requirements.push({ kind, operationId });
      artifacts.set(key, entry);
    }
  }

  if (artifacts.size === 0) return;
  if (typeof fetchImplementation !== "function") {
    throw new Error("fetch is required to verify promoted endpoint evidence");
  }

  const entries = [...artifacts.values()];
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const entry = entries[cursor];
      cursor += 1;
      const artifact = await fetchEvidenceArtifact(
        entry.reference,
        fetchImplementation,
        environment,
      );
      for (const { kind, operationId } of entry.requirements) {
        validateFetchedEvidence(artifact, kind, operationId, entry.reference.url);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
}

/**
 * Formats markdown links and SHA-256 digests for checked-in promotion evidence references.
 * Iterates defined evidence kinds in standard order to generate a markdown table suffix.
 * Returns formatted markdown string, or an empty string if no promotion evidence is provided.
 */
function promotionEvidenceSuffix(promotionEvidence) {
  if (!promotionEvidence) return "";
  const references = evidenceKinds
    .filter((kind) => promotionEvidence[kind])
    .map((kind) => {
      const reference = promotionEvidence[kind];
      return `[${kind}](${reference.url}) \`${reference.digest}\``;
    });
  return references.length > 0 ? ` Immutable promotion evidence: ${references.join(", ")}.` : "";
}

/**
 * Renders an aligned Markdown table from row tuples with computed column widths.
 * Formats header, delimiter, and data rows with uniform padding for deterministic diffs.
 * Returns complete multi-line Markdown table string.
 */
function markdownTable(rows) {
  const headers = [
    "Operation",
    "Current state",
    "Checked-in evidence and remaining promotion gate",
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const formatRow = (row) =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(" | ")} |`;
  return [
    formatRow(headers),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
  ].join("\n");
}

/**
 * Renders the complete Markdown document for endpoint-readiness.md from contract and catalog.
 * Validates catalog integrity and formats each operation row with state, gate, and evidence.
 * Returns a deterministic Markdown document with Bun evidence commands for CI drift verification.
 */
export function renderEndpointReadiness(openApi, catalog) {
  const operations = validateReadinessCatalog(openApi, catalog);
  const rows = operations.map(({ operationId }) => {
    const readiness = catalog.operations[operationId];
    return [
      `\`${operationId}\``,
      `\`${readiness.state}\``,
      `${readiness.evidenceAndGate}${promotionEvidenceSuffix(readiness.promotionEvidence)}`,
    ];
  });

  return `# Endpoint Readiness Matrix

<!-- Generated by bun run contract:readiness:generate. Do not edit this file directly. -->

The states and promotion rules come from the target contract and deployment
gates. This matrix records the highest verified environment, not
implementation intent. Its canonical source is
[operation-readiness.json](operation-readiness.json).

Current version: contract/client/Worker \`${catalog.contractVersion}\`.

${markdownTable(rows)}

## Promotion evidence policy

The generator fails closed if the metadata does not cover exactly every
OpenAPI \`operationId\`. A \`worker-preview\` row requires immutable release and
conformance artifacts. A \`staging-ready\` row additionally requires an
immutable staging smoke artifact and telemetry artifact. An \`accepted\` row
additionally requires an immutable phase-acceptance artifact. Every artifact
reference is a credential-free HTTPS URL paired with a lowercase SHA-256
content digest. Check mode retrieves each distinct bounded artifact without
following redirects, verifies its digest, and requires a passing JSON record
for the exact evidence kind and operation; labels or unfetched references
cannot promote an operation.

## Evidence commands

- \`bun run contract:readiness:generate\`
- \`bun run contract:readiness:check\`
- \`bun run contract:test-readiness\`
- \`bun run contract:check\`
- \`bun run --filter @meltiply/api-worker test\`
- \`bun run test:integration\`
- \`bun run local:smoke\`

The matrix advances only when the canonical metadata includes the evidence
required for the destination state. The checked-in CI gate regenerates the
matrix in memory and rejects source/output drift.
`;
}

/**
 * Parses CLI arguments for the endpoint readiness tool into normalized execution options.
 * Validates that exactly one mode (--check or --write) is specified alongside optional path flags.
 * Returns parsed options object with resolved absolute file paths and execution mode.
 * Throws Error on missing, duplicate, or unrecognized arguments.
 */
function parseArguments(args) {
  const options = { ...defaultPaths, mode: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check" || argument === "--write") {
      if (options.mode) throw new Error("choose exactly one of --check or --write");
      options.mode = argument.slice(2);
      continue;
    }
    const field = {
      "--metadata": "metadata",
      "--openapi": "openApi",
      "--output": "output",
    }[argument];
    if (!field) throw new Error(`unknown argument: ${argument}`);
    const value = args[index + 1];
    if (!value) throw new Error(`${argument} requires a path`);
    options[field] = resolve(value);
    index += 1;
  }
  if (!options.mode) throw new Error("choose exactly one of --check or --write");
  return options;
}

/**
 * Reads and parses the OpenAPI YAML specification and readiness JSON catalog in parallel.
 * Used by CLI runner to load source files before generation or drift verification.
 * Returns `{ catalog, openApi }` parsed data object.
 */
async function readInputs(options) {
  const [openApiSource, metadataSource] = await Promise.all([
    readFile(options.openApi, "utf8"),
    readFile(options.metadata, "utf8"),
  ]);
  return {
    catalog: JSON.parse(metadataSource),
    openApi: YAML.parse(openApiSource),
  };
}

/**
 * Main execution entry point for endpoint readiness matrix generation and validation.
 * In write mode, updates endpoint-readiness.md. In check mode, verifies that the checked-in
 * file matches generated output and validates all external promotion evidence artifacts.
 * Throws on stale output with the Bun regeneration command, invalid evidence, or invalid arguments.
 */
export async function run(args, dependencies) {
  const options = parseArguments(args);
  const { catalog, openApi } = await readInputs(options);
  const generated = renderEndpointReadiness(openApi, catalog);

  if (options.mode === "write") {
    await writeFile(options.output, generated, "utf8");
    console.log(`wrote ${options.output}`);
    return;
  }

  const current = await readFile(options.output, "utf8");
  if (current !== generated) {
    throw new Error(`${options.output} is stale; run bun run contract:readiness:generate`);
  }
  await verifyPromotionEvidence(openApi, catalog, dependencies);
  console.log(
    `endpoint readiness covers ${Object.keys(catalog.operations).length} OpenAPI operations and its required evidence is verified`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
