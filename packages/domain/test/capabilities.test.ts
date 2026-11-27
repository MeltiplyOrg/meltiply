import { describe, expect, it } from "vite-plus/test";

import { can, isWorkspaceRole } from "../src/capabilities";

describe("can", () => {
  it.each([
    ["an admin asking for member:read", "admin", false, "member:read", true],
    ["an admin asking for member:invite", "admin", false, "member:invite", true],
    ["an admin asking for brand-profile:manage", "admin", false, "brand-profile:manage", true],
    ["an admin asking for channel:manage", "admin", false, "channel:manage", true],
    [
      "an admin asking for content:delete-published",
      "admin",
      false,
      "content:delete-published",
      true,
    ],
    ["an admin asking for audit:read", "admin", false, "audit:read", true],
    ["an admin asking for member:assign-editor", "admin", false, "member:assign-editor", true],
    ["an admin asking for member:assign-viewer", "admin", false, "member:assign-viewer", true],
    ["an admin asking for member:assign-admin", "admin", false, "member:assign-admin", false],
    ["an admin asking for installation:manage", "admin", false, "installation:manage", false],
    ["an editor asking for content:read", "editor", false, "content:read", true],
    ["an editor asking for content:write", "editor", false, "content:write", true],
    ["an editor asking for channel:read", "editor", false, "channel:read", true],
    ["an editor asking for brand-profile:read", "editor", false, "brand-profile:read", true],
    [
      "an editor asking for content:delete-published",
      "editor",
      false,
      "content:delete-published",
      false,
    ],
    ["an editor asking for channel:manage", "editor", false, "channel:manage", false],
    ["an editor asking for brand-profile:manage", "editor", false, "brand-profile:manage", false],
    ["an editor asking for member:read", "editor", false, "member:read", false],
    ["an editor asking for audit:read", "editor", false, "audit:read", false],
    ["a viewer asking for content:read", "viewer", false, "content:read", true],
    ["a viewer asking for channel:read", "viewer", false, "channel:read", true],
    ["a viewer asking for content:write", "viewer", false, "content:write", false],
    ["a viewer asking for channel:manage", "viewer", false, "channel:manage", false],
    ["a viewer asking for brand-profile:read", "viewer", false, "brand-profile:read", false],
    ["an owning admin asking for member:assign-admin", "admin", true, "member:assign-admin", true],
    ["an owning admin asking for installation:manage", "admin", true, "installation:manage", true],
    [
      "an owning viewer asking for installation:manage",
      "viewer",
      true,
      "installation:manage",
      true,
    ],
    ["an owning viewer asking for member:manage", "viewer", true, "member:manage", true],
    ["an owning editor asking for content:write", "editor", true, "content:write", true],
  ] as const)("%s", (_example, role, installationOwner, capability, allowed) => {
    expect(can(role, installationOwner, capability)).toEqual(allowed);
  });
});

describe("isWorkspaceRole", () => {
  it.each([
    ["the admin role", "admin", true],
    ["the editor role", "editor", true],
    ["the viewer role", "viewer", true],
    ["an unknown role", "member", false],
    ["an empty string", "", false],
    ["a null value", null, false],
  ])("%s", (_example, value, expected) => {
    expect(isWorkspaceRole(value)).toEqual(expected);
  });
});
