import { CalendarClock, ChartColumn, PenSquare, Settings, Share2 } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkspaceView,
  sameOriginPath,
  workspaceNavItem,
  workspaceNavItems,
  workspaceViewPath,
  type WorkspaceView,
} from "./navigation";

const posts = {
  id: "posts",
  path: "/posts",
  label: "Posts",
  icon: PenSquare,
  placement: "primary",
};
const analytics = {
  id: "analytics",
  path: "/analytics",
  label: "Analytics",
  icon: ChartColumn,
  placement: "primary",
};
const channels = {
  id: "channels",
  path: "/channels",
  label: "Channels",
  icon: Share2,
  placement: "primary",
};
const queues = {
  id: "queues",
  path: "/queues",
  label: "Queues",
  icon: CalendarClock,
  placement: "primary",
};
const settings = {
  id: "settings",
  path: "/settings",
  label: "Settings",
  icon: Settings,
  placement: "utility",
};

const unsupported = "scheduled-posts" as WorkspaceView;

describe("workspaceNavItems", () => {
  it.each([
    ["primary", [posts, analytics, channels, queues]],
    ["utility", [settings]],
  ] as const)("the %s placement", (placement, items) => {
    expect(workspaceNavItems(placement)).toEqual(items);
  });
});

describe("workspaceNavItem", () => {
  it("a listed view", () => {
    expect(workspaceNavItem("channels")).toEqual(channels);
  });

  it("an unlisted view", () => {
    expect(workspaceNavItem(unsupported)).toEqual(posts);
  });
});

describe("workspaceViewPath", () => {
  it.each([
    ["queues", "/queues"],
    ["settings", "/settings"],
    [unsupported, "/posts"],
  ] as const)("the %s view", (view, path) => {
    expect(workspaceViewPath(view)).toEqual(path);
  });
});

describe("resolveWorkspaceView", () => {
  it.each([
    ["/posts", "posts"],
    ["/analytics", "analytics"],
    ["/channels", "channels"],
    ["/queues", "queues"],
    ["/settings", "settings"],
    ["/analytics/overview", "analytics"],
    ["/channels/connect", "channels"],
    ["/settings/account", "settings"],
    ["analytics", "analytics"],
    ["/", "posts"],
    ["", "posts"],
    ["/scheduled-posts", "posts"],
    ["/posts-archive", "posts"],
    ["/unknown", "posts"],
  ])("the path %j", (pathname, view) => {
    expect(resolveWorkspaceView(pathname)).toEqual(view);
  });
});

describe("sameOriginPath", () => {
  it.each([
    ["a path with a query", "/invitations/accept?token=abc", "/invitations/accept?token=abc"],
    ["a path with a hash", "/posts#composer", "/posts#composer"],
    ["the root", "/", "/"],
    ["a path with a parent segment", "/posts/../queues", "/queues"],
    ["a path outside ASCII", "/posts/é", "/posts/%C3%A9"],
  ])("%s", (_example, requested, path) => {
    expect(sameOriginPath(requested)).toEqual(path);
  });

  it.each([
    ["no path", null],
    ["an empty string", ""],
    ["a relative path", "posts"],
    ["an absolute URL", "https://evil.test/"],
    ["a protocol-relative URL", "//evil.test"],
    ["a backslash host", "/\\evil.test"],
    ["a tab before a slash", "/\t/evil.test"],
    ["a newline before a slash", "/\n/evil.test"],
    ["a dot segment before two slashes", "/.//evil.test"],
    ["a bracket that cannot be parsed", "//["],
  ])("%s", (_example, requested) => {
    expect(sameOriginPath(requested)).toEqual(null);
  });
});
