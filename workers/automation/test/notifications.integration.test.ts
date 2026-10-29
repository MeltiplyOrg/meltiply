import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import type { OutboxMessage } from "../src/messages";
import { processNotificationMessage } from "../src/notifications";
import { runSystemTransaction } from "./system-transaction";

const describeIntegration = describe;
const organizationId = "20000000-0000-4000-8000-000000000005";
const sender = "notifications@meltiply.test";

if (!process.env.MELTIPLY_DATABASE_TEST_URL) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

interface SentMail {
  html?: string;
  text?: string;
  subject?: string;
  to?: string;
}

const sendMail = vi.fn(async (_mail: SentMail) => ({ messageId: "mail_accepted_1" }));
const env = {
  APP_URL: "https://meltiply.test",
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  MAIL: { send: sendMail } as unknown as SendEmail,
  MAIL_FROM_ADDRESS: sender,
  MAIL_FROM_NAME: "Meltiply",
  VERSION: "1.0.0-target.0",
} satisfies AutomationEnv;

const deliveryKeys = new Set<string>();

/** Builds one durable outbox message carrying the notification payload. */
function message(
  key: string,
  kind: "publication_failed" | "channel_disconnected",
  aggregateId: string,
): OutboxMessage {
  deliveryKeys.add(key);
  return {
    aggregate_id: aggregateId,
    event_id: randomUUID(),
    organization_id: organizationId,
    payload: {
      aggregate_id: aggregateId,
      channel_name: "Fixture channel",
      delivery_key: key,
      kind,
      platform: "youtube",
      version: 1,
    },
    topic: "notification.delivery.requested",
    type: "outbox.event",
    version: 1,
  };
}

/** Writes the notification preferences used by one scenario. */
async function setPreferences(
  events: { channel_disconnected: boolean; publication_failed: boolean },
  email: boolean,
) {
  await runSystemTransaction(env, (client) =>
    client.query(
      `INSERT INTO publishing_preferences (org_id, notification_preferences)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (org_id) DO UPDATE SET
         notification_preferences = EXCLUDED.notification_preferences,
         updated_at = now()`,
      [
        organizationId,
        JSON.stringify({
          channels: { email },
          events,
        }),
      ],
    ),
  );
}

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({ messageId: "mail_accepted_1" });
});

beforeAll(async () => {
  await runSystemTransaction(env, (client) =>
    client.query(
      "DELETE FROM notification_deliveries WHERE org_id = $1 AND dedupe_key LIKE 'notification-test:%'",
      [organizationId],
    ),
  );
});

afterAll(async () => {
  await runSystemTransaction(env, (client) =>
    client.query(
      "DELETE FROM notification_deliveries WHERE org_id = $1 AND dedupe_key = ANY($2::text[])",
      [organizationId, [...deliveryKeys]],
    ),
  );
  await runSystemTransaction(env, (client) =>
    client.query(
      "DELETE FROM outbox_events WHERE org_id = $1 AND dedupe_key LIKE 'publication_failed:%notification-test-%'",
      [organizationId],
    ),
  );
});

describeIntegration("owner notification delivery", () => {
  it("records a skipped delivery when the event is disabled", async () => {
    sendMail.mockClear();
    await setPreferences({ channel_disconnected: false, publication_failed: false }, true);
    const key = `notification-test:disabled:${randomUUID()}`;
    const result = await Effect.runPromise(
      processNotificationMessage(env, message(key, "publication_failed", randomUUID())),
    );
    expect(result).toBe("skipped");
    expect(sendMail).not.toHaveBeenCalled();
    const row = await runSystemTransaction(env, (client) =>
      client.query<{ state: string }>(
        "SELECT state FROM notification_deliveries WHERE org_id = $1 AND dedupe_key = $2",
        [organizationId, key],
      ),
    );
    expect(row.rows[0]?.state).toBe("skipped");
  });

  it("delivers an enabled publication failure once and acks a replay", async () => {
    sendMail.mockClear();
    await setPreferences({ channel_disconnected: false, publication_failed: true }, true);
    const distribution = await runSystemTransaction(env, (client) =>
      client.query<{ id: string }>(
        "SELECT id FROM distributions WHERE org_id = $1 ORDER BY id LIMIT 1",
        [organizationId],
      ),
    );
    const aggregateId = distribution.rows[0]?.id;
    expect(aggregateId).toBeDefined();
    const key = `notification-test:delivered:${randomUUID()}`;

    const first = await Effect.runPromise(
      processNotificationMessage(env, message(key, "publication_failed", aggregateId!)),
    );
    expect(first).toBe("processed");
    expect(sendMail).toHaveBeenCalledTimes(1);
    const sent = sendMail.mock.calls[0]?.[0];
    expect(sent?.to).toBe("alpha@meltiply.local");
    expect(sent?.subject).toContain("Publication failed");
    expect(sent?.subject).not.toMatch(/[\r\n]/);
    expect(sent?.subject?.length).toBeLessThanOrEqual(160);

    const replay = await Effect.runPromise(
      processNotificationMessage(env, message(key, "publication_failed", aggregateId!)),
    );
    expect(replay).toBe("skipped");
    expect(sendMail).toHaveBeenCalledTimes(1);

    const row = await runSystemTransaction(env, (client) =>
      client.query<{ state: string }>(
        "SELECT state FROM notification_deliveries WHERE org_id = $1 AND dedupe_key = $2",
        [organizationId, key],
      ),
    );
    expect(row.rows[0]?.state).toBe("delivered");
  });

  it("defers a duplicate sender without consuming an attempt", async () => {
    await setPreferences({ channel_disconnected: true, publication_failed: false }, true);
    const key = `notification-test:concurrent:${randomUUID()}`;
    const event = message(key, "channel_disconnected", randomUUID());
    let markStarted!: () => void;
    let releaseSend!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    sendMail.mockImplementationOnce(async () => {
      markStarted();
      await release;
      return { messageId: "mail_concurrent" };
    });
    const first = Effect.runPromise(processNotificationMessage(env, event));
    try {
      await started;
      const duplicate = await Effect.runPromise(
        Effect.flip(processNotificationMessage(env, event)),
      );
      expect(duplicate).toMatchObject({
        _tag: "RetryableJobError",
        cause: "notification_delivery_busy",
      });
      const evidence = await runSystemTransaction(env, (client) =>
        client.query<{ attempt_count: number; state: string }>(
          "SELECT state, attempt_count FROM notification_deliveries WHERE org_id = $1 AND dedupe_key = $2",
          [organizationId, key],
        ),
      );
      expect(evidence.rows[0]).toMatchObject({ state: "sending", attempt_count: 1 });
      expect(sendMail).toHaveBeenCalledTimes(1);
    } finally {
      releaseSend();
      await first;
    }
    expect(await Effect.runPromise(processNotificationMessage(env, event))).toBe("skipped");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("reclaims an expired sending lease", async () => {
    await setPreferences({ channel_disconnected: true, publication_failed: false }, true);
    const key = `notification-test:expired:${randomUUID()}`;
    const event = message(key, "channel_disconnected", randomUUID());
    await runSystemTransaction(env, (client) =>
      client.query(
        `INSERT INTO notification_deliveries
           (org_id, dedupe_key, kind, aggregate_type, aggregate_id, state, attempt_count, updated_at)
         VALUES ($1, $2, 'channel_disconnected', 'platform_account', $3, 'sending', 1,
                 now() - interval '6 minutes')`,
        [organizationId, key, event.aggregate_id],
      ),
    );

    expect(await Effect.runPromise(processNotificationMessage(env, event))).toBe("processed");
    const evidence = await runSystemTransaction(env, (client) =>
      client.query<{ attempt_count: number; state: string }>(
        "SELECT state, attempt_count FROM notification_deliveries WHERE org_id = $1 AND dedupe_key = $2",
        [organizationId, key],
      ),
    );
    expect(evidence.rows[0]).toMatchObject({ state: "delivered", attempt_count: 2 });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("preserves a specific mail submission failure in the error and delivery evidence", async () => {
    await setPreferences({ channel_disconnected: true, publication_failed: false }, true);
    const key = `notification-test:ambiguous:${randomUUID()}`;
    sendMail.mockResolvedValueOnce({ messageId: "" });
    const failure = await Effect.runPromise(
      Effect.flip(
        processNotificationMessage(env, message(key, "channel_disconnected", randomUUID())),
      ),
    );
    const expectedMessage = "Notification email submission did not return an accepted message id.";
    expect(failure).toMatchObject({
      _tag: "RetryableJobError",
      cause: "notification_mail_ambiguous",
      message: expectedMessage,
    });
    const evidence = await runSystemTransaction(env, (client) =>
      client.query<{ last_error: string; state: string }>(
        "SELECT state, last_error FROM notification_deliveries WHERE org_id = $1 AND dedupe_key = $2",
        [organizationId, key],
      ),
    );
    expect(evidence.rows[0]).toEqual({ state: "failed", last_error: expectedMessage });
  });

  it("bounds multiline Post and Provider text before putting it in mail", async () => {
    await setPreferences({ channel_disconnected: false, publication_failed: true }, true);
    const postId = randomUUID();
    const distributionId = randomUUID();
    const key = `notification-test:excerpts:${randomUUID()}`;
    await runSystemTransaction(env, async (client) => {
      const profile = await client.query<{ id: string }>(
        "SELECT id FROM brand_profiles WHERE org_id = $1 ORDER BY id LIMIT 1",
        [organizationId],
      );
      await client.query(
        "INSERT INTO posts (id, org_id, brand_profile_id, default_text) VALUES ($1, $2, $3, $4)",
        [postId, organizationId, profile.rows[0]!.id, `Launch\n\t${"x".repeat(300)}`],
      );
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform, status, error_message)
         VALUES ($1, $2, $3, $4, 'youtube', 'failed', $5)`,
        [
          distributionId,
          organizationId,
          profile.rows[0]!.id,
          postId,
          `Provider\n\t${"r".repeat(600)}`,
        ],
      );
    });
    try {
      await Effect.runPromise(
        processNotificationMessage(env, message(key, "publication_failed", distributionId)),
      );
      const sent = sendMail.mock.calls[0]?.[0];
      expect(sent?.text).toContain(`Post: Launch ${"x".repeat(192)}…\n`);
      expect(sent?.text).toContain(`Reason: Provider ${"r".repeat(490)}…\n`);
      expect(sent?.subject).not.toMatch(/\s{2,}|[\r\n\t]/);
      expect(sent?.subject?.length).toBeLessThanOrEqual(160);
    } finally {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM posts WHERE id = $1", [postId]),
      );
    }
  });

  it("retries transient failures and stops at the bounded attempt limit", async () => {
    await setPreferences({ channel_disconnected: true, publication_failed: false }, true);
    const key = `notification-test:exhaustion:${randomUUID()}`;
    sendMail.mockClear();
    sendMail.mockRejectedValue(new Error("mail service unavailable"));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        Effect.runPromise(
          processNotificationMessage(env, message(key, "channel_disconnected", randomUUID())),
        ),
      ).rejects.toBeDefined();
    }
    const exhausted = await Effect.runPromise(
      processNotificationMessage(env, message(key, "channel_disconnected", randomUUID())),
    );
    expect(exhausted).toBe("skipped");
    expect(sendMail).toHaveBeenCalledTimes(5);

    const row = await runSystemTransaction(env, (client) =>
      client.query<{ attempt_count: number; state: string }>(
        "SELECT state, attempt_count FROM notification_deliveries WHERE org_id = $1 AND dedupe_key = $2",
        [organizationId, key],
      ),
    );
    expect(row.rows[0]?.state).toBe("dead");
    expect(Number(row.rows[0]?.attempt_count)).toBe(5);
  });

  it("writes the outbox event in the same transaction as a terminal failure", async () => {
    const seeded = await runSystemTransaction(env, (client) =>
      client.query<{ id: string; status: string }>(
        "SELECT id, status FROM distributions WHERE org_id = $1 AND status <> 'failed' ORDER BY id LIMIT 1",
        [organizationId],
      ),
    );
    const target = seeded.rows[0];
    expect(target).toBeDefined();
    const failureCode = `notification-test-${randomUUID()}`;
    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
            SET status = 'failed', failure_retryable = false, failure_code = $2,
                error_message = 'Fixture terminal failure', updated_at = now()
          WHERE id = $1`,
        [target!.id, failureCode],
      ),
    );
    const events = await runSystemTransaction(env, (client) =>
      client.query<{ dedupe_key: string; topic: string }>(
        "SELECT dedupe_key, topic FROM outbox_events WHERE aggregate_id = $1 AND topic = 'notification.delivery.requested'",
        [target!.id],
      ),
    );
    expect(events.rows[0]?.topic).toBe("notification.delivery.requested");
    expect(events.rows[0]?.dedupe_key).toContain(failureCode);

    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
            SET status = $2, failure_retryable = NULL, failure_code = NULL,
                error_message = NULL, updated_at = now()
          WHERE id = $1`,
        [target!.id, target!.status],
      ),
    );
  });

  it("alerts once on a live disconnect transition and not on deletion", async () => {
    const disconnectOrganizationId = "9a000000-0000-4000-8000-0000000000a1";
    const profileId = randomUUID();
    const accountId = randomUUID();
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM organizations WHERE id = $1", [disconnectOrganizationId]);
      await client.query(
        "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Disconnect alerts', 'notification-disconnect')",
        [disconnectOrganizationId],
      );
      await client.query(
        "INSERT INTO brand_profiles (id, org_id, name, color) VALUES ($1, $2, 'Alerts', '#1d4ed8')",
        [profileId, disconnectOrganizationId],
      );
      await client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id, access_token,
            connection_status, display_name)
         VALUES ($1, $2, $3, 'youtube', $4, 'token', 'connected', 'Alert channel')`,
        [accountId, disconnectOrganizationId, profileId, `disconnect-${accountId}`],
      );
    });
    const alertCount = async () =>
      (
        await runSystemTransaction(env, (client) =>
          client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM outbox_events
              WHERE aggregate_id = $1 AND topic = 'notification.delivery.requested'`,
            [accountId],
          ),
        )
      ).rows[0]!.count;

    try {
      expect(await alertCount()).toBe(0);
      await runSystemTransaction(env, (client) =>
        client.query(
          `UPDATE platform_accounts
              SET connection_status = 'reconnect_required', updated_at = now()
            WHERE id = $1`,
          [accountId],
        ),
      );
      expect(await alertCount()).toBe(1);

      // An explicit disconnect or Brand Profile teardown deletes the account;
      // there is no Channel left to reconnect, so it must not enqueue another alert.
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM platform_accounts WHERE id = $1", [accountId]),
      );
      expect(await alertCount()).toBe(1);
    } finally {
      await runSystemTransaction(env, async (client) => {
        await client.query("DELETE FROM outbox_events WHERE aggregate_id = $1", [accountId]);
        await client.query("DELETE FROM organizations WHERE id = $1", [disconnectOrganizationId]);
      });
    }
  });
});
