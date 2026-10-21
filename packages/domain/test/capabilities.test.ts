import { describe, expect, it } from "vite-plus/test";

import {
  can,
  INSTALLATION_OWNER_CAPABILITIES,
  isWorkspaceRole,
  roleCan,
  WORKSPACE_ROLE_CAPABILITIES,
} from "../src/capabilities";

describe("workspace capability model", () => {
  it("grants admins administration and configuration but not Admin assignment", () => {
    expect(roleCan("admin", "member:read")).toBe(true);
    expect(roleCan("admin", "member:invite")).toBe(true);
    expect(roleCan("admin", "brand-profile:manage")).toBe(true);
    expect(roleCan("admin", "channel:manage")).toBe(true);
    expect(roleCan("admin", "content:delete-published")).toBe(true);
    expect(roleCan("admin", "audit:read")).toBe(true);
    expect(roleCan("admin", "member:assign-editor")).toBe(true);
    expect(roleCan("admin", "member:assign-viewer")).toBe(true);
    expect(roleCan("admin", "member:assign-admin")).toBe(false);
    expect(roleCan("admin", "installation:manage")).toBe(false);
  });

  it("grants editors content work while keeping configuration read-only", () => {
    expect(roleCan("editor", "content:read")).toBe(true);
    expect(roleCan("editor", "content:write")).toBe(true);
    expect(roleCan("editor", "channel:read")).toBe(true);
    expect(roleCan("editor", "brand-profile:read")).toBe(true);
    expect(roleCan("editor", "content:delete-published")).toBe(false);
    expect(roleCan("editor", "channel:manage")).toBe(false);
    expect(roleCan("editor", "brand-profile:manage")).toBe(false);
    expect(roleCan("editor", "member:read")).toBe(false);
    expect(roleCan("editor", "audit:read")).toBe(false);
  });

  it("makes viewers read-only", () => {
    expect(roleCan("viewer", "content:read")).toBe(true);
    expect(roleCan("viewer", "channel:read")).toBe(true);
    expect(roleCan("viewer", "content:write")).toBe(false);
    expect(roleCan("viewer", "channel:manage")).toBe(false);
    expect(roleCan("viewer", "brand-profile:read")).toBe(false);
  });

  it("layers installation authority over the owner's admin membership", () => {
    expect(can("admin", true, "member:assign-admin")).toBe(true);
    expect(can("admin", true, "installation:manage")).toBe(true);
    expect(can("admin", false, "member:assign-admin")).toBe(false);
    expect(can("admin", false, "installation:manage")).toBe(false);
    expect(can("editor", false, "content:write")).toBe(true);
    expect(can("viewer", false, "content:write")).toBe(false);
    expect(INSTALLATION_OWNER_CAPABILITIES).toContain("member:assign-admin");
  });

  it("narrows untrusted role values", () => {
    expect(isWorkspaceRole("admin")).toBe(true);
    expect(isWorkspaceRole("editor")).toBe(true);
    expect(isWorkspaceRole("viewer")).toBe(true);
    expect(isWorkspaceRole("member")).toBe(false);
    expect(isWorkspaceRole("")).toBe(false);
    expect(isWorkspaceRole(null)).toBe(false);
    expect(WORKSPACE_ROLE_CAPABILITIES.admin.length).toBeGreaterThan(0);
  });
});
