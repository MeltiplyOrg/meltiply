import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const billingMonthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

const defaultInput = resolve(import.meta.dirname, "cost-model-inputs.json");
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const roundingModes = new Set(["ceil_billable", "ceil_usage", "continuous"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function collectNullPaths(value, prefix) {
  const paths = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (nested === null) paths.push(path);
    else if (record(nested)) paths.push(...collectNullPaths(nested, path));
  }
  return paths;
}

function actualUnknownInputs(profile) {
  return [
    ...collectNullPaths(profile.usage_1x, "usage_1x"),
    ...collectNullPaths(profile.business_units_1x, "business_units_1x"),
    ...collectNullPaths(profile.observed_metrics_1x, "observed_metrics_1x"),
    ...collectNullPaths(profile.external_costs, "external_costs"),
  ].sort();
}

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
      if (tariff.expires_on !== undefined) {
        if (!datePattern.test(tariff.expires_on))
          failures.push(`${tariff.id}.expires_on must use YYYY-MM-DD`);
        else if (profile.projection_on > tariff.expires_on)
          failures.push(`${tariff.id} price schedule expired on ${tariff.expires_on}`);
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

export function assertCompleteProjection(projection) {
  if (!projection.complete) {
    throw new Error(
      `cost projection is incomplete (${projection.unknown_inputs.length} explicit unknown inputs)`,
    );
  }
}

export async function loadCostProfile(path = defaultInput) {
  return validateCostProfile(JSON.parse(await readFile(resolve(path), "utf8")));
}

const defaultNeonConfig = resolve(import.meta.dirname, "../../infra/neon/endpoint.json");

const neonFields = {
  "endpoint.autosuspend_delay_seconds": (value) => Number.isSafeInteger(value) && value >= 0,
  "endpoint.max_cu": (value) => nonnegative(value) && value > 0,
  "endpoint.min_cu": nonnegative,
  "recent_month.billed_compute_cu_hours": nonnegative,
  "recent_month.month": (value) => typeof value === "string" && billingMonthPattern.test(value),
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

export async function loadNeonEndpointConfig(path = defaultNeonConfig) {
  return validateNeonEndpointConfig(JSON.parse(await readFile(resolve(path), "utf8")));
}

export function assertMeasuredNeonConfig(config) {
  if (config.unmeasured.length > 0) {
    throw new Error(`Neon compute configuration is unmeasured (${config.unmeasured.join(", ")})`);
  }
}

function argumentsFor(argv) {
  const options = {
    check: false,
    input: defaultInput,
    neonConfig: defaultNeonConfig,
    requireComplete: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--require-complete") options.requireComplete = true;
    else if (argument === "--input" && argv[index + 1]) {
      options.input = resolve(argv[(index += 1)]);
    } else if (argument === "--neon-config" && argv[index + 1]) {
      options.neonConfig = resolve(argv[(index += 1)]);
    } else throw new TypeError(`unknown cost-model argument: ${argument}`);
  }
  return options;
}

async function run() {
  const options = argumentsFor(process.argv.slice(2));
  const projection = buildCostProjection(await loadCostProfile(options.input));
  const neon = await loadNeonEndpointConfig(options.neonConfig);
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
