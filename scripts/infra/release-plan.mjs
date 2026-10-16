import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const transitionByPhase = Object.freeze({
  foundation: Object.freeze({
    attachApiCustomDomains: false,
    attachQueueConsumers: false,
    queueDeliveryPaused: true,
  }),
  pause: Object.freeze({
    attachApiCustomDomains: true,
    attachQueueConsumers: true,
    queueDeliveryPaused: true,
  }),
  "paused-consumers": Object.freeze({
    attachApiCustomDomains: false,
    attachQueueConsumers: true,
    queueDeliveryPaused: true,
  }),
  domain: Object.freeze({
    attachApiCustomDomains: true,
    attachQueueConsumers: true,
    queueDeliveryPaused: true,
  }),
  unpause: Object.freeze({
    attachApiCustomDomains: true,
    attachQueueConsumers: true,
    queueDeliveryPaused: false,
  }),
});

const variableNames = Object.freeze({
  attachApiCustomDomains: "attach_api_custom_domains",
  attachQueueConsumers: "attach_queue_consumers",
  queueDeliveryPaused: "queue_delivery_paused",
});

const workloadQueueAddress = /^module\.queues\.cloudflare_queue\.workload\["[^"]+"\]$/;
const workloadConsumerAddress = /^module\.queues\.cloudflare_queue_consumer\.workload\["[^"]+"\]$/;

/**
 * Determines whether a plan change targets a workload Queue resource.
 * Matches `module.queues.cloudflare_queue.workload["<name>"]`.
 *
 * @param {object} change - OpenTofu resource change object
 * @returns {boolean} True if the resource change is a workload queue
 */
function isWorkloadQueue(change) {
  return change.type === "cloudflare_queue" && workloadQueueAddress.test(change.address ?? "");
}

/**
 * Determines whether a plan change targets a workload Queue consumer resource.
 * Matches `module.queues.cloudflare_queue_consumer.workload["<name>"]`.
 *
 * @param {object} change - OpenTofu resource change object
 * @returns {boolean} True if the resource change is a workload consumer
 */
function isWorkloadConsumer(change) {
  return (
    change.type === "cloudflare_queue_consumer" &&
    workloadConsumerAddress.test(change.address ?? "")
  );
}

/**
 * Retrieves the resolved value of a planned variable from an OpenTofu execution plan.
 *
 * @param {object} plan - Parsed OpenTofu JSON execution plan
 * @param {string} name - Variable name
 * @returns {any} Resolved variable value
 * @throws {Error} If the variable is not defined or resolved in the plan
 */
function plannedVariable(plan, name) {
  const variable = plan.variables?.[name];
  if (!variable || !("value" in variable)) {
    throw new Error(`plan is missing the resolved ${name} variable`);
  }
  return variable.value;
}

/**
 * Filters plan resource changes to those containing active modifications,
 * excluding no-op and read-only data source actions.
 *
 * @param {object} plan - Parsed OpenTofu JSON execution plan
 * @returns {Array<object>} Array of actionable resource change objects
 */
function actionableChanges(plan) {
  return (plan.resource_changes ?? []).filter((change) =>
    change.change?.actions?.some((action) => action !== "no-op" && action !== "read"),
  );
}

/**
 * Enforces that an OpenTofu execution plan contains zero destructive deletion actions.
 * Protects persistent infrastructure from accidental teardown during phased releases.
 *
 * @param {object} plan - Parsed OpenTofu JSON execution plan
 * @param {string} phase - Release phase name for error reporting
 * @returns {void}
 * @throws {Error} If any resource change involves a 'delete' action
 */
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

/**
 * Asserts that planned resource changes stay strictly within the reviewed scope for a release phase.
 * Guarantees that:
 * - 'foundation' phase touches no Worker-dependent resources (custom domains or queue consumers).
 * - 'paused-consumers' phase modifies only workload queue consumers.
 * - 'domain' phase modifies only Worker custom domains.
 * - 'pause' and 'unpause' phases touch exactly the 11 workload queues with in-place delivery_paused toggles.
 *
 * @param {object} plan - Parsed OpenTofu JSON execution plan
 * @param {string} phase - Release phase identifier
 * @param {object} expected - Expected phase variable configuration
 * @returns {void}
 * @throws {Error} If changes fall outside the expected phase boundary or violate delivery state invariants
 */
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

/**
 * Validates that an OpenTofu execution plan conforms to the invariants and variable bindings
 * of a specific staging release phase ('foundation', 'paused-consumers', 'domain', 'pause', 'unpause').
 * Enforces staging environment, verifies input flags (custom domains, queue consumers, queue pause state),
 * and confirms that planned resource changes are strictly non-destructive and scoped to the phase.
 *
 * @param {object} plan - Parsed OpenTofu JSON execution plan
 * @param {string} phase - Target release phase identifier
 * @returns {Readonly<object>} Frozen transition specification describing the verified phase state
 * @throws {Error} If phase is unrecognized, environment is not staging, variables mismatch, or resource scope is breached
 */
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
  if (environment !== "staging") {
    throw new Error(`release plan environment must be staging, got ${JSON.stringify(environment)}`);
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

/**
 * Validates an OpenTofu plan and constructs a redacted summary object suitable for artifact emission.
 * Strips sensitive state while retaining phase metadata, OpenTofu version, transition variables,
 * and sorted resource change actions.
 *
 * @param {object} plan - Parsed OpenTofu JSON execution plan
 * @param {string} phase - Target release phase identifier
 * @returns {{ phase: string, resourceChanges: Array<object>, schemaVersion: number, terraformVersion: string | null, transition: object }} Redacted plan summary
 */
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

/**
 * CLI execution entrypoint for validating and summarizing OpenTofu release plans.
 * Reads the plan JSON, verifies it against the specified phase, and atomically writes
 * the redacted summary JSON with restricted permissions (0o600).
 *
 * @returns {Promise<void>}
 * @throws {Error} If CLI arguments are invalid or plan verification fails
 */
async function main() {
  const [phase, planPath, summaryPath, ...extra] = process.argv.slice(2);
  if (!phase || !planPath || !summaryPath || extra.length > 0) {
    throw new Error(
      "usage: node scripts/infra/release-plan.mjs <phase> <plan.json> <summary.json>",
    );
  }

  const plan = JSON.parse(await readFile(resolve(planPath), "utf8"));
  const summary = summarizeReleasePlan(plan, phase);
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
