// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { I18nProvider } from "@/lib/i18n";
import WorkspaceSettings from "./workspace-settings";

const workspace = vi.hoisted(() => ({
  canManageSettings: false,
}));

vi.mock("@/context/workspace.context", () => ({
  useWorkspace: () => ({
    user: { id: "u1", name: "Owner", email: "owner@example.test" },
    workspaceName: "Meltiply Workspace",
    canManageSettings: workspace.canManageSettings,
  }),
}));

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ requestedTheme: "light", setTheme: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-sign-out", () => ({
  useWorkspaceSignOut: () => vi.fn(),
}));

vi.mock("@/components/auth/account-security", () => ({
  AccountSecurity: () => <div>Security form</div>,
}));

vi.mock("@/app/(dashboard)/settings/page", () => ({
  default: () => <div>Administration</div>,
}));

vi.mock("@meltiply/ui/sidebar-glide-highlight", () => ({
  SidebarGlideHighlight: () => null,
}));

type RailBox = { left: number; width: number };

const RAIL_ITEMS: Record<string, RailBox> = {
  Appearance: { left: 0, width: 100 },
  Language: { left: 100, width: 100 },
  Account: { left: 200, width: 100 },
  Security: { left: 300, width: 100 },
};

const rail = {
  clientWidth: 320,
  scrollWidth: 600,
  items: RAIL_ITEMS,
};

const resizeObservers: TestResizeObserver[] = [];

class TestResizeObserver implements ResizeObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  notifyFor(target: Element): void {
    if (!this.targets.has(target)) return;
    this.callback([], this);
  }
}

const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");

const METRIC_KEYS = ["clientWidth", "scrollWidth", "offsetLeft", "offsetWidth"] as const;
const originalMetrics = Object.fromEntries(
  METRIC_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]),
) as Record<(typeof METRIC_KEYS)[number], PropertyDescriptor | undefined>;

function installRailMetrics(): void {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === "NAV" ? rail.clientWidth : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === "NAV" ? rail.scrollWidth : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      return rail.items[this.textContent?.trim() ?? ""]?.left ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return rail.items[this.textContent?.trim() ?? ""]?.width ?? 0;
    },
  });
}

function restoreLayoutMetrics(): void {
  for (const key of METRIC_KEYS) {
    const descriptor = originalMetrics[key];
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
}

function SettingsRouteFixture() {
  return (
    <I18nProvider>
      <MemoryRouter initialEntries={["/settings?section=security"]}>
        <WorkspaceSettings />
      </MemoryRouter>
    </I18nProvider>
  );
}

function renderSettings() {
  return render(<SettingsRouteFixture />);
}

beforeEach(() => {
  workspace.canManageSettings = false;
  rail.clientWidth = 320;
  rail.scrollWidth = 600;
  resizeObservers.length = 0;
  globalThis.ResizeObserver = TestResizeObserver;
  installRailMetrics();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  restoreLayoutMetrics();
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
  } else {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

describe("settings section rail", () => {
  it("centers the active section on mount, re-centers on section change, and resets the content", () => {
    renderSettings();

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.scrollLeft).toBe(190);

    const heading = screen.getByRole("heading", { level: 1, name: "Account security" });
    const content = heading.parentElement?.parentElement;
    expect(content).not.toBeNull();
    content!.scrollTop = 120;

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Account and workspace" }),
    ).toBeInTheDocument();
    expect(nav.scrollLeft).toBe(90);
    expect(content!.scrollTop).toBe(0);
  });

  it("re-centers the active section when the rail width changes", () => {
    renderSettings();

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.scrollLeft).toBe(190);

    rail.clientWidth = 200;
    fireEvent(window, new Event("resize"));

    expect(nav.scrollLeft).toBe(250);
  });

  it("re-centers when an observed non-active section label changes size", () => {
    rail.clientWidth = 390;
    rail.scrollWidth = 402;
    renderSettings();

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.scrollLeft).toBe(12);

    const accountButton = screen.getByRole("button", { name: "Account" });
    rail.scrollWidth = 526;
    for (const observer of resizeObservers) observer.notifyFor(accountButton);

    expect(nav.scrollLeft).toBe(136);
  });

  it("re-centers when Administration appears after the workspace resolves", () => {
    rail.clientWidth = 390;
    rail.scrollWidth = 402;
    const { rerender } = renderSettings();

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.scrollWidth).toBe(402);
    expect(nav.scrollLeft).toBe(12);
    expect(screen.queryByRole("button", { name: "Administration" })).toBeNull();

    workspace.canManageSettings = true;
    rail.scrollWidth = 526;
    rerender(<SettingsRouteFixture />);

    expect(screen.getByRole("button", { name: "Administration" })).toBeInTheDocument();
    expect(nav.scrollLeft).toBe(136);
  });

  it("leaves a rail that does not scroll horizontally alone", () => {
    rail.scrollWidth = 320;
    renderSettings();

    expect(screen.getByRole("navigation", { name: "Settings sections" }).scrollLeft).toBe(0);
  });

  it("groups visible sections and hides admin-only groups from members", () => {
    const { rerender } = renderSettings();

    expect(screen.getByRole("group", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Account" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publishing" })).toBeNull();

    workspace.canManageSettings = true;
    rerender(<SettingsRouteFixture />);

    expect(screen.getByRole("group", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publishing" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Administration" })).toBeInTheDocument();
  });
});
