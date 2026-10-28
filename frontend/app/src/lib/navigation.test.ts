import { describe, expect, it } from "vite-plus/test";
import {
  WORKSPACE_NAV_ITEMS,
  resolveWorkspaceView,
  workspaceNavItem,
  workspaceNavItems,
  workspaceViewPath,
  type WorkspaceView,
} from "./navigation";

describe("canonical workspace navigation", () => {
  it("exposes exactly the implemented destinations with one entry each", () => {
    expect(WORKSPACE_NAV_ITEMS.map(({ id, path, placement }) => ({ id, path, placement }))).toEqual(
      [
        { id: "posts", path: "/posts", placement: "primary" },
        { id: "analytics", path: "/analytics", placement: "primary" },
        { id: "channels", path: "/channels", placement: "primary" },
        { id: "queues", path: "/queues", placement: "primary" },
        { id: "settings", path: "/settings", placement: "utility" },
      ],
    );
    expect(new Set(WORKSPACE_NAV_ITEMS.map((item) => item.id)).size).toBe(
      WORKSPACE_NAV_ITEMS.length,
    );
  });

  it("separates primary destinations from the Settings utility destination", () => {
    expect(workspaceNavItems("primary").map((item) => item.id)).toEqual([
      "posts",
      "analytics",
      "channels",
      "queues",
    ]);
    expect(workspaceNavItems("utility").map((item) => item.id)).toEqual(["settings"]);
  });

  it("resolves every implemented destination and its nested routes", () => {
    expect(resolveWorkspaceView("/posts")).toBe("posts");
    expect(resolveWorkspaceView("/analytics")).toBe("analytics");
    expect(resolveWorkspaceView("/channels")).toBe("channels");
    expect(resolveWorkspaceView("/queues")).toBe("queues");
    expect(resolveWorkspaceView("/settings")).toBe("settings");
    expect(resolveWorkspaceView("/analytics/overview")).toBe("analytics");
    expect(resolveWorkspaceView("/channels/connect")).toBe("channels");
    expect(resolveWorkspaceView("/settings/account")).toBe("settings");
  });

  it("resolves unknown paths to Posts instead of inventing a destination", () => {
    for (const pathname of ["/", "", "/scheduled-posts", "/posts-archive", "/unknown"]) {
      expect(resolveWorkspaceView(pathname)).toBe("posts");
    }
  });

  it("returns canonical paths and items, falling back to Posts for invalid runtime values", () => {
    expect(workspaceViewPath("posts")).toBe("/posts");
    expect(workspaceViewPath("queues")).toBe("/queues");
    expect(workspaceViewPath("settings")).toBe("/settings");
    expect(workspaceNavItem("channels").path).toBe("/channels");

    const unsupported = "scheduled-posts" as WorkspaceView;
    expect(workspaceViewPath(unsupported)).toBe("/posts");
    expect(workspaceNavItem(unsupported).id).toBe("posts");
  });
});
