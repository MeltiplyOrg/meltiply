import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/api-errors";
import { createPublishingQueueApiService } from "../src/publishing-queue-service";
import {
  FakePublishingQueueRepository,
  FakePublishingQueueStore,
} from "../src/repositories/fake-publishing-queue-repository";
import { fakeEnv } from "../test-support/fakes";

const NOW = new Date("2026-02-01T00:00:00.000Z");
const ORG = "org-1";
const NEW_ID = "queue-new";
const env = fakeEnv();

const claims = (subject: string): SessionClaims => ({
  organizationId: ORG,
  organizationRole: subject,
  subject,
  userId: subject,
});
const admin = claims("admin");
const editor = claims("editor");
const viewer = claims("viewer");

const queue = (id: string) => ({
  brand_profile_id: "profile-1",
  created_at: "2026-01-01T00:00:00.000Z",
  id,
  name: "Weekly",
  slots: [{ weekday: 1, time: "09:00" }],
  timezone: "UTC",
  updated_at: "2026-01-01T00:00:00.000Z",
});
const storedQueue = (id: string) => ({ ...queue(id), deleted_at: null, org_id: ORG });
const configuration = {
  brand_profile_id: "profile-1",
  name: "Daily",
  slots: [{ weekday: 2, time: "10:00" }],
  timezone: "Europe/Paris",
};
const created = {
  ...configuration,
  created_at: NOW.toISOString(),
  id: NEW_ID,
  updated_at: NOW.toISOString(),
};
const scope = { brand_profile_id: "profile-1" };
const post: components["schemas"]["Post"] = {
  analytics: null,
  attachments: [],
  brand_profile_id: "profile-1",
  created_at: "2026-01-01T00:00:00.000Z",
  default_text: "Launch",
  distribution_analytics: [],
  distributions: [{ id: "distribution-1", status: "scheduled" } as never],
  id: "post-1",
  org_id: ORG,
  queue_membership: {
    assigned_at: "2026-02-02T09:00:00.000Z",
    queue_id: "queue-1",
    queue_name: "Weekly",
  },
  revision: 0,
  status: "active",
  targets: [],
  title: "Launch",
  updated_at: "2026-01-01T00:00:00.000Z",
};
const released = {
  ...post,
  distributions: [{ id: "distribution-1", status: "cancelled" }],
  queue_membership: null,
};

const queueMissing = new CoreApiError(
  404,
  "not_found",
  "The Queue was not found in this Brand Profile.",
);
const notMember = new CoreApiError(404, "not_found", "The Post is not a member of this Queue.");
const adminRequired = new CoreApiError(
  403,
  "workspace_admin_required",
  "Only Workspace Admins can configure Queues.",
);
const profileDeleted = new CoreApiError(
  409,
  "brand_profile_deleted",
  "The brand profile is deleted and cannot accept new data.",
);
const down = new DatabaseError({ message: "database down" });

function setup() {
  const store = new FakePublishingQueueStore(
    () => NOW,
    () => NEW_ID,
  );
  store.members.push(
    { organizationId: ORG, role: "admin", subject: "admin" },
    { organizationId: ORG, role: "editor", subject: "editor" },
    { organizationId: ORG, role: "viewer", subject: "viewer" },
  );
  const profile = {
    color: "#b91c1c",
    created_at: NOW.toISOString(),
    deleted_at: null,
    description: null,
    id: "profile-1",
    name: "Alpha",
    org_id: ORG,
    purge_at: null,
    updated_at: NOW.toISOString(),
  };
  store.brandProfiles.push(profile, {
    ...profile,
    deleted_at: NOW.toISOString(),
    id: "profile-gone",
    name: "Gone",
  });
  store.queues.push(storedQueue("queue-1"), storedQueue("queue-2"));
  const service = createPublishingQueueApiService({
    repository: () => new FakePublishingQueueRepository(store),
  });
  return { service, store };
}

function queuedPost(status: "scheduled" | "processing" = "scheduled") {
  const built = setup();
  built.store.posts.push({ org_id: ORG, post: structuredClone(post) });
  built.store.memberships.push({ post_id: "post-1", queue_id: "queue-1", released_at: null });
  built.store.distributions.push({ id: "distribution-1", owned: false, post_id: "post-1", status });
  built.store.publishCommands.push({ aggregate_id: "distribution-1", state: "pending" });
  const remove = (session = editor, queueId = "queue-1", brand = "profile-1") =>
    built.service.removePost(env, session, queueId, "post-1", brand, "remove-1");
  return { ...built, remove };
}

const run = <Value, Failure>(program: Effect.Effect<Value, Failure>) => Effect.runPromise(program);
const failure = <Value, Failure>(program: Effect.Effect<Value, Failure>) =>
  Effect.runPromise(Effect.flip(program));

describe("PublishingQueueService", () => {
  describe("list", () => {
    it("a first page with more to come", async () => {
      const { service } = setup();

      expect(await run(service.list(env, viewer, "profile-1", 1))).toEqual({
        items: [queue("queue-1")],
        next_cursor: "queue-1",
      });
    });

    it("the page after a cursor", async () => {
      const { service } = setup();

      expect(await run(service.list(env, viewer, "profile-1", 1, "queue-1"))).toEqual({
        items: [queue("queue-2")],
        next_cursor: null,
      });
    });

    it("an unknown Brand Profile", async () => {
      const { service } = setup();

      expect(await failure(service.list(env, viewer, "profile-9", 1))).toEqual(
        new CoreApiError(404, "brand_profile_not_found", "The brand profile was not found."),
      );
    });
  });

  describe("get", () => {
    it("a stored Queue", async () => {
      const { service } = setup();

      expect(await run(service.get(env, viewer, "queue-1"))).toEqual(queue("queue-1"));
    });

    it("an unknown Queue", async () => {
      const { service } = setup();

      expect(await failure(service.get(env, viewer, "queue-9"))).toEqual(queueMissing);
    });

    it("a Queue of a deleted Brand Profile, for an Admin", async () => {
      const { service, store } = setup();
      store.queues.push({ ...storedQueue("queue-3"), brand_profile_id: "profile-gone" });

      expect(await failure(service.get(env, admin, "queue-3"))).toEqual(profileDeleted);
    });
  });

  describe("mutate create", () => {
    const create = (
      service: ReturnType<typeof setup>["service"],
      session = admin,
      input = configuration,
      key = "key-1",
    ) => service.createQueue(env, session, input, key);

    it("an Admin", async () => {
      const { service, store } = setup();

      const result = await run(create(service));

      expect(result).toEqual({ replayed: false, value: created });
      expect(store.queues[2]).toEqual({ ...created, deleted_at: null, org_id: ORG });
      expect([...store.idempotencyKeys.values()]).toEqual([
        {
          request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          response_body: created,
          response_status: 201,
        },
      ]);
    });

    it("an Editor", async () => {
      const { service, store } = setup();

      expect(await failure(create(service, editor))).toEqual(adminRequired);
      expect(store.queues).toHaveLength(2);
    });

    it("an unsupported timezone", async () => {
      const { service, store } = setup();

      const error = await failure(
        create(service, admin, { ...configuration, timezone: "No/Zone" }),
      );

      expect(error).toEqual(
        new CoreApiError(422, "validation_error", "Use a supported IANA timezone."),
      );
      expect(store.queues).toHaveLength(2);
    });

    it("a deleted Brand Profile", async () => {
      const { service } = setup();

      const input = { ...configuration, brand_profile_id: "profile-gone" };

      expect(await failure(create(service, admin, input))).toEqual(profileDeleted);
    });

    it("the same request twice", async () => {
      const { service, store } = setup();
      await run(create(service));

      expect(await run(create(service))).toEqual({ replayed: true, value: created });
      expect(store.queues).toHaveLength(3);
    });

    it("a key reused for another request", async () => {
      const { service } = setup();
      await run(create(service));

      const error = await failure(create(service, admin, { ...configuration, name: "Other" }));

      expect(error).toEqual(
        new CoreApiError(
          409,
          "idempotency_conflict",
          "The Idempotency-Key was already used with a different request.",
        ),
      );
    });

    it("the database fails at commit", async () => {
      const { service, store } = setup();
      store.failNextCommit(down);

      expect(await failure(create(service))).toEqual(down);
      expect(store.queues).toHaveLength(2);
    });

    it("a retry after a failed commit", async () => {
      const { service, store } = setup();
      store.failNextCommit(down);
      await failure(create(service));

      expect(await run(create(service))).toEqual({ replayed: false, value: created });
    });
  });

  describe("mutate update", () => {
    const update = (service: ReturnType<typeof setup>["service"], id: string, input: object) =>
      service.updateQueue(env, admin, id, { ...scope, ...input }, "key-1");

    it("a new name", async () => {
      const { service, store } = setup();
      const renamed = { ...queue("queue-1"), name: "Renamed", updated_at: NOW.toISOString() };

      const result = await run(update(service, "queue-1", { name: "Renamed" }));

      expect(result).toEqual({ replayed: false, value: renamed });
      expect(store.queues[0]).toEqual({ ...renamed, deleted_at: null, org_id: ORG });
    });

    it("an unknown Queue", async () => {
      const { service } = setup();

      expect(await failure(update(service, "queue-9", { name: "Renamed" }))).toEqual(queueMissing);
    });

    it("a Queue of another Brand Profile", async () => {
      const { service, store } = setup();
      store.queues.push({ ...storedQueue("queue-3"), brand_profile_id: "profile-2" });

      expect(await failure(update(service, "queue-3", { name: "Renamed" }))).toEqual(queueMissing);
    });
  });

  describe("mutate delete", () => {
    const retire = (service: ReturnType<typeof setup>["service"], id = "queue-1") =>
      service.deleteQueue(env, admin, id, scope, "key-1");

    it("a Queue without pending Posts", async () => {
      const { service, store } = setup();

      const result = await run(retire(service));

      expect(result).toEqual({ replayed: false, value: null });
      expect(store.queues[0]?.deleted_at).toEqual(NOW.toISOString());
      expect([...store.idempotencyKeys.values()]).toEqual([
        {
          request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          response_body: null,
          response_status: 204,
        },
      ]);
    });

    it("a Queue with a pending Post", async () => {
      const { service, store } = queuedPost();

      expect(await failure(retire(service))).toEqual(
        new CoreApiError(
          409,
          "queue_has_pending_posts",
          "Remove pending Posts before deleting this Queue. In-flight work must settle first.",
        ),
      );
      expect(store.queues[0]?.deleted_at).toEqual(null);
    });

    it("an unknown Queue", async () => {
      const { service } = setup();

      expect(await failure(retire(service, "queue-9"))).toEqual(queueMissing);
    });

    it("the same request twice", async () => {
      const { service } = setup();
      await run(retire(service));

      expect(await run(retire(service))).toEqual({ replayed: true, value: null });
    });
  });

  describe("removePost", () => {
    it("a scheduled Post, by an Editor", async () => {
      const { remove, store } = queuedPost();

      const result = await run(remove());

      expect(result).toEqual({ replayed: false, value: released });
      expect(store.memberships[0]?.released_at).toEqual(NOW.toISOString());
      expect(store.distributions[0]?.status).toEqual("cancelled");
      expect(store.publishCommands).toEqual([]);
    });

    it("a Post of a retired Queue", async () => {
      const { remove, store } = queuedPost("scheduled");
      store.queues[0]!.deleted_at = NOW.toISOString();

      expect(await run(remove())).toEqual({ replayed: false, value: released });
    });

    it("a Viewer", async () => {
      const { remove } = queuedPost();

      expect(await failure(remove(viewer))).toEqual(
        new CoreApiError(403, "forbidden_role", "Your Workspace role is read-only."),
      );
    });

    it.each([
      ["another Queue", "queue-2", "profile-1"],
      ["another Brand Profile", "queue-1", "profile-2"],
    ])("%s", async (_example, queueId, brandProfileId) => {
      const { remove, store } = queuedPost();

      expect(await failure(remove(editor, queueId, brandProfileId))).toEqual(notMember);
      expect(store.memberships[0]?.released_at).toEqual(null);
    });

    it("a Post a Provider attempt holds", async () => {
      const { remove, store } = queuedPost("processing");

      expect(await failure(remove())).toEqual(
        new CoreApiError(
          409,
          "queue_post_in_flight",
          "Only unclaimed pending Posts can be removed. Provider-owned outcomes remain unchanged.",
        ),
      );
      expect(store.memberships[0]?.released_at).toEqual(null);
    });

    it("an unknown Post", async () => {
      const { service } = setup();

      expect(
        await failure(
          service.removePost(env, editor, "queue-1", "post-9", "profile-1", "remove-1"),
        ),
      ).toEqual(new CoreApiError(404, "post_not_found", "The post was not found."));
    });

    it("the same request twice", async () => {
      const { remove } = queuedPost();
      await run(remove());

      expect(await run(remove())).toEqual({ replayed: true, value: released });
    });

    it("the database fails at commit", async () => {
      const { remove, store } = queuedPost();
      store.failNextCommit(down);

      expect(await failure(remove())).toEqual(down);
      expect([store.memberships[0]?.released_at, store.distributions[0]?.status]).toEqual([
        null,
        "scheduled",
      ]);
    });
  });
});
