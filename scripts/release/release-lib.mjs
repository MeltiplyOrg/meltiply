import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMailSenderAddress, isMailSenderName } from "../../packages/domain/src/mail-content.mjs";
import { assertDatabaseRoles } from "../lib/database-roles.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";
import { releaseEnvironments } from "../lib/release-environments.mjs";
import { stableJson, stableValue } from "../lib/stable-json.mjs";
import { verifyReleaseCheckout } from "./release-guard.mjs";
import { exactKeys, plainObject } from "./validation.mjs";

const controlCharactersPattern = /[\u0000-\u001f\u007f]/;
const configurationTokenPattern = /^[A-Za-z0-9._:-]+$/;
const trailingSlashPattern = /\/$/;
const gitShaPattern = /^[0-9a-f]{40}$/;
const nonEmptyTextPattern = /^.+$/s;
const cloudflareIdPattern = /^[0-9a-f]{32}$/;
const bucketNamePattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const regionPattern = /^[a-z0-9-]+$/;
const neonIdPattern = /^[a-z0-9-]{1,60}$/;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const utcSuffixPattern = /Z$/;
const hostnamePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const trailingDotPattern = /\.$/;
const neonEndpointPattern = /^ep-[a-z0-9-]+(?:-pooler)?$/;
const poolerSuffixPattern = /-pooler$/;
const wranglerVersionPattern = /^4\.148\.0(?:\s|$)/;

const workerConfigs = {
  api: "workers/api/wrangler.jsonc",
  automation: "workers/automation/wrangler.jsonc",
  state: "workers/state/wrangler.jsonc",
  frontend: "frontend/app/wrangler.jsonc",
};

export const queueBindings = {
  analytics: "ANALYTICS_QUEUE",
  "asset-processing": "ASSET_PROCESSING_QUEUE",
  "channel-revocation": "CHANNEL_REVOCATION_QUEUE",
  comments: "COMMENTS_QUEUE",
  notifications: "NOTIFICATIONS_QUEUE",
  "publish-facebook": "FACEBOOK_PUBLISH_QUEUE",
  "publish-instagram": "INSTAGRAM_PUBLISH_QUEUE",
  "publish-threads": "THREADS_PUBLISH_QUEUE",
  "publish-tiktok": "TIKTOK_PUBLISH_QUEUE",
  "publish-youtube": "YOUTUBE_PUBLISH_QUEUE",
  replies: "REPLIES_QUEUE",
  "token-refresh": "TOKEN_REFRESH_QUEUE",
};

const providerVariables = {
  facebook: {
    accepted: "FACEBOOK_LIVE_ACCEPTED",
    client: "FACEBOOK_CLIENT_ID",
    clientField: "facebook_client_id",
    secret: "FACEBOOK_CLIENT_SECRET",
  },
  instagram: {
    accepted: "INSTAGRAM_LIVE_ACCEPTED",
    client: "INSTAGRAM_CLIENT_ID",
    clientField: "instagram_client_id",
    secret: "INSTAGRAM_CLIENT_SECRET",
  },
  threads: {
    accepted: "THREADS_LIVE_ACCEPTED",
    client: "THREADS_CLIENT_ID",
    clientField: "threads_client_id",
    secret: "THREADS_CLIENT_SECRET",
  },
  tiktok: {
    accepted: "TIKTOK_LIVE_ACCEPTED",
    client: "TIKTOK_CLIENT_KEY",
    clientField: "tiktok_client_key",
    secret: "TIKTOK_CLIENT_SECRET",
  },
  youtube: {
    accepted: "YOUTUBE_LIVE_ACCEPTED",
    client: "YOUTUBE_SHORTS_CLIENT_ID",
    clientField: "youtube_shorts_client_id",
    secret: "YOUTUBE_SHORTS_CLIENT_SECRET",
  },
};

const exactSpecKeys = new Set([
  "app_url",
  "api_workers_dev_url",
  "automation_guard",
  "deployment_mode",
  "environment",
  "allowed_origins",
  "git_sha",
  "neon_branch_id",
  "neon_project_id",
  "provider_acceptance",
  "release_id",
  "restore_point_expires_at",
  "runtime",
  "schema_version",
]);
const exactAcceptanceKeys = new Set([
  "facebook",
  "instagram",
  "instagram_engagement",
  "threads",
  "threads_engagement",
  "tiktok",
  "youtube",
]);
const exactRuntimeKeys = new Set([
  "mail_from_address",
  "mail_from_name",
  "facebook_client_id",
  "instagram_client_id",
  "r2_account_id",
  "object_storage_provider",
  "reporting_forced_off",
  "reporting_posthog_host",
  "reporting_posthog_project_token",
  "s3_bucket",
  "s3_endpoint",
  "s3_force_path_style",
  "s3_region",
  "threads_client_id",
  "tiktok_client_key",
  "tiktok_media_url_prefix",
  "youtube_shorts_client_id",
]);

function requiredString(value, name, pattern, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    controlCharactersPattern.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function optionalString(value, name, pattern, maximum = 512) {
  if (value === undefined) return undefined;
  return requiredString(value, name, pattern ?? configurationTokenPattern, maximum);
}

function httpsUrl(value, name, { originOnly = false } = {}) {
  requiredString(value, name);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${name} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (originOnly && parsed.pathname !== "/")
  ) {
    throw new TypeError(`${name} must be a credential-free HTTPS ${originOnly ? "origin" : "URL"}`);
  }
  return originOnly ? parsed.origin : parsed.toString().replace(trailingSlashPattern, "");
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function outputValue(outputs, name) {
  const output = outputs[name];
  if (!output || typeof output !== "object" || !("value" in output)) {
    throw new TypeError(`IaC output ${name} is required`);
  }
  if (output.sensitive === true) {
    throw new TypeError(`IaC output ${name} must not be sensitive`);
  }
  return output.value;
}

const credentialMaterialPattern =
  /postgres(?:ql)?:\/\/|-----BEGIN [A-Z ]+PRIVATE KEY-----|sk_(?:test|live)_/i;

export function containsCredentialMaterial(serialized) {
  return credentialMaterialPattern.test(serialized);
}

const posthogProjectTokenPattern = /^phc_[A-Za-z0-9_-]{8,200}$/;

function reportingRuntime(runtime) {
  const token = optionalString(
    runtime.reporting_posthog_project_token,
    "runtime.reporting_posthog_project_token",
    posthogProjectTokenPattern,
    210,
  );
  const host =
    runtime.reporting_posthog_host === undefined
      ? undefined
      : httpsUrl(runtime.reporting_posthog_host, "runtime.reporting_posthog_host", {
          originOnly: true,
        });
  if ((token === undefined) !== (host === undefined)) {
    throw new TypeError(
      "runtime.reporting_posthog_project_token and runtime.reporting_posthog_host must be set together",
    );
  }
  return {
    ...(host === undefined ? {} : { reporting_posthog_host: host }),
    ...(token === undefined ? {} : { reporting_posthog_project_token: token }),
    reporting_forced_off:
      runtime.reporting_forced_off === undefined
        ? false
        : boolean(runtime.reporting_forced_off, "runtime.reporting_forced_off"),
  };
}

export function validateReleaseSpec(input) {
  const spec = plainObject(input, "release input");
  const serialized = JSON.stringify(spec);
  if (containsCredentialMaterial(serialized)) {
    throw new TypeError("release input must not contain credentials or database URLs");
  }
  exactKeys(spec, exactSpecKeys, "release input", { allowMissing: true });
  if (spec.schema_version !== 1) throw new TypeError("schema_version must be 1");
  if (!releaseEnvironments.includes(spec.environment)) {
    throw new TypeError(`environment must be one of ${releaseEnvironments.join(", ")}`);
  }
  if (!new Set(["bootstrap", "update"]).has(spec.deployment_mode)) {
    throw new TypeError("deployment_mode must be bootstrap or update");
  }
  const gitSha = requiredString(spec.git_sha, "git_sha", gitShaPattern);
  const releaseId = requiredString(spec.release_id, "release_id");
  if (releaseId !== `${spec.environment}-${gitSha.slice(0, 12)}`) {
    throw new TypeError("release_id must match environment and the first 12 characters of git_sha");
  }

  const apiBaseUrl = httpsUrl(spec.app_url, "app_url", {
    originOnly: true,
  });
  const apiWorkersDevUrl = httpsUrl(spec.api_workers_dev_url, "api_workers_dev_url", {
    originOnly: true,
  });
  if (!new URL(apiWorkersDevUrl).hostname.endsWith(".workers.dev")) {
    throw new TypeError("api_workers_dev_url must use a workers.dev hostname");
  }
  if (apiWorkersDevUrl === apiBaseUrl) {
    throw new TypeError("api_workers_dev_url must differ from app_url");
  }
  if (spec.allowed_origins !== undefined && !Array.isArray(spec.allowed_origins)) {
    throw new TypeError("allowed_origins must be an array");
  }
  const frontendOrigins = [
    ...new Set([
      apiBaseUrl,
      ...(spec.allowed_origins ?? []).map((origin, index) =>
        httpsUrl(origin, `allowed_origins[${index}]`, { originOnly: true }),
      ),
    ]),
  ].sort();

  const acceptance = plainObject(spec.provider_acceptance, "provider_acceptance");
  exactKeys(acceptance, exactAcceptanceKeys, "provider_acceptance", { allowMissing: true });
  for (const key of exactAcceptanceKeys) boolean(acceptance[key], `provider_acceptance.${key}`);
  if (acceptance.instagram_engagement && !acceptance.instagram) {
    throw new TypeError("Instagram engagement acceptance requires Instagram acceptance");
  }
  if (acceptance.threads_engagement && !acceptance.threads) {
    throw new TypeError("Threads engagement acceptance requires Threads acceptance");
  }

  const runtime = plainObject(spec.runtime, "runtime");
  exactKeys(runtime, exactRuntimeKeys, "runtime", { allowMissing: true });
  const mailFromAddress = requiredString(runtime.mail_from_address, "runtime.mail_from_address");
  if (!isMailSenderAddress(mailFromAddress, true)) {
    throw new TypeError("runtime.mail_from_address is invalid");
  }
  const mailFromName = optionalString(
    runtime.mail_from_name,
    "runtime.mail_from_name",
    nonEmptyTextPattern,
  );
  if (mailFromName !== undefined && !isMailSenderName(mailFromName)) {
    throw new TypeError("runtime.mail_from_name is invalid");
  }
  const storageProvider = runtime.object_storage_provider ?? "r2";
  if (storageProvider !== "r2" && storageProvider !== "s3") {
    throw new TypeError("runtime.object_storage_provider must be r2 or s3");
  }
  const validatedRuntime = {
    mail_from_address: mailFromAddress,
    mail_from_name: mailFromName,
    facebook_client_id: optionalString(runtime.facebook_client_id, "runtime.facebook_client_id"),
    instagram_client_id: optionalString(runtime.instagram_client_id, "runtime.instagram_client_id"),
    r2_account_id: requiredString(
      runtime.r2_account_id,
      "runtime.r2_account_id",
      cloudflareIdPattern,
    ),
    ...reportingRuntime(runtime),
    threads_client_id: optionalString(runtime.threads_client_id, "runtime.threads_client_id"),
    tiktok_client_key: optionalString(runtime.tiktok_client_key, "runtime.tiktok_client_key"),
    tiktok_media_url_prefix:
      runtime.tiktok_media_url_prefix === undefined
        ? undefined
        : httpsUrl(runtime.tiktok_media_url_prefix, "runtime.tiktok_media_url_prefix"),
    youtube_shorts_client_id: optionalString(
      runtime.youtube_shorts_client_id,
      "runtime.youtube_shorts_client_id",
    ),
    ...(storageProvider === "s3"
      ? {
          object_storage_provider: "s3",
          s3_bucket: requiredString(runtime.s3_bucket, "runtime.s3_bucket", bucketNamePattern),
          s3_endpoint: httpsUrl(runtime.s3_endpoint, "runtime.s3_endpoint", { originOnly: true }),
          s3_force_path_style:
            runtime.s3_force_path_style === undefined
              ? true
              : boolean(runtime.s3_force_path_style, "runtime.s3_force_path_style"),
          s3_region:
            runtime.s3_region === undefined
              ? "us-east-1"
              : requiredString(runtime.s3_region, "runtime.s3_region", regionPattern),
        }
      : {}),
  };
  for (const [provider, fields] of Object.entries(providerVariables)) {
    if (acceptance[provider] && !validatedRuntime[fields.clientField]) {
      throw new TypeError(`${fields.clientField} is required when ${provider} is accepted`);
    }
  }

  const automationGuard = plainObject(spec.automation_guard, "automation_guard");
  exactKeys(automationGuard, new Set(["consumers_paused", "cron_safe"]), "automation_guard", {
    allowMissing: true,
  });
  if (
    !boolean(automationGuard.consumers_paused, "automation_guard.consumers_paused") ||
    !boolean(automationGuard.cron_safe, "automation_guard.cron_safe")
  ) {
    throw new TypeError("automation consumers must be paused and Cron must be safe before release");
  }

  const neonBranchId = requiredString(spec.neon_branch_id, "neon_branch_id", neonIdPattern);
  const neonProjectId = requiredString(spec.neon_project_id, "neon_project_id", neonIdPattern);
  const restorePointExpiresAt = requiredString(
    spec.restore_point_expires_at,
    "restore_point_expires_at",
    utcTimestampPattern,
  );
  const restorePointExpiry = Date.parse(restorePointExpiresAt);
  const canonicalRestorePointExpiry = Number.isFinite(restorePointExpiry)
    ? new Date(restorePointExpiry).toISOString()
    : "";
  if (
    canonicalRestorePointExpiry !== restorePointExpiresAt &&
    canonicalRestorePointExpiry !== restorePointExpiresAt.replace(utcSuffixPattern, ".000Z")
  ) {
    throw new TypeError("restore_point_expires_at is invalid");
  }

  return {
    app_url: apiBaseUrl,
    api_workers_dev_url: apiWorkersDevUrl,
    automation_guard: { consumers_paused: true, cron_safe: true },
    deployment_mode: spec.deployment_mode,
    environment: spec.environment,
    allowed_origins: frontendOrigins,
    git_sha: gitSha,
    neon_branch_id: neonBranchId,
    neon_project_id: neonProjectId,
    provider_acceptance: Object.fromEntries(
      [...exactAcceptanceKeys].sort().map((key) => [key, acceptance[key]]),
    ),
    release_id: releaseId,
    restore_point_expires_at: restorePointExpiresAt,
    runtime: validatedRuntime,
    schema_version: 1,
  };
}

export function validateIacOutputs(input, spec) {
  const outputs = plainObject(input, "IaC outputs");
  const resources = plainObject(outputValue(outputs, "release_resources"), "release_resources");
  const bindings = plainObject(outputValue(outputs, "worker_bindings"), "worker_bindings");
  if (resources.environment !== spec.environment) {
    throw new TypeError("IaC release resources environment must match the release input");
  }
  const hostname = requiredString(
    resources.app_hostname,
    "release_resources.app_hostname",
    hostnamePattern,
  );
  if (spec.app_url !== `https://${hostname}`) {
    throw new TypeError("app_url must match the IaC API hostname");
  }
  const bucket = requiredString(bindings.ASSETS, "worker_bindings.ASSETS");
  if (bucket !== resources.assets_bucket_name || !bucket.endsWith(`-${spec.environment}`)) {
    throw new TypeError(`the IaC asset bucket is inconsistent or not ${spec.environment}-scoped`);
  }
  const frontendWorkerName = requiredString(
    resources.frontend_worker_name,
    "release_resources.frontend_worker_name",
    /^[a-z0-9][a-z0-9-]*$/,
  );
  if (!frontendWorkerName.endsWith(`-${spec.environment}`)) {
    throw new TypeError("the IaC frontend Worker name must carry the release environment suffix");
  }
  const workerNames = plainObject(resources.worker_names, "release_resources.worker_names");
  exactKeys(workerNames, new Set(["api", "automation", "state", "frontend"]), "worker_names", {
    allowMissing: true,
  });
  for (const worker of ["api", "automation", "state", "frontend"]) {
    const name = requiredString(
      workerNames[worker],
      `worker_names.${worker}`,
      /^[a-z0-9][a-z0-9-]*$/,
    );
    if (spec.environment !== "staging" && !name.endsWith(`-${spec.environment}`)) {
      throw new TypeError(`worker_names.${worker} must carry the release environment suffix`);
    }
  }
  if (
    new Set(Object.values(workerNames)).size !== 4 ||
    workerNames.frontend !== frontendWorkerName
  ) {
    throw new TypeError("IaC Worker names must be distinct and consistent");
  }
  if (!new URL(spec.api_workers_dev_url).hostname.startsWith(`${workerNames.api}.`)) {
    throw new TypeError("api_workers_dev_url must name the IaC API Worker");
  }
  const authenticatedId = requiredString(
    bindings.DB_AUTHENTICATED,
    "worker_bindings.DB_AUTHENTICATED",
    cloudflareIdPattern,
  );
  const systemId = requiredString(
    bindings.DB_SYSTEM,
    "worker_bindings.DB_SYSTEM",
    cloudflareIdPattern,
  );
  if (
    authenticatedId === systemId ||
    authenticatedId !== resources.authenticated_hyperdrive_id ||
    systemId !== resources.system_hyperdrive_id
  ) {
    throw new TypeError("Hyperdrive output IDs must be distinct and consistent");
  }

  const queues = plainObject(bindings.queues, "worker_bindings.queues");
  exactKeys(queues, new Set(Object.keys(queueBindings)), "worker_bindings.queues", {
    allowMissing: true,
  });
  for (const workload of Object.keys(queueBindings)) {
    if (queues[workload] !== `meltiply-${workload}-${spec.environment}`) {
      throw new TypeError(`queue ${workload} is not the expected ${spec.environment} queue`);
    }
  }
  if (JSON.stringify(stableValue(queues)) !== JSON.stringify(stableValue(resources.queue_names))) {
    throw new TypeError("queue names differ between IaC outputs");
  }
  const deadLetters = plainObject(resources.dead_letter_queue_names, "dead_letter_queue_names");
  exactKeys(deadLetters, new Set(Object.keys(queueBindings)), "dead_letter_queue_names", {
    allowMissing: true,
  });
  for (const workload of Object.keys(queueBindings)) {
    if (deadLetters[workload] !== `meltiply-${workload}-${spec.environment}-dlq`) {
      throw new TypeError(
        `dead-letter queue ${workload} is not the expected ${spec.environment} queue`,
      );
    }
  }

  const accessAud = bindings.ACCESS_POLICY_AUD ?? null;
  const accessTeamDomain = bindings.ACCESS_TEAM_DOMAIN ?? null;
  const operatorHostname = bindings.OPERATOR_HOSTNAME ?? null;
  const accessValues = [accessAud, accessTeamDomain, operatorHostname];
  if (accessValues.some(Boolean) && !accessValues.every(Boolean)) {
    throw new TypeError("operator Access outputs must be either complete or absent");
  }
  if (accessAud !== (resources.operator_access_aud ?? null)) {
    throw new TypeError("operator Access audience differs between IaC outputs");
  }
  if (operatorHostname !== (resources.operator_hostname ?? null)) {
    throw new TypeError("operator hostname differs between IaC outputs");
  }
  if (accessTeamDomain) httpsUrl(accessTeamDomain, "worker_bindings.ACCESS_TEAM_DOMAIN");
  if (operatorHostname) requiredString(operatorHostname, "worker_bindings.OPERATOR_HOSTNAME");

  return {
    access_aud: accessAud,
    access_team_domain: accessTeamDomain,
    app_hostname: hostname,
    assets_bucket: bucket,
    authenticated_hyperdrive_id: authenticatedId,
    frontend_worker_name: frontendWorkerName,
    worker_names: stableValue(workerNames),
    operator_hostname: operatorHostname,
    queues: stableValue(queues),
    release_resources: stableValue(resources),
    system_hyperdrive_id: systemId,
  };
}

function providerVars(spec) {
  const values = {
    FACEBOOK_LIVE_ACCEPTED: String(spec.provider_acceptance.facebook),
    INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED: String(spec.provider_acceptance.instagram_engagement),
    INSTAGRAM_LIVE_ACCEPTED: String(spec.provider_acceptance.instagram),
    THREADS_ENGAGEMENT_LIVE_ACCEPTED: String(spec.provider_acceptance.threads_engagement),
    THREADS_LIVE_ACCEPTED: String(spec.provider_acceptance.threads),
    TIKTOK_LIVE_ACCEPTED: String(spec.provider_acceptance.tiktok),
    YOUTUBE_LIVE_ACCEPTED: String(spec.provider_acceptance.youtube),
  };
  for (const fields of Object.values(providerVariables)) {
    const client = spec.runtime[fields.clientField];
    if (client) values[fields.client] = client;
  }
  if (spec.runtime.tiktok_media_url_prefix) {
    values.TIKTOK_MEDIA_URL_PREFIX = spec.runtime.tiktok_media_url_prefix;
  }
  return values;
}

function replaceBinding(entries, identifier, replacement, key = "binding") {
  const filtered = (entries ?? []).filter((entry) => entry[key] !== identifier);
  return [...filtered, replacement];
}

export function renderWranglerConfigs(sourceConfigs, spec, iac) {
  const state = structuredClone(sourceConfigs.state);
  const automation = structuredClone(sourceConfigs.automation);
  const api = structuredClone(sourceConfigs.api);
  const frontend = structuredClone(sourceConfigs.frontend);
  const frontendEnvironment = frontend.env?.[spec.environment] ?? {};
  delete frontend.env;
  Object.assign(frontend, frontendEnvironment, {
    name: iac.frontend_worker_name,
    vars: { ENVIRONMENT: spec.environment, VERSION: spec.git_sha },
    services: (frontendEnvironment.services ?? frontend.services ?? []).map((binding) =>
      binding.binding === "API" ? { ...binding, service: iac.worker_names.api } : binding,
    ),
  });
  frontend.env = {
    [spec.environment]: {
      name: frontend.name,
      services: frontend.services,
      vars: frontend.vars,
      workers_dev: frontend.workers_dev,
    },
  };
  api.name = iac.worker_names.api;
  automation.name = iac.worker_names.automation;
  state.name = iac.worker_names.state;
  state.vars = { ...state.vars, ENVIRONMENT: spec.environment, VERSION: spec.git_sha };
  api.services = (api.services ?? []).map((binding) =>
    binding.binding === "AUTOMATION"
      ? { ...binding, service: iac.worker_names.automation }
      : binding,
  );
  if (api.durable_objects?.bindings) {
    api.durable_objects.bindings = api.durable_objects.bindings.map((binding) =>
      binding.name === "OAUTH_STATE"
        ? { ...binding, script_name: iac.worker_names.state }
        : binding,
    );
  }
  if (spec.environment !== "staging") {
    for (const container of automation.containers ?? []) {
      container.name = `${container.name}-${spec.environment}`;
    }
  }
  for (const workflow of automation.workflows ?? []) {
    if (workflow.binding === "REPLY_WORKFLOW") workflow.name = `meltiply-reply-${spec.environment}`;
  }
  const commonVars = {
    ENVIRONMENT: spec.environment,
    DEPLOYMENT_CATEGORY: "managed",
    ...(spec.runtime.reporting_posthog_host
      ? {
          REPORTING_POSTHOG_HOST: spec.runtime.reporting_posthog_host,
          REPORTING_POSTHOG_PROJECT_TOKEN: spec.runtime.reporting_posthog_project_token,
        }
      : {}),
    REPORTING_FORCED_OFF: String(spec.runtime.reporting_forced_off),
    APP_URL: spec.app_url,
    MAIL_FROM_ADDRESS: spec.runtime.mail_from_address,
    ...(spec.runtime.mail_from_name ? { MAIL_FROM_NAME: spec.runtime.mail_from_name } : {}),
    ...(spec.runtime.object_storage_provider === "s3"
      ? {
          OBJECT_STORAGE_PROVIDER: "s3",
          S3_BUCKET: spec.runtime.s3_bucket,
          S3_ENDPOINT: spec.runtime.s3_endpoint,
          S3_FORCE_PATH_STYLE: String(spec.runtime.s3_force_path_style),
          S3_REGION: spec.runtime.s3_region,
        }
      : { R2_ACCOUNT_ID: spec.runtime.r2_account_id, R2_BUCKET_NAME: iac.assets_bucket }),
    VERSION: spec.git_sha,
    ...providerVars(spec),
  };

  const isS3 = spec.runtime.object_storage_provider === "s3";
  automation.vars = commonVars;
  automation.r2_buckets = isS3
    ? (automation.r2_buckets ?? []).filter((entry) => entry.binding !== "ASSETS")
    : replaceBinding(automation.r2_buckets, "ASSETS", {
        binding: "ASSETS",
        bucket_name: iac.assets_bucket,
      });
  automation.hyperdrive = replaceBinding(automation.hyperdrive, "DB_SYSTEM", {
    binding: "DB_SYSTEM",
    id: iac.system_hyperdrive_id,
  });
  automation.queues = {
    ...(automation.queues ?? {}),
    producers: Object.entries(queueBindings).map(([workload, binding]) => ({
      binding,
      queue: iac.queues[workload],
    })),
  };

  api.vars = {
    ...commonVars,
    ALLOWED_ORIGINS: spec.allowed_origins.join(","),
    ...(iac.access_aud
      ? {
          ACCESS_POLICY_AUD: iac.access_aud,
          ACCESS_TEAM_DOMAIN: iac.access_team_domain,
          OPERATOR_HOSTNAME: iac.operator_hostname,
        }
      : {}),
  };
  for (const config of [api, automation]) {
    config.send_email = replaceBinding(
      config.send_email,
      "MAIL",
      {
        name: "MAIL",
        allowed_sender_addresses: [spec.runtime.mail_from_address],
      },
      "name",
    );
  }
  api.r2_buckets = isS3
    ? (api.r2_buckets ?? []).filter((entry) => entry.binding !== "ASSETS")
    : replaceBinding(api.r2_buckets, "ASSETS", {
        binding: "ASSETS",
        bucket_name: iac.assets_bucket,
      });
  api.hyperdrive = [
    { binding: "DB_AUTHENTICATED", id: iac.authenticated_hyperdrive_id },
    { binding: "DB_SYSTEM", id: iac.system_hyperdrive_id },
  ];
  api.preview_urls = true;

  return {
    api: stableValue(api),
    automation: stableValue(automation),
    state: stableValue(state),
    frontend: stableValue(frontend),
  };
}
export async function loadReleaseInputs({ iacOutputsPath, inputPath }) {
  const [inputSource, outputSource] = await Promise.all([
    readFile(inputPath, "utf8"),
    readFile(iacOutputsPath, "utf8"),
  ]);
  let rawInput;
  let rawOutputs;
  try {
    rawInput = JSON.parse(inputSource);
    rawOutputs = JSON.parse(outputSource);
  } catch {
    throw new TypeError("release input and IaC outputs must be valid JSON");
  }
  const spec = validateReleaseSpec(rawInput);
  return { iac: validateIacOutputs(rawOutputs, spec), spec };
}

export async function loadReleaseSpec(inputPath) {
  let rawInput;
  try {
    rawInput = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    throw new TypeError("release input must be valid JSON");
  }
  return validateReleaseSpec(rawInput);
}

async function loadSourceConfigs(repoRoot) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(workerConfigs).map(async ([worker, relativePath]) => [
        worker,
        parseJsonc(await readFile(path.join(repoRoot, relativePath), "utf8"), relativePath),
      ]),
    ),
  );
}

function rewriteConfigRelativePath(configDir, sourceDir, value) {
  if (typeof value !== "string" || value === "" || path.isAbsolute(value)) {
    return value;
  }
  return path.relative(configDir, path.resolve(sourceDir, value)).split(path.sep).join("/");
}

export async function writeRenderedConfigs({ outDir, repoRoot, spec, iac }) {
  const sourceConfigs = await loadSourceConfigs(repoRoot);
  const configs = renderWranglerConfigs(sourceConfigs, spec, iac);
  const configDir = path.join(outDir, "wrangler");
  await mkdir(configDir, { mode: 0o700, recursive: true });
  const paths = {};
  for (const worker of ["state", "automation", "api", "frontend"]) {
    const sourceDir = path.dirname(path.join(repoRoot, workerConfigs[worker]));
    for (const field of ["$schema", "main"]) {
      configs[worker][field] = rewriteConfigRelativePath(
        configDir,
        sourceDir,
        configs[worker][field],
      );
    }
    if (configs[worker].assets?.directory) {
      configs[worker].assets.directory = rewriteConfigRelativePath(
        configDir,
        sourceDir,
        configs[worker].assets.directory,
      );
    }
    for (const container of configs[worker].containers ?? []) {
      container.image = rewriteConfigRelativePath(configDir, sourceDir, container.image);
      container.image_build_context = rewriteConfigRelativePath(
        configDir,
        sourceDir,
        container.image_build_context,
      );
    }
    const outputPath = path.join(configDir, `${worker}.json`);
    await writeFile(outputPath, stableJson(configs[worker]), { mode: 0o600 });
    paths[worker] = outputPath;
  }
  const digest = createHash("sha256")
    .update(
      ["state", "automation", "api", "frontend"]
        .map((worker) => stableJson(configs[worker]))
        .join("\0"),
    )
    .digest("hex");
  return { config_digest: digest, paths };
}

export function normalizeNeonDatabaseHostname(hostname) {
  const labels = hostname.toLowerCase().replace(trailingDotPattern, "").split(".");
  if (
    labels.length < 4 ||
    labels.at(-2) !== "neon" ||
    labels.at(-1) !== "tech" ||
    !neonEndpointPattern.test(labels[0])
  ) {
    throw new Error("database URL must target a Neon endpoint hostname");
  }
  labels[0] = labels[0].replace(poolerSuffixPattern, "");
  return labels.join(".");
}

function validatedDatabaseUrl(value, name) {
  const connectionString = value?.trim();
  if (!connectionString) throw new Error(`${name} is required`);
  if (connectionString !== value) throw new Error(`${name} has surrounding space`);
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.username ||
    !parsed.password ||
    !parsed.hostname ||
    parsed.pathname === "/" ||
    !["require", "verify-ca", "verify-full"].includes(parsed.searchParams.get("sslmode") ?? "")
  ) {
    throw new Error(`${name} must be a complete TLS PostgreSQL URL`);
  }
  return {
    connectionString,
    hostname: normalizeNeonDatabaseHostname(parsed.hostname),
  };
}

export function validateDatabaseEnvironment(environment) {
  const system = validatedDatabaseUrl(
    environment.MELTIPLY_SYSTEM_DATABASE_URL,
    "MELTIPLY_SYSTEM_DATABASE_URL",
  );
  if (environment.MELTIPLY_AUTHENTICATED_DATABASE_URL !== undefined) {
    const authenticated = validatedDatabaseUrl(
      environment.MELTIPLY_AUTHENTICATED_DATABASE_URL,
      "MELTIPLY_AUTHENTICATED_DATABASE_URL",
    );
    if (authenticated.hostname !== system.hostname) {
      throw new Error("authenticated and system database URLs must target the same Neon endpoint");
    }
  }
  return system.connectionString;
}

export function requiredRemoteSecrets(spec) {
  const storage =
    spec.runtime.object_storage_provider === "s3"
      ? ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]
      : ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const common = [...storage, "TOKEN_ENCRYPTION_KEY"];
  const api = [...common, "AUTH_SETUP_SECRET", "BETTER_AUTH_SECRET"];
  const automation = [...common];
  for (const [provider, fields] of Object.entries(providerVariables)) {
    if (spec.provider_acceptance[provider]) {
      api.push(fields.secret);
      automation.push(fields.secret);
    }
  }
  return { api: api.sort(), automation: automation.sort(), state: [], frontend: [] };
}

export async function preflightRelease({
  clientFactory,
  environment,
  offline,
  repoRoot,
  runCommand,
  spec,
}) {
  const [, wranglerVersion] = await Promise.all([
    verifyReleaseCheckout({ repoRoot, runCommand, spec }),
    runCommand("bun", ["run", "--no-install", "wrangler", "--version"], {
      cwd: repoRoot,
    }),
  ]);
  if (!wranglerVersionPattern.test(wranglerVersion.stdout.trim())) {
    throw new Error("release requires Wrangler 4.148.0");
  }
  const requiredSecrets = requiredRemoteSecrets(spec);
  let databaseRoles = { reason: "offline", status: "skipped" };
  if (!offline) {
    const accountId = environment.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!accountId || accountId !== spec.runtime.r2_account_id) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID is missing or does not match release input");
    }
    if (!environment.CLOUDFLARE_API_TOKEN?.trim()) {
      throw new Error("CLOUDFLARE_API_TOKEN is required");
    }
    validateDatabaseEnvironment(environment);
    databaseRoles = await assertDatabaseRoles({ clientFactory, environment });
  }

  return {
    database_roles: databaseRoles,
    environment: spec.environment,
    deployment_mode: spec.deployment_mode,
    git_sha: spec.git_sha,
    offline,
    release_id: spec.release_id,
    remote_secret_binding_counts: Object.fromEntries(
      Object.entries(requiredSecrets).map(([worker, names]) => [worker, names.length]),
    ),
    status: "ready",
    wrangler_version: "4.148.0",
  };
}

export function redactError(error, environment) {
  let message = error instanceof Error ? error.message : String(error);
  const values = [
    environment.CLOUDFLARE_API_TOKEN,
    environment.MELTIPLY_SYSTEM_DATABASE_URL,
    environment.MELTIPLY_AUTHENTICATED_DATABASE_URL,
    environment.NEON_API_KEY,
    environment.TF_HTTP_PASSWORD,
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const value of values) message = message.split(value).join("[REDACTED]");
  return message;
}
