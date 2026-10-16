import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultInput = resolve(import.meta.dirname, "cost-model-inputs.json");
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const roundingModes = new Set(["ceil_billable", "ceil_usage", "continuous"]);

/**
 * Checks whether a value is a non-null, non-array object record.
 *
 * @param {unknown} value - Value to test
 * @returns {boolean} True if value is a plain object record
 */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Checks whether a value is a finite, non-negative number.
 *
 * @param {unknown} value - Value to test
 * @returns {boolean} True if value is a finite number >= 0
 */
function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Recursively collects dot-separated object paths for properties with explicit null values.
 * Used to discover unknown or unmeasured inputs across cost profile sections.
 *
 * @param {Record<string, unknown>} value - Object to traverse
 * @param {string} prefix - Current path prefix (e.g., "usage_1x")
 * @returns {Array<string>} Sorted list of dot-separated paths containing null values
 */
function collectNullPaths(value, prefix) {
  const paths = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (nested === null) paths.push(path);
    else if (record(nested)) paths.push(...collectNullPaths(nested, path));
  }
  return paths;
}

/**
 * Discovers all explicit null inputs across a cost profile's usage, business unit,
 * observed metric, and external cost sections to detect unmeasured cost drivers.
 *
 * @param {object} profile - Parsed cost profile object
 * @returns {Array<string>} Sorted array of dot-delimited null property paths
 */
function actualUnknownInputs(profile) {
  return [
    ...collectNullPaths(profile.usage_1x, "usage_1x"),
    ...collectNullPaths(profile.business_units_1x, "business_units_1x"),
    ...collectNullPaths(profile.observed_metrics_1x, "observed_metrics_1x"),
    ...collectNullPaths(profile.external_costs, "external_costs"),
  ].sort();
}

/**
 * Recursively validates that an object record contains only finite non-negative numbers or nulls,
 * accumulating human-readable error descriptions into the failures array.
 *
 * @param {Array<string>} failures - Accumulator array for validation error messages
 * @param {unknown} value - Object record to validate
 * @param {string} name - Dotted field name prefix for error messages
 * @returns {void}
 */
function validateNumericRecord(failures, value, name) {
  if (!record(value)) {
    failures.push(`${name} must be an object`);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (record(nested)) validateNumericRecord(failures, nested, `${name}.${key}`);
    else if (nested !== null && !nonnegative(nested)) {
      failures.push(`${name}.${key} must be null or a non-negative number`);
    }
  }
}

const requiredBusinessInputs = [
  "active_organizations",
  "api_requests",
  "assets_processed",
  "distribution_attempts",
  "successful_publishes",
  "sync_runs",
  "uploaded_gb",
];

/**
 * Validates a cost profile object against schema version 1 and internal invariants.
 * Enforces valid schema/profile versions, ISO dates, USD currency, unique positive scaling
 * scenarios, verified public-pricing source citations, tariff structures with recognized
 * rounding modes, required business drivers, and exact equality between declared
 * expected_unknown_inputs and actual null fields to prevent silent unknown-drift.
 *
 * @param {unknown} profile - Raw cost profile object to validate
 * @returns {object} Validated cost profile object
 * @throws {TypeError} If any schema or operational invariant validation check fails
 */
export function validateCostProfile(profile) {
  const failures = [];
  if (!record(profile)) throw new TypeError("cost profile must be an object");
  if (profile.schema_version !== 1) failures.push("schema_version must be 1");
  if (typeof profile.profile_version !== "string" || !profile.profile_version) {
    failures.push("profile_version is required");
  }
  if (!datePattern.test(profile.projection_on ?? "")) {
    failures.push("projection_on must use YYYY-MM-DD");
  }
  if (profile.currency !== "USD") failures.push("currency must be USD");
  if (
    !Array.isArray(profile.scenarios) ||
    profile.scenarios.length === 0 ||
    profile.scenarios.some((value) => !nonnegative(value) || value === 0) ||
    new Set(profile.scenarios).size !== profile.scenarios.length
  ) {
    failures.push("scenarios must contain unique positive numbers");
  }

  if (!record(profile.sources)) failures.push("sources must be an object");
  else {
    for (const [id, source] of Object.entries(profile.sources)) {
      if (
        !record(source) ||
        typeof source.url !== "string" ||
        !source.url.startsWith("https://") ||
        !datePattern.test(source.retrieved_on ?? "")
      ) {
        failures.push(`${id} must have an HTTPS URL and retrieval date`);
      }
    }
  }

  const tariffIds = new Set();
  if (!Array.isArray(profile.tariffs) || profile.tariffs.length === 0) {
    failures.push("tariffs must be a non-empty array");
  } else {
    for (const tariff of profile.tariffs) {
      if (!record(tariff) || typeof tariff.id !== "string" || !tariff.id) {
        failures.push("every tariff must have an id");
        continue;
      }
      if (tariffIds.has(tariff.id)) failures.push(`duplicate tariff ${tariff.id}`);
      tariffIds.add(tariff.id);
      if (!profile.sources?.[tariff.source]) {
        failures.push(`${tariff.id} has an unknown source`);
      }
      if (typeof tariff.usage !== "string" || !(tariff.usage in (profile.usage_1x ?? {}))) {
        failures.push(`${tariff.id} has an unknown usage input`);
      }
      if (!nonnegative(tariff.included)) {
        failures.push(`${tariff.id}.included must be non-negative`);
      }
      if (!nonnegative(tariff.billing_unit) || tariff.billing_unit === 0) {
        failures.push(`${tariff.id}.billing_unit must be positive`);
      }
      if (!nonnegative(tariff.usd_per_unit)) {
        failures.push(`${tariff.id}.usd_per_unit must be non-negative`);
      }
      if (!roundingModes.has(tariff.rounding)) {
        failures.push(`${tariff.id} has an invalid rounding mode`);
      }
      if (tariff.effective_on !== undefined && !datePattern.test(tariff.effective_on)) {
        failures.push(`${tariff.id}.effective_on must use YYYY-MM-DD`);
      }
    }
  }

  if (!Array.isArray(profile.monthly_base_costs)) {
    failures.push("monthly_base_costs must be an array");
  } else {
    for (const cost of profile.monthly_base_costs) {
      if (
        !record(cost) ||
        typeof cost.id !== "string" ||
        !profile.sources?.[cost.source] ||
        !nonnegative(cost.usd)
      ) {
        failures.push("every monthly base cost needs an id, source, and USD value");
      }
    }
  }

  if (!Array.isArray(profile.non_billable_services)) {
    failures.push("non_billable_services must be an array");
  } else {
    const nonBillableIds = new Set();
    for (const service of profile.non_billable_services) {
      if (
        !record(service) ||
        typeof service.id !== "string" ||
        !service.id ||
        nonBillableIds.has(service.id) ||
        !profile.sources?.[service.source] ||
        typeof service.statement !== "string" ||
        !service.statement
      ) {
        failures.push("every non-billable service needs a unique id, source, and statement");
      } else {
        nonBillableIds.add(service.id);
      }
    }
  }

  validateNumericRecord(failures, profile.usage_1x, "usage_1x");
  validateNumericRecord(failures, profile.business_units_1x, "business_units_1x");
  for (const input of requiredBusinessInputs) {
    if (!(input in (profile.business_units_1x ?? {}))) {
      failures.push(`business_units_1x.${input} is required`);
    }
  }
  validateNumericRecord(failures, profile.observed_metrics_1x, "observed_metrics_1x");
  validateNumericRecord(failures, profile.external_costs, "external_costs");
  if (record(profile.external_costs)) {
    for (const [service, cost] of Object.entries(profile.external_costs)) {
      if (!record(cost) || !("fixed_usd" in cost) || !("variable_usd_1x" in cost)) {
        failures.push(`external_costs.${service} needs fixed_usd and variable_usd_1x`);
      }
    }
  }

  if (!Array.isArray(profile.expected_unknown_inputs)) {
    failures.push("expected_unknown_inputs must be an array");
  } else {
    const expected = [...profile.expected_unknown_inputs];
    const sorted = [...new Set(expected)].sort();
    if (JSON.stringify(expected) !== JSON.stringify(sorted)) {
      failures.push("expected_unknown_inputs must be sorted and unique");
    } else if (
      [
        profile.usage_1x,
        profile.business_units_1x,
        profile.observed_metrics_1x,
        profile.external_costs,
      ].every(record)
    ) {
      const actual = actualUnknownInputs(profile);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        failures.push(`expected unknown inputs differ from profile: ${JSON.stringify(actual)}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new TypeError(`invalid cost profile:\n${failures.join("\n")}`);
  }
  return profile;
}

/**
 * Computes the monetary cost for a specific tariff given baseline usage and a scenario multiplier.
 * Accounts for effective start dates, included free allowances, billing units, and pricing
 * rounding modes ('ceil_usage', 'ceil_billable', or 'continuous').
 *
 * @param {object} tariff - Tariff pricing definition and rules
 * @param {number} usage - Baseline 1x usage volume
 * @param {number} multiplier - Scenario growth multiplier (e.g., 1, 3, 10)
 * @param {string} projectionOn - ISO date of the projection run
 * @returns {number} Unrounded computed USD cost for the tariff
 */
function tariffCost(tariff, usage, multiplier, projectionOn) {
  if (tariff.effective_on && projectionOn < tariff.effective_on) return 0;
  const scaled = usage * multiplier;
  const excess = Math.max(0, scaled - tariff.included);
  const billable =
    tariff.rounding === "ceil_usage"
      ? Math.max(0, Math.ceil(scaled / tariff.billing_unit) * tariff.billing_unit - tariff.included)
      : tariff.rounding === "ceil_billable"
        ? Math.ceil(excess / tariff.billing_unit) * tariff.billing_unit
        : excess;
  return (billable / tariff.billing_unit) * tariff.usd_per_unit;
}

/**
 * Rounds a floating-point USD value to 6 decimal places (micro-dollars) for deterministic
 * arithmetic precision without floating point drift across platforms.
 *
 * @param {number} value - Floating point monetary amount
 * @returns {number} Value rounded to 6 decimal places
 */
function rounded(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

const normalizedUnits = {
  active_organization: ["active_organizations", 1],
  api_request_1000: ["api_requests", 1_000],
  asset_processed: ["assets_processed", 1],
  distribution_attempt: ["distribution_attempts", 1],
  published_post: ["successful_publishes", 1],
  sync_run: ["sync_runs", 1],
  uploaded_gb: ["uploaded_gb", 1],
};

/**
 * Generates cost projections for a single scaling scenario multiplier.
 * Computes fixed base costs, variable tariff costs, and external costs, deriving total
 * known monthly cost and normalized unit costs per business driver (e.g., cost per publish).
 * If any inputs are null, outputs are labeled as lower bounds.
 *
 * @param {object} profile - Validated cost profile
 * @param {number} multiplier - Scale multiplier for the scenario
 * @returns {object} Detailed scenario projection with component breakdowns and unit costs
 */
function scenarioProjection(profile, multiplier) {
  const components = {};
  let knownTotal = 0;
  for (const cost of profile.monthly_base_costs) {
    components[cost.id] = rounded(cost.usd);
    knownTotal += cost.usd;
  }
  for (const tariff of profile.tariffs) {
    const usage = profile.usage_1x[tariff.usage];
    if (usage === null) {
      components[tariff.id] = null;
      continue;
    }
    const cost = tariffCost(tariff, usage, multiplier, profile.projection_on);
    components[tariff.id] = rounded(cost);
    knownTotal += cost;
  }
  for (const [service, cost] of Object.entries(profile.external_costs)) {
    if (cost.fixed_usd === null || cost.variable_usd_1x === null) {
      components[`external.${service}`] = null;
      continue;
    }
    const value = cost.fixed_usd + cost.variable_usd_1x * multiplier;
    components[`external.${service}`] = rounded(value);
    knownTotal += value;
  }

  const unitCosts = {};
  for (const [name, [input, units]] of Object.entries(normalizedUnits)) {
    const value = profile.business_units_1x[input];
    unitCosts[name] =
      value === null || value === 0 ? null : rounded(knownTotal / ((value * multiplier) / units));
  }

  return {
    multiplier,
    projection_kind:
      profile.expected_unknown_inputs.length === 0 ? "complete_total" : "known_lower_bound",
    known_monthly_usd: rounded(knownTotal),
    components,
    known_lower_bound_unit_usd: unitCosts,
  };
}

/**
 * Constructs a full multi-scenario cost projection from an input cost profile.
 * Produces structured monthly totals, normalized unit costs, explicit unknown input
 * tracking, and non-billable service audits across all configured scale scenarios (1x, 3x, 10x).
 *
 * @param {object} input - Raw or parsed cost profile data
 * @returns {object} Formatted projection report ready for JSON emission or gate evaluation
 */
export function buildCostProjection(input) {
  const profile = validateCostProfile(input);
  return {
    schema_version: 1,
    profile_version: profile.profile_version,
    projection_on: profile.projection_on,
    currency: profile.currency,
    complete: profile.expected_unknown_inputs.length === 0,
    unknown_inputs: [...profile.expected_unknown_inputs],
    non_billable_services: profile.non_billable_services.map(({ id }) => id),
    scenarios: profile.scenarios.map((multiplier) => scenarioProjection(profile, multiplier)),
  };
}

/**
 * Asserts that a cost projection is completely measured with zero unknown or unmeasured inputs.
 * Used as a fail-closed CI gate before production promotions to prevent untracked cost exposure.
 *
 * @param {object} projection - Built cost projection report
 * @returns {void}
 * @throws {Error} If any unknown inputs remain unmeasured
 */
export function assertCompleteProjection(projection) {
  if (!projection.complete) {
    throw new Error(
      `cost projection is incomplete (${projection.unknown_inputs.length} explicit unknown inputs)`,
    );
  }
}

/**
 * Asynchronously loads and validates a cost profile JSON file from disk.
 *
 * @param {string} [path=defaultInput] - Filesystem path to the cost profile JSON
 * @returns {Promise<object>} Validated cost profile object
 * @throws {Error} If reading or parsing fails
 * @throws {TypeError} If schema validation fails
 */
export async function loadCostProfile(path = defaultInput) {
  return validateCostProfile(JSON.parse(await readFile(resolve(path), "utf8")));
}

const defaultNeonConfig = resolve(import.meta.dirname, "../../infra/neon/endpoint.json");

/**
 * Shape of the checked-in Neon compute configuration: each field is either a
 * measured value of the given kind, or named in `unmeasured` so the gap is
 * explicit rather than defaulted to zero.
 */
const neonFields = {
  "endpoint.autosuspend_delay_seconds": (value) => Number.isSafeInteger(value) && value >= 0,
  "endpoint.max_cu": (value) => nonnegative(value) && value > 0,
  "endpoint.min_cu": nonnegative,
  "recent_month.billed_compute_cu_hours": nonnegative,
  "recent_month.month": (value) =>
    typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value),
  "recent_month.wall_clock_hours": (value) => nonnegative(value) && value > 0,
};

const neonRetrievalFields = [
  "api_base_url",
  "api_key_env",
  "branch_id_env",
  "consumption_command",
  "consumption_fields",
  "endpoint_settings_command",
  "endpoint_settings_fields",
  "project_id_env",
];

/**
 * Validates the schema and operational invariants of the Neon PostgreSQL compute endpoint configuration.
 * Verifies autosuspend delay, CU minimum/maximum bounds, billed compute CU hours, wall clock hours,
 * and ensures that every unmeasured field is explicitly declared in `unmeasured` and set to null.
 *
 * @param {unknown} config - Raw Neon endpoint configuration object
 * @returns {object} Validated Neon endpoint configuration
 * @throws {TypeError} If structure, types, or invariant checks fail
 */
export function validateNeonEndpointConfig(config) {
  if (!record(config)) {
    throw new TypeError("Neon endpoint config must be an object");
  }
  const failures = [];
  if (config.schema_version !== 1) failures.push("schema_version must be 1");
  if (!record(config.endpoint)) failures.push("endpoint must be an object");
  if (!record(config.recent_month)) failures.push("recent_month must be an object");
  if (!record(config.retrieval)) {
    failures.push("retrieval must be an object");
  } else {
    for (const field of neonRetrievalFields) {
      if (typeof config.retrieval[field] !== "string" || !config.retrieval[field]) {
        failures.push(`retrieval.${field} is required`);
      }
    }
  }
  if (!Array.isArray(config.unmeasured)) {
    failures.push("unmeasured must be an array");
  } else {
    const sorted = [...config.unmeasured].sort();
    if (
      config.unmeasured.some((name, index) => name !== sorted[index]) ||
      new Set(config.unmeasured).size !== config.unmeasured.length
    ) {
      failures.push("unmeasured must be sorted and unique");
    }
    for (const name of config.unmeasured) {
      if (!(name in neonFields)) failures.push(`unmeasured names ${name}, which is not a field`);
    }
  }

  const unmeasured = new Set(Array.isArray(config.unmeasured) ? config.unmeasured : []);
  for (const [name, valid] of Object.entries(neonFields)) {
    const [group, field] = name.split(".");
    const value = record(config[group]) ? config[group][field] : undefined;
    if (unmeasured.has(name)) {
      if (value !== null) {
        failures.push(`${name} is listed as unmeasured, so it must be null`);
      }
      continue;
    }
    if (!valid(value)) {
      failures.push(
        `${name} must be a measured value or be listed in unmeasured; read it with retrieval.${
          group === "endpoint" ? "endpoint_settings_command" : "consumption_command"
        } — never infer it`,
      );
    }
  }
  if (
    !unmeasured.has("endpoint.min_cu") &&
    !unmeasured.has("endpoint.max_cu") &&
    config.endpoint.max_cu < config.endpoint.min_cu
  ) {
    failures.push("endpoint.max_cu must not be below endpoint.min_cu");
  }

  if (failures.length > 0) {
    throw new TypeError(`invalid Neon endpoint config:\n${failures.join("\n")}`);
  }
  return config;
}

/**
 * Asynchronously loads and validates the Neon PostgreSQL endpoint configuration JSON file.
 *
 * @param {string} [path=defaultNeonConfig] - Filesystem path to the Neon endpoint configuration JSON
 * @returns {Promise<object>} Validated Neon endpoint configuration object
 * @throws {Error} If reading or parsing fails
 * @throws {TypeError} If configuration validation fails
 */
export async function loadNeonEndpointConfig(path = defaultNeonConfig) {
  return validateNeonEndpointConfig(JSON.parse(await readFile(resolve(path), "utf8")));
}

/**
 * Rejects a Neon configuration that still carries an unmeasured field. Used by
 * `--require-complete`, alongside the projection's own completeness check, so
 * the compute figure that dominates the bill cannot stay inferred once the
 * profile claims to be complete.
 *
 * @param {object} config - Validated Neon configuration object
 * @returns {void}
 * @throws {Error} If any Neon configuration fields are unmeasured
 */
export function assertMeasuredNeonConfig(config) {
  if (config.unmeasured.length > 0) {
    throw new Error(`Neon compute configuration is unmeasured (${config.unmeasured.join(", ")})`);
  }
}

/**
 * Parses command-line arguments for the cost-model tool.
 *
 * @param {Array<string>} argv - CLI argument vector
 * @returns {{ check: boolean, input: string, requireComplete: boolean }} Parsed execution options
 * @throws {TypeError} If an unknown argument is encountered
 */
function argumentsFor(argv) {
  const options = { check: false, input: defaultInput, requireComplete: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--require-complete") options.requireComplete = true;
    else if (argument === "--input" && argv[index + 1]) {
      options.input = resolve(argv[(index += 1)]);
    } else throw new TypeError(`unknown cost-model argument: ${argument}`);
  }
  return options;
}

/**
 * Main execution entrypoint for the cost model CLI.
 * Loads the cost profile and Neon configuration, builds the multi-scenario projection,
 * optionally enforces completeness, and prints formatted results to stdout.
 *
 * @returns {Promise<void>}
 */
async function run() {
  const options = argumentsFor(process.argv.slice(2));
  const projection = buildCostProjection(await loadCostProfile(options.input));
  const neon = await loadNeonEndpointConfig();
  if (options.requireComplete) {
    assertCompleteProjection(projection);
    assertMeasuredNeonConfig(neon);
  }
  if (options.check) {
    process.stdout.write(
      `Cost profile passed (${projection.scenarios.length} scenarios, ${projection.unknown_inputs.length} explicit unknown inputs).\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await run();
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : "cost model failed"}\n`);
    process.exitCode = 1;
  }
}
