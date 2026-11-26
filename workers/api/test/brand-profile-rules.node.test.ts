import { DatabaseError } from "@meltiply/domain";
import { describe, expect, it } from "vite-plus/test";

import {
  channelRevocationEvent,
  createBrandProfilePayload,
  isUniqueViolation,
  mapBrandProfile,
  restoreError,
  updateBrandProfilePayload,
  workspaceAdminError,
} from "../src/brand-profile-rules";
import { CoreApiError } from "../src/core-types";

describe("mapBrandProfile", () => {
  it("an active profile with every optional field empty", () => {
    const row = {
      color: "#b91c1c",
      created_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
      description: null,
      id: "profile-1",
      name: "Alpha",
      org_id: "org-1",
      purge_at: null,
      updated_at: "2026-01-02T00:00:00Z",
    };

    expect(mapBrandProfile(row)).toEqual({
      color: "#b91c1c",
      created_at: "2026-01-01T00:00:00.000Z",
      deleted_at: null,
      description: null,
      id: "profile-1",
      name: "Alpha",
      org_id: "org-1",
      purge_at: null,
      updated_at: "2026-01-02T00:00:00.000Z",
    });
  });

  it("a deleted profile with every field filled", () => {
    const row = {
      color: "#c2410c",
      created_at: new Date("2026-01-01T00:00:00Z"),
      deleted_at: new Date("2026-02-01T00:00:00Z"),
      description: "Outils éditoriaux",
      id: "profile-1",
      name: "Alpha",
      org_id: "org-1",
      purge_at: new Date("2026-03-01T00:00:00Z"),
      updated_at: new Date("2026-02-01T00:00:00Z"),
      extra: "dropped",
    };

    expect(mapBrandProfile(row)).toEqual({
      color: "#c2410c",
      created_at: "2026-01-01T00:00:00.000Z",
      deleted_at: "2026-02-01T00:00:00.000Z",
      description: "Outils éditoriaux",
      id: "profile-1",
      name: "Alpha",
      org_id: "org-1",
      purge_at: "2026-03-01T00:00:00.000Z",
      updated_at: "2026-02-01T00:00:00.000Z",
    });
  });
});

describe("createBrandProfilePayload", () => {
  it.each([
    [
      "no description",
      { color: "#b91c1c", name: "Alpha" },
      '{"color":"#b91c1c","description":null,"name":"Alpha"}',
    ],
    [
      "a description",
      { color: "#b91c1c", description: "Tools", name: "Alpha" },
      '{"color":"#b91c1c","description":"Tools","name":"Alpha"}',
    ],
  ])("%s", (_example, input, payload) => {
    expect(createBrandProfilePayload(input)).toEqual(payload);
  });
});

describe("updateBrandProfilePayload", () => {
  it.each([
    [
      "no field",
      {},
      '{"color":null,"description":null,"has_description":false,"name":null,"profile_id":"p"}',
    ],
    [
      "a cleared description",
      { description: null },
      '{"color":null,"description":null,"has_description":true,"name":null,"profile_id":"p"}',
    ],
    [
      "every field",
      { color: "#b91c1c", description: "Tools", name: "Alpha" },
      '{"color":"#b91c1c","description":"Tools","has_description":true,"name":"Alpha","profile_id":"p"}',
    ],
  ])("%s", (_example, input, payload) => {
    expect(updateBrandProfilePayload("p", input)).toEqual(payload);
  });
});

describe("workspaceAdminError", () => {
  it("an Admin", () => {
    expect(workspaceAdminError("admin")).toEqual(null);
  });

  it.each([
    ["an Editor", "editor"],
    ["no membership", null],
  ])("%s", (_example, role) => {
    expect(workspaceAdminError(role)).toEqual(
      new CoreApiError(403, "workspace_admin_required", "The workspace admin role is required."),
    );
  });
});

describe("isUniqueViolation", () => {
  it.each([
    ["a unique violation", { code: "23505" }, true],
    ["another database code", { code: "23503" }, false],
    ["a cause without a code", {}, false],
    ["a string cause", "23505", false],
    ["no cause", undefined, false],
    ["a null cause", null, false],
  ])("%s", (_example, cause, expected) => {
    const error = new DatabaseError({ cause, message: "failed" });

    expect(isUniqueViolation(error)).toEqual(expected);
  });
});

describe("restoreError", () => {
  const now = new Date("2026-02-01T00:00:00.000Z");

  it.each([
    ["a purge time one millisecond away", "2026-02-01T00:00:00.001Z"],
    ["no purge time", null],
  ])("%s", (_example, purge_at) => {
    const row = { deleted_at: "2026-01-01T00:00:00.000Z", purge_at };

    expect(restoreError(row, now)).toEqual(null);
  });

  it.each([
    ["a purge time that is now", "2026-02-01T00:00:00.000Z"],
    ["a purge time in the past", new Date("2026-01-31T00:00:00.000Z")],
  ])("%s", (_example, purge_at) => {
    const row = { deleted_at: "2026-01-01T00:00:00.000Z", purge_at };

    expect(restoreError(row, now)).toEqual(
      new CoreApiError(409, "invalid_state", "The brand profile retention window has elapsed."),
    );
  });

  it("a profile that is not deleted", () => {
    expect(restoreError({ deleted_at: null, purge_at: null }, now)).toEqual(
      new CoreApiError(409, "invalid_state", "The brand profile is not deleted."),
    );
  });
});

describe("channelRevocationEvent", () => {
  it("a connected Channel", () => {
    const account = {
      access_token: "sealed",
      brand_profile_id: "profile-1",
      id: "channel-1",
      platform: "threads",
    };

    expect(channelRevocationEvent(account)).toEqual({
      dedupeKey: "channel-revocation:channel-1",
      payload: {
        access_token: "sealed",
        brand_profile_id: "profile-1",
        platform: "threads",
        platform_account_id: "channel-1",
        version: 1,
      },
    });
  });
});
