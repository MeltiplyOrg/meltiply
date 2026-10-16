import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const infrastructureRoot = join(repositoryRoot, "infra/cloudflare");

/**
 * Recursively locates all Terraform/OpenTofu source files (*.tf) within a directory hierarchy.
 * Ignores vendor cache directories such as `.terraform`.
 *
 * @param {string} directory - Absolute or relative path of the root directory to search
 * @returns {Promise<Array<string>>} Array of absolute paths to discovered .tf files
 */
async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".terraform") continue;
      files.push(...(await filesBelow(path)));
    } else if (entry.name.endsWith(".tf")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Asserts that a text source matches a required regular expression pattern.
 * If the pattern does not match, appends the failure message to the failures list.
 *
 * @param {Array<string>} failures - Accumulator array for failure descriptions
 * @param {string} source - Source code or configuration text to check
 * @param {RegExp} pattern - Regular expression that must match
 * @param {string} message - Descriptive error message if assertion fails
 * @returns {void}
 */
function requirePattern(failures, source, pattern, message) {
  if (!pattern.test(source)) failures.push(message);
}

/**
 * Asserts that a text source does NOT match a forbidden regular expression pattern.
 * If the pattern matches, appends the failure message to the failures list.
 *
 * @param {Array<string>} failures - Accumulator array for failure descriptions
 * @param {string} source - Source code or configuration text to check
 * @param {RegExp} pattern - Forbidden regular expression pattern
 * @param {string} message - Descriptive error message if assertion fails
 * @returns {void}
 */
function rejectPattern(failures, source, pattern, message) {
  if (pattern.test(source)) failures.push(message);
}

/**
 * Validates that a numeric value is an integer within an inclusive range [minimum, maximum].
 *
 * @param {unknown} value - Value to validate
 * @param {number} minimum - Lower bound (inclusive)
 * @param {number} maximum - Upper bound (inclusive)
 * @returns {boolean} True if value is an integer within [minimum, maximum]
 */
function integerBetween(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

/**
 * Determines whether a planned OpenTofu resource change includes actions other than deletion
 * (e.g. create, update, or replace), indicating active resource configuration to evaluate.
 *
 * @param {object} change - OpenTofu resource change record
 * @returns {boolean} True if the change introduces or modifies resource attributes
 */
function isChanged(change) {
  return change.change?.actions?.some((action) => action !== "delete");
}

/**
 * Enforces static security, reliability, and architectural policies across Terraform/OpenTofu files
 * and production Wrangler configuration files.
 * Verifies lock-capable HTTP backend, disabled Hyperdrive caching, mandatory DLQs on workload consumers,
 * 14-day queue message retention, complete delivery/backpressure bounds, pull-only DLQ consumers,
 * explicit R2 CORS origins, grouped Zero Trust Access verifier bindings, hardened cookies (HttpOnly,
 * SameSite strict, binding cookie), module tagging (AUD-045), and prohibits secret variables in state,
 * account-wide USD budget alert misuse, public R2 domains, or primary asset auto-deletion.
 *
 * @returns {Promise<{ failures: Array<string>, files: Array<string> }>} Object containing collected policy failures and relative paths of examined files
 */
export async function checkStaticPolicy() {
  const failures = [];
  const files = await filesBelow(infrastructureRoot);
  const sources = await Promise.all(
    files.map(async (path) => ({
      path,
      source: await readFile(path, "utf8"),
    })),
  );
  const all = sources.map(({ source }) => source).join("\n");

  requirePattern(
    failures,
    all,
    /backend\s+"http"\s*\{/,
    "remote lock-capable HTTP state backend is required",
  );
  requirePattern(
    failures,
    all,
    /authenticated_cache_disabled[\s\S]*caching\.disabled/,
    "authenticated Hyperdrive caching must be checked as disabled",
  );
  requirePattern(
    failures,
    all,
    /cloudflare_queue_consumer[\s\S]*dead_letter_queue/,
    "every workload consumer must name a DLQ",
  );
  requirePattern(
    failures,
    all,
    /cloudflare_queue"\s+"workload"[\s\S]*delivery_paused\s*=\s*var\.delivery_paused[\s\S]*message_retention_period\s*=\s*1209600/,
    "workload Queues must retain messages for fourteen days",
  );
  requirePattern(
    failures,
    all,
    /cloudflare_queue"\s+"dead_letter"[\s\S]*message_retention_period\s*=\s*1209600/,
    "dead-letter Queues must retain messages for fourteen days",
  );
  requirePattern(
    failures,
    all,
    /cloudflare_queue_consumer"\s+"workload"[\s\S]*batch_size[\s\S]*max_concurrency[\s\S]*max_retries[\s\S]*max_wait_time_ms[\s\S]*retry_delay[\s\S]*visibility_timeout_ms/,
    "workload consumers must configure every delivery/backpressure bound",
  );
  requirePattern(
    failures,
    all,
    /cloudflare_queue_consumer"\s+"dead_letter_pull"[\s\S]*type\s*=\s*"http_pull"/,
    "every DLQ must expose a pull-only operator consumer",
  );
  requirePattern(
    failures,
    all,
    /cloudflare_r2_bucket_cors[\s\S]*origins\s*=/,
    "R2 upload CORS must be explicit",
  );
  requirePattern(
    failures,
    all,
    /ACCESS_POLICY_AUD\s*=\s*var\.enable_operator_access[\s\S]*ACCESS_TEAM_DOMAIN\s*=\s*var\.enable_operator_access[\s\S]*OPERATOR_HOSTNAME\s*=\s*var\.enable_operator_access/,
    "operator Access verifier bindings must be exported together",
  );
  requirePattern(
    failures,
    all,
    /cloudflare_zero_trust_access_application[\s\S]*enable_binding_cookie\s*=\s*true[\s\S]*http_only_cookie_attribute\s*=\s*true[\s\S]*same_site_cookie_attribute\s*=\s*"strict"/,
    "operator Access cookies must be bound, HttpOnly, and SameSite strict",
  );
  rejectPattern(
    failures,
    all,
    /\b(?:billing_limit_usd|monthly_budget_usd|budget_policy_ids)\b/,
    "product usage notifications must not be represented as account-wide USD budget alerts",
  );
  rejectPattern(
    failures,
    all,
    /resource\s+"cloudflare_hyperdrive_config"/,
    "secret-bearing Hyperdrive resources must not be stored in OpenTofu state",
  );
  rejectPattern(
    failures,
    all,
    /resource\s+"cloudflare_r2_(managed_domain|custom_domain)"/,
    "asset R2 buckets must remain private",
  );
  rejectPattern(
    failures,
    all,
    /\b(password|access_client_secret|api_token)\s*=\s*var\./,
    "secret values must not flow through OpenTofu variables/state",
  );
  requirePattern(
    failures,
    all,
    /resource\s+"cloudflare_zero_trust_access_application"[\s\S]*?tags\s*=\s*var\.tags/,
    "tag-capable Access application must carry module tags (AUD-045)",
  );
  requirePattern(
    failures,
    all,
    /module\s+"operator_access"[\s\S]*?tags\s*=\s*var\.common_tags/,
    "Access module must receive var.common_tags (AUD-045)",
  );
  rejectPattern(
    failures,
    all,
    /prefix\s*=\s*""(?:(?!prefix\s*=\s*").){0,300}?delete_objects_transition/,
    "primary asset paths must never be auto-deleted; only staging/ and incomplete multipart uploads may expire (AUD-045)",
  );

  const productionWrangler = await readFile(
    join(repositoryRoot, "workers/automation/wrangler.jsonc"),
    "utf8",
  );
  rejectPattern(
    failures,
    productionWrangler,
    /"consumers"\s*:/,
    "staging Queue consumers are OpenTofu-owned, not Wrangler-owned",
  );
  rejectPattern(
    failures,
    productionWrangler,
    /localConnectionString/,
    "production Wrangler config must not contain a direct database URL",
  );

  return {
    failures,
    files: sources.map(({ path }) => relative(repositoryRoot, path)),
  };
}

/**
 * Evaluates an OpenTofu JSON execution plan for operational and security policy violations.
 * Rejects secret-bearing Hyperdrive resources or public R2 bucket domains, enforces explicit
 * boolean queue delivery pause state, validates retention bounds (4-14 days), ensures DLQ
 * assignment for push consumers, and checks that consumer batch/concurrency/timeout settings
 * stay within bounded limits.
 *
 * @param {object} plan - Parsed OpenTofu JSON execution plan
 * @returns {Array<string>} Array of policy violation failure messages (empty if compliant)
 */
export function checkPlanPolicy(plan) {
  const failures = [];
  for (const change of plan.resource_changes ?? []) {
    const type = change.type;
    const after = change.change?.after ?? {};
    if (type === "cloudflare_hyperdrive_config") {
      failures.push(`${change.address}: Hyperdrive credentials would enter state`);
    }
    if (type === "cloudflare_r2_managed_domain" || type === "cloudflare_r2_custom_domain") {
      failures.push(`${change.address}: asset R2 public domain is forbidden`);
    }
    if (type === "cloudflare_queue" && isChanged(change)) {
      const settings = after.settings ?? {};
      if (typeof settings.delivery_paused !== "boolean") {
        failures.push(`${change.address}: Queue delivery state must be explicitly boolean`);
      }
      if (!integerBetween(settings.message_retention_period, 345_600, 1_209_600)) {
        failures.push(`${change.address}: Queue retention must be between four and fourteen days`);
      }
    }
    if (type === "cloudflare_queue_consumer" && isChanged(change)) {
      if (after.type === "http_pull") continue;
      if (!after.dead_letter_queue) {
        failures.push(`${change.address}: Queue consumer has no DLQ`);
      }
      const settings = after.settings ?? {};
      const bounds = [
        ["batch_size", 1, 100],
        ["max_concurrency", 1, 20],
        ["max_retries", 1, 100],
        ["max_wait_time_ms", 0, 60_000],
        ["retry_delay", 0, 43_200],
        ["visibility_timeout_ms", 1_000, 43_200_000],
      ];
      for (const [name, minimum, maximum] of bounds) {
        if (!integerBetween(settings[name], minimum, maximum)) {
          failures.push(
            `${change.address}: ${name} must be an integer between ${minimum} and ${maximum}`,
          );
        }
      }
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const staticResult = await checkStaticPolicy();
  let failures = [...staticResult.failures];
  const planPath = process.argv[2];
  if (planPath) {
    const plan = JSON.parse(await readFile(resolve(planPath), "utf8"));
    failures = failures.concat(checkPlanPolicy(plan));
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`policy: ${failure}`);
    process.exit(1);
  }

  console.log(`Infrastructure policy passed (${staticResult.files.length} HCL files checked).`);
}
