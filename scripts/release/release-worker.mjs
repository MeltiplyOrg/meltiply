import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { readJsonFile, sha256, writeEvidence } from "./release-guard.mjs";
import { stableJson } from "../lib/stable-json.mjs";
import { requiredRemoteSecrets } from "./release-lib.mjs";
import { buildFrontend } from "./release-frontend.mjs";
import { plainObject } from "./validation.mjs";

const ansiEscapePattern = /\u001b\[[0-9;]*m/g;
const createdVersionPattern = /Success! Created version ([0-9a-f-]{36}) with ([0-9]+) secrets\./g;
const currentVersionPattern = /Current Version ID:\s*([0-9a-f-]{36})(?:\s|$)/g;
const secretLineBreakPattern = /[\u0000\r\n]/;
const workerNotFoundApiCodePattern = /\[code:\s*10007\]/;
const gitShaPattern = /^[0-9a-f]{40}$/;
const jsonExtensionPattern = /\.json$/;

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
  [
    "frontend-update",
    { mode: "update", steps: new Set(["activate", "upload"]), worker: "frontend" },
  ],
]);

export function validateWorkerVersionId(value, name = "Worker version ID") {
  if (typeof value !== "string" || !versionIdPattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function parseJson(source, name) {
  try {
    return JSON.parse(source);
  } catch {
    throw new TypeError(`${name} must be valid JSON`);
  }
}

function exactObject(value, keys, name) {
  const object = plainObject(value, name);
  const actual = Object.keys(object);
  const unknown = actual.filter((key) => !keys.has(key));
  const missing = [...keys].filter((key) => !(key in object));
  if (unknown.length > 0) throw new TypeError(`${name} has unknown keys: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new TypeError(`${name} is missing keys: ${missing.join(", ")}`);
  return object;
}

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

export function parseSecretVersionOutput(source, expectedCount) {
  const sanitized = source.replace(ansiEscapePattern, "");
  const matches = [...sanitized.matchAll(createdVersionPattern)];
  if (matches.length !== 1) {
    throw new TypeError("Wrangler secret output must contain exactly one created version ID");
  }
  if (Number(matches[0][2]) !== expectedCount) {
    throw new TypeError("Wrangler secret output count does not match the submitted bundle");
  }
  return validateWorkerVersionId(matches[0][1]);
}

export function parseRollbackVersionOutput(source) {
  const sanitized = source.replace(ansiEscapePattern, "");
  const matches = [...sanitized.matchAll(currentVersionPattern)];
  if (matches.length !== 1) {
    throw new TypeError("Wrangler rollback output must contain exactly one current version ID");
  }
  return validateWorkerVersionId(matches[0][1]);
}

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

export function findUniqueTaggedVersion(versions, tag) {
  const matches = versions.filter((entry) => entry.tag === tag);
  if (matches.length > 1) {
    throw new TypeError(`Wrangler returned duplicate versions for tag ${tag}`);
  }
  return matches[0];
}

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
  const required = requiredRemoteSecrets(spec);
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
        secretLineBreakPattern.test(value)
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

export function workerConfigPath(outDir, worker) {
  return path.join(outDir, "wrangler", `${worker}.json`);
}

export function candidatePath(outDir, worker) {
  return path.join(outDir, `worker-${worker}-candidate.json`);
}

export function secretPath(outDir, worker) {
  return path.join(outDir, `worker-${worker}-secrets.json`);
}

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

async function runWranglerJson(runCommand, environment, args) {
  const result = await runCommand("bun", ["run", "--no-install", "wrangler", ...args], {
    env: environment,
  });
  return result.stdout;
}

function releaseTag(spec, worker, kind) {
  return `${spec.release_id}-${worker}-${kind}`;
}

/**
 * Cloudflare API error 10007 (`workers.api.error.script_not_found`), surfaced by
 * Wrangler as `[code: 10007]`.
 */
export function isMissingWorker(error) {
  const text = error instanceof Error ? error.message : String(error);
  return workerNotFoundApiCodePattern.test(text);
}

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
    !gitShaPattern.test(versionBindings[0].text)
  ) {
    throw new TypeError(`Wrangler ${expected.worker} version has no unique VERSION binding`);
  }
  return versionBindings[0].text;
}

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

export function assertWorkerTraffic(
  traffic,
  expected,
  message = "deployed Worker traffic does not match the requested release state",
) {
  const normalized = [...expected].sort((left, right) =>
    left.version_id.localeCompare(right.version_id),
  );
  if (JSON.stringify(traffic) !== JSON.stringify(normalized)) {
    throw new TypeError(message);
  }
}

async function writeBootstrapConfig(configPath, worker) {
  if (worker !== "automation") return configPath;
  const config = await readJsonFile(configPath, "rendered Automation config", 1024 * 1024);
  delete config.triggers;
  const bootstrapPath = configPath.replace(jsonExtensionPattern, "-bootstrap.json");
  await writeFile(bootstrapPath, stableJson(config), {
    mode: 0o600,
  });
  return bootstrapPath;
}

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
  const configPath = workerConfigPath(outDir, intent.worker);
  const configSource = await readFile(configPath, "utf8");
  const config = parseJson(configSource, "rendered Worker config");
  const workerName = config.name;
  if (
    typeof workerName !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/.test(workerName) ||
    (spec.environment === "production" && !workerName.endsWith(`-${spec.environment}`))
  ) {
    throw new TypeError("rendered Worker config has the wrong installation name");
  }
  if (
    intent.worker === "frontend" &&
    (workerName !== iac.frontend_worker_name ||
      config.vars?.VERSION !== spec.git_sha ||
      config.vars?.ENVIRONMENT !== spec.environment ||
      config.vars?.API_ORIGIN !== undefined ||
      config.services?.find((binding) => binding.binding === "API")?.service !==
        iac.worker_names.api)
  ) {
    throw new TypeError(
      "frontend config does not match the reviewed IaC Worker/environment/API target",
    );
  }
  const configDigest = sha256(configSource);
  const tag = releaseTag(spec, intent.worker, "code");
  let frontendCandidate;
  if (intent.worker === "frontend") {
    try {
      frontendCandidate = await readJsonFile(
        candidatePath(outDir, "frontend"),
        "frontend candidate",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      frontendCandidate &&
      (frontendCandidate.config_digest !== configDigest ||
        frontendCandidate.git_sha !== spec.git_sha ||
        frontendCandidate.release_id !== spec.release_id ||
        frontendCandidate.worker_name !== workerName)
    ) {
      throw new TypeError("frontend candidate does not match this release/config");
    }
    if (
      frontendCandidate &&
      sha256(await readFile(path.join(outDir, "wrangler/frontend-built.json"), "utf8")) !==
        frontendCandidate.build_config_digest
    ) {
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
        frontendBuild = {
          configPath: builtPath,
          build_config_digest: frontendCandidate.build_config_digest,
        };
      } else {
        frontendBuild = await buildFrontend({
          configPath,
          environment,
          outDir,
          repoRoot,
          runCommand,
          spec,
        });
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
      ...(frontendBuild
        ? { build_config_digest: frontendBuild.build_config_digest, worker_name: workerName }
        : {}),
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

    if (
      intent.mode === "bootstrap" &&
      (intent.worker === "state" || intent.worker === "frontend")
    ) {
      const traffic = await getWorkerTraffic({
        configPath,
        environment,
        runCommand,
      });
      assertWorkerTraffic(traffic, [{ percentage: 100, version_id: uploaded.version_id }]);
      await writeEvidence(outDir, `worker-${intent.worker}-deployment.json`, {
        approvals,
        ...(frontendBuild
          ? {
              build_config_digest: frontendBuild.build_config_digest,
              config_digest: configDigest,
              worker_name: workerName,
            }
          : {}),
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
  const alreadyActive =
    intent.worker === "frontend" &&
    JSON.stringify(await getWorkerTraffic({ configPath, environment, runCommand })) ===
      JSON.stringify([{ percentage: 100, version_id: selectedVersionId }]);
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
    ...(intent.worker === "frontend"
      ? {
          build_config_digest: source.build_config_digest,
          config_digest: configDigest,
          worker_name: workerName,
        }
      : {}),
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
