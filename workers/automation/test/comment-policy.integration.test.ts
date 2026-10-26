import { Effect } from "effect";
import { ProviderRegistry } from "@meltiply/providers";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { systemPoolFor } from "../src/database";
import { createQueuePublisherLive, type QueuePublisher } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import { isProviderSyncMessage, type ProviderSyncMessage } from "../src/messages";
import { tokenCipherFor } from "../src/provider-credentials";
import {
  processProviderSyncMessage,
  requestOnDemandCommentsSync,
  sweepDueProviderJobs,
} from "../src/provider-sync";
import { runSystemTransaction } from "./system-transaction";

const organizationId = "9f100000-0000-4000-8000-000000000001";
const profileId = "9f200000-0000-4000-8000-000000000001";
const channelId = "9f300000-0000-4000-8000-000000000001";
const postId = "9f400000-0000-4000-8000-000000000001";
const distributionId = "9f500000-0000-4000-8000-000000000001";
const legacyEventId = "9f600000-0000-4000-8000-000000000001";
const delivered: ProviderSyncMessage[] = [];
let failSend = false;
let providerReads = 0;

// Only the external Queue transport and Provider are controlled. Claims,
// checkpointing, encryption, leases, and replay guards use real PostgreSQL.
const queue: Queue<unknown> = {
  async metrics() {
    return {
      backlogCount: delivered.length,
      backlogBytes: new TextEncoder().encode(JSON.stringify(delivered)).byteLength,
    };
  },
  async send(body) {
    if (failSend) throw new Error("Controlled transport outage");
    if (!isProviderSyncMessage(body)) throw new TypeError("Unexpected Queue body");
    delivered.push(body);
    return { metadata: { metrics: await queue.metrics() } };
  },
  async sendBatch(batch) {
    if (failSend) throw new Error("Controlled transport outage");
    for (const entry of batch) {
      if (!isProviderSyncMessage(entry.body)) throw new TypeError("Unexpected Queue body");
      delivered.push(entry.body);
    }
    return { metadata: { metrics: await queue.metrics() } };
  },
};
const env: AutomationEnv = {
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "comment-policy",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  COMMENTS_QUEUE: queue,
  ANALYTICS_QUEUE: queue,
  TOKEN_REFRESH_QUEUE: queue,
};
const registry = new ProviderRegistry();
const capability = registry.capabilities().find((entry) => entry.platform === "threads");
if (!capability) throw new Error("Threads capability is required");
registry.register("threads", {
  capability: { ...capability, comments: true, analytics: false },
  transferModes: [],
  async listComments(_context, _credentials, _lookup, page) {
    providerReads += 1;
    const second = page?.cursor === "page-2";
    return {
      items: [
        {
          providerCommentId: second ? "new-2" : "new-1",
          providerPostId: "policy-post",
          body: second ? "Second page" : "First page",
          commentedAt: new Date().toISOString(),
        },
      ],
      ...(second ? {} : { nextCursor: "page-2" }),
    };
  },
});
const dependencies = { providerRegistry: registry };
const queueLayer = createQueuePublisherLive();

/** Runs the real provider-sync handler with the live Queue publisher adapter. */
function run<A, E>(program: Effect.Effect<A, E, QueuePublisher>) {
  return Effect.runPromise(Effect.provide(program, queueLayer));
}

/** Gives each scenario its own durable history and an already-armed recurring event. */
beforeEach(async () => {
  delivered.length = 0;
  providerReads = 0;
  failSend = false;
  const token = await tokenCipherFor(env).encrypt("comment-policy-token");
  await runSystemTransaction(env, async (client) => {
    await client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
    await client.query(
      "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Comment policy', 'comment-policy')",
      [organizationId],
    );
    await client.query(
      "INSERT INTO brand_profiles (id, org_id, name, color) VALUES ($1, $2, 'Policy', '#1d4ed8')",
      [profileId, organizationId],
    );
    await client.query(
      `INSERT INTO platform_accounts (id, org_id, brand_profile_id, platform, platform_user_id, access_token, connection_status)
      VALUES ($1, $2, $3, 'threads', 'comment-policy-account', $4, 'connected')`,
      [channelId, organizationId, profileId, token],
    );
    await client.query(
      "INSERT INTO posts (id, org_id, brand_profile_id, default_text) VALUES ($1, $2, $3, 'Policy post')",
      [postId, organizationId, profileId],
    );
    await client.query(
      `INSERT INTO distributions (id, org_id, brand_profile_id, post_id, platform_account_id, platform, status, platform_post_id, published_at, comments_next_sync_at, comments_sync_event_id)
      VALUES ($1, $2, $3, $4, $5, 'threads', 'published', 'policy-post', now(), now() - interval '1 hour', $6)`,
      [distributionId, organizationId, profileId, postId, channelId, legacyEventId],
    );
    await client.query(
      `INSERT INTO comments (distribution_id, org_id, platform_comment_id, body, commented_at)
      VALUES ($1, $2, 'retained', 'Existing history', now())`,
      [distributionId, organizationId],
    );
  });
});
afterAll(async () => {
  await runSystemTransaction(env, async (client) => {
    await client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
  });
  await systemPoolFor(env).end();
});

const legacyMessage: ProviderSyncMessage = {
  type: "provider.sync",
  version: 1,
  event_id: legacyEventId,
  target_id: distributionId,
  request_id: legacyEventId,
  workload: "comments",
};

describe("Comment collection deployment policy", () => {
  it("does not sweep or consume recurring work by default and retains existing history", async () => {
    await run(sweepDueProviderJobs(env, dependencies));
    expect(delivered.filter((message) => message.target_id === distributionId)).toEqual([]);
    expect(await run(processProviderSyncMessage(env, legacyMessage, dependencies))).toBe("skipped");
    expect(providerReads).toBe(0);
    await runSystemTransaction(env, async (client) => {
      const history = await client.query<{ body: string }>(
        "SELECT body FROM comments WHERE distribution_id = $1",
        [distributionId],
      );
      expect(history.rows).toEqual([{ body: "Existing history" }]);
    });
  });

  it("recovers authorized demand after a lost send, completes every page, then stops", async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query(
        "UPDATE distributions SET comments_next_sync_at = NULL, comments_sync_event_id = NULL WHERE id = $1",
        [distributionId],
      );
    });
    failSend = true;
    expect(
      await run(requestOnDemandCommentsSync(env, { organizationId, distributionId }, dependencies)),
    ).toBe(0);
    failSend = false;
    await runSystemTransaction(env, async (client) => {
      await client.query(
        "UPDATE distributions SET comments_next_sync_at = now() - interval '1 hour' WHERE id = $1",
        [distributionId],
      );
    });
    await run(sweepDueProviderJobs(env, dependencies));
    const first = delivered.find((message) => message.target_id === distributionId);
    expect(first).toBeDefined();
    if (!first) throw new Error("Demand recovery was not delivered");
    delivered.length = 0;
    expect(await run(processProviderSyncMessage(env, first, dependencies))).toBe("processed");
    const second = delivered.find((message) => message.target_id === distributionId);
    if (!second) throw new Error("Comment continuation was not delivered");
    delivered.length = 0;
    expect(await run(processProviderSyncMessage(env, second, dependencies))).toBe("processed");
    expect(await run(processProviderSyncMessage(env, first, dependencies))).toBe("skipped");
    expect(providerReads).toBe(2);
    expect(delivered.filter((message) => message.target_id === distributionId)).toEqual([]);
    expect(
      await run(requestOnDemandCommentsSync(env, { organizationId, distributionId }, dependencies)),
    ).toBe(0);
    await runSystemTransaction(env, async (client) => {
      const history = await client.query<{ body: string }>(
        "SELECT body FROM comments WHERE distribution_id = $1 ORDER BY platform_comment_id",
        [distributionId],
      );
      expect(history.rows.map((row) => row.body)).toEqual([
        "First page",
        "Second page",
        "Existing history",
      ]);
      const checkpoint = await client.query<{
        comments_next_sync_at: Date | null;
        comments_sync_event_id: string | null;
      }>("SELECT comments_next_sync_at, comments_sync_event_id FROM distributions WHERE id = $1", [
        distributionId,
      ]);
      expect(checkpoint.rows[0]).toEqual({
        comments_next_sync_at: null,
        comments_sync_event_id: null,
      });
    });
  });
});
