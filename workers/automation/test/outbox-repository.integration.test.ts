import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { integrationDatabaseUrl } from "../../../scripts/lib/integration-database";
import { systemPoolFor } from "../src/database";
import type { AutomationEnv } from "../src/env";
import {
  createFakeOutboxRepository,
  createPostgresOutboxRepository,
  FakeOutboxStore,
  type OutboxRepository,
} from "../src/repositories/outbox-repository";
import { runSystemTransaction } from "./system-transaction";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

const env = {
  DB_SYSTEM: {
    connectionString: integrationDatabaseUrl(connectionString, "system"),
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "outbox-repository-roundtrip",
} satisfies AutomationEnv;

const organizationId = "20000000-0000-4000-8000-000000000001";
const aggregateId = "40000000-0000-4000-8000-000000000001";

interface OutboxHarness {
  readonly repository: OutboxRepository;
  readonly seedEvent: (input: {
    attemptCount?: number;
    id: string;
    topic: string;
  }) => Promise<void>;
  readonly readState: (
    id: string,
  ) => Promise<{ attempt_count: number; last_error: string | null; state: string } | undefined>;
  readonly cleanup: (ids: readonly string[]) => Promise<void>;
}

function postgresHarness(): OutboxHarness {
  return {
    cleanup: async (ids) => {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM outbox_events WHERE id = ANY($1::uuid[])", [ids]),
      );
    },
    readState: async (id) =>
      runSystemTransaction(env, async (client) => {
        const result = await client.query<{
          attempt_count: number;
          last_error: string | null;
          state: string;
        }>("SELECT attempt_count, last_error, state FROM outbox_events WHERE id = $1", [id]);
        return result.rows[0];
      }),
    repository: createPostgresOutboxRepository(env),
    seedEvent: async ({ attemptCount = 0, id, topic }) => {
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `DELETE FROM outbox_events WHERE state IN ('pending', 'failed', 'leased')`,
        );
        await client.query(
          `INSERT INTO outbox_events
             (id, org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload, attempt_count, available_at)
           VALUES ($1, $2, $3, 'asset', $4, $5, '{"request_id":"roundtrip"}'::jsonb, $6, now() - INTERVAL '1 second')`,
          [id, organizationId, topic, aggregateId, `roundtrip:${id}`, attemptCount],
        );
      });
    },
  };
}

function fakeHarness(): OutboxHarness {
  const store = new FakeOutboxStore();
  return {
    cleanup: async () => {
      store.events.length = 0;
    },
    readState: async (id) => {
      const event = store.events.find((entry) => entry.id === id);
      if (!event) return undefined;
      return {
        attempt_count: event.attempt_count,
        last_error: event.last_error,
        state: event.state,
      };
    },
    repository: createFakeOutboxRepository(store),
    seedEvent: async ({ attemptCount = 0, id, topic }) => {
      store.events.push({
        aggregate_id: aggregateId,
        attempt_count: attemptCount,
        id,
        last_error: null,
        next_attempt_at: null,
        org_id: organizationId,
        payload: { request_id: "roundtrip" },
        platform: null,
        scheduled_at: null,
        state: "pending",
        topic,
      });
    },
  };
}

afterAll(async () => {
  await systemPoolFor(env).end();
});

describe("OutboxRepository round trip", () => {
  describe.each([
    ["Postgres", postgresHarness],
    ["fake", fakeHarness],
  ])("%s", (_label, createHarness) => {
    it("claims pending rows, marks them published, and does not re-claim them", async () => {
      const harness = createHarness();
      const id = crypto.randomUUID();
      try {
        await harness.seedEvent({ id, topic: "asset.processing.requested" });

        const claimed = await Effect.runPromise(harness.repository.claim(10, 10, 120));
        expect(claimed.map((row) => ({ attempt: row.attempt_count, id: row.id }))).toEqual([
          { attempt: 1, id },
        ]);
        expect(await harness.readState(id)).toEqual({
          attempt_count: 1,
          last_error: null,
          state: "leased",
        });

        await Effect.runPromise(harness.repository.markPublished([id]));
        expect(await harness.readState(id)).toEqual({
          attempt_count: 1,
          last_error: null,
          state: "published",
        });

        expect(await Effect.runPromise(harness.repository.claim(10, 10, 120))).toEqual([]);
      } finally {
        await harness.cleanup([id]);
      }
    });

    it("transitions exhausted failures to dead and returns the dead count", async () => {
      const harness = createHarness();
      const id = crypto.randomUUID();
      try {
        await harness.seedEvent({ attemptCount: 9, id, topic: "asset.processing.requested" });

        const claimed = await Effect.runPromise(harness.repository.claim(10, 10, 120));
        expect(claimed).toHaveLength(1);

        const dead = await Effect.runPromise(
          harness.repository.markFailed(
            [{ delaySeconds: 30, id, lastError: "downstream unavailable" }],
            10,
          ),
        );
        expect(dead).toEqual(1);
        expect(await harness.readState(id)).toEqual({
          attempt_count: 10,
          last_error: "downstream unavailable",
          state: "dead",
        });
        expect(await Effect.runPromise(harness.repository.claim(10, 10, 120))).toEqual([]);
      } finally {
        await harness.cleanup([id]);
      }
    });
  });
});
