import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMailSenderAddress, isMailSenderName } from "../../packages/domain/src/mail-content.mjs";
import { assertDatabaseRoles } from "../lib/database-roles.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";

const workerConfigs = {
  api: "workers/api/wrangler.jsonc",
  automation: "workers/automation/wrangler.jsonc",
  state: "workers/state/wrangler.jsonc",
};

const queueBindings = {
  analytics: "ANALYTICS_QUEUE",
  "asset-processing": "ASSET_PROCESSING_QUEUE",
  "channel-revocation": "CHANNEL_REVOCATION_QUEUE",
  comments: "COMMENTS_QUEUE",
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
  "s3_bucket",
  "s3_endpoint",
  "s3_force_path_style",
  "s3_region",
  "threads_client_id",
  "tiktok_client_key",
  "tiktok_media_url_prefix",
  "youtube_shorts_client_id",
]);

/**
 * Asserts that a value is a non-null, non-array object record.
 *
 * @param {unknown} value - Value to validate
 * @param {string} name - Contextual label for error reporting
 * @returns {object} The validated object
 * @throws {TypeError} If value is null, array, or not an object
 */
function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

/**
 * Asserts that an object contains only keys in the expected set, rejecting unknown properties.
 *
 * @param {object} value - Object to inspect
 * @param {Set<string>} expected - Set of permitted key names
 * @param {string} name - Contextual label for error reporting
 * @returns {void}
 * @throws {TypeError} If any unrecognized key is present
 */
function assertExactKeys(value, expected, name) {
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !expected.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${name} contains unknown fields: ${unknown.join(", ")}`);
  }
}

/**
 * Validates that a value is a trimmed, non-empty string adhering to length, control-character,
 * and optional regex constraints.
 *
 * @param {unknown} value - Value to validate
 * @param {string} name - Contextual label for error reporting
 * @param {RegExp} [pattern] - Optional pattern the string must match
 * @param {number} [maximum=512] - Maximum permitted string length
 * @returns {string} The validated string
 * @throws {TypeError} If the value is invalid or exceeds maximum length
 */
function requiredString(value, name, pattern, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

/**
 * Validates an optional string; returns undefined if undefined, otherwise runs requiredString.
 *
 * @param {unknown} value - Value to validate
 * @param {string} name - Contextual label for error reporting
 * @param {RegExp} [pattern] - Optional regex pattern
 * @param {number} [maximum=512] - Maximum permitted string length
 * @returns {string | undefined} Validated string or undefined
 */
function optionalString(value, name, pattern, maximum = 512) {
  if (value === undefined) return undefined;
  return requiredString(value, name, pattern ?? /^[A-Za-z0-9._:-]+$/, maximum);
}

/**
 * Validates that a string is a credential-free HTTPS URL or origin.
 *
 * @param {unknown} value - Candidate URL string
 * @param {string} name - Contextual label for error reporting
 * @param {object} [options={}] - Validation options
 * @param {boolean} [options.originOnly=false] - Whether the URL must be an origin without path/search/hash
 * @returns {string} Normalized HTTPS URL or origin
 * @throws {TypeError} If URL is malformed, not HTTPS, contains credentials, or violates originOnly
 */
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
  return originOnly ? parsed.origin : parsed.toString().replace(/\/$/, "");
}

/**
 * Validates that a value is a strict boolean.
 *
 * @param {unknown} value - Value to test
 * @param {string} name - Contextual label for error reporting
 * @returns {boolean} The validated boolean
 * @throws {TypeError} If value is not a boolean
 */
function boolean(value, name) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

/**
 * Extracts a non-sensitive output value from an OpenTofu JSON outputs dictionary.
 * Fails closed if the output is flagged as sensitive, ensuring secrets do not flow into state outputs.
 *
 * @param {Record<string, object>} outputs - OpenTofu outputs map
 * @param {string} name - Output property name
 * @returns {any} Resolved non-sensitive output value
 * @throws {TypeError} If output is missing or sensitive
 */
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

/**
 * Recursively normalizes an object or array with sorted keys to produce deterministic serialized representation.
 *
 * @param {any} value - Arbitrary data structure
 * @returns {any} Structurally cloned data structure with sorted object keys
 */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

/**
 * Formats a value as deterministic, pretty-printed JSON with sorted keys and a trailing newline.
 *
 * @param {any} value - Data structure to serialize
 * @returns {string} Deterministic JSON string
 */
function json(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

/**
 * Matches recognized credential material that must never appear in release
 * input, rendered evidence, or published manifests: PostgreSQL URLs, PEM
 * private keys, and Stripe-style secret keys. Shared by release input
 * validation and the manifest secret-exclusion scan.
 */
const credentialMaterialPattern =
  /postgres(?:ql)?:\/\/|-----BEGIN [A-Z ]+PRIVATE KEY-----|sk_(?:test|live)_/i;

/**
 * Reports whether a serialized document embeds recognized credential material.
 *
 * @param {string} serialized - Text (typically serialized JSON) to scan
 * @returns {boolean} True when credential material is present
 */
export function containsCredentialMaterial(serialized) {
  return credentialMaterialPattern.test(serialized);
}

/**
 * Validates a non-secret staging release specification document against structural and security invariants.
 * Enforces schema version 1, staging environment, valid deployment mode ('bootstrap' or 'update'),
 * 40-character Git SHA, derived release ID ('staging-<12-char-sha>'), origin-only HTTPS URLs,
 * the shared sender address/name policy with a
 * dotted sender domain required for staging, a staging DNS suffix, Neon scope,
 * and ISO 8601 restore point expiry. Rejects secrets, private keys, and connection strings.
 * Object storage defaults to R2; S3 selection requires a bucket and HTTPS origin,
 * with region us-east-1 and path-style addressing by default. Credentials stay
 * in provider-specific remote secrets, never this document. TikTok's optional media
 * prefix overrides the provider registry's default derived from the public API origin.
 * @param {unknown} input - Raw release specification object
 * @returns {object} Normalized, validated release specification
 * @throws {TypeError} If validation fails or forbidden secrets are present
 */
export function validateReleaseSpec(input) {
  const spec = assertPlainObject(input, "release input");
  const serialized = JSON.stringify(spec);
  if (containsCredentialMaterial(serialized)) {
    throw new TypeError("release input must not contain credentials or database URLs");
  }
  assertExactKeys(spec, exactSpecKeys, "release input");
  if (spec.schema_version !== 1) throw new TypeError("schema_version must be 1");
  if (spec.environment !== "staging") {
    throw new TypeError("the release tooling is staging-only");
  }
  if (!new Set(["bootstrap", "update"]).has(spec.deployment_mode)) {
    throw new TypeError("deployment_mode must be bootstrap or update");
  }
  const gitSha = requiredString(spec.git_sha, "git_sha", /^[0-9a-f]{40}$/);
  const releaseId = requiredString(spec.release_id, "release_id", /^staging-[0-9a-f]{12}$/);
  if (releaseId !== `staging-${gitSha.slice(0, 12)}`) {
    throw new TypeError("release_id must contain the first 12 characters of git_sha");
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
  if (!new URL(apiWorkersDevUrl).hostname.startsWith("meltiply-api.")) {
    throw new TypeError("api_workers_dev_url must name the meltiply-api Worker");
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

  const acceptance = assertPlainObject(spec.provider_acceptance, "provider_acceptance");
  assertExactKeys(acceptance, exactAcceptanceKeys, "provider_acceptance");
  for (const key of exactAcceptanceKeys) boolean(acceptance[key], `provider_acceptance.${key}`);
  if (acceptance.instagram_engagement && !acceptance.instagram) {
    throw new TypeError("Instagram engagement acceptance requires Instagram acceptance");
  }
  if (acceptance.threads_engagement && !acceptance.threads) {
    throw new TypeError("Threads engagement acceptance requires Threads acceptance");
  }

  const runtime = assertPlainObject(spec.runtime, "runtime");
  assertExactKeys(runtime, exactRuntimeKeys, "runtime");
  const mailFromAddress = requiredString(runtime.mail_from_address, "runtime.mail_from_address");
  if (!isMailSenderAddress(mailFromAddress, true)) {
    throw new TypeError("runtime.mail_from_address is invalid");
  }
  const mailFromName = optionalString(runtime.mail_from_name, "runtime.mail_from_name", /^.+$/s);
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
    r2_account_id: requiredString(runtime.r2_account_id, "runtime.r2_account_id", /^[0-9a-f]{32}$/),
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
          s3_bucket: requiredString(
            runtime.s3_bucket,
            "runtime.s3_bucket",
            /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
          ),
          s3_endpoint: httpsUrl(runtime.s3_endpoint, "runtime.s3_endpoint", { originOnly: true }),
          s3_force_path_style:
            runtime.s3_force_path_style === undefined
              ? true
              : boolean(runtime.s3_force_path_style, "runtime.s3_force_path_style"),
          s3_region:
            runtime.s3_region === undefined
              ? "us-east-1"
              : requiredString(runtime.s3_region, "runtime.s3_region", /^[a-z0-9-]+$/),
        }
      : {}),
  };
  for (const [provider, fields] of Object.entries(providerVariables)) {
    if (acceptance[provider] && !validatedRuntime[fields.clientField]) {
      throw new TypeError(`${fields.clientField} is required when ${provider} is accepted`);
    }
  }

  const automationGuard = assertPlainObject(spec.automation_guard, "automation_guard");
  assertExactKeys(automationGuard, new Set(["consumers_paused", "cron_safe"]), "automation_guard");
  if (
    !boolean(automationGuard.consumers_paused, "automation_guard.consumers_paused") ||
    !boolean(automationGuard.cron_safe, "automation_guard.cron_safe")
  ) {
    throw new TypeError("automation consumers must be paused and Cron must be safe before release");
  }

  const neonBranchId = requiredString(spec.neon_branch_id, "neon_branch_id", /^[a-z0-9-]{1,60}$/);
  const neonProjectId = requiredString(
    spec.neon_project_id,
    "neon_project_id",
    /^[a-z0-9-]{1,60}$/,
  );
  const restorePointExpiresAt = requiredString(
    spec.restore_point_expires_at,
    "restore_point_expires_at",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
  );
  const restorePointExpiry = Date.parse(restorePointExpiresAt);
  const canonicalRestorePointExpiry = Number.isFinite(restorePointExpiry)
    ? new Date(restorePointExpiry).toISOString()
    : "";
  if (
    canonicalRestorePointExpiry !== restorePointExpiresAt &&
    canonicalRestorePointExpiry !== restorePointExpiresAt.replace(/Z$/, ".000Z")
  ) {
    throw new TypeError("restore_point_expires_at is invalid");
  }

  return {
    app_url: apiBaseUrl,
    api_workers_dev_url: apiWorkersDevUrl,
    automation_guard: { consumers_paused: true, cron_safe: true },
    deployment_mode: spec.deployment_mode,
    environment: "staging",
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

/**
 * Validates post-apply OpenTofu IaC outputs against release specification invariants.
 * Ensures consistent resource names, valid Hyperdrive identifiers, staging-scoped R2 asset buckets,
 * and complete queue binding definitions across all supported workloads.
 *
 * @param {unknown} input - Raw OpenTofu JSON outputs object
 * @param {object} spec - Validated release specification
 * @returns {object} Validated, normalized IaC outputs bundle
 * @throws {TypeError} If outputs are malformed, inconsistent with the release spec, or contain unexpected values
 */
export function validateIacOutputs(input, spec) {
  const outputs = assertPlainObject(input, "IaC outputs");
  const resources = assertPlainObject(
    outputValue(outputs, "release_resources"),
    "release_resources",
  );
  const bindings = assertPlainObject(outputValue(outputs, "worker_bindings"), "worker_bindings");
  if (resources.environment !== "staging") {
    throw new TypeError("IaC release resources must be staging");
  }
  const hostname = requiredString(
    resources.app_hostname,
    "release_resources.app_hostname",
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/,
  );
  if (spec.app_url !== `https://${hostname}`) {
    throw new TypeError("app_url must match the IaC API hostname");
  }
  const bucket = requiredString(bindings.ASSETS, "worker_bindings.ASSETS");
  if (bucket !== resources.assets_bucket_name || !bucket.endsWith("-staging")) {
    throw new TypeError("the IaC asset bucket is inconsistent or not staging-scoped");
  }
  const authenticatedId = requiredString(
    bindings.DB_AUTHENTICATED,
    "worker_bindings.DB_AUTHENTICATED",
    /^[0-9a-f]{32}$/,
  );
  const systemId = requiredString(
    bindings.DB_SYSTEM,
    "worker_bindings.DB_SYSTEM",
    /^[0-9a-f]{32}$/,
  );
  if (
    authenticatedId === systemId ||
    authenticatedId !== resources.authenticated_hyperdrive_id ||
    systemId !== resources.system_hyperdrive_id
  ) {
    throw new TypeError("Hyperdrive output IDs must be distinct and consistent");
  }

  const queues = assertPlainObject(bindings.queues, "worker_bindings.queues");
  assertExactKeys(queues, new Set(Object.keys(queueBindings)), "worker_bindings.queues");
  for (const workload of Object.keys(queueBindings)) {
    if (queues[workload] !== `meltiply-${workload}-staging`) {
      throw new TypeError(`queue ${workload} is not the expected staging queue`);
    }
  }
  if (JSON.stringify(stableValue(queues)) !== JSON.stringify(stableValue(resources.queue_names))) {
    throw new TypeError("queue names differ between IaC outputs");
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
    operator_hostname: operatorHostname,
    queues: stableValue(queues),
    release_resources: stableValue(resources),
    system_hyperdrive_id: systemId,
  };
}

/**
 * Builds environment variable string mappings for provider acceptance flags and OAuth client keys.
 *
 * @param {object} spec - Release specification object
 * @returns {Record<string, string>} Provider environment variables map
 */
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

/**
 * Immutably replaces or appends a named binding within a Wrangler configuration section.
 * Most binding tables identify entries by `binding`; `send_email` entries use `name`.
 *
 * @param {Array<object> | undefined} entries - Existing binding entries list
 * @param {string} identifier - Target binding name to replace
 * @param {object} replacement - New binding descriptor object
 * @param {string} [key="binding"] - Entry property holding the binding identifier
 * @returns {Array<object>} Updated binding entries list
 */
function replaceBinding(entries, identifier, replacement, key = "binding") {
  const filtered = (entries ?? []).filter((entry) => entry[key] !== identifier);
  return [...filtered, replacement];
}

/**
 * Renders concrete Cloudflare Wrangler configuration trees for the api, automation, and state Workers.
 * Injects staging environment variables, Hyperdrive bindings, the selected object storage settings, queue producers,
 * allowed CORS origins, the sender-restricted send_email MAIL binding, Zero Trust Access bindings,
 * and per-version preview URLs on the API Worker (the stable workers.dev route stays disabled).
 * S3 deployments omit the unused ASSETS binding; omitted provider selection preserves R2.
 *
 * @param {Record<string, object>} sourceConfigs - Base source Wrangler configurations loaded from disk
 * @param {object} spec - Validated release specification
 * @param {object} iac - Validated post-apply IaC outputs
 * @returns {{ api: object, automation: object, state: object }} Complete rendered Wrangler configurations
 */
export function renderWranglerConfigs(sourceConfigs, spec, iac) {
  const state = structuredClone(sourceConfigs.state);
  const automation = structuredClone(sourceConfigs.automation);
  const api = structuredClone(sourceConfigs.api);
  const commonVars = {
    ENVIRONMENT: "staging",
    APP_URL: spec.app_url,
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

  automation.vars = commonVars;
  automation.r2_buckets = replaceBinding(automation.r2_buckets, "ASSETS", {
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
    MAIL_FROM_ADDRESS: spec.runtime.mail_from_address,
    ...(spec.runtime.mail_from_name ? { MAIL_FROM_NAME: spec.runtime.mail_from_name } : {}),
    ...(iac.access_aud
      ? {
          ACCESS_POLICY_AUD: iac.access_aud,
          ACCESS_TEAM_DOMAIN: iac.access_team_domain,
          OPERATOR_HOSTNAME: iac.operator_hostname,
        }
      : {}),
  };
  api.send_email = replaceBinding(
    api.send_email,
    "MAIL",
    {
      name: "MAIL",
      allowed_sender_addresses: [spec.runtime.mail_from_address],
    },
    "name",
  );
  api.r2_buckets = replaceBinding(api.r2_buckets, "ASSETS", {
    binding: "ASSETS",
    bucket_name: iac.assets_bucket,
  });
  if (spec.runtime.object_storage_provider === "s3") {
    api.r2_buckets = api.r2_buckets.filter((entry) => entry.binding !== "ASSETS");
    automation.r2_buckets = automation.r2_buckets.filter((entry) => entry.binding !== "ASSETS");
  }
  api.hyperdrive = [
    { binding: "DB_AUTHENTICATED", id: iac.authenticated_hyperdrive_id },
    { binding: "DB_SYSTEM", id: iac.system_hyperdrive_id },
  ];
  // `preview_urls` is a Worker-level subdomain setting written by
  // `wrangler deploy` (and `wrangler triggers deploy`, which the API release
  // never runs). Enabling it on the rendered API config makes the immutable
  // per-version URLs that version smoke fetches routable while the stable
  // `workers.dev` route stays disabled. Secret versions created by
  // `wrangler versions secret bulk` inherit the setting.
  api.preview_urls = true;

  return {
    api: stableValue(api),
    automation: stableValue(automation),
    state: stableValue(state),
  };
}
/**
 * Loads and validates both the staging release input and OpenTofu post-apply IaC output files.
 *
 * @param {object} params - File path parameters
 * @param {string} params.iacOutputsPath - Path to OpenTofu post-apply JSON outputs
 * @param {string} params.inputPath - Path to release specification JSON
 * @returns {Promise<{ iac: object, spec: object }>} Validated IaC outputs and release specification
 * @throws {TypeError} If files cannot be parsed as JSON or fail validation
 */
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

/**
 * Loads and validates a release specification JSON file from disk.
 *
 * @param {string} inputPath - Filesystem path to release specification JSON
 * @returns {Promise<object>} Validated release specification object
 * @throws {TypeError} If reading, parsing, or validation fails
 */
export async function loadReleaseSpec(inputPath) {
  let rawInput;
  try {
    rawInput = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    throw new TypeError("release input must be valid JSON");
  }
  return validateReleaseSpec(rawInput);
}

/**
 * Loads and parses JSONC Wrangler configurations for state, automation, and api Workers.
 *
 * @param {string} repoRoot - Repository root directory path
 * @returns {Promise<Record<string, object>>} Parsed source Wrangler configurations
 */
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

/**
 * Rebases a filesystem-relative Wrangler path from its source config directory
 * to the rendered directory. Nonstrings, empty values, and absolute paths pass
 * through; callers must exclude registry image references before rebasing.
 */
function rewriteConfigRelativePath(configDir, sourceDir, value) {
  if (typeof value !== "string" || value === "" || path.isAbsolute(value)) {
    return value;
  }
  return path.relative(configDir, path.resolve(sourceDir, value)).split(path.sep).join("/");
}

/**
 * Rewrites schema, main script, and container image/build-context relative paths
 * and generates a composite SHA-256 config digest.
 *
 * Wrangler resolves those paths against the directory holding the config file,
 * so a rendered config that kept the source paths would look for the media
 * processor Dockerfile beside the rendered file instead of in the Worker
 * directory.
 *
 * @param {object} params - Render options
 * @param {string} params.outDir - Output directory for rendered artifacts
 * @param {string} params.repoRoot - Repository root directory path
 * @param {object} params.spec - Validated release specification
 * @param {object} params.iac - Validated IaC outputs
 * @returns {Promise<{ config_digest: string, paths: Record<string, string> }>} Config SHA-256 digest and paths
 */
export async function writeRenderedConfigs({ outDir, repoRoot, spec, iac }) {
  const sourceConfigs = await loadSourceConfigs(repoRoot);
  const configs = renderWranglerConfigs(sourceConfigs, spec, iac);
  const configDir = path.join(outDir, "wrangler");
  await mkdir(configDir, { mode: 0o700, recursive: true });
  const paths = {};
  for (const worker of ["state", "automation", "api"]) {
    const sourceDir = path.dirname(path.join(repoRoot, workerConfigs[worker]));
    for (const field of ["$schema", "main"]) {
      configs[worker][field] = rewriteConfigRelativePath(
        configDir,
        sourceDir,
        configs[worker][field],
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
    await writeFile(outputPath, json(configs[worker]), { mode: 0o600 });
    paths[worker] = outputPath;
  }
  const digest = createHash("sha256")
    .update(["state", "automation", "api"].map((worker) => json(configs[worker])).join("\0"))
    .digest("hex");
  return { config_digest: digest, paths };
}

/**
 * Normalizes a Neon PostgreSQL endpoint hostname, stripping any `-pooler` suffix.
 * Validates domain structure (must be `ep-<id>[.region].neon.tech`).
 *
 * @param {string} hostname - Neon endpoint hostname
 * @returns {string} Normalized direct endpoint hostname without pooler suffix
 * @throws {Error} If hostname does not target a valid Neon endpoint
 */
export function normalizeNeonDatabaseHostname(hostname) {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  if (
    labels.length < 4 ||
    labels.at(-2) !== "neon" ||
    labels.at(-1) !== "tech" ||
    !/^ep-[a-z0-9-]+(?:-pooler)?$/.test(labels[0])
  ) {
    throw new Error("database URL must target a Neon endpoint hostname");
  }
  labels[0] = labels[0].replace(/-pooler$/, "");
  return labels.join(".");
}

/**
 * Validates that a database connection string is a trimmed, complete TLS PostgreSQL URL targeting a Neon endpoint.
 *
 * @param {string | undefined} value - Connection string to validate
 * @param {string} name - Variable name for error reporting
 * @returns {{ connectionString: string, hostname: string }} Validated connection string and normalized endpoint hostname
 * @throws {Error} If connection string is missing, invalid URL, not TLS, or targets non-Neon host
 */
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

/**
 * Validates the database environment variables, ensuring system and authenticated database URLs
 * target the exact same Neon database compute endpoint.
 *
 * @param {Record<string, string | undefined>} environment - Environment lookup source
 * @returns {string} System database connection string
 * @throws {Error} If URLs are missing, malformed, or point to mismatched Neon endpoints
 */
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

/**
 * Computes the remote secret names each Worker requires for a release: selected
 * object storage credentials, encryption keys, and the API session and first-owner bootstrap secrets,
 * provider-specific credentials enabled in provider acceptance. Mail delivery uses the native
 * send_email binding, so no delivery credential is required.
 *
 * @param {object} spec - Release specification object
 * @returns {{ api: Array<string>, automation: Array<string>, state: Array<string> }} Required secret names by worker
 */
function requiredRemoteSecrets(spec) {
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
  return { api: api.sort(), automation: automation.sort(), state: [] };
}

/**
 * Runs release preflight checks: verifies git HEAD commit matches release spec git_sha,
 * asserts a clean tracked working tree and pinned Wrangler CLI version via Bun without downloading tools,
 * and validates Cloudflare credentials plus both database login identities and role attributes.
 * The CI/release toolchain stays pinned together so reviewed evidence cannot drift.
 *
 * @param {object} params - Preflight parameters
 * @param {Function} [params.clientFactory] - Injectable PostgreSQL client factory
 * @param {Record<string, string | undefined>} params.environment - Environment variable lookup
 * @param {boolean} params.offline - Flag indicating offline mode (skips remote account/token checks)
 * @param {string} params.repoRoot - Repository root directory path
 * @param {(cmd: string, args: Array<string>, opts?: object) => Promise<object>} params.runCommand - Subprocess command runner
 * @param {object} params.spec - Validated release specification
 * @returns {Promise<object>} Preflight status summary object
 * @throws {Error} If commit mismatch, dirty checkout, wrong Wrangler version, or credentials fail validation
 */
export async function preflightRelease({
  clientFactory,
  environment,
  offline,
  repoRoot,
  runCommand,
  spec,
}) {
  const [head, status, wranglerVersion] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    runCommand("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: repoRoot,
    }),
    runCommand("bun", ["run", "--no-install", "wrangler", "--version"], {
      cwd: repoRoot,
    }),
  ]);
  if (head.stdout.trim() !== spec.git_sha) {
    throw new Error("release git_sha does not match the checked-out commit");
  }
  if (status.stdout.trim()) throw new Error("tracked working tree changes are not releasable");
  if (!/^4\.148\.0(?:\s|$)/.test(wranglerVersion.stdout.trim())) {
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
    environment: "staging",
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

/**
 * Sanitizes an error message or string representation by redacting known sensitive environment secrets
 * (Cloudflare API token, database URLs, Neon API key, Terraform HTTP backend password).
 *
 * @param {unknown} error - Caught error or message
 * @param {Record<string, string | undefined>} environment - Environment lookup holding secrets to redact
 * @returns {string} Error message string with sensitive credentials replaced by `[REDACTED]`
 */
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

export const releaseInternals = {
  json,
  queueBindings,
  requiredRemoteSecrets,
  stableValue,
  workerConfigs,
};
