import type { EffectTransactionClient } from "@meltiply/database";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import { createPublishQueueResolverLive, createQueuePublisherLive } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import { AutomationEntrypoint } from "../src/index";
import type { OutboxMessage } from "../src/messages";
import { relayOutbox, type OutboxRelayResult } from "../src/outbox";
import { publishingQueueFor } from "../src/publish-queues";

const organizationId = "00000000-0000-4000-8000-000000000001";
const aggregateId = "00000000-0000-4000-8000-000000000002";

function eventId(number: number): string {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

interface TestOutboxRow {
  aggregate_id: string;
  attempt_count: number;
  id: string;
  next_attempt_at?: Date | null;
  org_id: string;
  payload: { request_id: string };
  platform: "facebook" | null;
  scheduled_at?: Date | null;
  topic: string;
}

function row(
  id: string,
  topic = "asset.processing.requested",
  overrides: Partial<TestOutboxRow> = {},
): TestOutboxRow {
  return {
    aggregate_id: aggregateId,
    attempt_count: 1,
    id,
    org_id: organizationId,
    payload: { request_id: "request-outbox-test" },
    platform: null,
    topic,
    ...overrides,
  };
}

function scheduledPublishRow(scheduledAt: Date, idNumber = 1): TestOutboxRow {
  return row(eventId(idNumber), "distribution.publish.requested", {
    platform: "facebook",
    scheduled_at: scheduledAt,
  });
}

function publishQueueEnv(queue: Queue<unknown>): AutomationEnv {
  return {
    FACEBOOK_PUBLISH_QUEUE: queue,
    ENVIRONMENT: "test",
    VERSION: "test",
  };
}

/**
 * Runs the outbox relay Effect at the test boundary with production wiring:
 * the live QueuePublisher drives the recorded fake bindings, and the live
 * PublishQueueResolver maps platforms through publishingQueueFor against the
 * test env, so distribution rows still exercise real binding lookup.
 */
function runRelay(env: AutomationEnv, batchSize?: number): Promise<OutboxRelayResult> {
  return Effect.runPromise(
    Effect.provide(
      relayOutbox(env, batchSize),
      Layer.mergeAll(
        createQueuePublisherLive(),
        createPublishQueueResolverLive((platform) => publishingQueueFor(env, platform)),
      ),
    ),
  );
}

type SentBatch = MessageSendRequest<OutboxMessage>[];

function recordedQueue() {
  const batches: SentBatch[] = [];
  const sendBatch = vi.fn(async (messages: Iterable<MessageSendRequest<OutboxMessage>>) => {
    batches.push([...messages]);
    return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
  });
  return {
    batches,
    queue: { sendBatch } as unknown as Queue<unknown>,
    sendBatch,
  };
}

function eventOf(message: MessageSendRequest<OutboxMessage>): string {
  return message.body.event_id;
}

function delayOf(messages: SentBatch, id: string): number | undefined {
  return messages.find((message) => eventOf(message) === id)?.delaySeconds;
}

function setupClaim(rows: TestOutboxRow[], updatedRows: { state: string }[] = []) {
  const query = vi
    .fn()
    .mockReturnValueOnce(Effect.succeed({ rows }))
    .mockReturnValueOnce(Effect.succeed({ rows: updatedRows }))
    .mockReturnValue(Effect.succeed({ rows: [] }));
  withSystemTransactionEffect.mockImplementation(
    (_env: AutomationEnv, operation: (client: EffectTransactionClient) => Effect.Effect<unknown>) =>
      operation({ query }),
  );
  return query;
}

function baseEnv(queue: Queue<unknown>): AutomationEnv {
  return {
    ASSET_PROCESSING_QUEUE: queue,
    ENVIRONMENT: "test",
    VERSION: "test",
  };
}

describe("outbox relay publication", () => {
  it("publishes all messages for a binding with one sendBatch call", async () => {
    const sendBatch = vi.fn(async (_messages: Iterable<MessageSendRequest<unknown>>) => ({
      metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
    }));
    const send = vi.fn();
    const query = setupClaim([row(eventId(1)), row(eventId(2))]);

    await expect(
      runRelay(baseEnv({ send, sendBatch } as unknown as Queue<unknown>), 2),
    ).resolves.toEqual({ claimed: 2, dead: 0, failed: 0, published: 2 });

    expect(sendBatch).toHaveBeenCalledTimes(1);
    // QueuePublisher owns the wire payload shape; the binding applies its
    // default JSON content type.
    expect(sendBatch.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ event_id: eventId(1) }),
      }),
      expect.objectContaining({
        body: expect.objectContaining({ event_id: eventId(2) }),
      }),
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual([[eventId(1), eventId(2)]]);
  });

  it("marks every message failed when a batch send is rejected", async () => {
    const sendBatch = vi
      .fn()
      .mockRejectedValue(new Error("queue unavailable at https://secret.test"));
    const query = setupClaim([row(eventId(5)), row(eventId(6))]);

    await expect(runRelay(baseEnv({ sendBatch } as unknown as Queue<unknown>), 2)).resolves.toEqual(
      { claimed: 2, dead: 0, failed: 2, published: 0 },
    );

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual([
      [eventId(5), eventId(6)],
      [30, 30],
      ["queue unavailable at [REDACTED_URL]", "queue unavailable at [REDACTED_URL]"],
      10,
    ]);
  });
  it("moves an exhausted failure to dead and never claims it again", async () => {
    const exhausted = row(eventId(7));
    exhausted.attempt_count = 10;
    const query = setupClaim([exhausted], [{ state: "dead" }]);
    const sendBatch = vi.fn().mockRejectedValue(new Error("queue unavailable"));

    await expect(runRelay(baseEnv({ sendBatch } as unknown as Queue<unknown>))).resolves.toEqual({
      claimed: 1,
      dead: 1,
      failed: 1,
      published: 0,
    });
    await expect(runRelay(baseEnv({ sendBatch } as unknown as Queue<unknown>))).resolves.toEqual({
      claimed: 0,
      dead: 0,
      failed: 0,
      published: 0,
    });
    expect(query.mock.calls[0]?.[0]).toContain("event.attempt_count < $2");
    expect(query.mock.calls[2]?.[0]).toContain("event.attempt_count < $2");

    expect(query.mock.calls[1]?.[0]).toContain("state = CASE");
    expect(query.mock.calls[1]?.[1]).toEqual([
      [eventId(7)],
      [Math.min(3_600, 2 ** 10 * 15)],
      ["queue unavailable"],
      10,
    ]);
  });
});

describe("outbox relay delayed delivery", () => {
  it("sends each scheduled publish with its own durable delay", async () => {
    const now = Date.now();
    const query = setupClaim([
      scheduledPublishRow(new Date(now + 600_000), 1),
      scheduledPublishRow(new Date(now + 86_400_000), 2),
      row(eventId(3), "distribution.publish.requested", {
        platform: "facebook",
      }),
    ]);
    const { batches, queue, sendBatch } = recordedQueue();

    await expect(runRelay(publishQueueEnv(queue))).resolves.toEqual({
      claimed: 3,
      dead: 0,
      failed: 0,
      published: 3,
    });

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const sent = batches[0] ?? [];
    const sentAt = Date.now();
    // The delay is derived from the durable distribution row at relay time:
    // one bounded delay per message, and an already-due publish sends
    // immediately with no delay option.
    expect(delayOf(sent, eventId(1))).toBe(Math.max(0, Math.ceil((now + 600_000 - sentAt) / 1000)));
    expect(delayOf(sent, eventId(2))).toBeLessThanOrEqual(86_400);
    expect(delayOf(sent, eventId(3))).toBeUndefined();
    expect(sent.map(eventOf)).toEqual([eventId(1), eventId(2), eventId(3)]);
    expect(query.mock.calls[1]?.[1]).toEqual([[eventId(1), eventId(2), eventId(3)]]);
  });

  it("suppresses the send for a schedule that moved beyond the horizon", async () => {
    const now = Date.now();
    const beyond = scheduledPublishRow(new Date(now + 86_401_000), 5);
    const within = scheduledPublishRow(new Date(now + 60_000), 4);
    const query = setupClaim([beyond, within]);
    const { batches, queue, sendBatch } = recordedQueue();

    await expect(runRelay(publishQueueEnv(queue))).resolves.toEqual({
      claimed: 2,
      dead: 0,
      failed: 0,
      published: 2,
    });

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect((batches[0] ?? []).map(eventOf)).toEqual([eventId(4)]);
    // The stale command finalizes without a send so it can never fire late;
    // the Due work claim owns the row until it comes due.
    expect(query.mock.calls[1]?.[1]).toEqual([[eventId(5), eventId(4)]]);
  });

  it("delays provider reconciliation polling from next_attempt_at", async () => {
    const now = Date.now();
    const nextAttemptAt = new Date(now + 20_000);
    setupClaim([
      row(eventId(8), "distribution.reconcile.requested", {
        platform: "facebook",
        next_attempt_at: nextAttemptAt,
      }),
    ]);
    const { batches, queue, sendBatch } = recordedQueue();

    await expect(runRelay(publishQueueEnv(queue))).resolves.toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      published: 1,
    });

    expect(sendBatch).toHaveBeenCalledOnce();
    const sent = batches[0] ?? [];
    expect(delayOf(sent, eventId(8))).toBe(
      Math.max(0, Math.ceil((nextAttemptAt.getTime() - Date.now()) / 1000)),
    );
  });
  it("relays immediately when a recorded schedule cannot be read as a time", async () => {
    const unreadable = row(eventId(6), "distribution.publish.requested", {
      platform: "facebook",
      scheduled_at: "not-a-timestamp" as unknown as Date,
    });
    const query = setupClaim([unreadable]);
    const { batches, queue } = recordedQueue();

    await expect(runRelay(publishQueueEnv(queue))).resolves.toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      published: 1,
    });

    // No delay at all, rather than a non-finite one the Queue would reject.
    expect(batches[0]?.[0]?.delaySeconds).toBeUndefined();
    expect(delayOf(batches[0] ?? [], eventId(6))).toBeUndefined();
    expect(query.mock.calls[1]?.[1]).toEqual([[eventId(6)]]);
  });
});

describe("eager outbox relay through the Automation entrypoint", () => {
  // Expected-broken until the integrator rewires AutomationEntrypoint.relayOutbox
  // (src/index.ts) to run the returned Effect with its queue service layers —
  // the RPC currently resolves to the un-run Effect rather than the result.
  it("relays a bounded batch and cannot double-deliver against a live lease", async () => {
    const query = setupClaim([row(eventId(20), "asset.processing.requested")]);
    const { batches, queue } = recordedQueue();
    const entrypoint = new AutomationEntrypoint({} as ExecutionContext, {
      ASSET_PROCESSING_QUEUE: queue,
      ENVIRONMENT: "test",
      VERSION: "test",
    });

    await expect(entrypoint.relayOutbox()).resolves.toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      published: 1,
    });
    expect((batches[0] ?? []).map(eventOf)).toEqual([eventId(20)]);

    // The claim leases what it takes and only revisits a lease that has lapsed,
    // so an eager relay racing the hourly sweep cannot deliver the same entry
    // twice.
    const claimSql = query.mock.calls[0]?.[0] as string;
    expect(claimSql).toContain("FOR UPDATE OF event SKIP LOCKED");
    expect(claimSql).toContain(
      "(event.state IN ('pending', 'failed') AND event.available_at <= now())",
    );
    expect(claimSql).toContain("(event.state = 'leased' AND event.lease_expires_at <= now())");
    expect(query.mock.calls[0]?.[1]).toEqual([50, 10, 120]);
  });
});
