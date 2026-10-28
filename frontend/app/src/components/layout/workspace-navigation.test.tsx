// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import DashboardLayout from "../../app/(dashboard)/layout";
import { I18nProvider } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({
  setTheme: vi.fn(),
  workspace: {
    user: { id: "u1", email: "owner@example.test", name: "Owner" },
    brandProfiles: [],
    selectedBrandProfile: null,
    selectedBrandProfileId: null,
    workspaceName: null as string | null,
    isLoading: false,
    setSelectedBrandProfileId: vi.fn(),
    logout: vi.fn(),
  },
}));

vi.mock("@/app/providers", () => ({
  AppProviders: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/context/workspace.context", () => ({
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
  useWorkspace: () => mocks.workspace,
}));

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ requestedTheme: "light", setTheme: mocks.setTheme }),
}));

vi.mock("@/hooks/use-workspace-sign-out", () => ({
  useWorkspaceSignOut: () => vi.fn(),
}));

vi.mock("@/lib/preload-routes", () => ({
  preloadDashboardRoute: vi.fn(),
}));

/**
 * Exposes the live router location plus test-only route controls. The buttons
 * change the URL through the same router the shell reads, so assertions observe
 * pathname and query-only transitions rather than a hand-fed `currentView`.
 */
function LocationProbe(): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output data-testid="location">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => navigate("/posts?view=calendar")}>
        Show Posts calendar
      </button>
      <button type="button" onClick={() => navigate("/settings?section=security")}>
        Show security
      </button>
      <button type="button" onClick={() => navigate("/analytics-archive")}>
        Show unknown page
      </button>
    </div>
  );
}

/**
 * Renders the real dashboard layout, navigation shell, and `SidebarNav` inside a
 * memory router. Only data providers and platform APIs are mocked, so the rail
 * and drawer consume the same canonical roster and live route as production.
 */
function renderWorkspace(entry = "/posts"): void {
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="/posts" element={<LocationProbe />} />
            <Route path="/analytics" element={<LocationProbe />} />
            <Route path="/channels" element={<LocationProbe />} />
            <Route path="/queues" element={<LocationProbe />} />
            <Route path="/settings" element={<LocationProbe />} />
            <Route path="*" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

/** Minimal ResizeObserver stand-in; jsdom does not implement the platform API. */
class TestResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  // jsdom omits both APIs used by the rail's measured hover pill and Radix menus.
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

beforeEach(() => {
  mocks.workspace.workspaceName = null;
  mocks.setTheme.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.documentElement.lang = "en";
});

describe("workspace navigation selection", () => {
  it("follows pathname changes and stays truthful on query-only navigation", async () => {
    renderWorkspace();
    const location = screen.getByTestId("location");
    const posts = screen.getByRole("button", { name: "Posts" });
    expect(posts).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "Analytics" }));
    await waitFor(() => expect(location).toHaveTextContent("/analytics"));
    expect(screen.getByRole("button", { name: "Analytics" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(posts).not.toHaveAttribute("aria-current");

    fireEvent.click(screen.getByRole("button", { name: "Show Posts calendar" }));
    await waitFor(() => expect(location).toHaveTextContent("/posts?view=calendar"));
    expect(screen.getByRole("button", { name: "Posts" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Analytics" })).not.toHaveAttribute("aria-current");

    const accountMenu = screen.getByRole("button", { name: "Account menu" });
    fireEvent.pointerDown(accountMenu, { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Account settings" }));
    await waitFor(() => expect(location).toHaveTextContent("/settings?section=account"));
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Settings");

    fireEvent.click(screen.getByRole("button", { name: "Show security" }));
    await waitFor(() => expect(location).toHaveTextContent("/settings?section=security"));
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    // Unknown first segments fall back to Posts; a substring match would wrongly
    // keep Analytics selected for `/analytics-archive`.
    fireEvent.click(screen.getByRole("button", { name: "Show unknown page" }));
    await waitFor(() => expect(location).toHaveTextContent("/analytics-archive"));
    expect(screen.getByRole("button", { name: "Posts" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Analytics" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Posts");
  });

  it("shares destinations and theme preferences with the mobile drawer", async () => {
    renderWorkspace();
    const opener = screen.getByRole("button", { name: "Open navigation menu" });
    opener.focus();
    fireEvent.click(opener);

    const drawer = await screen.findByRole("dialog", {
      name: "Workspace navigation",
    });
    expect(within(drawer).getByRole("button", { name: "Queues" })).toBeVisible();
    expect(within(drawer).getByRole("link", { name: "Help and resources" })).toBeVisible();
    expect(within(drawer).getByRole("button", { name: "Settings" })).toBeVisible();

    fireEvent.click(within(drawer).getByRole("button", { name: "Channels" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/channels"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Channels" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(opener);
    const reopened = await screen.findByRole("dialog", {
      name: "Workspace navigation",
    });
    expect(within(reopened).getByRole("button", { name: "Channels" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const account = within(reopened).getByRole("button", { name: "Account menu" });
    fireEvent.pointerDown(account, { button: 0 });
    const menu = await screen.findByRole("menu", { name: "Account menu" });
    expect(within(menu).getByRole("menuitemradio", { name: "Light" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemradio", { name: "Dark" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemradio", { name: "System" })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Dark" }));
    expect(mocks.setTheme).toHaveBeenCalledWith("dark");

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("localizes the fallback workspace name and navigation labels", () => {
    writeCookieConsent({ functional: true });
    window.localStorage.setItem("meltiply.language", "de");

    renderWorkspace();

    expect(screen.getByText("Meltiply Arbeitsbereich")).toBeVisible();
    expect(screen.getByRole("button", { name: "Kontomenü" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Einstellungen" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Hilfe und Ressourcen" })).toBeVisible();
  });
});
