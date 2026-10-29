import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { readJsonFile, sha256, writeEvidence } from "./release-guard.mjs";
import { releaseInternals } from "./release-lib.mjs";
import { buildFrontend } from "./release-frontend.mjs";

const versionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const deployPhases = new Map([
  [
    "api-bootstrap",
    {
      mode: "bootstrap",
      steps: new Set(["activate", "initialize"]),
      worker: "api",
    },
  ],
  ["api-update", { mode: "update", steps: new Set(["upload"]), worker: "api" }],
  [
    "automation-bootstrap",
    {
      mode: "bootstrap",
      steps: new Set(["activate", "initialize"]),
      worker: "automation",
    },
  ],
  [
    "automation-update",
    {
      mode: "update",
      steps: new Set(["activate", "upload"]),
      worker: "automation",
    },
  ],
  ["state-bootstrap", { mode: "bootstrap", steps: new Set(["initialize"]), worker: "state" }],
  ["state-update", { mode: "update", steps: new Set(["activate", "upload"]), worker: "state" }],
  ["frontend-bootstrap", { mode: "bootstrap", steps: new Set(["initialize"]), worker: "frontend" }],
  ["frontend-update", { mode: "update", steps: new Set(["activate", "upload"]), worker: "frontend" }],
]);

/**
 * Asserts that a value is a valid Cloudflare Worker version identifier (UUID format).
 *
 * @param {unknown} value - Candidate version identifier to validate
 * @param {string} [name="Worker version ID"] - Field name used for descriptive error messages
 * @returns {string} Validated version ID string
 * @throws {TypeError} If value is not a valid UUID string
 */
export function validateWorkerVersionId(value, name = "Worker version ID") {
  if (typeof value !== "string" || !versionIdPattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

/**
 * Safely parses a JSON string, providing contextual error reporting on failure.
 *
 * @param {string} source - Raw JSON source string
 * @param {string} name - Entity or field name for error diagnostics
 * @returns {any} Parsed JavaScript value
 * @throws {TypeError} If source cannot be parsed as valid JSON
 */
function parseJson(source, name) {
  try {
    return JSON.parse(source);
  } catch {
    throw new TypeError(`${name} must be valid JSON`);
  }
}

/**
 * Validates that an object contains exactly the expected set of keys, with no extra or missing keys.
 *
 * @param {unknown} value - Candidate object to inspect
 * @param {Set<string>} keys - Set of required and allowed property names
 * @param {string} name - Description of the object for error diagnostics
 * @returns {Record<string, unknown>} Validated object
 * @throws {TypeError} If value is not an object, has unknown keys, or is missing required keys
 */
function exactObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.has(key));
  const missing = [...keys].filter((key) => !(key in value));
  if (unknown.length > 0) throw new TypeError(`${name} has unknown keys: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new TypeError(`${name} is missing keys: ${missing.join(", ")}`);
  return value;
}

/**
 * Resolves deployment phase and step specifications into execution parameters.
 *
 * Verifies that the requested phase is registered, conforms to the release deployment
 * mode (bootstrap vs update), and permits the requested step (initialize, upload, activate).
 *
 * @param {string} phase - Registered deploy phase name (e.g., "api-update", "state-bootstrap")
 * @param {string} step - Deployment step ("initialize", "upload", "activate")
 * @param {object} spec - Release specification defining deployment_mode
 * @returns {{ mode: "bootstrap"|"update", step: string, worker: "api"|"automation"|"state"|"frontend" }} Resolved phase execution intent
 * @throws {TypeError} If phase is unrecognized, mode mismatches, or step is disallowed for the phase
 */
export function resolveDeployPhase(phase, step, spec) {
  const definition = deployPhases.get(phase);
  if (!definition) throw new TypeError(`unknown deploy phase: ${phase}`);
  if (definition.mode !== spec.deployment_mode) {
    throw new TypeError(`${phase} does not match deployment_mode ${spec.deployment_mode}`);
  }
  if (!definition.steps.has(step)) {
    throw new TypeError(`${step} is not valid for ${phase}`);
  }
  return { mode: definition.mode, step, worker: definition.worker };
}

/**
 * Parses Wrangler NDJSON output file to extract deployment or version upload records.
 *
 * Inspects all NDJSON lines emitted by Wrangler, checking for explicit command-failed
 * records. Enforces that exactly one record matches expectedType and that the worker_name
 * aligns with the expected Worker service name.
 *
 * @param {string} source - Raw NDJSON output from Wrangler
 * @param {string} expectedType - Target record type ("deploy" or "version-upload")
 * @param {string} expectedWorker - Expected Cloudflare Worker name
 * @returns {{ preview_alias_url: string|null, preview_url: string|null, version_id: string }} Extracted URLs and validated version ID
 * @throws {Error|TypeError} If Wrangler reported failure, output format is invalid, or worker name mismatches
 */
export function parseWranglerOutput(source, expectedType, expectedWorker) {
  const entries = source
    .split("\n")
    .filter(Boolean)
    .map((line, index) => parseJson(line, `Wrangler output line ${index + 1}`));
  const failure = entries.find((entry) => entry.type === "command-failed");
  if (failure) throw new Error(`Wrangler reported failure: ${failure.message ?? "unknown error"}`);
  const matches = entries.filter((entry) => entry.type === expectedType);
  if (matches.length !== 1) {
    throw new TypeError(`Wrangler output must contain exactly one ${expectedType} record`);
  }
  const output = matches[0];
  if (output.worker_name !== expectedWorker) {
    throw new TypeError("Wrangler output Worker name does not match the release phase");
  }
  return {
    preview_alias_url:
      typeof output.preview_alias_url === "string" ? output.preview_alias_url : null,
    preview_url: typeof output.preview_url === "string" ? output.preview_url : null,
    version_id: validateWorkerVersionId(output.version_id),
  };
}

/**
 * Parses Wrangler secret bulk upload output to extract the newly created version ID.
 *
 * Strips ANSI terminal escape sequences, searches for the standard Wrangler version creation
 * confirmation string, verifies the number of injected secrets matches expectedCount, and
 * returns the validated new version identifier.
 *
 * @param {string} source - Terminal output from wrangler versions secret bulk
 * @param {number} expectedCount - Expected number of secrets injected
 * @returns {string} Validated version ID for the secret-injected version
 * @throws {TypeError} If output format mismatches or injected secret count does not match expected
 */
export function parseSecretVersionOutput(source, expectedCount) {
  const sanitized = source.replace(/\u001b\[[0-9;]*m/g, "");
  const matches = [
    ...sanitized.matchAll(/Success! Created version ([0-9a-f-]{36}) with ([0-9]+) secrets\./g),
  ];
  if (matches.length !== 1) {
    throw new TypeError("Wrangler secret output must contain exactly one created version ID");
  }
  if (Number(matches[0][2]) !== expectedCount) {
    throw new TypeError("Wrangler secret output count does not match the submitted bundle");
  }
  return validateWorkerVersionId(matches[0][1]);
}

/**
 * Parses Wrangler rollback output to extract the active Worker version ID.
 *
 * Strips ANSI formatting and extracts the version UUID from the "Current Version ID:" field.
 *
 * @param {string} source - Terminal output from wrangler rollback command
 * @returns {string} Validated current version ID
 * @throws {TypeError} If output does not contain exactly one current version ID match
 */
export function parseRollbackVersionOutput(source) {
  const sanitized = source.replace(/\u001b\[[0-9;]*m/g, "");
  const matches = [...sanitized.matchAll(/Current Version ID:\s*([0-9a-f-]{36})(?:\s|$)/g)];
  if (matches.length !== 1) {
    throw new TypeError("Wrangler rollback output must contain exactly one current version ID");
  }
  return validateWorkerVersionId(matches[0][1]);
}

/**
 * Parses JSON output of Wrangler versions list to extract version IDs and release tags.
 *
 * Enforces array structure and valid UUID version IDs, extracting custom worker tags
 * from annotations['workers/tag'] if present.
 *
 * @param {string} source - JSON string output from wrangler versions list --json
 * @returns {Array<{ id: string, tag: string|null }>} Array of parsed versions
 * @throws {TypeError} If output is not an array or contains invalid version IDs
 */
export function parseVersionList(source) {
  const versions = parseJson(source, "Wrangler version list");
  if (!Array.isArray(versions)) throw new TypeError("Wrangler version list must be an array");
  return versions.map((entry, index) => ({
    id: validateWorkerVersionId(entry?.id, `Wrangler version list[${index}].id`),
    tag:
      typeof entry?.annotations?.["workers/tag"] === "string"
        ? entry.annotations["workers/tag"]
        : null,
  }));
}

/**
 * Locates a uniquely tagged version entry within a list of Worker versions.
 *
 * Asserts uniqueness to prevent ambiguous version targeting; throws if multiple
 * versions share the same tag.
 *
 * @param {Array<{ id: string, tag: string|null }>} versions - List of candidate versions
 * @param {string} tag - Expected release tag
 * @returns {{ id: string, tag: string|null }|undefined} Unique matching version record, or undefined
 * @throws {TypeError} If duplicate versions with the specified tag are found
 */
export function findUniqueTaggedVersion(versions, tag) {
  const matches = versions.filter((entry) => entry.tag === tag);
  if (matches.length > 1) {
    throw new TypeError(`Wrangler returned duplicate versions for tag ${tag}`);
  }
  return matches[0];
}

/**
 * Parses Wrangler deployment status JSON to extract normalized traffic percentages.
 *
 * Validates that version percentages are positive finite numbers totaling 100%,
 * verifies valid UUID version IDs, and returns a canonically sorted traffic array.
 *
 * @param {string} source - Raw JSON string from wrangler deployments status --json
 * @returns {Array<{ percentage: number, version_id: string }>} Sorted traffic allocations
 * @throws {TypeError} If versions are missing, percentages are invalid, or total percentage does not equal 100
 */
export function parseDeploymentStatus(source) {
  const deployment = parseJson(source, "Wrangler deployment status");
  if (!Array.isArray(deployment?.versions) || deployment.versions.length === 0) {
    throw new TypeError("Wrangler deployment status must include version traffic");
  }
  const traffic = deployment.versions.map((entry, index) => {
    const percentage = Number(entry?.percentage);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      throw new TypeError(`Wrangler deployment status versions[${index}].percentage is invalid`);
    }
    return {
      percentage,
      version_id: validateWorkerVersionId(
        entry?.version_id,
        `Wrangler deployment status versions[${index}].version_id`,
      ),
    };
  });
  const total = traffic.reduce((sum, entry) => sum + entry.percentage, 0);
  if (Math.abs(total - 100) > 0.0001) {
    throw new TypeError("Wrangler deployment traffic must total 100 percent");
  }
  return traffic.sort((left, right) => left.version_id.localeCompare(right.version_id));
}

/**
 * Validates an unencrypted JSON secret bundle received via stdin for release injection.
 *
 * Enforces size limits (<= 64KB), restricts worker scope to "api" and "automation",
 * asserts presence of all required remote secrets specified by the release specification,
 * and validates that values are non-empty trimmed strings free of binary or newline corruption.
 *
 * @param {string} source - Raw JSON string from stdin secret bundle
 * @param {object} spec - Release specification defining required provider secrets
 * @param {"api"|"automation"} worker - Target Worker service identifier
 * @returns {{ names: Array<string>, values: Record<string, string> }} Required secret names and values for target worker
 * @throws {TypeError} If worker is unsupported, size exceeds limit, or secret values are malformed
 */
export function validateSecretBundle(source, spec, worker) {
  if (!new Set(["api", "automation"]).has(worker)) {
    throw new TypeError("secret injection is supported only for API and Automation");
  }
  if (Buffer.byteLength(source) > 64 * 1024) {
    throw new TypeError("release secret bundle exceeds 65536 bytes");
  }
  const bundle = exactObject(
    parseJson(source, "release secret bundle"),
    new Set(["api", "automation"]),
    "release secret bundle",
  );
  const required = releaseInternals.requiredRemoteSecrets(spec);
  for (const target of ["api", "automation"]) {
    const values = exactObject(
      bundle[target],
      new Set(required[target]),
      `release secret bundle.${target}`,
    );
    for (const name of required[target]) {
      const value = values[name];
      if (
        typeof value !== "string" ||
        value.trim() !== value ||
        value.length < 8 ||
        value.length > 4096 ||
        /[\u0000\r\n]/.test(value)
      ) {
        throw new TypeError(`release secret bundle.${target}.${name} is invalid`);
      }
    }
  }
  return {
    names: [...required[worker]],
    values: bundle[worker],
  };
}

/**
 * Resolves the filesystem path to a rendered Wrangler configuration file.
 *
 * @param {string} outDir - Base release output directory
 * @param {string} worker - Worker service name ("api", "automation", or "state")
 * @returns {string} Absolute path to the rendered wrangler JSON configuration
 */
export function workerConfigPath(outDir, worker) {
  return path.join(outDir, "wrangler", `${worker}.json`);
}

/**
 * Resolves the filesystem path to a Worker candidate evidence file.
 *
 * @param {string} outDir - Base release output directory
 * @param {string} worker - Worker service name ("api", "automation", or "state")
 * @returns {string} Absolute path to the worker candidate evidence JSON
 */
export function candidatePath(outDir, worker) {
  return path.join(outDir, `worker-${worker}-candidate.json`);
}

/**
 * Resolves the filesystem path to a Worker secrets evidence file.
 *
 * @param {string} outDir - Base release output directory
 * @param {string} worker - Worker service name ("api" or "automation")
 * @returns {string} Absolute path to the worker secrets evidence JSON
 */
export function secretPath(outDir, worker) {
  return path.join(outDir, `worker-${worker}-secrets.json`);
}

/**
 * Executes a Wrangler CLI command and captures its structured NDJSON output file.
 *
 * Removes any pre-existing output file before execution to prevent stale evidence reads.
 * Configures the WRANGLER_OUTPUT_FILE_PATH environment variable so Wrangler writes
 * machine-readable event lines to the specified path.
 * Uses Bun to locate the pinned Node CLI without fetching packages during a release.
 *
 * @param {object} options - Command execution options
 * @param {Array<string>} options.args - Command line arguments passed to wrangler
 * @param {Record<string, string | undefined>} options.environment - Process environment variables
 * @param {string} options.outDir - Output directory for Wrangler output file
 * @param {string} options.outputName - Output file name
 * @param {Function} options.runCommand - Runner function executing the subprocess
 * @returns {Promise<{ exitCode: number, output: string, stderr: string, stdout: string }>} Subprocess result augmented with raw file output
 */
async function runWrangler({ args, environment, outDir, outputName, runCommand }) {
  const outputPath = path.join(outDir, outputName);
  await rm(outputPath, { force: true });
  const result = await runCommand("bun", ["run", "--no-install", "wrangler", ...args], {
    env: { ...environment, WRANGLER_OUTPUT_FILE_PATH: outputPath },
    stdin: undefined,
  });
  return {
    ...result,
    output: await readFile(outputPath, "utf8"),
  };
}

/**
 * Executes the installed Node Wrangler through Bun without auto-install, returning JSON stdout.
 *
 * @param {Function} runCommand - Subprocess runner function
 * @param {Record<string, string | undefined>} environment - Process environment variables
 * @param {Array<string>} args - Arguments passed to wrangler
 * @returns {Promise<string>} Standard output string from the Wrangler command
 */
async function runWranglerJson(runCommand, environment, args) {
  const result = await runCommand("bun", ["run", "--no-install", "wrangler", ...args], {
    env: environment,
  });
  return result.stdout;
}

/**
 * Constructs a canonical release tag string for a Worker artifact or version.
 *
 * @param {object} spec - Release specification containing release_id
 * @param {string} worker - Worker service name ("api", "automation", "state")
 * @param {string} kind - Tag classification ("code" or "secrets")
 * @returns {string} Formatted release tag (<release_id>-<worker>-<kind>)
 */
function releaseTag(spec, worker, kind) {
  return `${spec.release_id}-${worker}-${kind}`;
}

/**
 * Detects whether a Wrangler command failure was caused by a non-existent Worker.
 *
 * Used during bootstrap mode to distinguish between an unprovisioned Worker service
 * and real control-plane or network failures.
 *
 * @param {unknown} error - Error thrown by Wrangler invocation
 * @returns {boolean} True if error indicates the Worker or deployment does not exist
 */
function isMissingWorker(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /worker|script/i.test(message) && /not found|does not exist|no deployments/i.test(message);
}

/**
 * Fetches and parses the list of deployed versions for a Worker service.
 *
 * @param {object} options - Version listing options
 * @param {string} options.configPath - Path to the worker's wrangler JSON config
 * @param {Record<string, string | undefined>} options.environment - Process environment
 * @param {Function} options.runCommand - Command execution runner
 * @returns {Promise<Array<{ id: string, tag: string|null }>>} List of parsed versions
 */
async function listVersions({ configPath, environment, runCommand }) {
  return parseVersionList(
    await runWranglerJson(runCommand, environment, [
      "versions",
      "list",
      "--config",
      configPath,
      "--json",
    ]),
  );
}

/**
 * Queries Cloudflare control plane for the current traffic routing status of a Worker.
 *
 * @param {object} options - Deployment status query options
 * @param {string} options.configPath - Path to the worker's wrangler JSON config
 * @param {Record<string, string | undefined>} options.environment - Process environment
 * @param {Function} options.runCommand - Command execution runner
 * @returns {Promise<Array<{ percentage: number, version_id: string }>>} Current traffic allocations
 */
export async function getWorkerTraffic({ configPath, environment, runCommand }) {
  return parseDeploymentStatus(
    await runWranglerJson(runCommand, environment, [
      "deployments",
      "status",
      "--config",
      configPath,
      "--json",
    ]),
  );
}

/**
 * Parses and verifies details of a specific Worker version from Cloudflare control plane.
 *
 * Enforces that the retrieved version ID and release tag match expected values.
 * For API, Automation, and frontend, asserts that the plaintext VERSION binding
 * matches the exact Git commit SHA of the release.
 *
 * @param {string} source - JSON output from wrangler versions view <id> --json
 * @param {object} expected - Expected version properties
 * @param {string} expected.gitSha - Expected Git commit SHA
 * @param {string} expected.id - Expected Worker version UUID
 * @param {string} expected.tag - Expected release tag
 * @param {string} expected.worker - Worker service identifier
 * @returns {object} Parsed version details object
 * @throws {TypeError} If ID, tag, or VERSION binding do not match expected values
 */
export function parseVersionDetails(source, expected) {
  const details = parseJson(source, "Wrangler version view");
  if (validateWorkerVersionId(details?.id) !== expected.id) {
    throw new TypeError("Wrangler returned a different version");
  }
  if (details?.annotations?.["workers/tag"] !== expected.tag) {
    throw new TypeError(`Wrangler ${expected.worker} version tag does not match the release`);
  }
  if (new Set(["api", "automation", "frontend"]).has(expected.worker)) {
    if (!Array.isArray(details?.resources?.bindings)) {
      throw new TypeError(`Wrangler ${expected.worker} version bindings are invalid`);
    }
    const versionBindings = details.resources.bindings.filter(
      (binding) => binding?.name === "VERSION",
    );
    if (
      versionBindings.length !== 1 ||
      versionBindings[0].type !== "plain_text" ||
      versionBindings[0].text !== expected.gitSha
    ) {
      throw new TypeError(`Wrangler ${expected.worker} VERSION binding does not match the release`);
    }
  }
  return details;
}

/**
 * Extracts the release-pinned VERSION binding SHA from a Worker version view payload.
 *
 * Used for versions that are not release candidates (for example the previous
 * serving version during a rollout), where tag assertions do not apply.
 * Requires the version to carry exactly one plain-text `VERSION` binding; its
 * value is returned unmodified for the caller to compare.
 *
 * @param {string} source - JSON output from wrangler versions view <id> --json
 * @param {object} expected - Expected version properties
 * @param {string} expected.id - Expected Worker version UUID
 * @param {string} expected.worker - Worker service identifier
 * @returns {string} The version's plain-text VERSION binding value
 * @throws {TypeError} If the ID mismatches or no unique VERSION binding exists
 */
function parseVersionBindingSha(source, expected) {
  const details = parseJson(source, "Wrangler version view");
  if (validateWorkerVersionId(details?.id) !== expected.id) {
    throw new TypeError("Wrangler returned a different version");
  }
  if (!Array.isArray(details?.resources?.bindings)) {
    throw new TypeError(`Wrangler ${expected.worker} version bindings are invalid`);
  }
  const versionBindings = details.resources.bindings.filter(
    (binding) => binding?.name === "VERSION",
  );
  if (
    versionBindings.length !== 1 ||
    versionBindings[0].type !== "plain_text" ||
    typeof versionBindings[0].text !== "string" ||
    !/^[0-9a-f]{40}$/.test(versionBindings[0].text)
  ) {
    throw new TypeError(`Wrangler ${expected.worker} version has no unique VERSION binding`);
  }
  return versionBindings[0].text;
}

/**
 * Retrieves and cryptographically validates a Worker version's control-plane metadata.
 *
 * @param {object} options - Version verification options
 * @param {string} options.configPath - Path to worker configuration file
 * @param {Record<string, string | undefined>} options.environment - Process environment
 * @param {string} options.gitSha - Expected Git commit SHA
 * @param {string} options.id - Worker version UUID to verify
 * @param {Function} options.runCommand - Subprocess runner
 * @param {string} options.tag - Expected release tag
 * @param {string} options.worker - Worker service identifier
 * @returns {Promise<object>} Verified version details
 */
export async function verifyWorkerVersion({
  configPath,
  environment,
  gitSha,
  runCommand,
  tag,
  worker,
  id,
}) {
  const source = await runWranglerJson(runCommand, environment, [
    "versions",
    "view",
    id,
    "--config",
    configPath,
    "--json",
  ]);
  return parseVersionDetails(source, { gitSha, id, tag, worker });
}

/**
 * Fetches a Worker version's plain-text VERSION binding SHA from the control plane.
 *
 * Used for versions that carry no release tag expectation, such as the
 * previous serving version during a canary rollout: the SHA lets live smoke
 * constrain which code the hostname may legitimately serve. Fails closed when
 * the version lacks a unique well-formed VERSION binding.
 *
 * @param {object} options - Version lookup options
 * @param {string} options.configPath - Path to the worker's wrangler JSON config
 * @param {Record<string, string | undefined>} options.environment - Process environment
 * @param {string} options.id - Worker version UUID to inspect
 * @param {(cmd: string, args: Array<string>, opts?: object) => Promise<object>} options.runCommand - Subprocess runner
 * @param {string} options.worker - Worker service identifier
 * @returns {Promise<string>} 40-hex Git SHA exposed by the version's VERSION binding
 */
export async function workerVersionBindingSha({ configPath, environment, id, runCommand, worker }) {
  const source = await runWranglerJson(runCommand, environment, [
    "versions",
    "view",
    id,
    "--config",
    configPath,
    "--json",
  ]);
  return parseVersionBindingSha(source, { id, worker });
}

/**
 * Asserts that active Worker traffic matches expected version routing percentages.
 *
 * Sorts both actual and expected traffic arrays by version ID before comparing,
 * ensuring deterministic verification.
 *
 * @param {Array<{ percentage: number, version_id: string }>} traffic - Actual traffic distribution
 * @param {Array<{ percentage: number, version_id: string }>} expected - Expected traffic distribution
 * @throws {TypeError} If traffic allocations differ
 */
function assertWorkerTraffic(traffic, expected) {
  const normalized = [...expected].sort((left, right) =>
    left.version_id.localeCompare(right.version_id),
  );
  if (JSON.stringify(traffic) !== JSON.stringify(normalized)) {
    throw new TypeError("deployed Worker traffic does not match the requested release state");
  }
}

/**
 * Prepares a bootstrap Wrangler configuration by removing scheduled triggers for Automation.
 *
 * Ensures that during initial service provisioning, scheduled cron triggers are suppressed
 * until the release has passed all verification gates and migrations. Writes the modified
 * config with restrictive (0o600) permissions.
 *
 * @param {string} configPath - Path to the rendered worker configuration
 * @param {string} worker - Worker service identifier
 * @returns {Promise<string>} Path to configuration file to use for bootstrap (original or modified)
 */
async function writeBootstrapConfig(configPath, worker) {
  if (worker !== "automation") return configPath;
  const config = await readJsonFile(configPath, "rendered Automation config", 1024 * 1024);
  delete config.triggers;
  const bootstrapPath = configPath.replace(/\.json$/, "-bootstrap.json");
  await writeFile(bootstrapPath, releaseInternals.json(config), {
    mode: 0o600,
  });
  return bootstrapPath;
}

/**
 * Executes a Worker deployment lifecycle step (initialize, upload, or activate).
 *
 * Enforces deployment mode matching (bootstrap vs update), handles idempotent recovery
 * by discovering existing tagged versions on the Cloudflare control plane, uploads code
 * candidate versions or activates secret/code versions to 100% traffic, verifies version
 * bindings, and persists private step evidence.
 *
 * @param {object} options - Worker deployment step options
 * @param {object} options.approvals - Verified human release approvals
 * @param {Record<string, string | undefined>} options.environment - Process environment variables
 * @param {string} options.outDir - Output directory for Wrangler artifacts and step evidence
 * @param {string} options.phase - Deployment phase identifier (e.g., "api-bootstrap", "automation-update")
 * @param {string} options.planDigest - SHA-256 digest of verified release plan
 * @param {Function} options.runCommand - Subprocess runner
 * @param {object} options.spec - Verified release specification
 * @param {string} options.repoRoot - Checkout root for the frontend production build
 * @param {object} options.iac - Reviewed infrastructure identity for frontend deployment
 * @param {string} options.step - Target step ("initialize", "upload", "activate")
 * @returns {Promise<object>} Generated and validated step evidence record
 * @throws {TypeError|Error} If phase/step is invalid, existing version conflicts occur, or traffic assertion fails
 */
export async function deployWorkerStep({
  approvals,
  environment,
  iac,
  outDir,
  phase,
  planDigest,
  runCommand,
  repoRoot,
  spec,
  step,
}) {
  const intent = resolveDeployPhase(phase, step, spec);
  // The reviewed rendered config, not a fixed staging service, owns deployment identity.
  const configPath = workerConfigPath(outDir, intent.worker);
  const configSource = await readFile(configPath, "utf8");
  const config = parseJson(configSource, "rendered Worker config");
  const workerName = config.name;
  if (typeof workerName !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(workerName) ||
      (spec.environment === "production" && !workerName.endsWith(`-${spec.environment}`))) {
    throw new TypeError("rendered Worker config has the wrong installation name");
  }
  if (intent.worker === "frontend" && (workerName !== iac.frontend_worker_name ||
      config.vars?.VERSION !== spec.git_sha || config.vars?.ENVIRONMENT !== spec.environment ||
      config.vars?.API_ORIGIN !== undefined ||
      config.services?.find((binding) => binding.binding === "API")?.service !== iac.worker_names.api)) {
    throw new TypeError("frontend config does not match the reviewed IaC Worker/environment/API target");
  }
  const configDigest = sha256(configSource);
  const tag = releaseTag(spec, intent.worker, "code");
  let frontendCandidate;
  if (intent.worker === "frontend") {
    try {
      frontendCandidate = await readJsonFile(candidatePath(outDir, "frontend"), "frontend candidate");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (frontendCandidate && (frontendCandidate.config_digest !== configDigest ||
        frontendCandidate.git_sha !== spec.git_sha || frontendCandidate.release_id !== spec.release_id ||
        frontendCandidate.worker_name !== workerName)) {
      throw new TypeError("frontend candidate does not match this release/config");
    }
    if (frontendCandidate && sha256(
      await readFile(path.join(outDir, "wrangler/frontend-built.json"), "utf8"),
    ) !== frontendCandidate.build_config_digest) {
      throw new TypeError("frontend built config does not match the candidate");
    }
  }

  if (step === "initialize" || step === "upload") {
    let versions;
    try {
      versions = await listVersions({ configPath, environment, runCommand });
    } catch (error) {
      if (intent.mode !== "bootstrap" || !isMissingWorker(error)) throw error;
      versions = [];
    }
    const recovered = findUniqueTaggedVersion(versions, tag);
    if (intent.mode === "bootstrap" && versions.length > 0 && !recovered) {
      throw new TypeError(`${workerName} already exists; use deployment_mode update`);
    }
    if (intent.mode === "update" && versions.length === 0) {
      throw new TypeError(`${workerName} has no versions; use deployment_mode bootstrap`);
    }

    let previousVersionId = null;
    if (intent.mode === "update") {
      const current = await getWorkerTraffic({
        configPath,
        environment,
        runCommand,
      });
      if (current.length !== 1 || current[0].percentage !== 100) {
        throw new TypeError("updates require one current Worker version at 100 percent");
      }
      previousVersionId = current[0].version_id;
    }
    if (recovered && frontendCandidate) previousVersionId = frontendCandidate.previous_version_id;

    let frontendBuild;
    if (intent.worker === "frontend") {
      if (frontendCandidate) {
        const builtPath = path.join(outDir, "wrangler/frontend-built.json");
        // The candidate's exact built config was verified before any provider call.
        frontendBuild = { configPath: builtPath, build_config_digest: frontendCandidate.build_config_digest };
      } else {
        frontendBuild = await buildFrontend({ configPath, environment, outDir, repoRoot, runCommand, spec });
      }
    }

    let uploaded;
    if (recovered) {
      uploaded = {
        preview_alias_url: null,
        preview_url: null,
        version_id: recovered.id,
      };
    } else {
      const command = intent.mode === "bootstrap" ? "deploy" : "versions";
      const commandArgs =
        intent.mode === "bootstrap"
          ? [
              command,
              "--config",
              await writeBootstrapConfig(frontendBuild?.configPath ?? configPath, intent.worker),
              "--strict",
              "--tag",
              tag,
              "--message",
              `${spec.release_id} ${intent.worker} bootstrap`,
            ]
          : [
              command,
              "upload",
              "--config",
              frontendBuild?.configPath ?? configPath,
              "--strict",
              "--preview-alias",
              spec.release_id,
              "--tag",
              tag,
              "--message",
              `${spec.release_id} ${intent.worker} candidate`,
            ];
      const result = await runWrangler({
        args: commandArgs,
        environment,
        outDir,
        outputName: `wrangler-${intent.worker}-${step}.jsonl`,
        runCommand,
      });
      uploaded = parseWranglerOutput(
        result.output,
        intent.mode === "bootstrap" ? "deploy" : "version-upload",
        workerName,
      );
    }

    await verifyWorkerVersion({
      configPath,
      environment,
      gitSha: spec.git_sha,
      id: uploaded.version_id,
      runCommand,
      tag,
      worker: intent.worker,
    });
    const evidence = {
      approvals,
      config_digest: configDigest,
      ...(frontendBuild ? { build_config_digest: frontendBuild.build_config_digest, worker_name: workerName } : {}),
      deployment_mode: intent.mode,
      git_sha: spec.git_sha,
      plan_digest: planDigest,
      preview_alias_url: intent.worker === "frontend" ? null : uploaded.preview_alias_url,
      preview_url: intent.worker === "frontend" ? null : uploaded.preview_url,
      previous_version_id: previousVersionId,
      release_id: spec.release_id,
      schema_version: 1,
      step,
      version_id: uploaded.version_id,
      worker: intent.worker,
    };
    await writeEvidence(outDir, `worker-${intent.worker}-candidate.json`, evidence);

    if (intent.mode === "bootstrap" && (intent.worker === "state" || intent.worker === "frontend")) {
      const traffic = await getWorkerTraffic({
        configPath,
        environment,
        runCommand,
      });
      assertWorkerTraffic(traffic, [{ percentage: 100, version_id: uploaded.version_id }]);
      await writeEvidence(outDir, `worker-${intent.worker}-deployment.json`, {
        approvals,
        ...(frontendBuild ? { build_config_digest: frontendBuild.build_config_digest, config_digest: configDigest, worker_name: workerName } : {}),
        git_sha: spec.git_sha,
        plan_digest: planDigest,
        release_id: spec.release_id,
        schema_version: 1,
        traffic,
        version_id: uploaded.version_id,
        worker: intent.worker,
      });
    }
    return evidence;
  }

  const source =
    intent.worker === "state" || intent.worker === "frontend"
      ? await readJsonFile(candidatePath(outDir, intent.worker), "Worker candidate evidence")
      : await readJsonFile(secretPath(outDir, intent.worker), "Worker secret evidence");
  const selectedVersionId = validateWorkerVersionId(source.version_id);
  if (intent.worker === "frontend" && !frontendCandidate) {
    throw new TypeError("frontend deploy step requires candidate evidence");
  }
  const expectedTag = releaseTag(
    spec,
    intent.worker,
    intent.worker === "state" || intent.worker === "frontend" ? "code" : "secrets",
  );
  await verifyWorkerVersion({
    configPath,
    environment,
    gitSha: spec.git_sha,
    id: selectedVersionId,
    runCommand,
    tag: expectedTag,
    worker: intent.worker,
  });
  const alreadyActive = intent.worker === "frontend" && JSON.stringify(
    await getWorkerTraffic({ configPath, environment, runCommand }),
  ) === JSON.stringify([{ percentage: 100, version_id: selectedVersionId }]);
  if (!alreadyActive) {
    await runWrangler({
      args: [
        "versions",
        "deploy",
        `${selectedVersionId}@100%`,
        "--config",
        configPath,
        "--message",
        `${spec.release_id} ${intent.worker} activation`,
        "--yes",
      ],
      environment,
      outDir,
      outputName: `wrangler-${intent.worker}-activate.jsonl`,
      runCommand,
    });
  }
  const traffic = await getWorkerTraffic({
    configPath,
    environment,
    runCommand,
  });
  assertWorkerTraffic(traffic, [{ percentage: 100, version_id: selectedVersionId }]);
  const evidence = {
    approvals,
    ...(intent.worker === "frontend" ? {
      build_config_digest: source.build_config_digest,
      config_digest: configDigest,
      worker_name: workerName,
    } : {}),
    git_sha: spec.git_sha,
    plan_digest: planDigest,
    release_id: spec.release_id,
    schema_version: 1,
    traffic,
    version_id: selectedVersionId,
    worker: intent.worker,
  };
  await writeEvidence(outDir, `worker-${intent.worker}-deployment.json`, evidence);
  return evidence;
}

/**
 * Injects validated production secrets into a candidate Worker version using stdin streaming.
 *
 * Validates the secret payload against required release secrets without writing plaintext
 * credentials to disk. Verifies that the code candidate is the latest version before applying
 * secrets via the Bun-resolved pinned Wrangler CLI, asserts the new secret version on Cloudflare's
 * control plane, and writes canonical secret evidence.
 *
 * @param {object} options - Secret injection options
 * @param {object} options.approvals - Verified human release approvals
 * @param {Record<string, string | undefined>} options.environment - Process environment variables
 * @param {string} options.outDir - Directory containing candidate evidence and target for secret evidence
 * @param {string} options.planDigest - SHA-256 digest of verified release plan
 * @param {Function} options.runCommand - Subprocess runner
 * @param {string} options.secretSource - Raw JSON string containing secret bundle from stdin
 * @param {object} options.spec - Verified release specification
 * @param {"api"|"automation"} options.worker - Target Worker service
 * @returns {Promise<object>} Generated secret version evidence record
 * @throws {TypeError|Error} If secrets are malformed, candidate is out of date, or version verification fails
 */
export async function injectWorkerSecrets({
  approvals,
  environment,
  outDir,
  planDigest,
  runCommand,
  secretSource,
  spec,
  worker,
}) {
  const { names, values } = validateSecretBundle(secretSource, spec, worker);
  const configPath = workerConfigPath(outDir, worker);
  const candidate = await readJsonFile(candidatePath(outDir, worker), "Worker candidate evidence");
  if (candidate.release_id !== spec.release_id || candidate.git_sha !== spec.git_sha) {
    throw new TypeError("Worker candidate evidence does not match the release");
  }
  const candidateVersionId = validateWorkerVersionId(candidate.version_id);
  const versions = await listVersions({ configPath, environment, runCommand });
  const tag = releaseTag(spec, worker, "secrets");
  const recovered = findUniqueTaggedVersion(versions, tag);
  let secretVersionId = recovered?.id;
  if (!secretVersionId) {
    const latest = versions[0];
    if (!latest || latest.id !== candidateVersionId) {
      throw new TypeError("the reviewed code candidate is not the latest Worker version");
    }
    const result = await runCommand(
      "bun",
      [
        "run",
        "--no-install",
        "wrangler",
        "versions",
        "secret",
        "bulk",
        "--config",
        configPath,
        "--message",
        `${spec.release_id} ${worker} protected secrets`,
        "--tag",
        tag,
      ],
      { env: environment, stdin: JSON.stringify(values) },
    );
    secretVersionId = parseSecretVersionOutput(result.stdout, names.length);
  }
  await verifyWorkerVersion({
    configPath,
    environment,
    gitSha: spec.git_sha,
    id: secretVersionId,
    runCommand,
    tag,
    worker,
  });
  const evidence = {
    approvals,
    based_on_version_id: candidateVersionId,
    git_sha: spec.git_sha,
    plan_digest: planDigest,
    release_id: spec.release_id,
    schema_version: 1,
    secret_names: names,
    version_id: secretVersionId,
    worker,
  };
  await writeEvidence(outDir, `worker-${worker}-secrets.json`, evidence);
  return evidence;
}

/**
 * Manages phased percentage-based traffic shifts for the API Worker during update releases.
 *
 * Enforces valid canary rollout percentages (5%, 25%, 50%, 100%), asserts the exact expected
 * traffic distribution prior to the shift, adjusts traffic via wrangler versions deploy,
 * verifies the post-shift traffic distribution against Cloudflare control plane, and writes
 * rollout evidence.
 *
 * @param {object} options - API rollout options
 * @param {object} options.approvals - Verified human release approvals
 * @param {Record<string, string | undefined>} options.environment - Process environment variables
 * @param {string} options.outDir - Release directory containing evidence files
 * @param {5|25|50|100} options.percentage - Target traffic percentage for the new release version
 * @param {string} options.planDigest - SHA-256 digest of verified release plan
 * @param {Function} options.runCommand - Subprocess runner
 * @param {object} options.spec - Verified release specification
 * @returns {Promise<object>} Generated rollout step evidence record
 * @throws {TypeError|Error} If deployment mode is not update, percentage is invalid, or traffic distribution mismatches
 */
export async function deployApiRollout({
  approvals,
  environment,
  outDir,
  percentage,
  planDigest,
  runCommand,
  spec,
}) {
  if (spec.deployment_mode !== "update") {
    throw new TypeError("gradual API rollout is valid only for update releases");
  }
  if (![5, 25, 50, 100].includes(percentage)) {
    throw new TypeError("API rollout percentage must be 5, 25, 50, or 100");
  }
  const configPath = workerConfigPath(outDir, "api");
  const candidate = await readJsonFile(candidatePath(outDir, "api"), "API candidate evidence");
  const secrets = await readJsonFile(secretPath(outDir, "api"), "API secret evidence");
  const previousVersionId = validateWorkerVersionId(
    candidate.previous_version_id,
    "previous API version ID",
  );
  const candidateVersionId = validateWorkerVersionId(
    secrets.version_id,
    "candidate API version ID",
  );
  const previousPercentage = percentage === 100 ? 0 : 100 - percentage;
  const expectedBefore =
    percentage === 5
      ? [{ percentage: 100, version_id: previousVersionId }]
      : [
          {
            percentage: percentage === 25 ? 5 : percentage === 50 ? 25 : 50,
            version_id: candidateVersionId,
          },
          {
            percentage: percentage === 25 ? 95 : percentage === 50 ? 75 : 50,
            version_id: previousVersionId,
          },
        ];
  const current = await getWorkerTraffic({
    configPath,
    environment,
    runCommand,
  });
  assertWorkerTraffic(current, expectedBefore);
  const versionSpecs =
    percentage === 100
      ? [`${candidateVersionId}@100%`]
      : [`${previousVersionId}@${previousPercentage}%`, `${candidateVersionId}@${percentage}%`];
  await runWrangler({
    args: [
      "versions",
      "deploy",
      ...versionSpecs,
      "--config",
      configPath,
      "--message",
      `${spec.release_id} API rollout ${percentage}%`,
      "--yes",
    ],
    environment,
    outDir,
    outputName: `wrangler-api-rollout-${percentage}.jsonl`,
    runCommand,
  });
  const traffic = await getWorkerTraffic({
    configPath,
    environment,
    runCommand,
  });
  assertWorkerTraffic(
    traffic,
    percentage === 100
      ? [{ percentage: 100, version_id: candidateVersionId }]
      : [
          { percentage, version_id: candidateVersionId },
          { percentage: previousPercentage, version_id: previousVersionId },
        ],
  );
  const evidence = {
    approvals,
    git_sha: spec.git_sha,
    percentage,
    plan_digest: planDigest,
    release_id: spec.release_id,
    schema_version: 1,
    traffic,
    version_id: candidateVersionId,
    worker: "api",
  };
  await writeEvidence(outDir, `api-rollout-${percentage}.json`, evidence);
  return evidence;
}
