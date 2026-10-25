// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Skeleton } from "@meltiply/ui/skeleton";
import { FrontendErrorBoundary } from "@/components/layout/frontend-error-boundary";
import { RuntimeStatus } from "@/components/layout/runtime-status";
import { I18nProvider, translate } from "@/lib/i18n";
import { frontendTelemetryEvent } from "@/lib/frontend-telemetry";
import { isPseudoLocalized, setPseudoLocalization } from "@/lib/pseudo-locale";

import { DevBox, DevBoxClientBridge } from "./dev-box";
import {
  devBoxStorageKey,
  readDevBoxState,
  writeDevBoxState,
  type DevBoxState,
} from "./devbox-state";
import { getDevBoxQueryClient, registerDevBoxQueryClient } from "./query-client-registry";
import {
  getThrottleLatency,
  isSkeletonHoldActive,
  uninstallNetworkThrottle,
} from "./network-throttle";
import { breakpointForWidth } from "./viewport-frame";
import { pseudoLocalize } from "@/lib/pseudo-locale";

function seedDockState(patch: Partial<DevBoxState> = {}) {
  window.localStorage.setItem(
    devBoxStorageKey,
    JSON.stringify({
      hidden: false,
      collapsed: false,
      tab: "skeletons",
      position: null,
      latency: 0,
      agentation: false,
      ...patch,
    }),
  );
}

function renderDevBox() {
  return render(
    <I18nProvider>
      <DevBox />
    </I18nProvider>,
  );
}

const initialViewport = { width: window.innerWidth, height: window.innerHeight };

/** Overrides layout dimensions that jsdom does not derive from CSS. */
function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

/** Builds a DOMRect-shaped measurement for a mocked dock. */
function rect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    width,
    height,
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Replaces one dock's measured box without touching other elements. */
function mockDockRect(panel: Element, box: DOMRect): void {
  Object.defineProperty(panel, "getBoundingClientRect", {
    configurable: true,
    value: () => box,
  });
}

/**
 * Minimal query-backed view used to prove the DevBox exercises a component’s
 * native loading branch: cached data renders text, while a reset query held by
 * Skeleton preview renders the shared Skeleton component instead.
 */
function QuerySkeletonFixture() {
  const query = useQuery({
    queryKey: ["devbox-preview-fixture"],
    queryFn: async ({ signal }) => {
      const response = await fetch("https://api.test/devbox-preview-fixture", { signal });
      return response.json() as Promise<{ id: string }>;
    },
    staleTime: Infinity,
  });
  return query.isLoading ? (
    <Skeleton data-testid="native-query-skeleton" />
  ) : (
    <p data-testid="query-result">Rendered query content</p>
  );
}

/** Starts each DevBox case with isolated storage and explicit functional consent. */
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  writeCookieConsent({ functional: true, analytics: false, marketing: false });
  seedDockState();
});

/** Clears browser state and global DevBox hooks so optional records cannot leak between cases. */
afterEach(() => {
  cleanup();
  setViewport(initialViewport.width, initialViewport.height);
  registerDevBoxQueryClient(null);
  uninstallNetworkThrottle();
  setPseudoLocalization(false);
  document.documentElement.removeAttribute("data-devbox-viewport");
  document.documentElement.removeAttribute("data-devbox-grid");
  document.documentElement.removeAttribute("data-devbox-outlines");
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
});

describe("DevBox shell", () => {
  it("renders the expanded dock with all four tabs", () => {
    renderDevBox();
    expect(screen.getByRole("region", { name: "Meltiply DevBox" })).toBeInTheDocument();
    for (const tab of ["Skeletons", "Benchmark", "Trace", "Helpers"]) {
      expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
    }
  });

  it("collapses to a pill and expands again", () => {
    renderDevBox();
    fireEvent.click(screen.getByRole("button", { name: "Collapse DevBox" }));
    expect(screen.queryByRole("tab", { name: "Skeletons" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand DevBox" }));
    expect(screen.getByRole("tab", { name: "Skeletons" })).toBeInTheDocument();
  });

  it("drags the collapsed pill without expanding it", () => {
    seedDockState({ collapsed: true });
    renderDevBox();
    const pill = screen.getByRole("button", { name: "Expand DevBox" });

    fireEvent.pointerDown(pill, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pill, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(pill, { pointerId: 1, clientX: 160, clientY: 140 });
    fireEvent.click(pill);

    const panel = screen.getByRole("region", { name: "Meltiply DevBox" });
    expect(panel).toHaveStyle({ left: "60px", top: "40px" });
    expect(screen.queryByRole("tab", { name: "Skeletons" })).not.toBeInTheDocument();

    fireEvent.click(pill);
    expect(screen.getByRole("tab", { name: "Skeletons" })).toBeInTheDocument();
  });

  it("does not capture pointer presses on the collapse button", () => {
    renderDevBox();
    const header = screen.getByRole("button", { name: "Collapse DevBox" }).parentElement
      ?.parentElement;
    const capture = vi.fn();
    if (!header) throw new Error("DevBox header is missing");
    header.setPointerCapture = capture;

    fireEvent.pointerDown(screen.getByRole("button", { name: "Collapse DevBox" }), {
      pointerId: 1,
    });
    expect(capture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Collapse DevBox" }));
    expect(screen.getByRole("button", { name: "Expand DevBox" })).toBeInTheDocument();
  });

  it("hides and reveals via the keyboard shortcut", () => {
    renderDevBox();
    fireEvent.keyDown(window, { key: "d", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("region", { name: "Meltiply DevBox" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "d", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("region", { name: "Meltiply DevBox" })).toBeInTheDocument();
  });

  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    it(`clamps a persisted position to the expanded dock on mount at ${viewport.name} width`, () => {
      setViewport(viewport.width, viewport.height);
      seedDockState({ collapsed: false, position: { x: 5000, y: 5000 } });
      const measure = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockReturnValue(rect(380, 300));
      try {
        renderDevBox();
        expect(screen.getByRole("region", { name: "Meltiply DevBox" })).toHaveStyle({
          left: `${viewport.width - 380}px`,
          top: `${viewport.height - 300}px`,
        });
      } finally {
        measure.mockRestore();
      }
    });
  }

  it("re-clamps a persisted position when the viewport resizes", () => {
    setViewport(1200, 800);
    seedDockState({ collapsed: false, position: { x: 700, y: 900 } });
    renderDevBox();
    const panel = screen.getByRole("region", { name: "Meltiply DevBox" });
    mockDockRect(panel, rect(380, 300));

    setViewport(390, 844);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(panel).toHaveStyle({ left: "10px", top: "544px" });
  });

  it("re-clamps when a collapsed dock expands", () => {
    setViewport(390, 844);
    seedDockState({ collapsed: true, position: { x: 350, y: 700 } });
    renderDevBox();
    const panel = screen.getByRole("region", { name: "Meltiply DevBox" });
    mockDockRect(panel, rect(380, 300));

    fireEvent.click(screen.getByRole("button", { name: "Expand DevBox" }));

    expect(screen.getByRole("tab", { name: "Skeletons" })).toBeInTheDocument();
    expect(panel).toHaveStyle({ left: "10px", top: "544px" });
  });

  it("keeps an expanded dock inside a phone viewport while dragging", () => {
    setViewport(390, 844);
    seedDockState({ collapsed: false });
    renderDevBox();
    const panel = screen.getByRole("region", { name: "Meltiply DevBox" });
    mockDockRect(panel, rect(380, 300));
    const header = screen.getByRole("button", { name: "Collapse DevBox" }).parentElement
      ?.parentElement;
    if (!header) throw new Error("DevBox header is missing");

    fireEvent.pointerDown(header, { pointerId: 7, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(header, { pointerId: 7, clientX: 600, clientY: 600 });
    fireEvent.pointerUp(header, { pointerId: 7, clientX: 600, clientY: 600 });

    expect(panel).toHaveStyle({ left: "10px", top: "544px" });
  });

  it("removes overlays, frame, highlights, and the picker on unmount", () => {
    seedDockState({ tab: "skeletons" });
    const raw = document.createElement("div");
    raw.setAttribute("style", "background-color: rgb(255, 0, 0)");
    document.body.appendChild(raw);
    const { unmount } = renderDevBox();

    fireEvent.click(screen.getByRole("switch", { name: "Toggle 390px viewport frame" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Helpers" }), { button: 0 });
    fireEvent.click(screen.getByRole("switch", { name: "Toggle baseline grid" }));
    fireEvent.click(screen.getByRole("switch", { name: "Toggle element outlines" }));
    fireEvent.click(screen.getByRole("switch", { name: "Toggle token picker" }));
    fireEvent.click(screen.getByRole("button", { name: "Audit page" }));

    expect(document.documentElement.hasAttribute("data-devbox-grid")).toBe(true);
    expect(document.documentElement.hasAttribute("data-devbox-outlines")).toBe(true);
    expect(document.documentElement.hasAttribute("data-devbox-viewport")).toBe(true);
    expect(raw).toHaveAttribute("data-devbox-token-violation");
    expect(document.getElementById("devbox-picker-highlight")).not.toBeNull();

    unmount();
    raw.remove();

    expect(document.documentElement.hasAttribute("data-devbox-grid")).toBe(false);
    expect(document.documentElement.hasAttribute("data-devbox-outlines")).toBe(false);
    expect(document.documentElement.hasAttribute("data-devbox-viewport")).toBe(false);
    expect(document.getElementById("devbox-grid-overlay")).toBeNull();
    expect(document.getElementById("devbox-viewport-label")).toBeNull();
    expect(document.getElementById("devbox-overlay-style")).toBeNull();
    expect(document.getElementById("devbox-viewport-style")).toBeNull();
    expect(document.getElementById("devbox-token-violation-style")).toBeNull();
    expect(document.getElementById("devbox-picker-highlight")).toBeNull();
    expect(raw).not.toHaveAttribute("data-devbox-token-violation");
  });

  it("removes page overlays when the dock is hidden", () => {
    seedDockState({ tab: "helpers" });
    renderDevBox();
    fireEvent.click(screen.getByRole("switch", { name: "Toggle baseline grid" }));
    fireEvent.click(screen.getByRole("switch", { name: "Toggle element outlines" }));
    expect(document.documentElement.hasAttribute("data-devbox-grid")).toBe(true);

    fireEvent.keyDown(window, { key: "d", ctrlKey: true, shiftKey: true });

    expect(screen.queryByRole("region", { name: "Meltiply DevBox" })).not.toBeInTheDocument();
    expect(document.documentElement.hasAttribute("data-devbox-grid")).toBe(false);
    expect(document.documentElement.hasAttribute("data-devbox-outlines")).toBe(false);
    expect(document.getElementById("devbox-grid-overlay")).toBeNull();
  });

  it("releases requests held by infinite latency when the dock unmounts", async () => {
    const base = vi.fn(() => Promise.resolve(new Response("{}")));
    const original = globalThis.fetch;
    globalThis.fetch = base;
    try {
      const { unmount } = renderDevBox();
      fireEvent.click(screen.getByRole("button", { name: "∞" }));
      const held = globalThis.fetch("https://api.test/infinite");

      expect(base).not.toHaveBeenCalled();
      unmount();

      await expect(held).resolves.toBeInstanceOf(Response);
      expect(base).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("persists dock state across remounts", () => {
    const first = renderDevBox();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Helpers" }), {
      button: 0,
      ctrlKey: false,
    });
    first.unmount();
    renderDevBox();
    expect(screen.getByRole("tab", { name: "Helpers" })).toHaveAttribute("aria-selected", "true");
  });

  it("keeps DevBox usable without optional persistence after rejection", () => {
    window.localStorage.setItem("feedback-annotations-/posts", "optional annotation");
    window.sessionStorage.setItem("agentation-session-/posts", "optional session");
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
    window.localStorage.setItem(
      devBoxStorageKey,
      JSON.stringify({
        hidden: false,
        collapsed: false,
        tab: "helpers",
        position: null,
        latency: 0,
        agentation: false,
      }),
    );
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");

    expect(readDevBoxState().tab).toBe("skeletons");
    writeDevBoxState({
      hidden: false,
      collapsed: false,
      tab: "helpers",
      position: null,
      latency: 0,
      agentation: false,
    });

    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    get.mockRestore();
    set.mockRestore();
    renderDevBox();
    fireEvent.click(screen.getByRole("button", { name: "Expand DevBox" }));
    expect(screen.getByRole("tab", { name: "Skeletons" })).toBeInTheDocument();
    expect(window.localStorage.getItem("feedback-annotations-/posts")).toBeNull();
    expect(window.sessionStorage.getItem("agentation-session-/posts")).toBeNull();
  });
});

describe("Skeletons tab", () => {
  it("switches cached workspace queries between skeleton and rendered previews", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["assets"], [{ id: "a1" }]);
    registerDevBoxQueryClient(queryClient);
    renderDevBox();

    fireEvent.click(screen.getByRole("button", { name: "Skeleton" }));

    await waitFor(() => {
      expect(queryClient.getQueryCache().find({ queryKey: ["assets"] })?.state.status).toBe(
        "pending",
      );
    });
    expect(isSkeletonHoldActive()).toBe(true);
    expect(screen.getByText(/Skeleton preview holds workspace reads/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rendered" }));

    await waitFor(() => expect(isSkeletonHoldActive()).toBe(false));
  });

  it("applies the selected latency to the network throttle", () => {
    renderDevBox();
    fireEvent.click(screen.getByRole("button", { name: "1.5s" }));
    expect(getThrottleLatency()).toBe(1500);
  });

  it("holds GET requests while letting mutations through in skeleton preview", async () => {
    const base = vi.fn().mockResolvedValue(new Response("{}"));
    const original = globalThis.fetch;
    globalThis.fetch = base;
    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      registerDevBoxQueryClient(queryClient);
      renderDevBox();
      fireEvent.click(screen.getByRole("button", { name: "Skeleton" }));
      await waitFor(() => expect(isSkeletonHoldActive()).toBe(true));

      // A held GET never reaches the wrapped fetch; a POST passes through.
      const controller = new AbortController();
      const held = globalThis.fetch("https://api.test/x", { signal: controller.signal });
      // Abort first, then await the rejection assertion directly: `.rejects`
      // accepts an already-settled promise, so this still proves the held GET
      // rejects with the signal's abort error without detaching the assertion
      // from its await the way the two-step `rejection` variable did.
      controller.abort();
      await expect(held).rejects.toThrow();
      expect(base).not.toHaveBeenCalled();

      await globalThis.fetch("https://api.test/x", { method: "POST" });
      expect(base).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("releases held GET requests when returning to rendered preview", async () => {
    const base = vi.fn().mockResolvedValue(new Response("{}"));
    const original = globalThis.fetch;
    globalThis.fetch = base;
    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      registerDevBoxQueryClient(queryClient);
      renderDevBox();
      fireEvent.click(screen.getByRole("button", { name: "Skeleton" }));
      await waitFor(() => expect(isSkeletonHoldActive()).toBe(true));

      const request = globalThis.fetch("https://api.test/release");
      expect(base).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Rendered" }));

      await expect(
        Promise.race([
          request,
          new Promise<never>((_, reject) =>
            window.setTimeout(() => reject(new Error("held request was not released")), 100),
          ),
        ]),
      ).resolves.toBeInstanceOf(Response);
      expect(base).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });
  it("renders native query skeletons while preview is selected", async () => {
    const base = vi.fn(() => Promise.resolve(new Response('{"id":"a1"}')));
    const original = globalThis.fetch;
    globalThis.fetch = base;
    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      registerDevBoxQueryClient(queryClient);
      render(
        <QueryClientProvider client={queryClient}>
          <QuerySkeletonFixture />
        </QueryClientProvider>,
      );
      renderDevBox();
      expect(await screen.findByTestId("query-result")).toHaveTextContent("Rendered query content");

      fireEvent.click(screen.getByRole("button", { name: "Skeleton" }));
      await waitFor(() => {
        const state = queryClient.getQueryCache().find({
          queryKey: ["devbox-preview-fixture"],
        })?.state;
        expect(state?.status).toBe("pending");
        expect(state?.fetchStatus).toBe("fetching");
      });

      expect(await screen.findByTestId("native-query-skeleton")).toBeInTheDocument();
      expect(
        screen.getByText("Skeleton preview holds workspace reads for 1 cached query."),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Rendered" }));

      expect(await screen.findByTestId("query-result")).toHaveTextContent("Rendered query content");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("applies the 390px frame and shows the breakpoint pill", () => {
    renderDevBox();
    fireEvent.click(screen.getByRole("switch", { name: "Toggle 390px viewport frame" }));
    expect(document.documentElement.hasAttribute("data-devbox-viewport")).toBe(true);
    expect(document.getElementById("devbox-viewport-label")).toHaveTextContent("390px");
    expect(
      screen.getByText(`${breakpointForWidth(window.innerWidth)} · ${window.innerWidth}px`),
    ).toBeInTheDocument();
  });
});

describe("Trace tab", () => {
  it("renders dispatched telemetry events in the live log", async () => {
    seedDockState({ tab: "trace" });
    renderDevBox();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(frontendTelemetryEvent, {
          detail: { kind: "api-error", status: 500, code: "internal" },
        }),
      );
    });
    expect((await screen.findAllByText(/api-error/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText("error").length).toBeGreaterThan(0);
  });
});

describe("Helpers tab", () => {
  it("runs an axe scan and reports violations", async () => {
    seedDockState({ tab: "helpers" });
    const img = document.createElement("img");
    img.setAttribute("src", "x");
    document.body.appendChild(img);
    renderDevBox();
    fireEvent.click(screen.getByRole("button", { name: "Scan route" }));
    expect(
      await screen.findByText(/image-alt|Images must have/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    img.remove();
  });

  it("toggles the baseline grid and outline overlays", () => {
    seedDockState({ tab: "helpers" });
    renderDevBox();
    fireEvent.click(screen.getByRole("switch", { name: "Toggle baseline grid" }));
    expect(document.documentElement.hasAttribute("data-devbox-grid")).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Toggle element outlines" }));
    expect(document.documentElement.hasAttribute("data-devbox-outlines")).toBe(true);
  });

  it("pseudo-localizes translated strings", () => {
    seedDockState({ tab: "helpers" });
    renderDevBox();
    fireEvent.click(screen.getByRole("switch", { name: "Toggle pseudo-localization" }));
    expect(isPseudoLocalized()).toBe(true);
    expect(translate("en", "Dashboard")).toMatch(/^⟦.*⟧$/);
  });

  it("dispatches the auth-expired runtime status", async () => {
    seedDockState({ tab: "helpers" });
    render(
      <I18nProvider>
        <RuntimeStatus />
        <DevBox />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expire session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your session expired");
  });

  it("throws a synthetic render error caught by the error boundary", async () => {
    seedDockState({ tab: "helpers" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <I18nProvider>
        <FrontendErrorBoundary>
          <DevBox />
        </FrontendErrorBoundary>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Crash this render" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An error has occurred.");
    vi.restoreAllMocks();
  });
});

describe("DevBoxClientBridge", () => {
  it("registers the scoped query client for the dock", () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <DevBoxClientBridge />
      </QueryClientProvider>,
    );
    expect(getDevBoxQueryClient()).toBe(queryClient);
  });
});

describe("pseudoLocalize", () => {
  it("expands strings and preserves placeholders", () => {
    const out = pseudoLocalize("Hello {name}");
    expect(out).toMatch(/^⟦.*⟧$/);
    expect(out).toContain("{name}");
    expect(out.length).toBeGreaterThan("Hello {name}".length);
  });
});
