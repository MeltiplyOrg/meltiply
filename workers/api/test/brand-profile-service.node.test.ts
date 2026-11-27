import type { SessionClaims } from "@meltiply/auth";
import { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { createBrandProfileService } from "../src/brand-profile-service";
import { CoreApiError } from "../src/api-errors";
import {
  FakeBrandProfileRepository,
  FakeBrandProfileStore,
} from "../src/repositories/fake-brand-profile-repository";
import { fakeEnv } from "../test-support/fakes";

const NOW = new Date("2026-02-01T00:00:00.000Z");
const ORG = "org-1";
const NEW_ID = "profile-new";
const env = fakeEnv();

const claims = (subject: string): SessionClaims => ({
  organizationId: ORG,
  organizationRole: subject,
  subject,
  userId: subject,
});
const admin = claims("admin");
const editor = claims("editor");

const alpha = {
  color: "#b91c1c",
  created_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  description: null,
  id: "profile-alpha",
  name: "Alpha",
  org_id: ORG,
  purge_at: null,
  updated_at: "2026-01-01T00:00:00.000Z",
};
const deleted = {
  ...alpha,
  deleted_at: "2026-01-15T00:00:00.000Z",
  id: "profile-gone",
  name: "Gone",
  purge_at: "2026-02-14T00:00:00.000Z",
};
const created = {
  ...alpha,
  created_at: NOW.toISOString(),
  id: NEW_ID,
  name: "Bravo",
  updated_at: NOW.toISOString(),
};
const channel = {
  access_token: "sealed",
  brand_profile_id: alpha.id,
  id: "channel-1",
  org_id: ORG,
  platform: "threads",
};

const notFound = new CoreApiError(404, "not_found", "The brand profile was not found.");
const adminRequired = new CoreApiError(
  403,
  "workspace_admin_required",
  "The workspace admin role is required.",
);
const duplicateName = new CoreApiError(
  409,
  "invalid_state",
  "A brand profile with this name already exists.",
);
const down = new DatabaseError({ message: "database down" });

function setup(now = NOW) {
  const store = new FakeBrandProfileStore(
    () => now,
    () => NEW_ID,
  );
  store.members.push(
    { organizationId: ORG, role: "admin", subject: "admin" },
    { organizationId: ORG, role: "editor", subject: "editor" },
  );
  store.brandProfiles.push({ ...alpha }, { ...deleted });
  const service = createBrandProfileService({
    now: () => now,
    repository: () => new FakeBrandProfileRepository(store),
  });
  return { service, store };
}

const run = <Value, Failure>(program: Effect.Effect<Value, Failure>) => Effect.runPromise(program);
const failure = <Value, Failure>(program: Effect.Effect<Value, Failure>) =>
  Effect.runPromise(Effect.flip(program));

describe("BrandProfileService", () => {
  describe("listBrandProfiles", () => {
    it("a Workspace with one active and one deleted profile", async () => {
      const { service } = setup();

      expect(await run(service.listBrandProfiles(env, editor))).toEqual([alpha]);
    });
  });

  describe("listDeletedBrandProfiles", () => {
    it("an Admin", async () => {
      const { service } = setup();

      expect(await run(service.listDeletedBrandProfiles(env, admin))).toEqual([deleted]);
    });

    it("an Editor", async () => {
      const { service } = setup();

      expect(await failure(service.listDeletedBrandProfiles(env, editor))).toEqual(adminRequired);
    });
  });

  describe("getBrandProfile", () => {
    it("a stored profile", async () => {
      const { service } = setup();

      expect(await run(service.getBrandProfile(env, editor, alpha.id))).toEqual(alpha);
    });

    it("an unknown profile", async () => {
      const { service } = setup();

      expect(await failure(service.getBrandProfile(env, editor, "missing"))).toEqual(notFound);
    });
  });

  describe("createBrandProfile", () => {
    const input = { color: "#b91c1c", name: "Bravo" };

    it("a new name", async () => {
      const { service, store } = setup();

      const result = await run(service.createBrandProfile(env, admin, input, "key-1"));

      expect(result).toEqual({ replayed: false, value: created });
      expect(store.brandProfiles).toEqual([alpha, deleted, created]);
      expect([...store.idempotencyKeys.values()]).toEqual([
        {
          request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          response_body: created,
          response_status: 201,
        },
      ]);
    });

    it("the same request twice", async () => {
      const { service, store } = setup();
      await run(service.createBrandProfile(env, admin, input, "key-1"));

      const result = await run(service.createBrandProfile(env, admin, input, "key-1"));

      expect(result).toEqual({ replayed: true, value: created });
      expect(store.brandProfiles).toEqual([alpha, deleted, created]);
    });

    it("a key reused for another request", async () => {
      const { service } = setup();
      await run(service.createBrandProfile(env, admin, input, "key-1"));

      const error = await failure(
        service.createBrandProfile(env, admin, { ...input, name: "Charlie" }, "key-1"),
      );

      expect(error).toEqual(
        new CoreApiError(
          409,
          "idempotency_conflict",
          "The Idempotency-Key was already used with a different request.",
        ),
      );
    });

    it("a name already taken", async () => {
      const { service, store } = setup();

      const error = await failure(
        service.createBrandProfile(env, admin, { ...input, name: "alpha" }, "key-1"),
      );

      expect(error).toEqual(duplicateName);
      expect(store.idempotencyKeys.size).toEqual(0);
    });

    it("an Editor", async () => {
      const { service, store } = setup();

      const error = await failure(service.createBrandProfile(env, editor, input, "key-1"));

      expect(error).toEqual(adminRequired);
      expect(store.brandProfiles).toEqual([alpha, deleted]);
    });

    it("someone outside the Workspace", async () => {
      const { service } = setup();

      const error = await failure(
        service.createBrandProfile(env, claims("stranger"), input, "key-1"),
      );

      expect(error).toEqual(
        new ActiveOrganizationRequiredError({
          message: "The authenticated identity is not an active organization member.",
        }),
      );
    });

    it("the database fails at commit", async () => {
      const { service, store } = setup();
      store.failNextCommit(down);

      expect(await failure(service.createBrandProfile(env, admin, input, "key-1"))).toEqual(down);
      expect(store.brandProfiles).toEqual([alpha, deleted]);
    });

    it("a retry after a failed commit", async () => {
      const { service, store } = setup();
      store.failNextCommit(down);
      await failure(service.createBrandProfile(env, admin, input, "key-1"));

      const result = await run(service.createBrandProfile(env, admin, input, "key-1"));

      expect(result).toEqual({ replayed: false, value: created });
    });
  });

  describe("updateBrandProfile", () => {
    const renamed = { ...alpha, name: "Renamed", updated_at: NOW.toISOString() };

    it("a new name", async () => {
      const { service, store } = setup();

      const result = await run(
        service.updateBrandProfile(env, admin, alpha.id, { name: "Renamed" }, "key-1"),
      );

      expect(result).toEqual({ replayed: false, value: renamed });
      expect(store.brandProfiles).toEqual([renamed, deleted]);
    });

    it("the same request twice", async () => {
      const { service } = setup();
      await run(service.updateBrandProfile(env, admin, alpha.id, { name: "Renamed" }, "key-1"));

      const result = await run(
        service.updateBrandProfile(env, admin, alpha.id, { name: "Renamed" }, "key-1"),
      );

      expect(result).toEqual({ replayed: true, value: renamed });
    });

    it("a deleted profile", async () => {
      const { service } = setup();

      const error = await failure(
        service.updateBrandProfile(env, admin, deleted.id, { name: "Back" }, "key-1"),
      );

      expect(error).toEqual(notFound);
    });

    it("a name already taken", async () => {
      const { service, store } = setup();

      const error = await failure(
        service.updateBrandProfile(env, admin, alpha.id, { name: "gone" }, "key-1"),
      );

      expect(error).toEqual(duplicateName);
      expect(store.brandProfiles).toEqual([alpha, deleted]);
    });

    it("an Editor", async () => {
      const { service } = setup();

      const error = await failure(
        service.updateBrandProfile(env, editor, alpha.id, { name: "Renamed" }, "key-1"),
      );

      expect(error).toEqual(adminRequired);
    });

    it("the database fails at commit", async () => {
      const { service, store } = setup();
      store.failNextCommit(down);

      const error = await failure(
        service.updateBrandProfile(env, admin, alpha.id, { name: "Renamed" }, "key-1"),
      );

      expect(error).toEqual(down);
      expect(store.brandProfiles).toEqual([alpha, deleted]);
    });
  });

  describe("deleteBrandProfile", () => {
    function connected() {
      const built = setup();
      built.store.channels.push({ ...channel });
      built.store.distributions.push({
        id: "distribution-1",
        platform_account_id: channel.id,
        status: "scheduled",
      });
      return built;
    }

    it("a profile with a connected Channel", async () => {
      const { service, store } = connected();

      const result = await run(service.deleteBrandProfile(env, admin, alpha.id, "key-1"));

      expect(result).toEqual({ replayed: false, value: alpha });
      expect(store.brandProfiles).toEqual([deleted]);
      expect(store.channels).toEqual([]);
      expect(store.distributions).toEqual([
        { id: "distribution-1", platform_account_id: channel.id, status: "cancelled" },
      ]);
      expect(store.outbox).toEqual([
        {
          dedupeKey: "channel-revocation:channel-1",
          org_id: ORG,
          payload: {
            access_token: "sealed",
            brand_profile_id: alpha.id,
            platform: "threads",
            platform_account_id: "channel-1",
            version: 1,
          },
        },
      ]);
    });

    it("the same request twice", async () => {
      const { service, store } = connected();
      await run(service.deleteBrandProfile(env, admin, alpha.id, "key-1"));

      const result = await run(service.deleteBrandProfile(env, admin, alpha.id, "key-1"));

      expect(result).toEqual({ replayed: true, value: alpha });
      expect(store.outbox).toHaveLength(1);
    });

    it("an unknown profile", async () => {
      const { service } = setup();

      expect(await failure(service.deleteBrandProfile(env, admin, "missing", "key-1"))).toEqual(
        notFound,
      );
    });

    it("an Editor", async () => {
      const { service, store } = connected();

      const error = await failure(service.deleteBrandProfile(env, editor, alpha.id, "key-1"));

      expect(error).toEqual(adminRequired);
      expect(store.channels).toEqual([channel]);
    });

    it("the database fails at commit", async () => {
      const { service, store } = connected();
      store.failNextCommit(down);

      expect(await failure(service.deleteBrandProfile(env, admin, alpha.id, "key-1"))).toEqual(
        down,
      );
      expect([store.brandProfiles.length, store.channels, store.outbox]).toEqual([
        2,
        [channel],
        [],
      ]);
    });
  });

  describe("restoreBrandProfile", () => {
    const restored = {
      ...deleted,
      deleted_at: null,
      purge_at: null,
      updated_at: NOW.toISOString(),
    };

    it("a profile inside its retention window", async () => {
      const { service, store } = setup();

      const result = await run(service.restoreBrandProfile(env, admin, deleted.id, "key-1"));

      expect(result).toEqual({ replayed: false, value: restored });
      expect(store.brandProfiles).toEqual([alpha, restored]);
    });

    it("a profile after its retention window", async () => {
      const { service, store } = setup(new Date("2026-02-15T00:00:00.000Z"));

      const error = await failure(service.restoreBrandProfile(env, admin, deleted.id, "key-1"));

      expect(error).toEqual(
        new CoreApiError(409, "invalid_state", "The brand profile retention window has elapsed."),
      );
      expect(store.brandProfiles).toEqual([alpha, deleted]);
    });

    it("an active profile", async () => {
      const { service } = setup();

      expect(await failure(service.restoreBrandProfile(env, admin, alpha.id, "key-1"))).toEqual(
        new CoreApiError(409, "invalid_state", "The brand profile is not deleted."),
      );
    });

    it("the same request twice", async () => {
      const { service } = setup();
      await run(service.restoreBrandProfile(env, admin, deleted.id, "key-1"));

      const result = await run(service.restoreBrandProfile(env, admin, deleted.id, "key-1"));

      expect(result).toEqual({ replayed: true, value: restored });
    });

    it("an unknown profile", async () => {
      const { service } = setup();

      expect(await failure(service.restoreBrandProfile(env, admin, "missing", "key-1"))).toEqual(
        notFound,
      );
    });

    it("an Editor", async () => {
      const { service } = setup();

      expect(await failure(service.restoreBrandProfile(env, editor, deleted.id, "key-1"))).toEqual(
        adminRequired,
      );
    });
  });
});
