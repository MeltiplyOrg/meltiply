import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/core-types";
import { settledDistributionStatuses } from "../src/distribution-service";
import { mapQueue, type QueueMutationInput } from "../src/publishing-queue-rules";
import {
  FakePublishingQueueRepository,
  FakePublishingQueueStore,
} from "../src/repositories/fake-publishing-queue-repository";
import { postgresPublishingQueueRepository } from "../src/repositories/postgres-publishing-queue-repository";
import type { PublishingQueueRepositoryProvider } from "../src/repositories/publishing-queue-repository";
import {
  seedDistribution,
  seedMembership,
  seedPost,
  seedProfile,
  seedPublishCommand,
} from "./queue-fixtures";
import {
  closeDatabase,
  contend,
  database,
  databaseEnv,
  inTransaction,
  failureOf,
  seedFakeTenant,
  seedPostgresTenant,
  type Tenant,
} from "./tenant-harness";

type Status = "cancelled" | "processing" | "published" | "queued" | "scheduled";

interface Harness {
  commandStates(distributionId: string): Promise<string[]>;
  distributionStatus(distributionId: string): Promise<string | undefined>;
  repository: ReturnType<PublishingQueueRepositoryProvider>;
  seedDistribution(
    tenant: Tenant,
    postId: string,
    status: Status,
    claimed?: boolean,
  ): Promise<string>;
  seedMembership(tenant: Tenant, queueId: string, postId: string): Promise<void>;
  seedPost(tenant: Tenant, brandProfileId: string): Promise<string>;
  seedProfile(tenant: Tenant): Promise<string>;
  seedPublishCommand(
    tenant: Tenant,
    distributionId: string,
    state: "failed" | "leased" | "pending" | "published",
  ): Promise<void>;
  tenant(): Promise<Tenant>;
}

function postgresHarness(): Harness {
  const profileOfPost = new Map<string, string>();
  const profileOfQueue = async (queueId: string) => {
    const result = await database().query<{ brand_profile_id: string }>(
      "SELECT brand_profile_id FROM publishing_queues WHERE id = $1",
      [queueId],
    );
    return result.rows[0]!.brand_profile_id;
  };
  return {
    async commandStates(distributionId) {
      const result = await database().query<{ state: string }>(
        "SELECT state FROM outbox_events WHERE aggregate_id = $1 ORDER BY state",
        [distributionId],
      );
      return result.rows.map((row) => row.state);
    },
    async distributionStatus(distributionId) {
      const result = await database().query<{ status: string }>(
        "SELECT status FROM distributions WHERE id = $1",
        [distributionId],
      );
      return result.rows[0]?.status;
    },
    repository: postgresPublishingQueueRepository(databaseEnv),
    seedDistribution: (tenant, postId, status, claimed) =>
      seedDistribution(
        tenant,
        profileOfPost.get(postId)!,
        postId,
        status,
        claimed ? "attempt_count = 1" : "",
      ),
    async seedMembership(tenant, queueId, postId) {
      await seedMembership(tenant, await profileOfQueue(queueId), queueId, postId);
    },
    async seedPost(tenant, brandProfileId) {
      const id = await seedPost(tenant, brandProfileId);
      profileOfPost.set(id, brandProfileId);
      return id;
    },
    seedProfile,
    seedPublishCommand,
    tenant: seedPostgresTenant,
  };
}

function fakeHarness(): Harness {
  const store = new FakePublishingQueueStore(() => new Date(), randomUUID);
  return {
    commandStates: (distributionId) =>
      Promise.resolve(
        store.publishCommands
          .filter((command) => command.aggregate_id === distributionId)
          .map((command) => command.state)
          .toSorted(),
      ),
    distributionStatus: (distributionId) =>
      Promise.resolve(store.distributions.find((row) => row.id === distributionId)?.status),
    repository: new FakePublishingQueueRepository(store),
    seedDistribution(_tenant, postId, status, claimed = false) {
      const id = randomUUID();
      store.distributions.push({ id, owned: claimed, post_id: postId, status });
      return Promise.resolve(id);
    },
    seedMembership(_tenant, queueId, postId) {
      store.memberships.push({ post_id: postId, queue_id: queueId, released_at: null });
      return Promise.resolve();
    },
    seedPost(tenant, brandProfileId) {
      const id = randomUUID();
      store.posts.push({
        org_id: tenant.organizationId,
        post: {
          analytics: null,
          attachments: [],
          brand_profile_id: brandProfileId,
          created_at: "2026-01-01T00:00:00.000Z",
          default_text: "Caption",
          distribution_analytics: [],
          distributions: [],
          id,
          org_id: tenant.organizationId,
          queue_membership: null,
          revision: 0,
          status: "active",
          targets: [],
          title: "Round trip",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      });
      return Promise.resolve(id);
    },
    seedProfile(tenant) {
      const id = randomUUID();
      store.brandProfiles.push({
        color: "#b91c1c",
        created_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null,
        description: null,
        id,
        name: id,
        org_id: tenant.organizationId,
        purge_at: null,
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      return Promise.resolve(id);
    },
    seedPublishCommand(_tenant, distributionId, state) {
      store.publishCommands.push({ aggregate_id: distributionId, state });
      return Promise.resolve();
    },
    tenant: () => Promise.resolve(seedFakeTenant(store)),
  };
}

afterAll(closeDatabase);

describe("PublishingQueueRepository", () => {
  describe.each([
    ["Postgres", postgresHarness],
    ["fake", fakeHarness],
  ])("%s", (_name, createHarness) => {
    const harness = createHarness();
    const { repository } = harness;

    const configuration = (brandProfileId: string): QueueMutationInput => ({
      brand_profile_id: brandProfileId,
      name: "Weekly",
      slots: [{ weekday: 1, time: "09:00" }],
      timezone: "America/New_York",
    });

    async function planned() {
      const tenant = await harness.tenant();
      const profileId = await harness.seedProfile(tenant);
      const insert = () =>
        inTransaction(repository, tenant.admin, (tx) =>
          tx.insertQueue(tenant.organizationId, configuration(profileId)),
        );
      const queue = await insert();
      const read = (id = queue.id) =>
        inTransaction(repository, tenant.viewer, (tx) => tx.queue(id));
      return { insert, profileId, queue, read, tenant };
    }

    async function queued() {
      const built = await planned();
      const postId = await harness.seedPost(built.tenant, built.profileId);
      await harness.seedMembership(built.tenant, built.queue.id, postId);
      return { ...built, postId };
    }

    describe("queue round trip", () => {
      it("a new Queue", async () => {
        const { profileId, queue, read, tenant } = await planned();

        const row = await read();

        expect(mapQueue(row!)).toEqual(queue);
        expect(row).toMatchObject({ brand_profile_id: profileId, org_id: tenant.organizationId });
      });

      it("a Queue with several slots", async () => {
        const { profileId, tenant, read } = await planned();
        const slots = [
          { weekday: 0, time: "00:00" },
          { weekday: 6, time: "23:59" },
        ];

        const queue = await inTransaction(repository, tenant.admin, (tx) =>
          tx.insertQueue(tenant.organizationId, { ...configuration(profileId), slots }),
        );

        expect((await read(queue.id))!.slots).toEqual(slots);
      });

      it("an unknown Queue", async () => {
        const { read } = await planned();

        expect(await read(randomUUID())).toEqual(null);
      });

      it("another Workspace's Queue", async () => {
        const { read } = await planned();
        const other = await planned();

        expect(await read(other.queue.id)).toEqual(null);
      });

      it("the owner of a Queue", async () => {
        const { profileId, queue, tenant } = await planned();

        expect(
          await inTransaction(repository, tenant.admin, (tx) => tx.queueOwner(queue.id)),
        ).toEqual({ brand_profile_id: profileId, org_id: tenant.organizationId });
      });

      it("an updated Queue", async () => {
        const { queue, read, tenant } = await planned();
        const changes = {
          name: "Daily",
          slots: [{ weekday: 2, time: "10:00" }],
          timezone: "UTC",
        };

        const updated = await inTransaction(repository, tenant.admin, (tx) =>
          tx.updateQueue(queue.id, changes),
        );

        expect(updated).toEqual({ ...queue, ...changes, updated_at: expect.any(String) });
        expect(mapQueue((await read())!)).toEqual(updated);
      });

      it("a retired Queue", async () => {
        const { profileId, queue, read, tenant } = await planned();

        await inTransaction(repository, tenant.admin, (tx) => tx.retireQueue(queue.id));

        expect(await read()).toEqual(null);
        expect(
          await inTransaction(repository, tenant.admin, (tx) => tx.queueOwner(queue.id)),
        ).toEqual(null);
        expect(
          await inTransaction(repository, tenant.admin, (tx) =>
            tx.queuesAfter(profileId, null, 10),
          ),
        ).toEqual([]);
      });
    });

    describe("queuesAfter", () => {
      async function three() {
        const built = await planned();
        const queues = [built.queue, await built.insert(), await built.insert()].toSorted((a, b) =>
          a.id < b.id ? -1 : 1,
        );
        const page = (cursor: string | null, count: number) =>
          inTransaction(repository, built.tenant.viewer, (tx) =>
            tx.queuesAfter(built.profileId, cursor, count),
          );
        return { page, queues };
      }

      it("every Queue in id order", async () => {
        const { page, queues } = await three();

        expect(await page(null, 10)).toEqual(queues);
      });

      it("the count caps the page", async () => {
        const { page, queues } = await three();

        expect(await page(null, 2)).toEqual(queues.slice(0, 2));
      });

      it("the cursor itself is excluded", async () => {
        const { page, queues } = await three();

        expect(await page(queues[0]!.id, 10)).toEqual(queues.slice(1));
      });

      it("another Brand Profile", async () => {
        const { profileId, tenant } = await planned();
        const otherProfile = await harness.seedProfile(tenant);

        expect(
          await inTransaction(repository, tenant.viewer, (tx) =>
            tx.queuesAfter(otherProfile, null, 10),
          ),
        ).toEqual([]);
        expect(profileId).not.toEqual(otherProfile);
      });
    });

    describe("hasPendingMemberships", () => {
      const pending = (tenant: Tenant, queueId: string) =>
        inTransaction(repository, tenant.admin, (tx) =>
          tx.hasPendingMemberships(queueId, settledDistributionStatuses),
        );

      it("a Queue without memberships", async () => {
        const { queue, tenant } = await planned();

        expect(await pending(tenant, queue.id)).toEqual(false);
      });

      it("a membership without Distributions", async () => {
        const { queue, tenant } = await queued();

        expect(await pending(tenant, queue.id)).toEqual(true);
      });

      it("a released membership", async () => {
        const { postId, queue, tenant } = await queued();
        await inTransaction(repository, tenant.admin, (tx) => tx.releaseQueueMembership(postId));

        expect(await pending(tenant, queue.id)).toEqual(false);
      });

      it("only settled Distributions", async () => {
        const { postId, queue, tenant } = await queued();
        await harness.seedDistribution(tenant, postId, "published");
        await harness.seedDistribution(tenant, postId, "cancelled");

        expect(await pending(tenant, queue.id)).toEqual(false);
      });

      it("one unsettled Distribution among settled ones", async () => {
        const { postId, queue, tenant } = await queued();
        await harness.seedDistribution(tenant, postId, "published");
        await harness.seedDistribution(tenant, postId, "processing");

        expect(await pending(tenant, queue.id)).toEqual(true);
      });
    });

    describe("lockQueuedPost", () => {
      const locked = (tenant: Tenant, postId: string) =>
        inTransaction(repository, tenant.editor, (tx) =>
          Effect.map(tx.lockQueuedPost(postId), ({ brandProfileId, queueId }) => ({
            brandProfileId,
            queueId,
          })),
        );

      it("a queued Post", async () => {
        const { postId, profileId, queue, tenant } = await queued();

        expect(await locked(tenant, postId)).toEqual({
          brandProfileId: profileId,
          queueId: queue.id,
        });
      });

      it("a Post outside any Queue", async () => {
        const { profileId, tenant } = await planned();
        const postId = await harness.seedPost(tenant, profileId);

        expect(await locked(tenant, postId)).toEqual({
          brandProfileId: profileId,
          queueId: null,
        });
      });

      it("an unknown Post", async () => {
        const { tenant } = await planned();

        expect(
          await failureOf(repository, tenant.editor, (tx) => tx.lockQueuedPost(randomUUID())),
        ).toEqual(new CoreApiError(404, "post_not_found", "The post was not found."));
      });

      it("the released read model", async () => {
        const { postId, tenant } = await queued();

        const released = await inTransaction(repository, tenant.editor, (tx) =>
          Effect.flatMap(tx.lockQueuedPost(postId), (post) => post.released()),
        );

        expect(released).toMatchObject({ distributions: [], id: postId, queue_membership: null });
      });

      const releasedUnderContention = async (organizationFirst: boolean) => {
        const { postId, queue, tenant } = await queued();
        const locked = (tx: Parameters<Parameters<typeof repository.transaction>[1]>[0]) =>
          Effect.andThen(
            organizationFirst ? tx.lockOrganization(tenant.organizationId) : Effect.void,
            () => Effect.map(tx.lockQueuedPost(postId), (post) => post.queueId),
          );
        const second = await contend(
          repository,
          tenant.editor,
          { lock: locked, write: (tx) => tx.releaseQueueMembership(postId) },
          locked,
        );
        return { queueId: queue.id, second };
      };

      it("a second removal under the organization lock sees the release", async () => {
        expect((await releasedUnderContention(true)).second).toEqual(null);
      });

      it("the post row lock alone keeps the membership read before waiting", async () => {
        const { queueId, second } = await releasedUnderContention(false);

        expect(second).toEqual(queueId);
      });
    });

    describe("lockPostDistributions", () => {
      const outcomes = (tenant: Tenant, postId: string) =>
        inTransaction(repository, tenant.editor, (tx) => tx.lockPostDistributions(postId));

      it("a Post without Distributions", async () => {
        const { postId, tenant } = await queued();

        expect(await outcomes(tenant, postId)).toEqual([]);
      });

      it.each([
        ["an unclaimed Distribution", false],
        ["a claimed Distribution", true],
      ])("%s", async (_example, claimed) => {
        const { postId, tenant } = await queued();
        const id = await harness.seedDistribution(tenant, postId, "queued", claimed);

        expect(await outcomes(tenant, postId)).toEqual([{ id, owned: claimed, status: "queued" }]);
      });

      it("a change sees the status another removal wrote", async () => {
        const { postId, tenant } = await queued();
        const id = await harness.seedDistribution(tenant, postId, "queued");

        const second = await contend(
          repository,
          tenant.editor,
          {
            lock: (tx) => tx.lockPostDistributions(postId),
            write: (tx) => tx.cancelUnstartedDistributions([id]),
          },
          (tx) => tx.lockPostDistributions(postId),
        );

        expect(second).toEqual([{ id, owned: false, status: "cancelled" }]);
      });
    });

    describe("cancelUnstartedDistributions", () => {
      it.each([
        ["scheduled", "cancelled"],
        ["queued", "cancelled"],
        ["processing", "processing"],
      ] as const)("a %s Distribution", async (status, expected) => {
        const { postId, tenant } = await queued();
        const id = await harness.seedDistribution(tenant, postId, status);

        await inTransaction(repository, tenant.editor, (tx) =>
          tx.cancelUnstartedDistributions([id]),
        );

        expect(await harness.distributionStatus(id)).toEqual(expected);
      });

      it("a Distribution that was not asked for", async () => {
        const { postId, tenant } = await queued();
        const id = await harness.seedDistribution(tenant, postId, "queued");

        await inTransaction(repository, tenant.editor, (tx) =>
          tx.cancelUnstartedDistributions([randomUUID()]),
        );

        expect(await harness.distributionStatus(id)).toEqual("queued");
      });
    });

    describe("withdrawPublishCommands", () => {
      it.each([
        ["pending", []],
        ["failed", []],
        ["leased", ["leased"]],
        ["published", ["published"]],
      ] as const)("a %s command", async (state, remaining) => {
        const { postId, tenant } = await queued();
        const id = await harness.seedDistribution(tenant, postId, "queued");
        await harness.seedPublishCommand(tenant, id, state);

        await inTransaction(repository, tenant.editor, (tx) => tx.withdrawPublishCommands([id]));

        expect(await harness.commandStates(id)).toEqual(remaining);
      });
    });

    describe("releaseQueueMembership", () => {
      it("a queued Post leaves its Queue", async () => {
        const { postId, tenant } = await queued();

        await inTransaction(repository, tenant.editor, (tx) => tx.releaseQueueMembership(postId));

        expect(
          await inTransaction(repository, tenant.editor, (tx) =>
            Effect.map(tx.lockQueuedPost(postId), (post) => post.queueId),
          ),
        ).toEqual(null);
      });
    });
  });

  describe("lockPostDistributions claim filter", () => {
    const repository = postgresPublishingQueueRepository(databaseEnv);

    async function distribution(claim: string) {
      const tenant = await seedPostgresTenant();
      const profileId = await seedProfile(tenant);
      const postId = await seedPost(tenant, profileId);
      const id = await seedDistribution(tenant, profileId, postId, "queued", claim);
      const owned = async () => {
        const rows = await inTransaction(repository, tenant.editor, (tx) =>
          tx.lockPostDistributions(postId),
        );
        return rows[0]!.owned;
      };
      return { id, owned, tenant };
    }

    it.each([
      ["an attempt", "attempt_count = 1"],
      ["a Provider operation id", "provider_operation_id = 'op'"],
      ["a last attempt time", "last_attempt_at = now()"],
      ["a publication time", "published_at = now()"],
      ["a Provider Post id", "platform_post_id = 'post'"],
      ["a requested cancellation", "cancel_requested_at = now()"],
    ])("%s", async (_example, claim) => {
      expect(await (await distribution(claim)).owned()).toEqual(true);
    });

    it("a recorded Provider operation", async () => {
      const { id, owned, tenant } = await distribution("");
      await database().query(
        `INSERT INTO provider_operations (org_id, distribution_id, operation, idempotency_key)
         VALUES ($1, $2, 'publish', $3)`,
        [tenant.organizationId, id, randomUUID()],
      );

      expect(await owned()).toEqual(true);
    });

    it.each([
      ["a leased publish command", "leased", true],
      ["a pending publish command", "pending", false],
    ])("%s", async (_example, state, expected) => {
      const { id, owned, tenant } = await distribution("");
      await seedPublishCommand(tenant, id, state);

      expect(await owned()).toEqual(expected);
    });
  });
});
