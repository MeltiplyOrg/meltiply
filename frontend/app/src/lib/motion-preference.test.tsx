// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import {
  MotionPreferenceProvider,
  useMotionAllowed,
  useMotionPreference,
} from "@meltiply/ui/motion-preference";
import { motionPreferenceStorageKey } from "@meltiply/ui/motion-state";
import { themeStorageKey } from "@meltiply/ui/theme-preference";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

let systemReducedMotion = false;
const mediaListeners = new Set<() => void>();

/**
 * Flips the stubbed OS reduced-motion preference and notifies every registered
 * media-query listener, simulating a live `(prefers-reduced-motion: reduce)`
 * change mid-session so provider effects recompute without a reload.
 *
 * @param matches Whether the OS now requests reduced motion.
 */
function emitSystemPreferenceChange(matches: boolean) {
  systemReducedMotion = matches;
  for (const listener of mediaListeners) listener();
}

/**
 * Renders the provider's effective and OS-level motion state as a toggle button
 * (`low|full:system|device-default`) so tests can read the resolved preference
 * and flip the manual choice through the real context setter.
 */
function MotionProbe(): React.ReactElement {
  const { lowMotion, manualLowMotion, setManualLowMotion, systemLowMotion } = useMotionPreference();
  return (
    <button type="button" onClick={() => setManualLowMotion(!manualLowMotion)}>
      {lowMotion ? "low" : "full"}:{systemLowMotion ? "system" : "device-default"}
    </button>
  );
}

/**
 * Executes the inline boot scripts from `index.html` against the test document,
 * mirroring the browser's pre-paint run before the module bundle loads React.
 * Scripts are located by parsing the HTML — never asserted as source text — and
 * only classic inline scripts (`<script>` without `src` or `type`) run, matching
 * what a browser executes in place. Evaluation uses `new Function` so top-level
 * `var` declarations stay scoped to the call while `window`, `document`, and
 * `localStorage` resolve to the same jsdom objects the React tests observe.
 * The helper asserts nothing about script presence itself: the stored-on and
 * OS-on tests fail when the boot script is missing or dead, so the behavioral
 * assertions — not an existence check — prove it actually ran.
 */
function runBootScript(): void {
  const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const scripts = parsed.querySelectorAll("script:not([src]):not([type])");
  for (const script of scripts) {
    new Function(script.textContent ?? "")();
  }
}

beforeEach(() => {
  systemReducedMotion = false;
  document.documentElement.removeAttribute("data-low-motion");
  document.documentElement.classList.remove("dark");
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
  window.localStorage.clear();
  writeCookieConsent({ functional: true, analytics: false, marketing: false });

  mediaListeners.clear();
  // Only the reduced-motion query can match; every other media query
  // (e.g. prefers-color-scheme) always reports no preference.
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === reducedMotionQuery && systemReducedMotion;
    },
    media: query,
    addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
  window.history.replaceState(null, "", "/");
  document.documentElement.removeAttribute("data-cookie-functional");
  document.documentElement.removeAttribute("data-cookie-decided");
});

describe("native-page motion consumers", () => {
  it("reacts to native root changes and live OS changes without a React provider", async () => {
    render(<MotionProbe />);
    expect(screen.getByRole("button")).toHaveTextContent("full:device-default");
    await act(async () => {
      document.documentElement.setAttribute("data-low-motion", "");
    });
    expect(screen.getByRole("button")).toHaveTextContent("low:device-default");
    act(() => emitSystemPreferenceChange(true));
    expect(screen.getByRole("button")).toHaveTextContent("low:system");
    await act(async () => {
      document.documentElement.removeAttribute("data-low-motion");
    });
    expect(screen.getByRole("button")).toHaveTextContent("low:system");
    act(() => emitSystemPreferenceChange(false));
    expect(screen.getByRole("button")).toHaveTextContent("full:device-default");
  });

  it("freezes spatial motion during ink without changing the accessibility preference", async () => {
    /** Exposes the consumer's spatial and accessibility states independently. */
    function SpatialProbe(): React.ReactElement {
      const allowed = useMotionAllowed();
      const { lowMotion } = useMotionPreference();
      return (
        <output>
          {allowed ? "moving" : "still"}:{lowMotion ? "low" : "full"}
        </output>
      );
    }
    render(<SpatialProbe />);
    expect(screen.getByRole("status")).toHaveTextContent("moving:full");
    await act(async () => {
      document.documentElement.setAttribute("data-theme-ink", "");
    });
    expect(screen.getByRole("status")).toHaveTextContent("still:full");
    await act(async () => {
      document.documentElement.removeAttribute("data-theme-ink");
    });
    expect(screen.getByRole("status")).toHaveTextContent("moving:full");
  });
});

describe("MotionPreferenceProvider", () => {
  it("applies the stored manual choice to the document root", () => {
    window.localStorage.setItem(motionPreferenceStorageKey, "on");

    render(
      <MotionPreferenceProvider>
        <MotionProbe />
      </MotionPreferenceProvider>,
    );

    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
    expect(screen.getByRole("button")).toHaveTextContent("low:device-default");
  });

  it("persists the manual choice and toggles the root marker", () => {
    render(
      <MotionPreferenceProvider>
        <MotionProbe />
      </MotionPreferenceProvider>,
    );

    act(() => screen.getByRole("button").click());
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
    expect(window.localStorage.getItem(motionPreferenceStorageKey)).toBe("on");

    act(() => screen.getByRole("button").click());
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(false);
    expect(window.localStorage.getItem(motionPreferenceStorageKey)).toBeNull();
  });

  it("keeps low motion active when the OS requests it and manual mode is off", () => {
    systemReducedMotion = true;
    render(
      <MotionPreferenceProvider>
        <MotionProbe />
      </MotionPreferenceProvider>,
    );

    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
    expect(screen.getByRole("button")).toHaveTextContent("low:system");

    // Turning the manual switch on then off must not restore motion under an OS preference.
    act(() => screen.getByRole("button").click());
    act(() => screen.getByRole("button").click());
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
  });

  it("recomputes when the OS preference changes during the session", () => {
    render(
      <MotionPreferenceProvider>
        <MotionProbe />
      </MotionPreferenceProvider>,
    );

    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(false);
    act(() => emitSystemPreferenceChange(true));
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
    act(() => emitSystemPreferenceChange(false));
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(false);
  });

  /** Ensures storage failures do not prevent the current-page motion control from working. */
  it("keeps the in-memory toggle working when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    render(
      <MotionPreferenceProvider>
        <MotionProbe />
      </MotionPreferenceProvider>,
    );

    act(() => screen.getByRole("button").click());
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
  });

  /**
   * Manual motion remains a live in-memory accessibility control when
   * functional consent is denied, without reading or writing preference storage.
   */
  it("keeps the manual low-motion control working without optional storage", () => {
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");

    render(
      <MotionPreferenceProvider>
        <MotionProbe />
      </MotionPreferenceProvider>,
    );
    act(() => screen.getByRole("button").click());

    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
    expect(screen.getByRole("button")).toHaveTextContent("low:device-default");
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    get.mockRestore();
    set.mockRestore();
  });
});

describe("boot script", () => {
  it("marks the document root before React renders when low motion is stored", () => {
    window.localStorage.setItem(motionPreferenceStorageKey, "on");

    runBootScript();

    // The marker must exist before React mounts so pre-paint CSS can honor it,
    // and the provider must preserve it once it takes over the document root.
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    render(
      <MotionPreferenceProvider>
        <MotionProbe />
      </MotionPreferenceProvider>,
    );

    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
    expect(screen.getByRole("button")).toHaveTextContent("low:device-default");
  });

  it("leaves the root unmarked when the stored choice is off", () => {
    window.localStorage.setItem(motionPreferenceStorageKey, "off");

    runBootScript();

    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(false);
  });

  it("leaves the root unmarked when the stored value is invalid", () => {
    window.localStorage.setItem(motionPreferenceStorageKey, "sepia");

    runBootScript();

    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(false);
  });

  it("marks the root when the OS requests reduced motion and the manual choice is off", () => {
    window.localStorage.setItem(motionPreferenceStorageKey, "off");
    systemReducedMotion = true;

    runBootScript();

    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
  });

  it("marks the root when the OS requests reduced motion and nothing is stored", () => {
    systemReducedMotion = true;

    runBootScript();

    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
  });

  it("applies the stored theme without enabling low motion", () => {
    window.localStorage.setItem(themeStorageKey, "dark");

    runBootScript();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(false);
  });

  it("keeps OS reduced motion active when preference storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    systemReducedMotion = true;

    expect(() => runBootScript()).not.toThrow();
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(true);
  });

  /**
   * A transferred light choice overrides stale dark storage without consent.
   * Boot must not read or write optional stores and must strip only its query.
   */
  it("applies transferred intent without accessing optional storage", () => {
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
    window.localStorage.setItem(themeStorageKey, "dark");
    window.localStorage.setItem(motionPreferenceStorageKey, "on");
    document.cookie = "meltiply-theme=dark; Path=/";
    window.history.replaceState(null, "", "/?meltiply-theme=light&keep=1");
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");

    runBootScript();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.getAttribute("data-theme-preference")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.hasAttribute("data-low-motion")).toBe(false);
    expect(window.location.search).toBe("?keep=1");
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    get.mockRestore();
    set.mockRestore();
  });
});
