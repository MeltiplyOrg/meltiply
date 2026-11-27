import { describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/api-errors";
import { isPendingDistribution } from "../src/distribution-service";
import {
  isQueueInScope,
  mapQueue,
  mapQueueMembership,
  queueChanges,
  queueConfigurationRoleError,
  queuePage,
  queueRemovalError,
  queueRemovalRoleError,
  reservationDecision,
} from "../src/publishing-queue-rules";

const queue = (id: string) => ({
  brand_profile_id: "profile-1",
  created_at: "2026-01-01T00:00:00.000Z",
  id,
  name: "Weekly",
  slots: [{ weekday: 1, time: "09:00" }],
  timezone: "UTC",
  updated_at: "2026-01-01T00:00:00.000Z",
});

describe("mapQueue", () => {
  it("a stored row with driver dates", () => {
    const row = {
      ...queue("queue-1"),
      created_at: new Date("2026-01-01T00:00:00Z"),
      org_id: "org-1",
      updated_at: "2026-01-01T00:00:00Z",
    };

    expect(mapQueue(row)).toEqual(queue("queue-1"));
  });
});

describe("mapQueueMembership", () => {
  it("no row", () => {
    expect(mapQueueMembership(undefined)).toEqual(null);
  });

  it("a row", () => {
    const row = {
      assigned_at: new Date("2026-01-05T09:00:00Z"),
      queue_id: "queue-1",
      queue_name: "Weekly",
    };

    expect(mapQueueMembership(row)).toEqual({
      assigned_at: "2026-01-05T09:00:00.000Z",
      queue_id: "queue-1",
      queue_name: "Weekly",
    });
  });
});

describe("isQueueInScope", () => {
  const row = { brand_profile_id: "profile-1", org_id: "org-1" };

  it.each([
    ["the owning Brand Profile", row, "profile-1", true],
    ["no Brand Profile asked for", row, undefined, true],
    ["another Brand Profile", row, "profile-2", false],
    ["a missing row", null, "profile-1", false],
    ["no row", undefined, undefined, false],
  ])("%s", (_example, stored, brandProfileId, inScope) => {
    expect(isQueueInScope(stored, brandProfileId)).toEqual(inScope);
  });
});

describe("reservationDecision", () => {
  const now = new Date("2026-01-05T09:00:00.000Z");
  const membership = (queue_id: string, assigned_at: string) => ({
    assigned_at,
    queue_id,
    queue_name: "Weekly",
  });
  const exists = {
    kind: "reject",
    error: new CoreApiError(
      409,
      "queue_membership_exists",
      "Remove this Post from its Queue before changing plans or reusing an elapsed reservation.",
    ),
  };

  it("no membership", () => {
    expect(reservationDecision(null, "queue-1", now)).toEqual({ kind: "reserve" });
  });

  it("a future slot in the same Queue", () => {
    const held = membership("queue-1", "2026-01-05T09:00:00.001Z");

    expect(reservationDecision(held, "queue-1", now)).toEqual({
      kind: "reuse",
      assignedAt: new Date("2026-01-05T09:00:00.001Z"),
    });
  });

  it.each([
    ["a slot that is now", "queue-1", "2026-01-05T09:00:00.000Z"],
    ["an elapsed slot", "queue-1", "2026-01-05T08:00:00.000Z"],
    ["a future slot in another Queue", "queue-2", "2026-01-06T09:00:00.000Z"],
  ])("%s", (_example, queueId, assignedAt) => {
    expect(reservationDecision(membership(queueId, assignedAt), "queue-1", now)).toEqual(exists);
  });
});

describe("queuePage", () => {
  it.each([
    ["no Queue", [], 2, [], null],
    ["fewer than the limit", [queue("a")], 2, [queue("a")], null],
    ["exactly the limit", [queue("a"), queue("b")], 2, [queue("a"), queue("b")], null],
    ["one more than the limit", [queue("a"), queue("b")], 1, [queue("a")], "a"],
  ])("%s", (_example, rows, limit, items, next_cursor) => {
    expect(queuePage(rows, limit)).toEqual({ items, next_cursor });
  });
});

describe("queueChanges", () => {
  const current = { name: "Weekly", slots: [{ weekday: 1, time: "09:00" }], timezone: "UTC" };

  it("no changed field", () => {
    expect(queueChanges(current, { brand_profile_id: "profile-1" })).toEqual(current);
  });

  it("every field changed", () => {
    const input = {
      brand_profile_id: "profile-1",
      name: "Daily",
      slots: [{ weekday: 2, time: "10:00" }],
      timezone: "Europe/Paris",
    };

    expect(queueChanges(current, input)).toEqual({
      name: "Daily",
      slots: [{ weekday: 2, time: "10:00" }],
      timezone: "Europe/Paris",
    });
  });
});

describe("queueConfigurationRoleError", () => {
  it("an Admin", () => {
    expect(queueConfigurationRoleError("admin")).toEqual(null);
  });

  it.each([
    ["an Editor", "editor"],
    ["a Viewer", "viewer"],
    ["no membership", null],
  ])("%s", (_example, role) => {
    expect(queueConfigurationRoleError(role)).toEqual(
      new CoreApiError(
        403,
        "workspace_admin_required",
        "Only Workspace Admins can configure Queues.",
      ),
    );
  });
});

describe("queueRemovalRoleError", () => {
  it.each(["admin", "editor"])("the %s", (role) => {
    expect(queueRemovalRoleError(role)).toEqual(null);
  });

  it.each([
    ["a Viewer", "viewer"],
    ["no membership", null],
  ])("%s", (_example, role) => {
    expect(queueRemovalRoleError(role)).toEqual(
      new CoreApiError(403, "forbidden_role", "Your Workspace role is read-only."),
    );
  });
});

describe("queueRemovalError", () => {
  const outcome = (status: "scheduled" | "queued" | "cancelled" | "processing" | "published") => ({
    id: "distribution-1",
    owned: false,
    status,
  });
  const inFlight = new CoreApiError(
    409,
    "queue_post_in_flight",
    "Only unclaimed pending Posts can be removed. Provider-owned outcomes remain unchanged.",
  );

  it.each([
    ["no Distribution", []],
    [
      "unclaimed pending and cancelled ones",
      [outcome("scheduled"), outcome("queued"), outcome("cancelled")],
    ],
  ])("%s", (_example, outcomes) => {
    expect(queueRemovalError(outcomes, isPendingDistribution)).toEqual(null);
  });

  it.each([
    ["a claimed pending one", { ...outcome("queued"), owned: true }],
    ["one in flight", outcome("processing")],
    ["a published one", outcome("published")],
  ])("%s", (_example, blocking) => {
    expect(queueRemovalError([outcome("scheduled"), blocking], isPendingDistribution)).toEqual(
      inFlight,
    );
  });
});
