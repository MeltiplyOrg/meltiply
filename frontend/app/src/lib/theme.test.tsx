// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { themeStorageKey } from "@meltiply/ui/theme-preference";
import { resolveTheme, ThemeProvider, useTheme } from "./theme";

/**
 * Mutable stand-in for the effective motion preference. The provider reads
 * `useMotionPreference()` on every render, so flipping this between renders
 * exercises the same code path as a real OS/user change.
 */
const motionState = vi.hoisted(() => ({
  lowMotion: false,
  manualLowMotion: false,
  systemLowMotion: false,
}));

/**
 * Scripted stand-in for the shared live-wave runtime. `startThemeReveal`
 * records every call and returns a contract-shaped handle: `setDirection`
 * accepts retargets only while the wave is active (returning `false` once it
 * has finished, matching the real runtime), and `skip()` settles the wave at
 * its latest direction — `applyTheme` forward, `restoreTheme` in reverse.
 * Tests complete a wave naturally via `finishWave`; provider-driven settles
 * go through `handle.skip()` exactly as the adapter calls them.
 */
const waveState = vi.hoisted(() => ({
  calls: [] as {
    fromTheme: string;
    toTheme: string;
    origin: { x: number; y: number };
    lowMotion: boolean;
  }[],
  active: false,
  forward: true,
  kind: "ink" as "ink" | "blink",
  applyTheme: (): void => undefined,
  restoreTheme: (): void => undefined,
}));

vi.mock("@meltiply/ui/motion-preference", () => ({
  useMotionPreference: () => ({
    lowMotion: motionState.lowMotion,
    manualLowMotion: motionState.manualLowMotion,
    systemLowMotion: motionState.systemLowMotion,
    setManualLowMotion: () => undefined,
  }),
}));

vi.mock("@meltiply/ui/theme-transition", () => ({
  applyThemeImmediately: (applyTheme: () => void): void => {
    // Mirrors the real runtime's suppression side effect for origin-less
    // commits (the release is rAF-driven and stays inert under the test stub).
    document.documentElement.classList.add("theme-changing");
    applyTheme();
  },
  startThemeReveal: (options: {
    fromTheme: string;
    toTheme: string;
    applyTheme: () => void;
    restoreTheme: () => void;
    origin: { x: number; y: number };
    lowMotion: boolean;
  }) => {
    waveState.calls.push({
      fromTheme: options.fromTheme,
      toTheme: options.toTheme,
      origin: options.origin,
      lowMotion: options.lowMotion,
    });
    waveState.active = true;
    waveState.forward = true;
    waveState.kind = options.lowMotion ? "blink" : "ink";
    waveState.applyTheme = options.applyTheme;
    waveState.restoreTheme = options.restoreTheme;
    const settle = () => {
      if (!waveState.active) return;
      waveState.active = false;
      if (waveState.forward) {
        waveState.applyTheme();
      } else {
        waveState.restoreTheme();
      }
    };
    return {
      kind: waveState.kind,
      setDirection: (forward: boolean) => {
        if (!waveState.active || waveState.kind !== "ink") return false;
        waveState.forward = forward;
        return true;
      },
      skip: settle,
    };
  },
  themeOriginFromEvent: () => ({ x: 0, y: 0 }),
}));

/**
 * Settles the scripted wave as if its animation reached an endpoint, without
 * going through the provider's `skip()` path. Direction defaults to whatever
 * the last `setDirection` (or wave start) left.
 */
function finishWave(): void {
  if (!waveState.active) return;
  waveState.active = false;
  if (waveState.forward) {
    waveState.applyTheme();
  } else {
    waveState.restoreTheme();
  }
}

/**
 * Probe exposing committed vs requested palette plus an origin-driven toggle,
 * so tests can watch the two diverge while a wave is in flight.
 */
function ToggleProbe(): React.ReactElement {
  const { requestedTheme, theme, toggleTheme } = useTheme();
  return (
    <>
      <span data-testid="committed">{theme}</span>
      <span data-testid="requested">{requestedTheme}</span>
      <button type="button" onClick={() => toggleTheme({ x: 10, y: 10 })}>
        toggle
      </button>
    </>
  );
}

/**
 * Probe driving explicit selections both with an activation origin and
 * without one, plus a same-palette re-selection to exercise no-op requests.
 */
function SelectProbe(): React.ReactElement {
  const { requestedTheme, setTheme, theme } = useTheme();
  return (
    <>
      <span data-testid="committed">{theme}</span>
      <span data-testid="requested">{requestedTheme}</span>
      <button type="button" onClick={() => setTheme("light", { x: 10, y: 10 })}>
        light
      </button>
      <button type="button" onClick={() => setTheme("dark", { x: 20, y: 20 })}>
        dark
      </button>
      <button type="button" onClick={() => setTheme("light")}>
        light-instant
      </button>
      <button type="button" onClick={() => setTheme("dark")}>
        dark-instant
      </button>
      <button type="button" onClick={() => setTheme(theme)}>
        same
      </button>
    </>
  );
}
/** Resets page-only navigation intent alongside the consent and animation fixtures. */
beforeEach(() => {
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
  document.documentElement.removeAttribute("data-theme-preference");
  window.localStorage.clear();
  writeCookieConsent({ functional: true, analytics: false, marketing: false });

  waveState.calls = [];
  waveState.active = false;
  waveState.forward = true;
  waveState.kind = "ink";
  motionState.lowMotion = false;
  motionState.manualLowMotion = false;
  motionState.systemLowMotion = false;
});

/** Removes hydrated page intent so later scenarios cannot inherit a transferred palette. */
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme-preference");
  document.documentElement.style.removeProperty("color-scheme");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
});

describe("theme resolution", () => {
  it("prefers a stored choice over the system preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("falls back to the system preference for unknown values", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("sepia", true)).toBe("dark");
  });
});

/** Hydration and an initial optional-cookie rejection preserve transferred light intent without storage, even on a dark OS. */
it("preserves a transferred light palette through hydration without functional consent", () => {
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.documentElement.removeAttribute("data-cookie-functional");
  document.documentElement.removeAttribute("data-cookie-decided");
  document.documentElement.setAttribute("data-theme-preference", "light");
  document.documentElement.classList.remove("dark");
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  expect(document.documentElement).not.toHaveClass("dark");
  expect(screen.getByTestId("committed")).toHaveTextContent("light");
  expect(screen.getByTestId("requested")).toHaveTextContent("light");
  expect(window.localStorage.getItem(themeStorageKey)).toBeNull();
  act(() => writeCookieConsent({ functional: false, analytics: false, marketing: false }));
  expect(document.documentElement).not.toHaveClass("dark");
  expect(document.documentElement.style.colorScheme).toBe("light");
});

it("keeps theme usable in memory without reading or writing optional storage", () => {
  writeCookieConsent({ functional: false, analytics: false, marketing: false });
  window.localStorage.setItem(themeStorageKey, "light");
  const get = vi.spyOn(Storage.prototype, "getItem");
  const set = vi.spyOn(Storage.prototype, "setItem");

  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  act(() => screen.getByRole("button", { name: "dark-instant" }).click());

  expect(screen.getByTestId("committed")).toHaveTextContent("dark");
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  get.mockRestore();
  set.mockRestore();
});

/**
 * Preserves a theme selected in memory before acceptance, then proves
 * withdrawal clears both optional stores and returns to the OS palette.
 */
it("persists the current choice on acceptance and clears it on withdrawal", () => {
  act(() => {
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
  });
  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  act(() => screen.getByRole("button", { name: "dark-instant" }).click());
  expect(window.localStorage.getItem(themeStorageKey)).toBeNull();

  act(() => {
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
  });
  expect(window.localStorage.getItem(themeStorageKey)).toBe("dark");

  act(() => {
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
  });
  expect(window.localStorage.getItem(themeStorageKey)).toBeNull();
  expect(document.cookie).not.toContain("meltiply-theme=dark");
  expect(screen.getByTestId("committed")).toHaveTextContent("light");
});

describe("ThemeProvider", () => {
  it("applies the stored theme to the document root", () => {
    window.localStorage.setItem(themeStorageKey, "dark");

    render(
      <ThemeProvider>
        <ToggleProbe />
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByTestId("committed")).toHaveTextContent("dark");
    expect(screen.getByTestId("requested")).toHaveTextContent("dark");
  });

  it("persists an instant change and swaps the root class", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light-instant" }).click());

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(screen.getByTestId("committed")).toHaveTextContent("light");
    expect(window.localStorage.getItem(themeStorageKey)).toBe("light");
  });

  it("commits origin-less changes inside the shared suppression window", () => {
    // Programmatic `setTheme` (no activation point) must still suppress the
    // per-component colour transitions that would otherwise smear the swap.
    window.localStorage.setItem(themeStorageKey, "dark");
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light-instant" }).click());

    expect(document.documentElement.classList.contains("theme-changing")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(waveState.calls).toHaveLength(0);
  });

  it("keeps the root palette unchanged until a wave reaches its endpoint", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light" }).click());

    // Requested moves immediately so controls reflect the selection; the
    // committed palette and root class wait for the wave's endpoint.
    expect(waveState.calls).toEqual([
      { fromTheme: "dark", toTheme: "light", origin: { x: 10, y: 10 }, lowMotion: false },
    ]);
    expect(screen.getByTestId("requested")).toHaveTextContent("light");
    expect(screen.getByTestId("committed")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem(themeStorageKey)).toBe("light");

    act(() => finishWave());

    expect(screen.getByTestId("committed")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("retargets one running wave instead of restarting it", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light" }).click());
    // Re-selecting the wave's target continues forward; selecting the
    // committed palette rolls the same wave back. Neither starts a second
    // reveal.
    act(() => screen.getByRole("button", { name: "light" }).click());
    act(() => screen.getByRole("button", { name: "dark" }).click());

    expect(waveState.calls).toHaveLength(1);
    expect(screen.getByTestId("requested")).toHaveTextContent("dark");

    act(() => finishWave());

    // The reversed wave restores the palette it started from: the newest
    // selection lands without ever having restarted the animation.
    expect(screen.getByTestId("committed")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("alternates same-task toggles against the latest request", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    render(
      <ThemeProvider>
        <ToggleProbe />
      </ThemeProvider>,
    );

    const toggle = screen.getByRole("button", { name: "toggle" });
    // Committed state is still dark for all three activations; only
    // latest-request parity makes them alternate instead of repeating the
    // same forward target.
    act(() => toggle.click());
    act(() => toggle.click());
    act(() => toggle.click());

    expect(waveState.calls).toHaveLength(1);
    expect(screen.getByTestId("requested")).toHaveTextContent("light");
    expect(screen.getByTestId("committed")).toHaveTextContent("dark");
    expect(window.localStorage.getItem(themeStorageKey)).toBe("light");

    act(() => finishWave());

    expect(screen.getByTestId("committed")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("finishes the latest request instantly for origin-less changes", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light" }).click());
    // A programmatic selection mid-wave settles it toward the newest request:
    // no animation restarts and the committed palette jumps straight there.
    act(() => screen.getByRole("button", { name: "light-instant" }).click());
    expect(waveState.calls).toHaveLength(1);
    expect(screen.getByTestId("committed")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // An instant change to the committed side of a reversed wave likewise
    // commits immediately instead of waiting for the animation.
    act(() => screen.getByRole("button", { name: "dark" }).click());
    act(() => screen.getByRole("button", { name: "dark-instant" }).click());

    expect(waveState.calls).toHaveLength(2);
    expect(screen.getByTestId("committed")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("persists a re-selection of the committed palette without animating", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "same" }).click());

    // Re-selecting the active palette is a no-op visually, but the write is
    // still attempted so storage stays authoritative.
    expect(waveState.calls).toHaveLength(0);
    expect(setSpy).toHaveBeenCalledWith(themeStorageKey, "dark");
    expect(screen.getByTestId("committed")).toHaveTextContent("dark");
  });

  it("applies the request and records it when storage writes are denied", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light" }).click());
    act(() => finishWave());

    // A denied write must not swallow the selection: the palette still
    // commits for the current session even though nothing was persisted.
    expect(screen.getByTestId("requested")).toHaveTextContent("light");
    expect(screen.getByTestId("committed")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("settles a running ink wave when low motion becomes effective", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    function Harness(): React.ReactElement {
      const [, setTick] = React.useState(0);
      return (
        <>
          <ThemeProvider>
            <SelectProbe />
          </ThemeProvider>
          <button type="button" onClick={() => setTick((value) => value + 1)}>
            tick
          </button>
        </>
      );
    }
    render(<Harness />);

    act(() => screen.getByRole("button", { name: "light" }).click());
    // The wave is still in flight: turning low motion on must settle it
    // toward the newest request instead of leaving spatial motion running
    // under an accessibility preference.
    motionState.lowMotion = true;
    act(() => screen.getByRole("button", { name: "tick" }).click());

    expect(waveState.active).toBe(false);
    expect(screen.getByTestId("committed")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("uses a blink reveal under effective low motion and settles retargets on it", () => {
    motionState.lowMotion = true;
    window.localStorage.setItem(themeStorageKey, "dark");
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light" }).click());
    expect(waveState.calls).toEqual([
      { fromTheme: "dark", toTheme: "light", origin: { x: 10, y: 10 }, lowMotion: true },
    ]);

    // Blinks carry no direction, so a new selection settles the current one
    // and starts a fresh blink toward the newest request.
    act(() => screen.getByRole("button", { name: "dark" }).click());
    expect(waveState.calls).toHaveLength(2);
    expect(screen.getByTestId("committed")).toHaveTextContent("light");

    act(() => finishWave());
    expect(screen.getByTestId("committed")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("settles an in-flight wave to the latest request on unmount", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    const { unmount } = render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light" }).click());
    unmount();

    // The abandoned wave commits the requested palette directly on the root
    // without a React state write.
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(waveState.active).toBe(false);
  });

  it("leaves the document alone when unmounting with no wave running", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    const { unmount } = render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    unmount();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
