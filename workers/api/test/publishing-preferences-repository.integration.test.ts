import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  FakePublishingPreferencesRepository,
  FakePublishingPreferencesStore,
} from "../src/repositories/fake-publishing-preferences-repository";
import { postgresPublishingPreferencesRepository } from "../src/repositories/postgres-publishing-preferences-repository";
import type { SavedPreferences } from "../src/repositories/publishing-preferences-repository";
import {
  closeDatabase,
  databaseEnv,
  failureOf,
  inTransaction,
  seedFakeTenant,
  seedPostgresTenant,
  type Tenant,
} from "./tenant-harness";

const EMPTY: SavedPreferences = {
  notifications: {
    channels: { email: { enabled: false, recipients: [] } },
    events: { channel_disconnected: false, publication_failed: false },
  },
  signatures: [],
  timezone: null,
};
const FILLED: SavedPreferences = {
  notifications: {
    channels: { email: { enabled: true, recipients: ["ops@example.com"] } },
    events: { channel_disconnected: true, publication_failed: true },
  },
  signatures: [
    {
      body: "Merci 🚀",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      is_default: true,
      name: "Main",
      position: 0,
    },
  ],
  timezone: "America/New_York",
};

const rowOf = (preferences: SavedPreferences) => ({
  notification_preferences: preferences.notifications,
  signature_templates: preferences.signatures,
  timezone: preferences.timezone,
  updated_at: expect.any(Date),
});

function postgresHarness() {
  return {
    repository: postgresPublishingPreferencesRepository(databaseEnv),
    tenant: seedPostgresTenant,
  };
}

function fakeHarness() {
  const store = new FakePublishingPreferencesStore(() => new Date());
  return {
    repository: new FakePublishingPreferencesRepository(store),
    tenant: () => Promise.resolve(seedFakeTenant(store)),
  };
}

afterAll(closeDatabase);

describe("PublishingPreferencesRepository", () => {
  describe.each([
    ["Postgres", postgresHarness],
    ["fake", fakeHarness],
  ])("%s", (_name, createHarness) => {
    const { repository, tenant: seedTenant } = createHarness();

    const save = (tenant: Tenant, preferences: SavedPreferences) =>
      inTransaction(repository, tenant.admin, (tx) =>
        tx.savePreferences(tenant.organizationId, preferences),
      );
    const read = (tenant: Tenant) =>
      inTransaction(repository, tenant.viewer, (tx) => tx.preferences());

    describe("preferences round trip", () => {
      it.each([
        ["no timezone, template or recipient", EMPTY],
        ["every field filled", FILLED],
      ])("%s", async (_example, preferences) => {
        const tenant = await seedTenant();

        const written = await save(tenant, preferences);

        expect(written).toEqual(rowOf(preferences));
        expect(await read(tenant)).toEqual(written);
      });

      it("a second save replaces the first", async () => {
        const tenant = await seedTenant();
        await save(tenant, FILLED);

        await save(tenant, EMPTY);

        expect(await read(tenant)).toEqual(rowOf(EMPTY));
      });

      it("a Workspace that never saved", async () => {
        expect(await read(await seedTenant())).toEqual(undefined);
      });

      it("another Workspace's preferences", async () => {
        const tenant = await seedTenant();
        await save(await seedTenant(), FILLED);

        expect(await read(tenant)).toEqual(undefined);
      });

      it("a failed transaction writes nothing", async () => {
        const tenant = await seedTenant();

        await failureOf(repository, tenant.admin, (tx) =>
          Effect.andThen(tx.savePreferences(tenant.organizationId, FILLED), () =>
            Effect.fail("abort"),
          ),
        );

        expect(await read(tenant)).toEqual(undefined);
      });
    });
  });
});
