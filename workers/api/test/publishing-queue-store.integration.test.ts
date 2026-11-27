import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/api-errors";
import { withTenantTransactionEffect } from "../src/database";
import {
  releaseQueueMembershipEffect,
  requireNoQueueMembershipEffect,
  reserveQueueSlotEffect,
} from "../src/publishing-queue-store";
import { seedPost, seedProfile } from "./queue-fixtures";
import { closeDatabase, database, databaseEnv, seedPostgresTenant } from "./tenant-harness";

type Slot = { time: string; weekday: number };

async function plan(slots: Slot[], timezone = "UTC", deletedProfile = false) {
  const tenant = await seedPostgresTenant();
  const profileId = await seedProfile(tenant, deletedProfile);
  const queue = async (name = "Weekly") => {
    const result = await database().query<{ id: string }>(
      `INSERT INTO publishing_queues (org_id, brand_profile_id, name, timezone, slots)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [tenant.organizationId, profileId, name, timezone, JSON.stringify(slots)],
    );
    return result.rows[0]!.id;
  };
  const queueId = await queue();
  const post = () => seedPost(tenant, profileId);
  const inTenant = <Value, Failure>(
    work: Parameters<typeof withTenantTransactionEffect<Value, Failure, never>>[2],
  ) => withTenantTransactionEffect(databaseEnv, tenant.admin, work);
  const reserve = (postId: string, now: string, id = queueId, profile = profileId) =>
    inTenant((client) =>
      reserveQueueSlotEffect(client, tenant.organizationId, profile, postId, id, new Date(now)),
    );
  const assigned = (postId: string, now: string, id = queueId) =>
    Effect.runPromise(reserve(postId, now, id));
  const refused = (postId: string, now: string, id = queueId, profile = profileId) =>
    Effect.runPromise(Effect.flip(reserve(postId, now, id, profile)));
  return { assigned, inTenant, post, profileId, queue, queueId, refused };
}

const MONDAYS = [
  { weekday: 1, time: "09:00" },
  { weekday: 1, time: "09:01" },
];
const exists = new CoreApiError(
  409,
  "queue_membership_exists",
  "Remove this Post from its Queue before changing plans or reusing an elapsed reservation.",
);
const notFound = new CoreApiError(
  404,
  "not_found",
  "The Queue was not found in this Brand Profile.",
);

afterAll(closeDatabase);

describe("publishing queue store", () => {
  describe("reserveQueueSlotEffect", () => {
    it.each([
      [
        "a local time skipped by daylight saving",
        "2026-03-08T06:00:00Z",
        "America/New_York",
        { weekday: 0, time: "02:30" },
        "2026-03-15T06:30:00.000Z",
      ],
      [
        "a local time repeated by daylight saving",
        "2026-11-01T04:00:00Z",
        "America/New_York",
        { weekday: 0, time: "01:30" },
        "2026-11-01T06:30:00.000Z",
      ],
      [
        "a quarter-hour offset exactly at the slot",
        "2026-10-26T08:30:00Z",
        "Asia/Kathmandu",
        { weekday: 1, time: "14:15" },
        "2026-11-02T08:30:00.000Z",
      ],
      [
        "one second before the slot",
        "2026-10-25T23:59:59Z",
        "UTC",
        { weekday: 1, time: "00:00" },
        "2026-10-26T00:00:00.000Z",
      ],
    ])("%s", async (_example, now, timezone, slot, expected) => {
      const { assigned, post } = await plan([slot], timezone);

      expect(await assigned(await post(), now)).toEqual(new Date(expected));
    });

    it("a slot another Post holds", async () => {
      const { assigned, post } = await plan(MONDAYS);
      await assigned(await post(), "2026-10-26T08:00:00Z");

      expect(await assigned(await post(), "2026-10-26T08:00:00Z")).toEqual(
        new Date("2026-10-26T09:01:00.000Z"),
      );
    });

    it("every slot of the week is held", async () => {
      const { assigned, post } = await plan([{ weekday: 1, time: "09:00" }]);
      await assigned(await post(), "2026-10-26T08:00:00Z");

      expect(await assigned(await post(), "2026-10-26T08:00:00Z")).toEqual(
        new Date("2026-11-02T09:00:00.000Z"),
      );
    });

    it("a released slot", async () => {
      const { assigned, inTenant, post } = await plan(MONDAYS);
      const first = await post();
      await assigned(first, "2026-10-26T08:00:00Z");
      await Effect.runPromise(inTenant((client) => releaseQueueMembershipEffect(client, first)));

      expect(await assigned(await post(), "2026-10-26T08:00:00Z")).toEqual(
        new Date("2026-10-26T09:00:00.000Z"),
      );
    });

    it("the same Post again before its slot", async () => {
      const { assigned, post } = await plan(MONDAYS);
      const postId = await post();
      await assigned(postId, "2026-10-26T08:00:00Z");

      expect(await assigned(postId, "2026-10-26T08:30:00Z")).toEqual(
        new Date("2026-10-26T09:00:00.000Z"),
      );
    });

    it("the same Post after its slot elapsed", async () => {
      const { assigned, post, refused } = await plan(MONDAYS);
      const postId = await post();
      await assigned(postId, "2026-10-26T08:00:00Z");

      expect(await refused(postId, "2026-10-26T09:00:00Z")).toEqual(exists);
    });

    it("a Post held by another Queue", async () => {
      const { assigned, post, queue, refused } = await plan(MONDAYS);
      const postId = await post();
      await assigned(postId, "2026-10-26T08:00:00Z");

      expect(await refused(postId, "2026-10-26T08:00:00Z", await queue("Other"))).toEqual(exists);
    });

    it("an unknown Queue", async () => {
      const { post, refused } = await plan(MONDAYS);

      expect(await refused(await post(), "2026-10-26T08:00:00Z", randomUUID())).toEqual(notFound);
    });

    it("a Queue of another Brand Profile", async () => {
      const { post, queueId, refused } = await plan(MONDAYS);

      expect(await refused(await post(), "2026-10-26T08:00:00Z", queueId, randomUUID())).toEqual(
        notFound,
      );
    });

    it("a Queue of a deleted Brand Profile", async () => {
      const { post, refused } = await plan(MONDAYS, "UTC", true);

      expect(await refused(await post(), "2026-10-26T08:00:00Z")).toEqual(
        new CoreApiError(
          409,
          "brand_profile_deleted",
          "The brand profile is deleted and cannot accept new data.",
        ),
      );
    });
  });

  describe("requireNoQueueMembershipEffect", () => {
    it("a Post outside any Queue", async () => {
      const { inTenant, post } = await plan(MONDAYS);
      const postId = await post();

      expect(
        await Effect.runPromise(
          inTenant((client) => requireNoQueueMembershipEffect(client, postId)),
        ),
      ).toEqual(undefined);
    });

    it("a queued Post", async () => {
      const { assigned, inTenant, post } = await plan(MONDAYS);
      const postId = await post();
      await assigned(postId, "2026-10-26T08:00:00Z");

      expect(
        await Effect.runPromise(
          Effect.flip(inTenant((client) => requireNoQueueMembershipEffect(client, postId))),
        ),
      ).toEqual(
        new CoreApiError(
          409,
          "queue_membership_exists",
          "Remove this Post from its Queue before manually changing its Schedule.",
        ),
      );
    });
  });
});
