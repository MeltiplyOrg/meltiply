import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCompleteProjection,
  assertMeasuredNeonConfig,
  buildCostProjection,
  loadCostProfile,
  loadNeonEndpointConfig,
  validateCostProfile,
  validateNeonEndpointConfig,
} from "./cost-model.mjs";

function replaceNulls(value) {
  for (const [key, nested] of Object.entries(value)) {
    if (nested === null) value[key] = 0;
    else if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      replaceNulls(nested);
    }
  }
}

test("checked-in cost profile reports Neon compute as an explicit unknown", async () => {
  const projection = buildCostProjection(await loadCostProfile());

  assert.equal(projection.complete, false);
  assert.deepEqual(projection.unknown_inputs, ["usage_1x.neon_compute_cu_hours"]);
  assert.deepEqual(projection.non_billable_services, ["cloudflare.hyperdrive.paid_plan"]);
  assert.deepEqual(
    projection.scenarios.map(({ known_monthly_usd, projection_kind }) => ({
      known_monthly_usd,
      projection_kind,
    })),
    [
      { known_monthly_usd: 5, projection_kind: "known_lower_bound" },
      { known_monthly_usd: 5, projection_kind: "known_lower_bound" },
      { known_monthly_usd: 5, projection_kind: "known_lower_bound" },
    ],
  );
  assert.throws(() => assertCompleteProjection(projection), /cost projection is incomplete/u);
});

test("projects shared allowances, scaled usage, and provider rounding", async () => {
  const profile = structuredClone(await loadCostProfile());
  replaceNulls(profile.usage_1x);
  replaceNulls(profile.business_units_1x);
  replaceNulls(profile.observed_metrics_1x);
  replaceNulls(profile.external_costs);
  profile.expected_unknown_inputs = [];
  Object.assign(profile.usage_1x, {
    workers_and_workflows_requests: 11_000_000,
    workers_and_workflows_cpu_ms: 31_000_000,
    workers_log_events: 21_000_000,
    queue_operations: 2_000_000,
    workflow_steps: 600_000,
    workflow_storage_gb_month: 2,
    r2_standard_storage_gb_month: 10.1,
    neon_compute_cu_hours: 100,
  });
  Object.assign(profile.business_units_1x, {
    active_organizations: 10,
    api_requests: 11_000_000,
    assets_processed: 1_000,
    distribution_attempts: 2_000,
    successful_publishes: 1_800,
    sync_runs: 3_000,
    uploaded_gb: 10.1,
  });

  const projection = buildCostProjection(profile);
  assert.equal(projection.complete, true);
  assert.deepEqual(projection.unknown_inputs, []);
  assert.equal(projection.scenarios[0].known_monthly_usd, 17.935);
  assert.equal(projection.scenarios[1].known_monthly_usd, 84.475);
  assert.equal(projection.scenarios[0].components["r2.storage"], 0.015);
  assert.ok(projection.scenarios[2].known_monthly_usd > projection.scenarios[1].known_monthly_usd);
  assert.doesNotThrow(() => assertCompleteProjection(projection));
});

test("rounds Durable Objects compute overage after its included allowance", async () => {
  const profile = structuredClone(await loadCostProfile());
  Object.assign(profile.usage_1x, {
    durable_object_requests: 1_000_001,
    durable_object_duration_gb_seconds: 400_001,
  });

  const projection = buildCostProjection(profile);
  const firstScenario = projection.scenarios[0];

  assert.equal(firstScenario.components["durable_objects.requests"], 0.15);
  assert.equal(firstScenario.components["durable_objects.duration"], 12.5);
  assert.equal(firstScenario.known_monthly_usd, 17.65);
});

test("rejects silent unknown drift and invalid tariff values", async () => {
  const profile = structuredClone(await loadCostProfile());
  profile.usage_1x.queue_operations = -1;
  profile.expected_unknown_inputs = profile.expected_unknown_inputs.filter(
    (path) => path !== "usage_1x.queue_operations",
  );

  assert.throws(
    () => validateCostProfile(profile),
    /queue_operations must be null or a non-negative number/u,
  );

  const drifted = structuredClone(await loadCostProfile());
  drifted.usage_1x.queue_operations = null;
  assert.throws(() => validateCostProfile(drifted), /expected unknown inputs differ/u);

  const malformed = structuredClone(await loadCostProfile());
  delete malformed.business_units_1x.api_requests;
  delete malformed.external_costs.billing_provider.fixed_usd;
  assert.throws(
    () => validateCostProfile(malformed),
    /business_units_1x\.api_requests is required[\s\S]*external_costs\.billing_provider needs fixed_usd/u,
  );
});

function measuredNeonConfig() {
  return {
    schema_version: 1,
    endpoint: {
      min_cu: 0.25,
      max_cu: 0.25,
      autosuspend_delay_seconds: 300,
    },
    recent_month: {
      month: "2026-07",
      wall_clock_hours: 744,
      billed_compute_cu_hours: 186,
    },
    unmeasured: [],
    retrieval: {
      api_base_url: "https://console.neon.tech/api/v2",
      api_key_env: "NEON_API_KEY",
      branch_id_env: "MELTIPLY_NEON_BRANCH_ID",
      consumption_command: "curl -s https://console.neon.tech/api/v2",
      consumption_fields: "periods[].consumption[].compute_unit_seconds",
      endpoint_settings_command: "curl -s https://console.neon.tech/api/v2",
      endpoint_settings_fields: "endpoints[].suspend_timeout_seconds",
      project_id_env: "MELTIPLY_NEON_PROJECT_ID",
    },
  };
}

test("checked-in Neon configuration names every unmeasured field", async () => {
  const config = await loadNeonEndpointConfig();

  // The dashboard values and the billed month are not yet readable from here,
  // so they are declared unmeasured rather than defaulted to a number.
  assert.deepEqual(config.unmeasured, [
    "endpoint.autosuspend_delay_seconds",
    "endpoint.max_cu",
    "endpoint.min_cu",
    "recent_month.billed_compute_cu_hours",
    "recent_month.month",
    "recent_month.wall_clock_hours",
  ]);
  assert.throws(
    () => assertMeasuredNeonConfig(config),
    /Neon compute configuration is unmeasured/u,
  );
});

test("Neon configuration must be measured or explicitly unmeasured, never inferred", () => {
  const measured = measuredNeonConfig();
  assert.doesNotThrow(() => validateNeonEndpointConfig(measured));
  assert.doesNotThrow(() => assertMeasuredNeonConfig(measured));

  const scaleToZeroFloor = measuredNeonConfig();
  scaleToZeroFloor.endpoint.min_cu = 0;
  assert.doesNotThrow(() => validateNeonEndpointConfig(scaleToZeroFloor));

  const inverted = measuredNeonConfig();
  inverted.endpoint.max_cu = 0.125;
  assert.throws(
    () => validateNeonEndpointConfig(inverted),
    /endpoint\.max_cu must not be below endpoint\.min_cu/u,
  );

  const silentlyNull = measuredNeonConfig();
  silentlyNull.endpoint.min_cu = null;
  silentlyNull.recent_month.billed_compute_cu_hours = null;
  assert.throws(
    () => validateNeonEndpointConfig(silentlyNull),
    /endpoint\.min_cu must be a measured value[\s\S]*recent_month\.billed_compute_cu_hours must be a measured value/u,
  );

  const contradictory = measuredNeonConfig();
  contradictory.unmeasured = ["endpoint.min_cu"];
  assert.throws(
    () => validateNeonEndpointConfig(contradictory),
    /endpoint\.min_cu is listed as unmeasured, so it must be null/u,
  );

  const unknownField = measuredNeonConfig();
  unknownField.unmeasured = ["endpoint.region"];
  assert.throws(
    () => validateNeonEndpointConfig(unknownField),
    /unmeasured names endpoint\.region, which is not a field/u,
  );
});
