import { describe, expect, it } from "vite-plus/test";

import { can, isWorkspaceRole, type WorkspaceCapability } from "../src/capabilities";

describe("workspace capability model", () => {
  it("grants admins administration and configuration but not Admin assignment", () => {
    const granted: WorkspaceCapability[] = [
      "member:read",
      "member:invite",
      "brand-profile:manage",
      "channel:manage",
      "content:delete-published",
      "audit:read",
      "member:assign-editor",
      "member:assign-viewer",
    ];
    for (const capability of granted) expect(can("admin", false, capability)).toBe(true);
    expect(can("admin", false, "member:assign-admin")).toBe(false);
    expect(can("admin", false, "installation:manage")).toBe(false);
  });

  it("grants editors content work while keeping configuration read-only", () => {
    for (const capability of [
      "content:read",
      "content:write",
      "channel:read",
      "brand-profile:read",
    ] as const) {
      expect(can("editor", false, capability)).toBe(true);
    }
    for (const capability of [
      "content:delete-published",
      "channel:manage",
      "brand-profile:manage",
      "member:read",
      "audit:read",
    ] as const) {
      expect(can("editor", false, capability)).toBe(false);
    }
  });

  it("makes viewers read-only", () => {
    expect(can("viewer", false, "content:read")).toBe(true);
    expect(can("viewer", false, "channel:read")).toBe(true);
    expect(can("viewer", false, "content:write")).toBe(false);
    expect(can("viewer", false, "channel:manage")).toBe(false);
    expect(can("viewer", false, "brand-profile:read")).toBe(false);
  });

  it("layers installation authority over any membership role without removing admin powers", () => {
    expect(can("admin", true, "member:assign-admin")).toBe(true);
    expect(can("admin", true, "installation:manage")).toBe(true);
    expect(can("viewer", true, "installation:manage")).toBe(true);
    expect(can("viewer", true, "member:manage")).toBe(true);
    expect(can("editor", true, "content:write")).toBe(true);
  });

  it("narrows untrusted role values", () => {
    expect(isWorkspaceRole("admin")).toBe(true);
    expect(isWorkspaceRole("editor")).toBe(true);
    expect(isWorkspaceRole("viewer")).toBe(true);
    expect(isWorkspaceRole("member")).toBe(false);
    expect(isWorkspaceRole("")).toBe(false);
    expect(isWorkspaceRole(null)).toBe(false);
  });
});
