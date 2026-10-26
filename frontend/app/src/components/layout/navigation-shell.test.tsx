// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type * as SidebarNavModule from "@/components/primitives/sidebar-nav";
import { I18nProvider } from "@/lib/i18n";
import { NavigationShell } from "./navigation-shell";

const workspace = vi.hoisted(() => ({
  value: {
    user: { id: "u1", email: "owner@example.test", name: "Owner" },
    brandProfiles: [
      { id: "profile-1", name: "Studio One" },
      { id: "profile-2", name: "Studio Two" },
    ],
    selectedBrandProfile: { id: "profile-1", name: "Studio One" },
    selectedBrandProfileId: "profile-1",
    workspaceName: "Meltiply Workspace",
    isLoading: false,
    setSelectedBrandProfileId: vi.fn(),
    logout: vi.fn(),
  },
}));

vi.mock("@/context/workspace.context", () => ({
  useWorkspace: () => workspace.value,
}));

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ requestedTheme: "light", setTheme: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-sign-out", () => ({
  useWorkspaceSignOut: () => vi.fn(),
}));

vi.mock("@/lib/preload-routes", () => ({
  preloadDashboardRoute: vi.fn(),
}));

vi.mock("@/components/primitives/sidebar-nav", async (importOriginal) => ({
  ...(await importOriginal<typeof SidebarNavModule>()),
  SidebarNav: () => <nav aria-label="Workspace navigation" />,
}));

function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", { configurable: true, value: platform });
}

function renderShell() {
  const onNavigate = vi.fn();
  render(
    <I18nProvider>
      <NavigationShell currentView="posts" onNavigate={onNavigate}>
        <button type="button">Workspace content</button>
      </NavigationShell>
    </I18nProvider>,
  );
  return {
    onNavigate,
    trigger: screen.getByRole("button", { name: "Search and jump to" }),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPlatform("Linux armv8l");
});

describe("workspace search shortcut", () => {
  it("shows the platform modifier and follows it when the platform changes", () => {
    setPlatform("Win32");
    const { trigger } = renderShell();
    expect(trigger).toHaveTextContent("Ctrl K");

    cleanup();
    setPlatform("MacIntel");
    const mac = renderShell();
    expect(mac.trigger).toHaveTextContent("⌘K");
  });

  it("opens from the pointer with focus on the search field and returns focus on Escape", async () => {
    const { trigger } = renderShell();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Search and jump to" });
    const input = screen.getByRole("textbox", { name: "Search pages and Brand Profiles" });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("opens from the keyboard, navigates to a destination, and closes without trapping focus", async () => {
    setPlatform("Win32");
    const { onNavigate, trigger } = renderShell();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const input = await screen.findByRole("textbox", {
      name: "Search pages and Brand Profiles",
    });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "Channels" } });
    fireEvent.click(screen.getByRole("button", { name: "Channels" }));

    expect(onNavigate).toHaveBeenCalledWith("channels", undefined);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Search and jump to" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Search pages and Brand Profiles" })).toHaveValue(
      "",
    );
  });

  it("selects a Brand Profile, dismisses, and keeps the shortcut working", async () => {
    const { onNavigate, trigger } = renderShell();
    fireEvent.click(trigger);
    const input = await screen.findByRole("textbox", {
      name: "Search pages and Brand Profiles",
    });
    fireEvent.change(input, { target: { value: "Studio Two" } });
    fireEvent.click(screen.getByRole("button", { name: "Studio Two" }));

    expect(workspace.value.setSelectedBrandProfileId).toHaveBeenCalledWith("profile-2");
    expect(onNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Search and jump to" })).toBeVisible();
  });
});
