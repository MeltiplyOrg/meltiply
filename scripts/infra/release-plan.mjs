import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { releaseEnvironments } from "../lib/release-environments.mjs";
import { validateReleaseSpec } from "../release/release-lib.mjs";

const transitionByPhase = Object.freeze({
  foundation: Object.freeze({
    attachAppCustomDomains: false,
    attachQueueConsumers: false,
    queueDeliveryPaused: true,
  }),
  pause: Object.freeze({
    attachAppCustomDomains: true,
    attachQueueConsumers: true,
    queueDeliveryPaused: true,
  }),
  "paused-consumers": Object.freeze({
    attachAppCustomDomains: false,
    attachQueueConsumers: true,
    queueDeliveryPaused: true,
  }),
  domain: Object.freeze({
    attachAppCustomDomains: true,
    attachQueueConsumers: true,
    queueDeliveryPaused: true,
  }),
  unpause: Object.freeze({
    attachAppCustomDomains: true,
    attachQueueConsumers: true,
    queueDeliveryPaused: false,
  }),
});

const variableNames = Object.freeze({
  attachAppCustomDomains: "attach_app_custom_domains",
  attachQueueConsumers: "attach_queue_consumers",
  queueDeliveryPaused: "queue_delivery_paused",
});

const workloadQueueAddress = /^module\.queues\.cloudflare_queue\.workload\["[^"]+"\]$/;
const workloadConsumerAddress = /^module\.queues\.cloudflare_queue_consumer\.workload\["[^"]+"\]$/;

function isWorkloadQueue(change) {
  return change.type === "cloudflare_queue" && workloadQueueAddress.test(change.address ?? "");
}

function isWorkloadConsumer(change) {
  return (
    change.type === "cloudflare_queue_consumer" &&
    workloadConsumerAddress.test(change.address ?? "")
  );
}

function plannedVariable(plan, name) {
  const variable = plan.variables?.[name];
  if (!variable || !("value" in variable)) {
    throw new Error(`plan is missing the resolved ${name} variable`);
  }
  return variable.value;
}

function actionableChanges(plan) {
  return (plan.resource_changes ?? []).filter((change) =>
    change.change?.actions?.some((action) => action !== "no-op" && action !== "read"),
  );
}

function assertNoDestructiveChanges(plan, phase) {
  const destructive = (plan.resource_changes ?? []).filter((change) =>
    change.change?.actions?.includes("delete"),
  );
  if (destructive.length > 0) {
    throw new Error(
      `${phase} plan contains destructive changes: ${destructive
        .map(({ address }) => address)
        .sort()
        .join(", ")}`,
    );
  }
}

function assertPhaseResourceScope(plan, phase, expected) {
  const changes = actionableChanges(plan);

  for (const change of changes) {
    if (change.type !== "cloudflare_queue") continue;
    const paused = change.change?.after?.settings?.delivery_paused;
    if (paused !== undefined && paused !== expected.queueDeliveryPaused) {
      throw new Error(`${change.address} plans delivery_paused=${String(paused)} during ${phase}`);
    }
  }

  if (phase === "foundation") {
    const unsafeReference = changes.find(
      (change) => change.type === "cloudflare_workers_custom_domain" || isWorkloadConsumer(change),
    );
    if (unsafeReference) {
      throw new Error(
        `foundation plan references a Worker-dependent resource: ${unsafeReference.address}`,
      );
    }
  }

  if (phase === "paused-consumers") {
    const outOfScope = changes.find((change) => !isWorkloadConsumer(change));
    if (outOfScope) {
      throw new Error(
        `paused-consumers plan contains a non-consumer transition: ${outOfScope.address}`,
      );
    }
  }

  if (phase === "domain") {
    const outOfScope = changes.find((change) => change.type !== "cloudflare_workers_custom_domain");
    if (outOfScope) {
      throw new Error(`domain plan contains a non-domain transition: ${outOfScope.address}`);
    }
  }

  if (phase === "pause" || phase === "unpause") {
    const outOfScope = changes.find((change) => !isWorkloadQueue(change));
    if (outOfScope) {
      throw new Error(`${phase} plan contains a non-Queue transition: ${outOfScope.address}`);
    }

    if (changes.length !== 11) {
      throw new Error(
        `${phase} plan must update exactly 11 workload Queues, got ${changes.length}`,
      );
    }
    for (const change of changes) {
      if (change.change.actions.length !== 1 || change.change.actions[0] !== "update") {
        throw new Error(`${change.address} must be an in-place Queue update`);
      }
      const before = structuredClone(change.change.before ?? {});
      const after = structuredClone(change.change.after ?? {});
      if (before.settings?.delivery_paused !== !expected.queueDeliveryPaused) {
        throw new Error(`${change.address} does not start from the opposite delivery state`);
      }
      delete before.settings.delivery_paused;
      delete after.settings.delivery_paused;
      if (!isDeepStrictEqual(before, after)) {
        throw new Error(`${change.address} changes more than delivery_paused during ${phase}`);
      }
    }
  }
}

export function verifyReleasePlan(plan, phase) {
  const expected = transitionByPhase[phase];
  if (!expected) {
    throw new Error(
      `unknown release phase ${JSON.stringify(phase)}; expected ${Object.keys(
        transitionByPhase,
      ).join(", ")}`,
    );
  }

  const environment = plannedVariable(plan, "environment");
  if (!releaseEnvironments.includes(environment)) {
    throw new Error(
      `release plan environment must be one of ${releaseEnvironments.join(", ")}, got ${JSON.stringify(environment)}`,
    );
  }

  const transition = { environment };
  for (const [summaryName, variableName] of Object.entries(variableNames)) {
    const actual = plannedVariable(plan, variableName);
    if (actual !== expected[summaryName]) {
      throw new Error(
        `${phase} requires ${variableName}=${String(expected[summaryName])}, got ${String(actual)}`,
      );
    }
    transition[summaryName] = actual;
  }

  assertNoDestructiveChanges(plan, phase);
  assertPhaseResourceScope(plan, phase, expected);

  return Object.freeze(transition);
}

export function summarizeReleasePlan(plan, phase) {
  const transition = verifyReleasePlan(plan, phase);
  const resourceChanges = (plan.resource_changes ?? [])
    .map((change) => ({
      actions: [...(change.change?.actions ?? [])],
      address: change.address,
      type: change.type,
    }))
    .sort((left, right) => left.address.localeCompare(right.address));

  return {
    schemaVersion: 1,
    phase,
    terraformVersion: plan.terraform_version ?? null,
    transition,
    resourceChanges,
  };
}

async function main() {
  const [phase, planPath, summaryPath, inputPath, ...extra] = process.argv.slice(2);
  if (!phase || !planPath || !summaryPath || !inputPath || extra.length > 0) {
    throw new Error(
      "usage: node scripts/infra/release-plan.mjs <phase> <plan.json> <summary.json> <release-input.json>",
    );
  }

  const plan = JSON.parse(await readFile(resolve(planPath), "utf8"));
  const summary = summarizeReleasePlan(plan, phase);
  const spec = validateReleaseSpec(JSON.parse(await readFile(resolve(inputPath), "utf8")));
  if (summary.transition.environment !== spec.environment) {
    throw new Error("release plan environment does not match the release input");
  }
  const outputPath = resolve(summaryPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`Verified ${phase} release plan transition.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
