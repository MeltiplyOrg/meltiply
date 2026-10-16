import { Effect } from "effect";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

import type { Queryable } from "@meltiply/database";
import { ProviderRegistry, type ProviderAdapter } from "@meltiply/providers";

import { RetryableJobError } from "../src/effect/index";
import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";
import { enqueueDueDistributions } from "../src/distribution";
import { enqueueDueReplyReconciliations } from "../src/reply-reconciliation";
import { processReplyMessage } from "../src/replies";
import { runSystemTransaction } from "./system-transaction";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;
const organizationId = "20000000-0000-4000-8000-000000000001";
// The seeded Alpha workspace profile owns the fixture Posts and distributions
// below; brand_profile_id is mandatory and the composite FKs require
// same-profile references.
const seededAlphaProfileId = "a0000000-0000-4000-8000-000000000001";

const env = {
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "test",
} satisfies AutomationEnv;

/**
 * Inserts one retained Post owning the fixture's text-only composition.
 * Reply reconciliation is Post-independent, so a text-only Post with zero
 * attachments is the minimal faithful fixture: distributions reference the
 * Post, never a stored Asset.
 */
async function insertTextPost(client: Queryable, postId: string) {
  await client.query(
    `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
     VALUES ($1, $2, $3, 'Reply reconciliation fixture', 'Fixture body', 'active')`,
    [postId, organizationId, seededAlphaProfileId],
  );
}

describeIntegration("reply reconciliation enqueue with PostgreSQL", () => {
  const postId = crypto.randomUUID();
  const distributionId = crypto.randomUUID();
  const needsId = crypto.randomUUID();
  const expiredId = crypto.randomUUID();
  const liveId = crypto.randomUUID();
  const exhaustedId = crypto.randomUUID();

  afterAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])", [
        [needsId, expiredId, liveId, exhaustedId],
      ]);
      await client.query("DELETE FROM distributions WHERE id = $1", [distributionId]);
      await client.query("DELETE FROM posts WHERE id = $1", [postId]);
    });
  });

  it("enqueues expired work once, skips live leases, and advances dedupe keys", async () => {
    await runSystemTransaction(env, async (client) => {
      await insertTextPost(client, postId);
      await client.query(
        `INSERT INTO distributions (id, org_id, brand_profile_id, post_id, platform, status)
         VALUES ($1, $2, $3, $4, 'youtube', 'published')`,
        [distributionId, organizationId, seededAlphaProfileId, postId],
      );
      await client.query(
        `INSERT INTO comments (
           id, org_id, distribution_id, platform_comment_id, body,
           commented_at, reply_status, reply_reconciliation_attempt_count,
           reply_lease_expires_at, updated_at
         ) VALUES
           ($1, $5, $6, 'reply-reconcile-needs', 'needs reconciliation',
            now() - INTERVAL '4 minutes', 'needs_reconciliation', 0, NULL,
            now() - INTERVAL '4 minutes'),
           ($2, $5, $6, 'reply-reconcile-expired', 'expired lease',
            now() - INTERVAL '3 minutes', 'in_progress', 0,
            now() - INTERVAL '1 minute', now() - INTERVAL '3 minutes'),
           ($3, $5, $6, 'reply-reconcile-live', 'live lease',
            now() - INTERVAL '2 minutes', 'needs_reconciliation', 0,
            now() + INTERVAL '1 hour', now() - INTERVAL '2 minutes'),
           ($4, $5, $6, 'reply-reconcile-exhausted', 'attempts exhausted',
            now() - INTERVAL '1 minute', 'needs_reconciliation', 10, NULL,
            now() - INTERVAL '1 minute')`,
        [needsId, expiredId, liveId, exhaustedId, organizationId, distributionId],
      );
    });

    await expect(Effect.runPromise(enqueueDueReplyReconciliations(env, 100))).resolves.toBe(2);
    await expect(Effect.runPromise(enqueueDueReplyReconciliations(env, 100))).resolves.toBe(0);

    const firstEvents = await runSystemTransaction(env, (client) =>
      client.query<{
        aggregate_id: string;
        aggregate_type: string;
        dedupe_key: string;
        payload: Record<string, unknown>;
        state: string;
        topic: string;
      }>(
        `SELECT aggregate_id, aggregate_type, dedupe_key, payload, state, topic
           FROM outbox_events
          WHERE aggregate_id = ANY($1::uuid[])
          ORDER BY aggregate_id`,
        [[needsId, expiredId, liveId, exhaustedId]],
      ),
    );

    expect(firstEvents.rows).toHaveLength(2);
    expect(firstEvents.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aggregate_id: needsId,
          aggregate_type: "comment",
          dedupe_key: `comment-reply-reconcile:${needsId}:1`,
          payload: { comment_id: needsId, reconciliation: true },
          state: "pending",
          topic: "comment.reply.requested",
        }),
        expect.objectContaining({
          aggregate_id: expiredId,
          aggregate_type: "comment",
          dedupe_key: `comment-reply-reconcile:${expiredId}:1`,
          payload: { comment_id: expiredId, reconciliation: true },
          state: "pending",
          topic: "comment.reply.requested",
        }),
      ]),
    );

    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE comments
            SET reply_reconciliation_attempt_count = 1,
                reply_lease_expires_at = NULL,
                updated_at = now()
          WHERE id = $1`,
        [needsId],
      ),
    );

    await expect(Effect.runPromise(enqueueDueReplyReconciliations(env, 100))).resolves.toBe(1);

    const keys = await runSystemTransaction(env, (client) =>
      client.query<{ dedupe_key: string }>(
        `SELECT dedupe_key
           FROM outbox_events
          WHERE aggregate_id = $1
          ORDER BY dedupe_key`,
        [needsId],
      ),
    );
    expect(keys.rows.map((row) => row.dedupe_key)).toEqual([
      `comment-reply-reconcile:${needsId}:1`,
      `comment-reply-reconcile:${needsId}:2`,
    ]);
  });

  it.each([0, -1, 101, 1.5, Number.NaN])("rejects invalid limits (%s)", async (limit) => {
    // Invalid limits fail the Effect with a classified RetryableJobError
    // (the RangeError name is preserved on the wrapper's `cause`).
    await expect(Effect.runPromise(enqueueDueReplyReconciliations(env, limit))).rejects.toThrow(
      RetryableJobError,
    );
  });
});

describeIntegration("reply container lifecycle with PostgreSQL", () => {
  const accountId = crypto.randomUUID();
  const postId = crypto.randomUUID();
  const distributionId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  const sendEventId = crypto.randomUUID();
  const lookupEventId = crypto.randomUUID();
  const replayEventId = crypto.randomUUID();

  afterAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM outbox_events WHERE aggregate_id = $1", [commentId]);
      await client.query("DELETE FROM provider_operations WHERE comment_id = $1", [commentId]);
      await client.query("DELETE FROM async_job_events WHERE event_key = ANY($1::text[])", [
        [sendEventId, lookupEventId, replayEventId].map((id) => `outbox:${id}`),
      ]);
      await client.query("DELETE FROM comments WHERE id = $1", [commentId]);
      await client.query("DELETE FROM distributions WHERE id = $1", [distributionId]);
      await client.query("DELETE FROM platform_accounts WHERE id = $1", [accountId]);
      await client.query("DELETE FROM posts WHERE id = $1", [postId]);
    });
  });

  /**
   * Builds an OutboxMessage for the reply topic with a fresh event identity so
   * each delivery claims its own job lease, mirroring real Queue redelivery.
   */
  function replyMessage(eventId: string): OutboxMessage {
    return {
      aggregate_id: commentId,
      attempt: 1,
      event_id: eventId,
      organization_id: organizationId,
      payload: { comment_id: commentId, reconciliation: true },
      topic: "comment.reply.requested",
      type: "outbox.event",
      version: 1,
    };
  }

  /**
   * Registers a Threads-shaped adapter whose reply creates a media container
   * (operation identity only) and whose lookup reports the scripted status.
   */
  function containerRegistry(lookupPublication: ProviderAdapter["lookupPublication"]) {
    const registry = new ProviderRegistry();
    registry.register("threads", {
      capability: {
        accepted_mime_types: [],
        analytics: false,
        asset_types: [],
        comments: false,
        connect_available: false,
        max_caption_length: 500,
        max_file_size: null,
        max_hashtags: null,
        max_media_count: null,
        max_video_duration_sec: null,
        min_media_count: null,
        multi_asset_types: [],
        notes: [],
        platform: "threads",
        publish: false,
        reply: true,
      },
      lookupPublication,
      reply: vi.fn(async () => ({
        outcome: "confirmed_success" as const,
        providerOperationId: "created:reply-container-1",
      })),
      retryPolicy: {
        baseDelaySeconds: 15,
        maxAttempts: 5,
        maxDelaySeconds: 300,
      },
      transferModes: [],
    });
    return registry;
  }

  // The reply container fixture records every dependency under one seeded
  // Brand Profile, matching the production ownership and composite-key model.
  it("keeps an operation-only reply pending, then finalizes it exactly once", async () => {
    await runSystemTransaction(env, async (client) => {
      await insertTextPost(client, postId);
      await client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id,
            access_token, token_expires_at, connection_status)
         VALUES ($1, $2, $3, 'threads', 'threads-user-1', 'enc-token',
                 now() + INTERVAL '1 day', 'connected')`,
        [accountId, organizationId, seededAlphaProfileId],
      );
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform,
            platform_account_id, status)
         VALUES ($1, $2, $3, $4, 'threads', $5, 'published')`,
        [distributionId, organizationId, seededAlphaProfileId, postId, accountId],
      );
      await client.query(
        `INSERT INTO comments
           (id, org_id, distribution_id, platform_comment_id, body,
            commented_at, reply_text, reply_status)
         VALUES ($1, $2, $3, 'reply-container-comment', 'original comment',
                 now(), 'Reply container body', 'queued')`,
        [commentId, organizationId, distributionId],
      );
    });

    const dependencies = {
      decryptToken: async () => "decrypted-token",
      providerRegistry: containerRegistry(
        vi.fn(async () => ({
          result: {
            outcome: "confirmed_success" as const,
            providerOperationId: "submitted:reply-container-1",
            providerPostId: "reply-post-1",
          },
          state: "published" as const,
        })),
      ),
    };

    // The container create confirms only an operation identity: the reply must
    // stay pending with durable reconciliation work, never replied = true.
    await expect(
      Effect.runPromise(processReplyMessage(env, replyMessage(sendEventId), dependencies)),
    ).resolves.toBe("processed");

    const pending = await runSystemTransaction(env, (client) =>
      client.query<{
        operation_status: string;
        provider_operation_id: string | null;
        replied: boolean;
        reply_status: string;
      }>(
        `SELECT comment.replied, comment.reply_status,
                comment.reply_provider_operation_id AS provider_operation_id,
                operation.status AS operation_status
         FROM comments AS comment
         JOIN provider_operations AS operation
           ON operation.comment_id = comment.id
         WHERE comment.id = $1`,
        [commentId],
      ),
    );
    expect(pending.rows[0]).toEqual({
      operation_status: "needs_reconciliation",
      provider_operation_id: "created:reply-container-1",
      replied: false,
      reply_status: "needs_reconciliation",
    });

    const armed = await runSystemTransaction(env, (client) =>
      client.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
        `SELECT dedupe_key, payload FROM outbox_events
         WHERE aggregate_id = $1 AND topic = 'comment.reply.requested'`,
        [commentId],
      ),
    );
    expect(armed.rows).toEqual([
      {
        dedupe_key: `comment-reply-reconcile:${commentId}:1`,
        payload: {
          comment_id: commentId,
          delay_seconds: 60,
          reconciliation: true,
        },
      },
    ]);

    // The delayed reconciliation delivery performs the lookup, which finalizes
    // the ready container and marks the reply succeeded exactly once.
    await expect(
      Effect.runPromise(processReplyMessage(env, replyMessage(lookupEventId), dependencies)),
    ).resolves.toBe("processed");

    const succeeded = await runSystemTransaction(env, (client) =>
      client.query<{
        provider_post_id: string | null;
        replied: boolean;
        reply_status: string;
      }>(
        `SELECT replied, reply_status,
                reply_provider_post_id AS provider_post_id
         FROM comments WHERE id = $1`,
        [commentId],
      ),
    );
    expect(succeeded.rows[0]).toEqual({
      provider_post_id: "reply-post-1",
      replied: true,
      reply_status: "succeeded",
    });

    // A further reconciliation delivery observes the terminal state and skips.
    await expect(
      Effect.runPromise(processReplyMessage(env, replyMessage(replayEventId), dependencies)),
    ).resolves.toBe("skipped");
    const final = await runSystemTransaction(env, (client) =>
      client.query<{ replied: boolean; reply_status: string }>(
        "SELECT replied, reply_status FROM comments WHERE id = $1",
        [commentId],
      ),
    );
    expect(final.rows[0]).toEqual({ replied: true, reply_status: "succeeded" });
  });
});

describeIntegration("distribution reconciliation recovery with PostgreSQL", () => {
  const postId = crypto.randomUUID();
  const deadEventId = crypto.randomUUID();
  const strandedId = crypto.randomUUID();

  afterAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])", [
        [deadEventId, strandedId],
      ]);
      await client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [
        [deadEventId, strandedId],
      ]);
      await client.query("DELETE FROM posts WHERE id = $1", [postId]);
    });
  });

  // The stranded-reconcile fixtures retain a single seeded Brand Profile so
  // recovery tests cover scheduling rather than violating ownership FKs.
  it("re-arms a lost reconcile trigger instead of stranding the row", async () => {
    await runSystemTransaction(env, async (client) => {
      await insertTextPost(client, postId);
      // A stalled processing row the scanner already recovered once: its
      // armed reconcile event died in the relay, and next_attempt_at was
      // cleared when the event was armed — the stranded signature (#256).
      await client.query(
        `INSERT INTO distributions
             (id, org_id, brand_profile_id, post_id, platform, status,
              reconciliation_attempt_count, next_attempt_at, updated_at)
           VALUES
             ($1, $3, $4, $5, 'youtube', 'needs_reconciliation', 0, NULL,
              now() - INTERVAL '10 minutes'),
             ($2, $3, $4, $5, 'youtube', 'needs_reconciliation', 0, NULL,
              now() - INTERVAL '10 minutes')`,
        [deadEventId, strandedId, organizationId, seededAlphaProfileId, postId],
      );
      await client.query(
        `INSERT INTO outbox_events
             (org_id, topic, aggregate_type, aggregate_id, dedupe_key,
              payload, state, attempt_count)
           VALUES ($1, 'distribution.reconcile.requested', 'distribution', $2,
                   $3, $4::jsonb, 'dead', 10)`,
        [
          organizationId,
          deadEventId,
          `distribution:${deadEventId}:reconcile:1`,
          JSON.stringify({ distribution_id: deadEventId, version: 1 }),
        ],
      );
    });

    // The dead event's dedupe key must not block recovery: the claim revives
    // it as pending, and the row with no event at all gains a fresh trigger.
    await expect(Effect.runPromise(enqueueDueDistributions(env, 100))).resolves.toBe(2);

    const recovered = await runSystemTransaction(env, (client) =>
      client.query<{
        aggregate_id: string;
        attempt_count: number;
        dedupe_key: string;
        state: string;
      }>(
        `SELECT aggregate_id::text AS aggregate_id, dedupe_key, state,
                  attempt_count
             FROM outbox_events
            WHERE aggregate_id = ANY($1::uuid[])`,
        [[deadEventId, strandedId]],
      ),
    );
    const recoveredById: Record<string, (typeof recovered.rows)[number]> = {};
    for (const row of recovered.rows) recoveredById[row.aggregate_id] = row;
    expect(recoveredById[deadEventId]).toEqual({
      aggregate_id: deadEventId,
      attempt_count: 0,
      dedupe_key: `distribution:${deadEventId}:reconcile:1`,
      state: "pending",
    });
    expect(recoveredById[strandedId]).toEqual({
      aggregate_id: strandedId,
      attempt_count: 0,
      dedupe_key: `distribution:${strandedId}:reconcile:1`,
      state: "pending",
    });

    // A second scan finds both events live and arms nothing new.
    await expect(Effect.runPromise(enqueueDueDistributions(env, 100))).resolves.toBe(0);
  });
});
