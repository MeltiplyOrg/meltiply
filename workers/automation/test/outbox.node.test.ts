import { DatabaseError } from "@meltiply/domain";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createPublishQueueResolverLive, createQueuePublisherLive } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";
import { relayOutbox, type OutboxRelayResult } from "../src/outbox";
import { publishingQueueFor } from "../src/publish-queues";
import {
  createFakeOutboxRepository,
  FakeOutboxStore,
  type FakeOutboxEvent,
} from "../src/repositories/outbox-repository";
import { fakeQueue } from "./test-doubles";

const NOW_MS = new Date("2026-06-01T12:00:00.000Z").getTime();
const organizationId = "00000000-0000-4000-8000-000000000001";
const aggregateId = "00000000-0000-4000-8000-000000000002";

const eventId = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

function eventRow(
  id: string,
  topic = "asset.processing.requested",
  overrides: Partial<FakeOutboxEvent> = {},
): FakeOutboxEvent {
  return {
    aggregate_id: aggregateId,
    attempt_count: 0,
    id,
    last_error: null,
    next_attempt_at: null,
    org_id: organizationId,
    payload: { request_id: "request-outbox-test" },
    platform: null,
    scheduled_at: null,
    state: "pending",
    topic,
    ...overrides,
  };
}

type SentBatch = MessageSendRequest<OutboxMessage>[];

function recordedQueue(options: { failWith?: Error } = {}) {
  const batches: SentBatch[] = [];
  let singleSends = 0;
  const queue = fakeQueue({
    send: async () => {
      singleSends += 1;
      return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
    },
    sendBatch: async (messages) => {
      if (options.failWith) throw options.failWith;
      batches.push([...(messages as Iterable<MessageSendRequest<OutboxMessage>>)]);
      return { metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } } };
    },
  });
  return { batches, queue, singleSends: () => singleSends };
}

function runRelay(
  env: AutomationEnv,
  store: FakeOutboxStore,
  batchSize?: number,
): Promise<OutboxRelayResult> {
  return Effect.runPromise(
    Effect.provide(
      relayOutbox(env, batchSize, {
        now: () => NOW_MS,
        repository: createFakeOutboxRepository(store),
      }),
      Layer.mergeAll(
        createQueuePublisherLive(),
        createPublishQueueResolverLive((platform) => publishingQueueFor(env, platform)),
      ),
    ),
  );
}

const assetEnv = (queue: Queue<unknown>): AutomationEnv => ({
  ASSET_PROCESSING_QUEUE: queue,
  ENVIRONMENT: "test",
  VERSION: "test",
});

const publishEnv = (queue: Queue<unknown>): AutomationEnv => ({
  ENVIRONMENT: "test",
  FACEBOOK_PUBLISH_QUEUE: queue,
  VERSION: "test",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("relayOutbox", () => {
  it("batches messages for the same binding into one sendBatch call and marks them published", async () => {
    const store = new FakeOutboxStore();
    store.events.push(eventRow(eventId(1)), eventRow(eventId(2)));
    const { batches, queue, singleSends } = recordedQueue();

    expect(await runRelay(assetEnv(queue), store, 2)).toEqual({
      claimed: 2,
      dead: 0,
      failed: 0,
      published: 2,
    });
    expect(singleSends()).toEqual(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((m) => m.body.event_id)).toEqual([eventId(1), eventId(2)]);
    expect(store.publishedIds).toEqual([[eventId(1), eventId(2)]]);
  });

  it("marks every message failed with redacted URLs when a batch send rejects", async () => {
    const store = new FakeOutboxStore();
    store.events.push(eventRow(eventId(5)), eventRow(eventId(6)));
    const { queue } = recordedQueue({
      failWith: new Error("queue unavailable at https://secret.test"),
    });

    expect(await runRelay(assetEnv(queue), store, 2)).toEqual({
      claimed: 2,
      dead: 0,
      failed: 2,
      published: 0,
    });
    expect(store.failedUpdates).toEqual([
      [
        { delaySeconds: 30, id: eventId(5), lastError: "queue unavailable at [REDACTED_URL]" },
        { delaySeconds: 30, id: eventId(6), lastError: "queue unavailable at [REDACTED_URL]" },
      ],
    ]);
  });

  it("moves an exhausted failure to dead and never claims it on the next relay pass", async () => {
    const store = new FakeOutboxStore();
    store.events.push(eventRow(eventId(7), "asset.processing.requested", { attempt_count: 9 }));
    const { queue } = recordedQueue({ failWith: new Error("queue unavailable") });

    expect(await runRelay(assetEnv(queue), store)).toEqual({
      claimed: 1,
      dead: 1,
      failed: 1,
      published: 0,
    });
    expect(store.events[0]?.state).toEqual("dead");
    expect(await runRelay(assetEnv(queue), store)).toEqual({
      claimed: 0,
      dead: 0,
      failed: 0,
      published: 0,
    });
  });

  it("leaves accepted messages leased and logs settlement error when markPublished fails", async () => {
    const store = new FakeOutboxStore();
    store.events.push(eventRow(eventId(9)), eventRow(eventId(10)));
    store.markPublishedError = new DatabaseError({ message: "database settlement timeout" });
    const { batches, queue } = recordedQueue();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runRelay(assetEnv(queue), store, 2)).toEqual({
      claimed: 2,
      dead: 0,
      failed: 0,
      published: 0,
    });
    expect(batches).toHaveLength(1);
    expect(store.events.every((event) => event.state === "leased")).toEqual(true);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0]?.[0])).toContain("outbox_settlement_failed");
  });

  it("assigns per-message durable delays for scheduled publishes and omits delay for immediate ones", async () => {
    const store = new FakeOutboxStore();
    store.events.push(
      eventRow(eventId(1), "distribution.publish.requested", {
        platform: "facebook",
        scheduled_at: new Date(NOW_MS + 600_000),
      }),
      eventRow(eventId(2), "distribution.publish.requested", {
        platform: "facebook",
        scheduled_at: new Date(NOW_MS + 86_400_000),
      }),
      eventRow(eventId(3), "distribution.publish.requested", { platform: "facebook" }),
    );
    const { batches, queue } = recordedQueue();

    expect(await runRelay(publishEnv(queue), store)).toEqual({
      claimed: 3,
      dead: 0,
      failed: 0,
      published: 3,
    });
    expect(batches[0]?.map((m) => ({ delaySeconds: m.delaySeconds, id: m.body.event_id }))).toEqual(
      [
        { delaySeconds: 600, id: eventId(1) },
        { delaySeconds: 86_400, id: eventId(2) },
        { delaySeconds: undefined, id: eventId(3) },
      ],
    );
  });

  it("suppresses queue send for schedules beyond the 24-hour delivery horizon while marking them published", async () => {
    const store = new FakeOutboxStore();
    store.events.push(
      eventRow(eventId(5), "distribution.publish.requested", {
        platform: "facebook",
        scheduled_at: new Date(NOW_MS + 86_401_000),
      }),
      eventRow(eventId(4), "distribution.publish.requested", {
        platform: "facebook",
        scheduled_at: new Date(NOW_MS + 60_000),
      }),
    );
    const { batches, queue } = recordedQueue();

    expect(await runRelay(publishEnv(queue), store)).toEqual({
      claimed: 2,
      dead: 0,
      failed: 0,
      published: 2,
    });
    expect(batches[0]?.map((m) => m.body.event_id)).toEqual([eventId(4)]);
    expect(store.publishedIds).toEqual([[eventId(5), eventId(4)]]);
  });

  it("delays reconciliation triggers from next_attempt_at", async () => {
    const store = new FakeOutboxStore();
    store.events.push(
      eventRow(eventId(8), "distribution.reconcile.requested", {
        next_attempt_at: new Date(NOW_MS + 20_000),
        platform: "facebook",
      }),
    );
    const { batches, queue } = recordedQueue();

    expect(await runRelay(publishEnv(queue), store)).toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      published: 1,
    });
    expect(batches[0]?.[0]?.delaySeconds).toEqual(20);
  });

  it("relays immediately when scheduled_at is unreadable", async () => {
    const store = new FakeOutboxStore();
    store.events.push(
      eventRow(eventId(6), "distribution.publish.requested", {
        platform: "facebook",
        scheduled_at: "not-a-timestamp",
      }),
    );
    const { batches, queue } = recordedQueue();

    expect(await runRelay(publishEnv(queue), store)).toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      published: 1,
    });
    expect(batches[0]?.[0]?.delaySeconds).toEqual(undefined);
  });

  it("relays a channel revocation event to its queue with the strict payload allowlist", async () => {
    const store = new FakeOutboxStore();
    store.events.push(
      eventRow(eventId(21), "channel.revocation.requested", {
        payload: {
          access_token: "enc:ciphertext-token",
          brand_profile_id: "00000000-0000-4000-8000-000000000003",
          platform: "tiktok",
          request_id: "request-revocation-test",
          stray_field: "must-not-leak",
          version: 1,
        },
      }),
    );
    const { batches, queue } = recordedQueue();
    const env: AutomationEnv = {
      CHANNEL_REVOCATION_QUEUE: queue,
      ENVIRONMENT: "test",
      VERSION: "test",
    };

    expect(await runRelay(env, store)).toEqual({
      claimed: 1,
      dead: 0,
      failed: 0,
      published: 1,
    });
    expect(batches).toHaveLength(1);
    const sent = batches[0]?.[0];
    expect(sent?.body.event_id).toEqual(eventId(21));
    expect(sent?.body.topic).toEqual("channel.revocation.requested");
    expect(sent?.body.payload).toEqual({
      access_token: "enc:ciphertext-token",
      brand_profile_id: "00000000-0000-4000-8000-000000000003",
      platform: "tiktok",
      platform_account_id: aggregateId,
    });
    expect(sent?.delaySeconds).toEqual(undefined);
    expect(store.publishedIds).toEqual([[eventId(21)]]);
  });

  it("marks a channel revocation event failed instead of dropping it when the queue binding is missing", async () => {
    const store = new FakeOutboxStore();
    store.events.push(
      eventRow(eventId(22), "channel.revocation.requested", {
        payload: {
          access_token: "enc:ciphertext-token",
          brand_profile_id: "00000000-0000-4000-8000-000000000003",
          platform: "tiktok",
          version: 1,
        },
      }),
    );

    expect(await runRelay({ ENVIRONMENT: "test", VERSION: "test" }, store)).toEqual({
      claimed: 1,
      dead: 0,
      failed: 1,
      published: 0,
    });
    expect(store.failedUpdates).toEqual([
      [
        {
          delaySeconds: 30,
          id: eventId(22),
          lastError: "channel-revocation Queue binding is unavailable",
        },
      ],
    ]);
  });
});
