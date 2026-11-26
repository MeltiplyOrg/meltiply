import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import type { DisconnectableAccountRow } from "../src/brand-profile-rules";
import { isUniqueViolation } from "../src/brand-profile-rules";
import type { BrandProfileRepositoryProvider } from "../src/repositories/brand-profile-repository";
import {
  FakeBrandProfileRepository,
  FakeBrandProfileStore,
} from "../src/repositories/fake-brand-profile-repository";
import { postgresBrandProfileRepository } from "../src/repositories/postgres-brand-profile-repository";
import {
  closeDatabase,
  contend,
  database,
  databaseEnv,
  failureOf,
  inTransaction,
  seedFakeTenant,
  seedPostgresTenant,
  type Tenant,
} from "./tenant-harness";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Harness {
  distributionStatus(id: string): Promise<string | undefined>;
  repository: ReturnType<BrandProfileRepositoryProvider>;
  revocations(organizationId: string): Promise<unknown[]>;
  seedChannel(tenant: Tenant, profileId: string): Promise<DisconnectableAccountRow>;
  seedDeletedProfile(tenant: Tenant, name: string, deletedAt: string): Promise<string>;
  seedDistribution(
    tenant: Tenant,
    channel: DisconnectableAccountRow,
    status: string,
  ): Promise<string>;
  tenant(): Promise<Tenant>;
}

const PURGE_AT = "2030-01-01T00:00:00.000Z";

function postgresHarness(): Harness {
  return {
    async distributionStatus(id) {
      const result = await database().query<{ status: string }>(
        "SELECT status FROM distributions WHERE id = $1",
        [id],
      );
      return result.rows[0]?.status;
    },
    repository: postgresBrandProfileRepository(databaseEnv),
    async revocations(organizationId) {
      const result = await database().query(
        `SELECT dedupe_key AS "dedupeKey", payload FROM outbox_events
          WHERE org_id = $1 AND topic = 'channel.revocation.requested'`,
        [organizationId],
      );
      return result.rows;
    },
    async seedChannel(tenant, profileId) {
      const result = await database().query<DisconnectableAccountRow>(
        `INSERT INTO platform_accounts
           (org_id, brand_profile_id, platform, platform_user_id, display_name,
            access_token, scopes, connection_status)
         VALUES ($1, $2, 'threads', $3, 'Round trip', 'sealed-token', ARRAY['publish'], 'connected')
         RETURNING id, brand_profile_id, platform, access_token`,
        [tenant.organizationId, profileId, randomUUID()],
      );
      return result.rows[0]!;
    },
    async seedDeletedProfile(tenant, name, deletedAt) {
      const result = await database().query<{ id: string }>(
        `INSERT INTO brand_profiles (org_id, name, color, deleted_at, purge_at)
         VALUES ($1, $2, '#b91c1c', $3, $4) RETURNING id`,
        [tenant.organizationId, name, deletedAt, PURGE_AT],
      );
      return result.rows[0]!.id;
    },
    async seedDistribution(tenant, channel, status) {
      const post = await database().query<{ id: string }>(
        `INSERT INTO posts (org_id, brand_profile_id, title, default_text, status)
         VALUES ($1, $2, 'Round trip', 'Caption', 'active') RETURNING id`,
        [tenant.organizationId, channel.brand_profile_id],
      );
      const result = await database().query<{ id: string }>(
        `INSERT INTO distributions
           (org_id, brand_profile_id, post_id, platform_account_id, platform, status, attachment_ids)
         VALUES ($1, $2, $3, $4, 'threads', $5, ARRAY[]::uuid[]) RETURNING id`,
        [tenant.organizationId, channel.brand_profile_id, post.rows[0]!.id, channel.id, status],
      );
      return result.rows[0]!.id;
    },
    tenant: seedPostgresTenant,
  };
}

function fakeHarness(): Harness {
  const store = new FakeBrandProfileStore(() => new Date(), randomUUID);
  const stored = (id: string) => store.distributions.find((row) => row.id === id);
  return {
    distributionStatus: (id) => Promise.resolve(stored(id)?.status),
    repository: new FakeBrandProfileRepository(store),
    revocations: (organizationId) =>
      Promise.resolve(
        store.outbox
          .filter((event) => event.org_id === organizationId)
          .map(({ dedupeKey, payload }) => ({ dedupeKey, payload })),
      ),
    seedChannel(tenant, profileId) {
      const channel = {
        access_token: "sealed-token",
        brand_profile_id: profileId,
        id: randomUUID(),
        platform: "threads",
      };
      store.channels.push({ ...channel, org_id: tenant.organizationId });
      return Promise.resolve(channel);
    },
    seedDeletedProfile(tenant, name, deletedAt) {
      const id = randomUUID();
      store.brandProfiles.push({
        color: "#b91c1c",
        created_at: deletedAt,
        deleted_at: deletedAt,
        description: null,
        id,
        name,
        org_id: tenant.organizationId,
        purge_at: PURGE_AT,
        updated_at: deletedAt,
      });
      return Promise.resolve(id);
    },
    seedDistribution(_tenant, channel, status) {
      const id = randomUUID();
      store.distributions.push({ id, platform_account_id: channel.id, status });
      return Promise.resolve(id);
    },
    tenant: () => Promise.resolve(seedFakeTenant(store)),
  };
}

afterAll(closeDatabase);

describe("BrandProfileRepository", () => {
  describe.each([
    ["Postgres", postgresHarness],
    ["fake", fakeHarness],
  ])("%s", (_name, createHarness) => {
    const harness = createHarness();
    const { repository } = harness;

    async function profile(tenant: Tenant, name = "Alpha", description: string | null = null) {
      return inTransaction(repository, tenant.admin, (tx) =>
        tx.insertBrandProfile(tenant.organizationId, { color: "#b91c1c", description, name }),
      );
    }

    const read = (tenant: Tenant, id: string, session = tenant.admin) =>
      inTransaction(repository, session, (tx) => tx.brandProfile(id));

    describe("brand profile round trip", () => {
      it("a profile without a description", async () => {
        const tenant = await harness.tenant();

        const inserted = await profile(tenant);

        expect(inserted).toEqual({
          color: "#b91c1c",
          created_at: expect.stringMatching(ISO),
          deleted_at: null,
          description: null,
          id: expect.stringMatching(UUID),
          name: "Alpha",
          org_id: tenant.organizationId,
          purge_at: null,
          updated_at: expect.stringMatching(ISO),
        });
        expect(await read(tenant, inserted.id)).toEqual(inserted);
      });

      it("a profile with a description", async () => {
        const tenant = await harness.tenant();

        const inserted = await profile(tenant, "Alpha", "Editorial tools");

        expect(await read(tenant, inserted.id)).toEqual({
          ...inserted,
          description: "Editorial tools",
        });
      });

      it("an unknown profile", async () => {
        const tenant = await harness.tenant();

        expect(await read(tenant, randomUUID())).toEqual(null);
      });

      it("another Workspace's profile", async () => {
        const tenant = await harness.tenant();
        const other = await harness.tenant();
        const inserted = await profile(other);

        expect(await read(tenant, inserted.id)).toEqual(null);
      });

      it("a deleted profile read by an Admin", async () => {
        const tenant = await harness.tenant();
        const id = await harness.seedDeletedProfile(tenant, "Gone", "2026-01-02T00:00:00.000Z");

        expect(await read(tenant, id)).toMatchObject({
          deleted_at: "2026-01-02T00:00:00.000Z",
          purge_at: PURGE_AT,
        });
      });

      it("a deleted profile read by an Editor", async () => {
        const tenant = await harness.tenant();
        const id = await harness.seedDeletedProfile(tenant, "Gone", "2026-01-02T00:00:00.000Z");

        expect(await read(tenant, id, tenant.editor)).toEqual(null);
      });

      it("a name that differs only in case and spacing", async () => {
        const tenant = await harness.tenant();
        await profile(tenant, "Alpha Brand");

        const failure = await failureOf(repository, tenant.admin, (tx) =>
          tx.insertBrandProfile(tenant.organizationId, {
            color: "#b91c1c",
            name: "  alpha   brand ",
          }),
        );

        expect(isUniqueViolation(failure as never)).toEqual(true);
      });
    });

    describe("activeBrandProfiles", () => {
      const listed = (tenant: Tenant) =>
        inTransaction(repository, tenant.viewer, (tx) => tx.activeBrandProfiles());

      it("profiles in name order, without deleted or foreign ones", async () => {
        const tenant = await harness.tenant();
        const bravo = await profile(tenant, "Bravo");
        const alpha = await profile(tenant, "Alpha");
        await harness.seedDeletedProfile(tenant, "Charlie", "2026-01-02T00:00:00.000Z");
        await profile(await harness.tenant(), "Delta");

        expect(await listed(tenant)).toEqual([alpha, bravo]);
      });

      it("a Workspace without profiles", async () => {
        expect(await listed(await harness.tenant())).toEqual([]);
      });
    });

    describe("deletedBrandProfiles", () => {
      it("deleted profiles, the latest deletion first", async () => {
        const tenant = await harness.tenant();
        await profile(tenant, "Active");
        const older = await harness.seedDeletedProfile(tenant, "Older", "2026-01-02T00:00:00.000Z");
        const newer = await harness.seedDeletedProfile(tenant, "Newer", "2026-01-03T00:00:00.000Z");

        const deleted = await inTransaction(repository, tenant.admin, (tx) =>
          tx.deletedBrandProfiles(),
        );

        expect(deleted.map((row) => row.id)).toEqual([newer, older]);
      });

      it("an Editor sees none", async () => {
        const tenant = await harness.tenant();
        await harness.seedDeletedProfile(tenant, "Gone", "2026-01-02T00:00:00.000Z");

        expect(
          await inTransaction(repository, tenant.editor, (tx) => tx.deletedBrandProfiles()),
        ).toEqual([]);
      });
    });

    describe("updateBrandProfile", () => {
      const update = (tenant: Tenant, id: string, input: object, session = tenant.admin) =>
        inTransaction(repository, session, (tx) =>
          tx.updateBrandProfile(id, tenant.organizationId, input),
        );

      it("every field", async () => {
        const tenant = await harness.tenant();
        const inserted = await profile(tenant);

        const updated = await update(tenant, inserted.id, {
          color: "#c2410c",
          description: "New",
          name: "Renamed",
        });

        expect(updated).toEqual({
          ...inserted,
          color: "#c2410c",
          description: "New",
          name: "Renamed",
          updated_at: expect.stringMatching(ISO),
        });
        expect(await read(tenant, inserted.id)).toEqual(updated);
      });

      it("no field keeps what is stored", async () => {
        const tenant = await harness.tenant();
        const inserted = await profile(tenant, "Alpha", "Kept");

        expect(await update(tenant, inserted.id, {})).toEqual({
          ...inserted,
          updated_at: expect.stringMatching(ISO),
        });
      });

      it("a null description clears it", async () => {
        const tenant = await harness.tenant();
        const inserted = await profile(tenant, "Alpha", "Dropped");

        expect(await update(tenant, inserted.id, { description: null })).toMatchObject({
          description: null,
        });
      });

      it("a deleted profile", async () => {
        const tenant = await harness.tenant();
        const id = await harness.seedDeletedProfile(tenant, "Gone", "2026-01-02T00:00:00.000Z");

        expect(await update(tenant, id, { name: "Back" })).toEqual(null);
      });

      it("an Editor changes nothing", async () => {
        const tenant = await harness.tenant();
        const inserted = await profile(tenant);

        expect(await update(tenant, inserted.id, { name: "Renamed" }, tenant.editor)).toEqual(null);
        expect(await read(tenant, inserted.id)).toEqual(inserted);
      });

      it("another profile's name", async () => {
        const tenant = await harness.tenant();
        await profile(tenant, "Taken");
        const inserted = await profile(tenant, "Alpha");

        const failure = await failureOf(repository, tenant.admin, (tx) =>
          tx.updateBrandProfile(inserted.id, tenant.organizationId, { name: "taken" }),
        );

        expect(isUniqueViolation(failure as never)).toEqual(true);
      });
    });

    describe("lockBrandProfileForDeletion", () => {
      const lock = (tenant: Tenant, id: string) =>
        inTransaction(repository, tenant.admin, (tx) =>
          tx.lockBrandProfileForDeletion(id, tenant.organizationId),
        );

      it("a stored profile", async () => {
        const tenant = await harness.tenant();

        expect(await lock(tenant, (await profile(tenant)).id)).toEqual(true);
      });

      it("an unknown profile", async () => {
        expect(await lock(await harness.tenant(), randomUUID())).toEqual(false);
      });

      it("two deletions at once apply one after the other", async () => {
        const tenant = await harness.tenant();
        const { id } = await profile(tenant);

        const second = await contend(
          repository,
          tenant.admin,
          {
            lock: (tx) => tx.lockBrandProfileForDeletion(id, tenant.organizationId),
            write: (tx) => tx.deleteBrandProfile(id, tenant.organizationId),
          },
          (tx) => tx.lockBrandProfileForDeletion(id, tenant.organizationId),
        );

        expect(second).toEqual(false);
      });
    });

    describe("lockBrandProfileRetention", () => {
      const retention = (tenant: Tenant, id: string) =>
        inTransaction(repository, tenant.admin, (tx) =>
          tx.lockBrandProfileRetention(id, tenant.organizationId),
        );

      it("a deleted profile", async () => {
        const tenant = await harness.tenant();
        const id = await harness.seedDeletedProfile(tenant, "Gone", "2026-01-02T00:00:00.000Z");

        const row = await retention(tenant, id);

        expect([new Date(row!.deleted_at!), new Date(row!.purge_at!)]).toEqual([
          new Date("2026-01-02T00:00:00.000Z"),
          new Date(PURGE_AT),
        ]);
      });

      it("an active profile", async () => {
        const tenant = await harness.tenant();

        expect(await retention(tenant, (await profile(tenant)).id)).toEqual({
          deleted_at: null,
          purge_at: null,
        });
      });

      it("an unknown profile", async () => {
        expect(await retention(await harness.tenant(), randomUUID())).toEqual(null);
      });

      it("a change sees what the other restore wrote", async () => {
        const tenant = await harness.tenant();
        const id = await harness.seedDeletedProfile(tenant, "Gone", "2026-01-02T00:00:00.000Z");

        const second = await contend(
          repository,
          tenant.admin,
          {
            lock: (tx) => tx.lockBrandProfileRetention(id, tenant.organizationId),
            write: (tx) => tx.restoreBrandProfile(id, tenant.organizationId),
          },
          (tx) => tx.lockBrandProfileRetention(id, tenant.organizationId),
        );

        expect(second).toEqual({ deleted_at: null, purge_at: null });
      });
    });

    describe("restoreBrandProfile", () => {
      it("a deleted profile", async () => {
        const tenant = await harness.tenant();
        const id = await harness.seedDeletedProfile(tenant, "Gone", "2026-01-02T00:00:00.000Z");

        const restored = await inTransaction(repository, tenant.admin, (tx) =>
          tx.restoreBrandProfile(id, tenant.organizationId),
        );

        expect(restored).toMatchObject({ deleted_at: null, id, purge_at: null });
        expect(await read(tenant, id, tenant.editor)).toEqual(restored);
      });
    });

    describe("deleteBrandProfile", () => {
      it("a stored profile", async () => {
        const tenant = await harness.tenant();
        const inserted = await profile(tenant);

        const removed = await inTransaction(repository, tenant.admin, (tx) =>
          tx.deleteBrandProfile(inserted.id, tenant.organizationId),
        );

        expect(removed).toEqual(inserted);
        expect(await read(tenant, inserted.id)).toEqual(null);
      });

      it("a failed transaction writes nothing", async () => {
        const tenant = await harness.tenant();
        const inserted = await profile(tenant);

        await failureOf(repository, tenant.admin, (tx) =>
          Effect.andThen(tx.deleteBrandProfile(inserted.id, tenant.organizationId), () =>
            Effect.fail("abort"),
          ),
        );

        expect(await read(tenant, inserted.id)).toEqual(inserted);
      });
    });

    describe("brandProfileChannels", () => {
      const channels = (tenant: Tenant, id: string) =>
        inTransaction(repository, tenant.admin, (tx) =>
          tx.brandProfileChannels(id, tenant.organizationId),
        );

      it("only the profile's Channels", async () => {
        const tenant = await harness.tenant();
        const { id } = await profile(tenant, "Alpha");
        const channel = await harness.seedChannel(tenant, id);
        await harness.seedChannel(tenant, (await profile(tenant, "Bravo")).id);

        expect(await channels(tenant, id)).toEqual([channel]);
      });

      it("a profile without Channels", async () => {
        const tenant = await harness.tenant();

        expect(await channels(tenant, (await profile(tenant)).id)).toEqual([]);
      });
    });

    describe("disconnectChannel", () => {
      async function connected() {
        const tenant = await harness.tenant();
        const { id } = await profile(tenant);
        const channel = await harness.seedChannel(tenant, id);
        const disconnect = () =>
          inTransaction(repository, tenant.admin, (tx) =>
            tx.disconnectChannel(tenant.organizationId, channel),
          );
        return { channel, disconnect, id, tenant };
      }

      it("the Channel is removed and its revocation recorded", async () => {
        const { channel, disconnect, id, tenant } = await connected();

        await disconnect();

        expect(
          await inTransaction(repository, tenant.admin, (tx) =>
            tx.brandProfileChannels(id, tenant.organizationId),
          ),
        ).toEqual([]);
        expect(await harness.revocations(tenant.organizationId)).toEqual([
          {
            dedupeKey: `channel-revocation:${channel.id}`,
            payload: {
              access_token: "sealed-token",
              brand_profile_id: id,
              platform: "threads",
              platform_account_id: channel.id,
              version: 1,
            },
          },
        ]);
      });

      it("the same Channel twice records one revocation", async () => {
        const { disconnect, tenant } = await connected();

        await disconnect();
        await disconnect();

        expect(await harness.revocations(tenant.organizationId)).toHaveLength(1);
      });

      it.each([
        ["scheduled", "cancelled"],
        ["queued", "cancelled"],
        ["published", "published"],
      ])("a %s Distribution", async (status, expected) => {
        const { channel, disconnect, tenant } = await connected();
        const distributionId = await harness.seedDistribution(tenant, channel, status);

        await disconnect();

        expect(await harness.distributionStatus(distributionId)).toEqual(expected);
      });
    });
  });
});
