import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const unsafeEvidenceCharactersPattern = /[\r\n|]/u;
const headerLineBreakPattern = /[\r\n]/u;

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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowedKeys, subject) {
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${subject} has unsupported field(s): ${unexpected.sort().join(", ")}`);
  }
}

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
    unsafeEvidenceCharactersPattern.test(readiness.evidenceAndGate)
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

function evidenceRequestHeaders(url, environment) {
  const authorization = environment.MELTIPLY_READINESS_EVIDENCE_AUTHORIZATION?.trim();
  if (!authorization) return undefined;
  if (headerLineBreakPattern.test(authorization)) {
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
