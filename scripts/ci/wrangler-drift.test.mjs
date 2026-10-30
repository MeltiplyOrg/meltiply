// Wrangler ↔ Terraform ↔ environment drift gate (AUD-050).
//
// Single source of truth assertions:
//   1. Terraform queue consumers attach the Worker name declared in wrangler;
//   2. every `env.X` / `process.env.X` binding referenced in worker source is
//      declared in that worker's wrangler.jsonc or in .env.example;
//   3. the only `replace-with-*` strings in checked-in configs are the
//      documented release-substituted placeholders.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJsonc } from "../lib/jsonc.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const workerNames = ["api", "automation", "state"];

function read(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function workerConfigs() {
  return workerNames.map((name) => ({
    name,
    config: parseJsonc(read(`workers/${name}/wrangler.jsonc`)),
  }));
}

function tfvarsValue(name) {
  const source = read("infra/cloudflare/staging.tfvars.example");
  const match = source.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, "m"));
  assert.ok(match, `staging.tfvars.example must declare ${name} for the drift gate`);
  return match[1];
}

function collectSourceFiles(root, files = []) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      collectSourceFiles(path, files);
    } else if (entry.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

test("Terraform Queue consumers attach the Worker declared in wrangler", () => {
  const automationWorkerName = tfvarsValue("automation_worker_name");
  const automation = workerConfigs().find((w) => w.name === "automation").config;
  assert.equal(
    automation.name,
    automationWorkerName,
    "automation wrangler name must match Terraform automation_worker_name",
  );
  const queuesSource = read("infra/cloudflare/modules/queues/main.tf");
  assert.match(
    queuesSource,
    /resource\s+"cloudflare_queue_consumer"\s+"workload"[\s\S]*?script_name\s*=\s*var\.automation_worker_name/,
    "Terraform Queue consumers must attach var.automation_worker_name",
  );
});

// Binding discovery covers native mail declarations as well as storage and
// service bindings; undeclared source references still fail the drift gate.
test("worker bindings referenced in code are declared in wrangler or .env.example", () => {
  const envNames = new Set(
    read(".env.example")
      .split("\n")
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)\s*=/)?.[1])
      .filter(Boolean),
  );
  assert.ok(envNames.size > 0, ".env.example must declare variable names");

  for (const { name, config } of workerConfigs()) {
    const declared = new Set([
      ...Object.keys(config.vars ?? {}),
      ...(config.hyperdrive ?? []).map((binding) => binding.binding),
      ...(config.r2_buckets ?? []).map((binding) => binding.binding),
      ...(config.queues?.producers ?? []).map((binding) => binding.binding),
      ...(config.workflows ?? []).map((binding) => binding.binding),
      ...(config.durable_objects?.bindings ?? []).map((binding) => binding.name),
      ...(config.services ?? []).map((binding) => binding.binding),
      ...(config.send_email ?? []).map((binding) => binding.name),
    ]);
    const sourceRoot = join(repositoryRoot, `workers/${name}/src`);
    for (const file of collectSourceFiles(sourceRoot)) {
      const source = read(relative(repositoryRoot, file));
      for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
        const binding = match[1];
        assert.ok(
          declared.has(binding) || envNames.has(binding),
          `${name}: env.${binding} referenced in ${relative(repositoryRoot, file)} is not declared in wrangler.jsonc or .env.example`,
        );
      }
      for (const match of source.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g)) {
        const binding = match[1];
        assert.ok(
          declared.has(binding) || envNames.has(binding),
          `${name}: process.env.${binding} referenced in ${relative(repositoryRoot, file)} is not declared in wrangler.jsonc or .env.example`,
        );
      }
    }
  }
});

// Mail sender placeholders are intentionally release-rendered into both the
// sender variable and binding restriction; all undocumented placeholders fail.
test("only documented replace-with placeholders remain in checked-in configs", () => {
  const documented = [
    "system-hyperdrive-id",
    "authenticated-hyperdrive-id",
    "operator-access-aud",
    "team.cloudflareaccess.com",
    "mail-from-address",
  ];
  for (const name of workerNames) {
    const source = read(`workers/${name}/wrangler.jsonc`);
    for (const match of source.matchAll(/replace-with-([a-z0-9.-]+)/g)) {
      assert.ok(
        documented.includes(match[1]),
        `${name}: unexpected placeholder replace-with-${match[1]} — placeholders are release-substituted and must stay on the documented list`,
      );
    }
  }
});

const providerLiveAcceptanceVars = [
  "FACEBOOK_LIVE_ACCEPTED",
  "INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED",
  "INSTAGRAM_LIVE_ACCEPTED",
  "TIKTOK_LIVE_ACCEPTED",
  "THREADS_ENGAGEMENT_LIVE_ACCEPTED",
  "THREADS_LIVE_ACCEPTED",
  "YOUTUBE_LIVE_ACCEPTED",
];

const providerCredentialVars = [
  "FACEBOOK_CLIENT_ID",
  "FACEBOOK_CLIENT_SECRET",
  "INSTAGRAM_CLIENT_ID",
  "INSTAGRAM_CLIENT_SECRET",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "THREADS_CLIENT_ID",
  "THREADS_CLIENT_SECRET",
  "YOUTUBE_SHORTS_CLIENT_ID",
  "YOUTUBE_SHORTS_CLIENT_SECRET",
];

test("checked-in provider configuration stays credential-free and fail-closed", () => {
  const envValues = Object.fromEntries(
    read(".env.example")
      .split("\n")
      .flatMap((line) => {
        const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
        return match ? [[match[1], match[2]]] : [];
      }),
  );
  const configs = [
    { name: ".env.example", vars: envValues },
    ...workerConfigs()
      .filter(({ name }) => name === "api" || name === "automation")
      .map(({ name, config }) => ({
        name: `workers/${name}/wrangler.jsonc`,
        vars: config.vars ?? {},
      })),
  ];

  for (const { name, vars } of configs) {
    for (const variable of providerLiveAcceptanceVars) {
      assert.equal(
        vars[variable],
        "false",
        `${name}: ${variable} must remain explicitly false without protected provider acceptance`,
      );
    }
  }
  for (const variable of providerCredentialVars) {
    assert.equal(
      envValues[variable],
      "",
      `.env.example: ${variable} must not contain a credential`,
    );
  }
});
