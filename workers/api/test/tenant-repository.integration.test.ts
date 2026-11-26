import { randomUUID } from "node:crypto";
import { ActiveOrganizationRequiredError } from "@meltiply/domain";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/core-types";
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

function postgresHarness() {
  return {
    async deletedProfile(tenant: Tenant) {
      const result = await database().query<{ id: string }>(
        `INSERT INTO brand_profiles (org_id, name, color, deleted_at, purge_at)
         VALUES ($1, 'Gone', '#b91c1c', now(), now() + interval '1 day') RETURNING id`,
        [tenant.organizationId],
      );
      return result.rows[0]!.id;
    },
    repository: postgresBrandProfileRepository(databaseEnv),
    tenant: seedPostgresTenant,
  };
}

function fakeHarness() {
  const store = new FakeBrandProfileStore(() => new Date(), randomUUID);
  return {
    deletedProfile(tenant: Tenant) {
      const id = randomUUID();
      store.brandProfiles.push({
        color: "#b91c1c",
        created_at: "2026-01-01T00:00:00.000Z",
        deleted_at: "2026-01-02T00:00:00.000Z",
        description: null,
        id,
        name: "Gone",
        org_id: tenant.organizationId,
        purge_at: "2030-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
      });
      return Promise.resolve(id);
    },
    repository: new FakeBrandProfileRepository(store),
    tenant: () => Promise.resolve(seedFakeTenant(store)),
  };
}

const notFound = new CoreApiError(
  404,
  "brand_profile_not_found",
  "The brand profile was not found.",
);
const conflict = new CoreApiError(
  409,
  "idempotency_conflict",
  "The Idempotency-Key was already used with a different request.",
);

afterAll(closeDatabase);

describe("TenantRepository", () => {
  describe.each([
    ["Postgres", postgresHarness],
    ["fake", fakeHarness],
  ])("%s", (_name, createHarness) => {
    const { deletedProfile, repository, tenant: seedTenant } = createHarness();

    const activeProfile = (tenant: Tenant, name = "Alpha") =>
      inTransaction(repository, tenant.admin, (tx) =>
        tx.insertBrandProfile(tenant.organizationId, { color: "#b91c1c", name }),
      );

    describe("activeOrganizationId", () => {
      it("a member", async () => {
        const tenant = await seedTenant();

        expect(
          await inTransaction(repository, tenant.viewer, (tx) => tx.activeOrganizationId()),
        ).toEqual(tenant.organizationId);
      });

      it("someone outside the Workspace", async () => {
        const tenant = await seedTenant();

        expect(
          await failureOf(repository, tenant.outsider, (tx) => tx.activeOrganizationId()),
        ).toEqual(
          new ActiveOrganizationRequiredError({
            message: "The authenticated identity is not an active organization member.",
          }),
        );
      });
    });

    describe("activeRole", () => {
      it.each(["admin", "editor", "viewer"] as const)("the %s", async (role) => {
        const tenant = await seedTenant();

        expect(await inTransaction(repository, tenant[role], (tx) => tx.activeRole())).toEqual(
          role,
        );
      });

      it("someone outside the Workspace", async () => {
        const tenant = await seedTenant();

        expect(await inTransaction(repository, tenant.outsider, (tx) => tx.activeRole())).toEqual(
          null,
        );
      });

      it("a claimed role the membership does not hold", async () => {
        const tenant = await seedTenant();
        const claimed = { ...tenant.viewer, organizationRole: "admin" };

        expect(await inTransaction(repository, claimed, (tx) => tx.activeRole())).toEqual("viewer");
      });
    });

    describe("requireActiveBrandProfile", () => {
      const guard = (tenant: Tenant, id: string, session = tenant.editor) =>
        inTransaction(repository, session, (tx) =>
          tx.requireActiveBrandProfile(tenant.organizationId, id),
        );
      const rejected = (tenant: Tenant, id: string, session = tenant.editor) =>
        failureOf(repository, session, (tx) =>
          tx.requireActiveBrandProfile(tenant.organizationId, id),
        );

      it("an active profile", async () => {
        const tenant = await seedTenant();

        expect(await guard(tenant, (await activeProfile(tenant)).id)).toEqual(undefined);
      });

      it("an unknown profile", async () => {
        expect(await rejected(await seedTenant(), randomUUID())).toEqual(notFound);
      });

      it("another Workspace's profile", async () => {
        const tenant = await seedTenant();
        const { id } = await activeProfile(await seedTenant());

        expect(await rejected(tenant, id)).toEqual(notFound);
      });

      it("a deleted profile, for an Admin", async () => {
        const tenant = await seedTenant();
        const id = await deletedProfile(tenant);

        expect(await rejected(tenant, id, tenant.admin)).toEqual(
          new CoreApiError(
            409,
            "brand_profile_deleted",
            "The brand profile is deleted and cannot accept new data.",
          ),
        );
      });

      it("a deleted profile, for an Editor", async () => {
        const tenant = await seedTenant();

        expect(await rejected(tenant, await deletedProfile(tenant))).toEqual(notFound);
      });
    });

    describe("timezoneExists", () => {
      it.each([
        ["a regional zone", "America/New_York", true],
        ["UTC", "UTC", true],
        ["an unknown zone", "Not/A_Zone", false],
        ["a zone in the wrong case", "europe/paris", false],
        ["an empty string", "", false],
      ])("%s", async (_example, timezone, exists) => {
        const tenant = await seedTenant();

        expect(
          await inTransaction(repository, tenant.admin, (tx) => tx.timezoneExists(timezone)),
        ).toEqual(exists);
      });
    });

    describe("lockOrganization", () => {
      it("two locked changes apply one after the other", async () => {
        const tenant = await seedTenant();

        const seen = await contend(
          repository,
          tenant.admin,
          {
            lock: (tx) => tx.lockOrganization(tenant.organizationId),
            write: (tx) =>
              tx.insertBrandProfile(tenant.organizationId, { color: "#b91c1c", name: "First" }),
          },
          (tx) =>
            Effect.andThen(tx.lockOrganization(tenant.organizationId), () =>
              tx.activeBrandProfiles(),
            ),
        );

        expect(seen.map((profile) => profile.name)).toEqual(["First"]);
      });
    });

    describe("idempotency round trip", () => {
      const reserve = (tenant: Tenant, hash = "hash-a") =>
        inTransaction(repository, tenant.admin, (tx) =>
          tx.reserveIdempotency(tenant.organizationId, "round-trip", "key", hash),
        );
      const finish = (tenant: Tenant, body: unknown) =>
        inTransaction(repository, tenant.admin, (tx) =>
          Effect.andThen(
            tx.reserveIdempotency(tenant.organizationId, "round-trip", "key", "hash-a"),
            () => tx.completeIdempotency(tenant.organizationId, "round-trip", "key", 201, body),
          ),
        );

      it("a fresh key", async () => {
        expect(await reserve(await seedTenant())).toEqual(null);
      });

      it.each([
        ["a completed key with a body", { id: "one", nested: [null] }],
        ["a completed key without a body", null],
      ])("%s", async (_example, body) => {
        const tenant = await seedTenant();
        await finish(tenant, body);

        expect(await reserve(tenant)).toEqual({
          request_hash: "hash-a",
          response_body: body,
          response_status: 201,
        });
      });

      it("a completed key with another request", async () => {
        const tenant = await seedTenant();
        await finish(tenant, null);

        expect(
          await failureOf(repository, tenant.admin, (tx) =>
            tx.reserveIdempotency(tenant.organizationId, "round-trip", "key", "hash-b"),
          ),
        ).toEqual(conflict);
      });

      it("a key reserved but not completed", async () => {
        const tenant = await seedTenant();
        await reserve(tenant);

        expect(
          await failureOf(repository, tenant.admin, (tx) =>
            tx.reserveIdempotency(tenant.organizationId, "round-trip", "key", "hash-a"),
          ),
        ).toEqual(
          new CoreApiError(
            409,
            "idempotency_in_progress",
            "The idempotent operation is still in progress.",
          ),
        );
      });

      it("a key whose transaction failed", async () => {
        const tenant = await seedTenant();
        await failureOf(repository, tenant.admin, (tx) =>
          Effect.andThen(
            tx.reserveIdempotency(tenant.organizationId, "round-trip", "key", "hash-a"),
            () => Effect.fail("abort"),
          ),
        );

        expect(await reserve(tenant)).toEqual(null);
      });

      it("two requests at once run the work once", async () => {
        const tenant = await seedTenant();

        const second = await contend(
          repository,
          tenant.admin,
          {
            lock: (tx) =>
              tx.reserveIdempotency(tenant.organizationId, "round-trip", "key", "hash-a"),
            write: (tx) =>
              tx.completeIdempotency(tenant.organizationId, "round-trip", "key", 200, {
                done: true,
              }),
          },
          (tx) => tx.reserveIdempotency(tenant.organizationId, "round-trip", "key", "hash-a"),
        );

        expect(second).toEqual({
          request_hash: "hash-a",
          response_body: { done: true },
          response_status: 200,
        });
      });
    });
  });
});
