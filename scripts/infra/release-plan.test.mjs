import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeReleasePlan, verifyReleasePlan } from "./release-plan.mjs";

function planFor(
  { attachApiCustomDomains = false, attachQueueConsumers = false, queueDeliveryPaused = true } = {},
  resourceChanges = [],
) {
  return {
    terraform_version: "1.10.2",
    variables: {
      environment: { value: "staging" },
      attach_api_custom_domains: { value: attachApiCustomDomains },
      attach_queue_consumers: { value: attachQueueConsumers },
      queue_delivery_paused: { value: queueDeliveryPaused },
    },
    resource_changes: resourceChanges,
  };
}

function change(address, type, actions, after = {}) {
  return { address, type, change: { actions, after } };
}

function deliveryChanges(paused) {
  return Array.from({ length: 11 }, (_, index) => ({
    address: `module.queues.cloudflare_queue.workload["workload-${index}"]`,
    type: "cloudflare_queue",
    change: {
      actions: ["update"],
      before: {
        queue_name: `queue-${index}`,
        settings: {
          delivery_paused: !paused,
          message_retention_period: 1_209_600,
        },
      },
      after: {
        queue_name: `queue-${index}`,
        settings: {
          delivery_paused: paused,
          message_retention_period: 1_209_600,
        },
      },
    },
  }));
}

test("accepts the bootstrap and update release transition invariants", () => {
  assert.deepEqual(verifyReleasePlan(planFor(), "foundation"), {
    environment: "staging",
    attachApiCustomDomains: false,
    attachQueueConsumers: false,
    queueDeliveryPaused: true,
  });
  assert.deepEqual(
    verifyReleasePlan(
      planFor(
        {
          attachApiCustomDomains: true,
          attachQueueConsumers: true,
        },
        deliveryChanges(true),
      ),
      "pause",
    ),
    {
      environment: "staging",
      attachApiCustomDomains: true,
      attachQueueConsumers: true,
      queueDeliveryPaused: true,
    },
  );
  assert.deepEqual(verifyReleasePlan(planFor({ attachQueueConsumers: true }), "paused-consumers"), {
    environment: "staging",
    attachApiCustomDomains: false,
    attachQueueConsumers: true,
    queueDeliveryPaused: true,
  });
  assert.deepEqual(
    verifyReleasePlan(
      planFor({
        attachApiCustomDomains: true,
        attachQueueConsumers: true,
      }),
      "domain",
    ),
    {
      environment: "staging",
      attachApiCustomDomains: true,
      attachQueueConsumers: true,
      queueDeliveryPaused: true,
    },
  );
  assert.deepEqual(
    verifyReleasePlan(
      planFor(
        {
          attachApiCustomDomains: true,
          attachQueueConsumers: true,
          queueDeliveryPaused: false,
        },
        deliveryChanges(false),
      ),
      "unpause",
    ),
    {
      environment: "staging",
      attachApiCustomDomains: true,
      attachQueueConsumers: true,
      queueDeliveryPaused: false,
    },
  );
});

test("rejects a transition whose resolved plan variables do not match", () => {
  assert.throws(
    () => verifyReleasePlan(planFor(), "paused-consumers"),
    /requires attach_queue_consumers=true, got false/,
  );
  assert.throws(
    () =>
      verifyReleasePlan(
        planFor({
          attachApiCustomDomains: true,
          attachQueueConsumers: true,
        }),
        "unpause",
      ),
    /requires queue_delivery_paused=false, got true/,
  );
});

test("rejects destructive, early Worker references, and broad unpause plans", () => {
  assert.throws(
    () =>
      verifyReleasePlan(
        planFor({}, [
          change("module.storage.cloudflare_r2_bucket.assets", "cloudflare_r2_bucket", ["delete"]),
        ]),
        "foundation",
      ),
    /contains destructive changes/,
  );
  assert.throws(
    () =>
      verifyReleasePlan(
        planFor({}, [
          change(
            'module.queues.cloudflare_queue_consumer.workload["distribution"]',
            "cloudflare_queue_consumer",
            ["create"],
          ),
        ]),
        "foundation",
      ),
    /references a Worker-dependent resource/,
  );
  assert.throws(
    () =>
      verifyReleasePlan(
        planFor(
          {
            attachApiCustomDomains: true,
            attachQueueConsumers: true,
            queueDeliveryPaused: false,
          },
          [
            change(
              "module.edge.cloudflare_workers_custom_domain.api[0]",
              "cloudflare_workers_custom_domain",
              ["update"],
            ),
          ],
        ),
        "unpause",
      ),
    /contains a non-Queue transition/,
  );
});

test("narrow phases reject unrelated non-destructive drift", () => {
  const storageUpdate = change(
    "module.storage.cloudflare_r2_bucket.assets",
    "cloudflare_r2_bucket",
    ["update"],
  );
  assert.throws(
    () =>
      verifyReleasePlan(
        planFor({ attachQueueConsumers: true }, [storageUpdate]),
        "paused-consumers",
      ),
    /contains a non-consumer transition/,
  );
  assert.throws(
    () =>
      verifyReleasePlan(
        planFor(
          {
            attachApiCustomDomains: true,
            attachQueueConsumers: true,
          },
          [storageUpdate],
        ),
        "domain",
      ),
    /contains a non-domain transition/,
  );
  assert.throws(
    () =>
      verifyReleasePlan(
        planFor(
          {
            attachApiCustomDomains: true,
            attachQueueConsumers: true,
            queueDeliveryPaused: false,
          },
          [storageUpdate],
        ),
        "unpause",
      ),
    /contains a non-Queue transition/,
  );
  assert.throws(
    () =>
      verifyReleasePlan(
        planFor(
          {
            attachApiCustomDomains: true,
            attachQueueConsumers: true,
          },
          [storageUpdate],
        ),
        "pause",
      ),
    /pause plan contains a non-Queue transition/,
  );
});

test("unpause ignores unrelated no-op resources", () => {
  const plan = planFor(
    {
      attachApiCustomDomains: true,
      attachQueueConsumers: true,
      queueDeliveryPaused: false,
    },
    [
      change("module.storage.cloudflare_r2_bucket.assets", "cloudflare_r2_bucket", ["no-op"]),
      change(
        "module.edge.cloudflare_workers_custom_domain.api[0]",
        "cloudflare_workers_custom_domain",
        ["no-op"],
      ),
      ...deliveryChanges(false),
    ],
  );

  assert.equal(verifyReleasePlan(plan, "unpause").queueDeliveryPaused, false);
});

test("pause and unpause require exactly the delivery flag on all workloads", () => {
  const pauseVariables = {
    attachApiCustomDomains: true,
    attachQueueConsumers: true,
  };
  assert.throws(
    () => verifyReleasePlan(planFor(pauseVariables, deliveryChanges(true).slice(0, 9)), "pause"),
    /must update exactly 11 workload Queues, got 9/,
  );

  const broadChanges = deliveryChanges(true);
  broadChanges[0].change.after.settings.message_retention_period = 600;
  assert.throws(
    () => verifyReleasePlan(planFor(pauseVariables, broadChanges), "pause"),
    /changes more than delivery_paused/,
  );

  const misleadingAddresses = deliveryChanges(true).map((queueChange) => ({
    ...queueChange,
    address: queueChange.address.replace(
      "cloudflare_queue.workload",
      "cloudflare_queue.unrelated_workload",
    ),
  }));
  assert.throws(
    () => verifyReleasePlan(planFor(pauseVariables, misleadingAddresses), "pause"),
    /contains a non-Queue transition/,
  );
});

test("rejects Queue resource state that contradicts the phase", () => {
  assert.throws(
    () =>
      verifyReleasePlan(
        planFor({ attachQueueConsumers: true }, [
          change(
            'module.queues.cloudflare_queue.workload["distribution"]',
            "cloudflare_queue",
            ["update"],
            { settings: { delivery_paused: false } },
          ),
        ]),
        "paused-consumers",
      ),
    /plans delivery_paused=false/,
  );
});

test("summary exposes only reviewable metadata and transition values", () => {
  const plan = planFor({ attachQueueConsumers: true }, [
    change(
      'module.queues.cloudflare_queue_consumer.workload["distribution"]',
      "cloudflare_queue_consumer",
      ["create"],
      { secret: "must-not-leak" },
    ),
  ]);

  const summary = summarizeReleasePlan(plan, "paused-consumers");
  assert.deepEqual(summary.transition, {
    environment: "staging",
    attachApiCustomDomains: false,
    attachQueueConsumers: true,
    queueDeliveryPaused: true,
  });
  assert.deepEqual(summary.resourceChanges, [
    {
      actions: ["create"],
      address: 'module.queues.cloudflare_queue_consumer.workload["distribution"]',
      type: "cloudflare_queue_consumer",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /must-not-leak|secret/);
});
