// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { I18nProvider } from "@/lib/i18n";
import WorkspaceSettings from "./workspace-settings";

vi.mock("@/context/workspace.context", () => ({
  useWorkspace: () => ({
    user: { id: "u1", name: "Owner", email: "owner@example.test" },
    workspaceName: "Meltiply Workspace",
    canManageSettings: false,
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

/**
 * Layout metrics jsdom does not compute. The active security tab starts past
 * the rail's right edge, so centering must move the rail instead of leaving the
 * tab offscreen.
 */
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

const METRIC_KEYS = ["clientWidth", "scrollWidth", "offsetLeft", "offsetWidth"] as const;
const originalMetrics = Object.fromEntries(
  METRIC_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]),
) as Record<(typeof METRIC_KEYS)[number], PropertyDescriptor | undefined>;

/** Replaces jsdom's zeroed layout metrics with the rail geometry under test. */
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

/** Restores the platform's layout metric descriptors after a test. */
function restoreLayoutMetrics(): void {
  for (const key of METRIC_KEYS) {
    const descriptor = originalMetrics[key];
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  }
}

/** Renders the Settings route at a reloadable section URL. */
function renderSettings(): void {
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/settings?section=security"]}>
        <WorkspaceSettings />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  rail.clientWidth = 320;
  rail.scrollWidth = 600;
  installRailMetrics();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  restoreLayoutMetrics();
});

describe("settings section rail", () => {
  it("centers the active section on mount, re-centers on section change, and resets the content", () => {
    renderSettings();

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    // Security: 300 + 100/2 - 320/2 = 190, within the 280px scroll range.
    expect(nav.scrollLeft).toBe(190);

    const heading = screen.getByRole("heading", { level: 1, name: "Account security" });
    const content = heading.parentElement?.parentElement;
    expect(content).not.toBeNull();
    content!.scrollTop = 120;

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Account and workspace" }),
    ).toBeInTheDocument();
    // Account: 200 + 100/2 - 320/2 = 90.
    expect(nav.scrollLeft).toBe(90);
    expect(content!.scrollTop).toBe(0);
  });

  it("re-centers the active section when the rail width changes", () => {
    renderSettings();

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.scrollLeft).toBe(190);

    rail.clientWidth = 200;
    fireEvent(window, new Event("resize"));

    // Security: 300 + 100/2 - 200/2 = 250, within the 400px scroll range.
    expect(nav.scrollLeft).toBe(250);
  });

  it("leaves a rail that does not scroll horizontally alone", () => {
    rail.scrollWidth = 320;
    renderSettings();

    expect(screen.getByRole("navigation", { name: "Settings sections" }).scrollLeft).toBe(0);
  });
});
