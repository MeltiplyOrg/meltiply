import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { handleBillingWebhook } from "../src/billing-webhook";
import { withSystemTransactionEffect } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;
const deliveryNow = new Date("2026-07-22T12:00:00.000Z");
const deliveryTimestamp = Math.floor(deliveryNow.getTime() / 1_000);
const organizationId = "20000000-0000-4000-8000-000000000003";
const creatorProductId = "11111111-1111-4111-8111-111111111111";
const agencyProductId = "22222222-2222-4222-8222-222222222222";
const eventIds = [
  "msg_MeltiplyBilling001",
  "msg_MeltiplyBilling002",
  "msg_MeltiplyBilling003",
  "msg_MeltiplyBilling004",
  "msg_MeltiplyBilling005",
  "msg_MeltiplyBilling006",
  "msg_MeltiplyBilling007",
];
const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  BILLING_WEBHOOK_SECRET: "polar_billing_integration_secret",
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  POLAR_AGENCY_PRODUCT_ID: agencyProductId,
  POLAR_CREATOR_PRODUCT_ID: creatorProductId,
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

async function signature(body: string, id: string, timestamp = deliveryTimestamp): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BILLING_WEBHOOK_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function headers(body: string, id: string, timestamp = deliveryTimestamp): Promise<Headers> {
  return new Headers({
    "webhook-id": id,
    "webhook-signature": `v1,${await signature(body, id, timestamp)}`,
    "webhook-timestamp": String(timestamp),
  });
}

function subscriptionEvent(input: {
  cancelAtPeriodEnd?: boolean;
  endsAt?: string;
  eventType?: string;
  productId: string;
  status: string;
}) {
  return JSON.stringify({
    data: {
      cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
      current_period_end: "2026-08-21T12:00:00.000Z",
      ...(input.endsAt ? { ends_at: input.endsAt } : {}),
      customer: {
        external_id: organizationId,
        metadata: { meltiply_organization_id: organizationId },
      },
      product: { id: input.productId },
      status: input.status,
    },
    type: input.eventType ?? "subscription.updated",
  });
}

describeIntegration("Polar billing webhook ledger", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      withSystemTransactionEffect(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            "DELETE FROM webhook_events WHERE provider = 'billing' AND event_id = ANY($1::text[])",
            [eventIds],
          );
          yield* client.query(
            `INSERT INTO organizations (id, name, slug, plan, billing_status)
             VALUES ($1, 'Billing Webhook Integration', 'billing-webhook-integration', 'creator', 'free')
             ON CONFLICT (id) DO UPDATE
               SET name = EXCLUDED.name,
                   plan = EXCLUDED.plan,
                   billing_status = EXCLUDED.billing_status,
                   renews_at = NULL,
                   cancel_at = NULL,
                   billing_event_at = NULL,
                   updated_at = now()`,
            [organizationId],
          );
        }),
      ),
    );
  });

  afterAll(async () => {
    await Effect.runPromise(
      withSystemTransactionEffect(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(
            "DELETE FROM webhook_events WHERE provider = 'billing' AND event_id = ANY($1::text[])",
            [eventIds],
          );
          yield* client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
        }),
      ),
    );
  });

  it("verifies Standard Webhooks signatures, deduplicates, and rejects mismatches", async () => {
    const body = subscriptionEvent({
      eventType: "subscription.active",
      productId: agencyProductId,
      status: "active",
    });
    const signedHeaders = await headers(body, eventIds[0]!);
    await expect(
      Effect.runPromise(
        handleBillingWebhook(env, body, signedHeaders, {
          now: () => deliveryNow,
        }),
      ),
    ).resolves.toEqual({ ignored: false, replayed: false });
    await expect(
      Effect.runPromise(
        handleBillingWebhook(env, body, signedHeaders, {
          now: () => deliveryNow,
        }),
      ),
    ).resolves.toEqual({ ignored: false, replayed: true });

    await Effect.runPromise(
      withSystemTransactionEffect(env, (client) =>
        client
          .query<{
            billing_status: string;
            plan: string;
          }>("SELECT plan, billing_status FROM organizations WHERE id = $1", [organizationId])
          .pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                expect(result.rows[0]).toEqual({
                  billing_status: "active",
                  plan: "agency",
                });
              }),
            ),
          ),
      ),
    );

    const changed = subscriptionEvent({
      eventType: "subscription.active",
      productId: creatorProductId,
      status: "active",
    });
    await expect(
      Effect.runPromise(
        handleBillingWebhook(env, changed, await headers(changed, eventIds[0]!), {
          now: () => deliveryNow,
        }),
      ),
    ).rejects.toMatchObject({ code: "webhook_replay_mismatch", status: 409 });
  });

  it("normalizes lifecycle states, timestamps, and unknown products", async () => {
    const lifecycle = [
      {
        eventType: "subscription.created",
        productId: creatorProductId,
        status: "active",
      },
      {
        eventType: "subscription.past_due",
        productId: creatorProductId,
        status: "past_due",
      },
      {
        cancelAtPeriodEnd: true,
        eventType: "subscription.canceled",
        productId: creatorProductId,
        status: "canceled",
      },
    ] as const;

    for (const [index, item] of lifecycle.entries()) {
      const body = subscriptionEvent(item);
      const timestamp = deliveryTimestamp + (index + 1) * 60;
      await expect(
        Effect.runPromise(
          handleBillingWebhook(env, body, await headers(body, eventIds[index + 1]!, timestamp), {
            now: () => deliveryNow,
          }),
        ),
      ).resolves.toEqual({ ignored: false, replayed: false });
    }

    await Effect.runPromise(
      withSystemTransactionEffect(env, (client) =>
        client
          .query<{
            billing_status: string;
            cancel_at: Date | null;
            plan: string;
            renews_at: Date | null;
          }>("SELECT plan, billing_status, renews_at, cancel_at FROM organizations WHERE id = $1", [
            organizationId,
          ])
          .pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                expect(result.rows[0]).toMatchObject({
                  billing_status: "cancelled",
                  plan: "creator",
                });
                expect(result.rows[0]?.renews_at).toBeNull();
                expect(result.rows[0]?.cancel_at?.toISOString()).toBe("2026-08-21T12:00:00.000Z");
              }),
            ),
          ),
      ),
    );

    const unknownBody = subscriptionEvent({
      eventType: "subscription.active",
      productId: "33333333-3333-4333-8333-333333333333",
      status: "active",
    });
    await expect(
      Effect.runPromise(
        handleBillingWebhook(
          env,
          unknownBody,
          await headers(unknownBody, eventIds[4]!, deliveryTimestamp + 240),
          { now: () => deliveryNow },
        ),
      ),
    ).resolves.toEqual({ ignored: true, replayed: false });
  });

  it("rejects stale delivery signatures before database access", async () => {
    const body = subscriptionEvent({
      eventType: "subscription.active",
      productId: creatorProductId,
      status: "active",
    });
    const staleTimestamp = deliveryTimestamp - 301;
    await expect(
      Effect.runPromise(
        handleBillingWebhook(env, body, await headers(body, eventIds[5]!, staleTimestamp), {
          now: () => deliveryNow,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_webhook_signature", status: 401 });
  });

  it("ignores a later event with the same delivery timestamp", async () => {
    const firstBody = subscriptionEvent({
      eventType: "subscription.active",
      productId: agencyProductId,
      status: "active",
    });
    await expect(
      Effect.runPromise(
        handleBillingWebhook(env, firstBody, await headers(firstBody, eventIds[6]!), {
          now: () => deliveryNow,
        }),
      ),
    ).resolves.toEqual({ ignored: true, replayed: false });
  });
});
