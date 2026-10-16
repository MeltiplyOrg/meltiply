// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyThemeImmediately,
  startThemeReveal as startSharedThemeReveal,
  themeOriginFromEvent,
  type ThemeRevealHandle,
  type ThemeRevealOptions,
} from "@meltiply/ui/theme-transition";

let activeReveal: ThemeRevealHandle | undefined;

/** Retains the active handle so teardown settles paints before replacing globals or fixtures. */
function startThemeReveal(options: ThemeRevealOptions) {
  activeReveal = startSharedThemeReveal(options);
  return activeReveal;
}

/**
 * Deterministic two-palette fixture. The shared runtime samples the palette
 * tokens declared under the committed-theme selector and under the *other*
 * theme's selector, so the test declares the same convention the app ships:
 * `:root` is light, `.dark` is dark. Palette values are literal `rgb()` colors
 * because `getComputedStyle().getPropertyValue()` returns them verbatim, which
 * lets tests assert the actual painted palette instead of attribute wiring.
 */
const LIGHT_PAGE = "rgb(244, 244, 248)";
const LIGHT_INK = "rgb(24, 24, 32)";
const DARK_PAGE = "rgb(16, 16, 24)";
const DARK_INK = "rgb(236, 236, 240)";

/** Full forward wave duration. It is a user-facing contract, not a detail. */
const WAVE_FULL_MS = 1200;
/** Reduced-motion blink duration and its palette-commit midpoint. */
const BLINK_MS = 200;
const BLINK_MIDPOINT_MS = 100;

const VIEWPORT = { width: 1200, height: 800 } as const;
const DOC_HEIGHT = 5000;
/**
 * Declares the app's committed-theme convention and nothing else — all wave
 * paint comes from the real runtime and the masked layer the helper builds,
 * never from test-painted element styles. The app commits via `.dark` while
 * the landing uses `data-theme="dark"`; the shared palette block covers both
 * selector conventions plus the clone root a layer could theme directly.
 */
function installTestPalette(): void {
  const style = document.createElement("style");
  style.textContent = `
    :root { color: ${LIGHT_INK}; --page: ${LIGHT_PAGE}; --ink: ${LIGHT_INK}; --line: rgb(220, 220, 228); }
    .dark, [data-theme="dark"] {
      --page: ${DARK_PAGE}; --ink: ${DARK_INK}; --line: rgb(52, 52, 64);
    }
    .probe { background-color: var(--page); }
    :root.dark, :root[data-theme="dark"] { color: ${DARK_INK}; }
    .nested-scroll { overflow: auto; }
  `;
  document.head.appendChild(style);
}

/**
 * Compares effective palette colors, normalizing only serializer whitespace;
 * jsdom and browsers serialize identical RGB differently. Custom properties
 * inherit through cloned subtrees exactly like real layout, so the same read
 * works on live elements and on the masked layer's mirrored clone.
 */
function readsAs(element: Element, palette: "light" | "dark"): boolean {
  return (
    getComputedStyle(element).getPropertyValue("--page").replace(/\s+/g, "") ===
    (palette === "dark" ? DARK_PAGE : LIGHT_PAGE).replace(/\s+/g, "")
  );
}

/** Every mounted masked-copy overlay; the contract is at most one per wave. */
function inkLayers(): HTMLElement[] {
  return [...document.documentElement.querySelectorAll<HTMLElement>("[data-theme-ink-layer]")];
}

/** Returns the single mounted ink layer, asserting exactly one exists. */
function theInkLayer(): HTMLElement {
  const layers = inkLayers();
  expect(layers).toHaveLength(1);
  return layers[0]!;
}
/** Current document-space mask radius published on the root, in px. */
function waveRadius(): number {
  return parseFloat(document.documentElement.dataset.themeWaveRadius ?? "0");
}

/**
 * Reads inertness however the runtime expressed it: the `inert` attribute in
 * engines that reflect it, the expando property in jsdom where no reflection
 * exists. Both forms remove the clone from tab order and hit-testing.
 */
function isInert(element: HTMLElement): boolean {
  return (
    element.hasAttribute("inert") || (element as HTMLElement & { inert?: boolean }).inert === true
  );
}

/**
 * Manual rAF pump. The wave advances on `requestAnimationFrame` timestamps, so
 * tests drive a virtual clock instead of fake timers: `tick(ms)` advances the
 * clock first, then runs the callbacks that were queued before the tick (a
 * rAF re-queued by a callback belongs to the NEXT frame, matching browsers).
 * `performance.now` is aligned to the same clock because a runtime that reads
 * it instead of the rAF timestamp must still observe consistent progress.
 */
interface WaveClock {
  /** Advances the virtual clock and runs one animation frame. */
  tick(ms: number): void;
  /** Advances in 16ms frames until `total` has elapsed (drives many frames). */
  advance(total: number): void;
  /** Current virtual time in ms since the clock was installed. */
  now(): number;
}

/** Aligns rAF and performance clocks so manual frame travel verifies the real reversible timeline. */
function installWaveClock(): WaveClock {
  let now = 0;
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queue.push(callback);
    return queue.length;
  });
  const clock: WaveClock = {
    tick(ms: number) {
      now += ms;
      const frame = queue;
      queue = [];
      for (const callback of frame) callback(now);
    },
    advance(total: number) {
      for (let elapsed = 0; elapsed < total; elapsed += 16) clock.tick(16);
    },
    now: () => now,
  };
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return clock;
}

/**
 * Installs the capability probes the full-motion wave needs: `CSS.supports`
 * answering the mask-image radial-gradient query and a deterministic
 * document/viewport geometry. jsdom reports zero rects and zero scroll
 * extents, so the document gets an explicit unrolled height the layer's
 * capture must cover; scrolling moves viewport-space tops while
 * `docY + scrollY` document math stays stable.
 */
function installWaveEnvironment(): void {
  vi.stubGlobal("CSS", { supports: () => true });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: VIEWPORT.height });
  Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
  Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: 0 });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: (x: number, y?: number) => {
      window.scrollY = typeof y === "number" ? y : x;
      // Real viewport scrolls fire on the document and bubble to window;
      // dispatching there covers capture and bubble listeners on both.
      document.dispatchEvent(new Event("scroll", { bubbles: true }));
    },
  });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: DOC_HEIGHT,
  });
  Object.defineProperty(document.documentElement, "scrollWidth", {
    configurable: true,
    value: VIEWPORT.width,
  });
  Object.defineProperty(document.body, "scrollHeight", {
    configurable: true,
    value: DOC_HEIGHT,
  });
  Object.defineProperty(document.body, "scrollWidth", {
    configurable: true,
    value: VIEWPORT.width,
  });
  // jsdom reports zero rects for the root and body; the runtime needs the
  // full-document extent to size the mask's travel, not just the viewport.
  vi.spyOn(document.documentElement, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, -window.scrollY, VIEWPORT.width, DOC_HEIGHT),
  );
  vi.spyOn(document.body, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, -window.scrollY, VIEWPORT.width, DOC_HEIGHT),
  );
}

/**
 * Pins an element's document-space position via `getBoundingClientRect`. The
 * rect's viewport-space top tracks `window.scrollY`; callers can also pass a
 * dynamic doc-top getter (nested scroller content) so child rects move when a
 * scroller scrolls — matching real layout.
 */
function place(
  element: HTMLElement,
  rect: { centerX: number; docTop: number | (() => number); width?: number; height?: number },
): HTMLElement {
  const width = rect.width ?? 200;
  const height = rect.height ?? 40;
  const docTop = rect.docTop;
  vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => {
    const top = (typeof docTop === "function" ? docTop() : docTop) - window.scrollY;
    return new DOMRect(rect.centerX - width / 2, top, width, height);
  });
  return element;
}

/** Mounts a painted probe element with an explicit document-space position. */
function mountProbe(rect: {
  centerX: number;
  docTop: number;
  width?: number;
  height?: number;
}): HTMLElement {
  const element = document.createElement("div");
  element.className = "probe";
  element.textContent = "probe content";
  document.body.appendChild(element);
  return place(element, rect);
}

/** Standard light→dark reveal options; callbacks commit real root palette. */
function waveOptions(overrides: Partial<ThemeRevealOptions> = {}) {
  return {
    fromTheme: "light" as const,
    toTheme: "dark" as const,
    applyTheme: () => document.documentElement.classList.add("dark"),
    restoreTheme: () => document.documentElement.classList.remove("dark"),
    origin: { x: 150, y: 300 },
    lowMotion: false,
    ...overrides,
  };
}

/** The shared runtime releases suppression through `requestAnimationFrame`. */
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  installTestPalette();
});

/** Restores browser stubs, timers, root theme state, and test DOM. */
afterEach(() => {
  activeReveal?.skip();
  activeReveal = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(document.documentElement, "animate");
  document.documentElement.classList.remove("dark");
  document.documentElement.classList.remove("theme-changing");
  document.documentElement.removeAttribute("data-theme-ink");
  document.documentElement.removeAttribute("data-theme-wave");
  document.documentElement.removeAttribute("style");
  for (const layer of inkLayers()) layer.remove();
  document.body.replaceChildren();
  for (const style of document.head.querySelectorAll("style")) style.remove();
});

describe("themeOriginFromEvent", () => {
  it("anchors pointer activation to the button center rather than the clicked edge", () => {
    const button = document.createElement("button");
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 60, 80, 40));
    const origin = themeOriginFromEvent({
      clientX: 102,
      clientY: 62,
      detail: 1,
      currentTarget: button,
    });

    expect(origin).toEqual({ x: 140, y: 80 });
  });

  it("uses the control's center for keyboard-activated clicks", () => {
    const button = document.createElement("button");
    const rect = new DOMRect(100, 60, 80, 40);
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(rect);

    // Keyboard and programmatic clicks report detail 0 and meaningless pointer
    // coordinates, so the reveal must center on the activated element instead.
    const origin = themeOriginFromEvent({
      clientX: 5,
      clientY: 7,
      detail: 0,
      currentTarget: button,
    });

    expect(origin).toEqual({ x: 140, y: 80 });
  });

  it("centers on the explicit control when the event has no currentTarget", () => {
    // Native listeners can read `currentTarget` only during dispatch; the
    // shared runtime also accepts the control directly, and the fallback must
    // still center the reveal instead of trusting zeroed coordinates.
    const control = document.createElement("button");
    vi.spyOn(control, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 30, 40));

    const origin = themeOriginFromEvent(
      { clientX: 1, clientY: 2, detail: 0, currentTarget: null },
      control,
    );

    expect(origin).toEqual({ x: 25, y: 40 });
  });
});

describe("applyThemeImmediately", () => {
  it("commits synchronously inside the transition-suppression window", () => {
    const applyTheme = vi.fn(() => {
      // The suppression class must be live while the palette commits so
      // per-component colour transitions cannot interpolate between palettes.
      expect(document.documentElement).toHaveClass("theme-changing");
      document.documentElement.classList.add("dark");
    });

    applyThemeImmediately(applyTheme);

    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).toHaveClass("dark");
  });

  it("releases suppression after painted frames so transitions resume", () => {
    const clock = installWaveClock();

    applyThemeImmediately(() => undefined);
    expect(document.documentElement).toHaveClass("theme-changing");

    // Release defers past two painted frames so the committed palette reaches
    // the screen before transitions are allowed to interpolate again.
    clock.tick(16);
    expect(document.documentElement).toHaveClass("theme-changing");
    clock.tick(16);
    clock.tick(16);
    expect(document.documentElement).not.toHaveClass("theme-changing");
  });

  it("propagates commit errors without leaving suppression behind", () => {
    const clock = installWaveClock();

    expect(() =>
      applyThemeImmediately(() => {
        throw new Error("commit failed");
      }),
    ).toThrow("commit failed");

    clock.advance(50);
    expect(document.documentElement).not.toHaveClass("theme-changing");
  });
});

describe("startThemeReveal ink wave", () => {
  // The mask is the only repainting surface: live elements stay on the source
  // palette and the mirrored copy stays on the target throughout travel.
  it("keeps live elements on the source palette and the copy on the target through travel and reversal", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const probe = mountProbe({ centerX: 150, docTop: 750 });
    const handle = startThemeReveal(waveOptions());
    const layer = theInkLayer();
    for (let frame = 0; frame < 80; frame += 1) {
      if (frame === 32) handle.setDirection(false);
      if (frame === 44) handle.setDirection(true);
      clock.tick(16);
      // Live paint never leaves the committed source palette mid-wave.
      expect(readsAs(probe, "light")).toBe(true);
      // The mirrored counterpart carries the target palette from frame one —
      // coverage is decided by the mask, never by per-element palette writes.
      expect(readsAs(layer.querySelector(".probe")!, "dark")).toBe(true);
      expect(getComputedStyle(probe).color).toBe(LIGHT_INK);
      expect(getComputedStyle(layer.querySelector(".probe")!).color).toBe(DARK_INK);
    }
    expect(theInkLayer()).toBe(layer);
  });

  it("keeps native text and layered artwork intact throughout travel and reversal", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const probe = mountProbe({ centerX: 150, docTop: 380 });
    probe.textContent = "Readable content throughout the theme wave";
    probe.style.color = "var(--ink)";
    probe.style.backgroundImage = "linear-gradient(90deg, red, blue)";
    const originalImage = getComputedStyle(probe).backgroundImage;
    const originalClip = getComputedStyle(probe).backgroundClip;
    /**
     * The masked reveal never needs the transparent-text/background-clip
     * feather trick: verifying the live element's paint contract beats
     * asserting on the layer's private mask wiring.
     */
    const assertNativePaint = () => {
      expect(getComputedStyle(probe).backgroundImage).toBe(originalImage);
      expect(getComputedStyle(probe).backgroundClip).toBe(originalClip);
      expect(getComputedStyle(probe).color).not.toBe("rgba(0, 0, 0, 0)");
    };
    const handle = startThemeReveal(waveOptions());
    assertNativePaint();
    clock.advance(450);
    assertNativePaint();
    handle.setDirection(false);
    clock.advance(250);
    assertNativePaint();
    handle.skip();
    assertNativePaint();
  });

  it("mounts exactly one inert layer outside the body while the root palette waits", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));
    const restoreTheme = vi.fn(() => document.documentElement.classList.remove("dark"));
    const bodyChildrenBefore = [...document.body.children];
    const button = document.createElement("button");
    button.textContent = "Live control";
    document.body.appendChild(button);
    bodyChildrenBefore.push(button);

    const handle = startThemeReveal(waveOptions({ applyTheme, restoreTheme }));

    expect(handle.kind).toBe("ink");
    // No pre-reveal flicker: sampling the target palette happens without
    // painting, and neither endpoint callback may run before its endpoint.
    expect(document.documentElement).not.toHaveClass("dark");
    expect(applyTheme).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveAttribute("data-theme-ink", "");
    expect(document.documentElement).toHaveAttribute("data-theme-wave", "dark");

    // One masked copy of the document, mounted as a sibling AFTER the body —
    // never inside it, so the live tree is never duplicated for scripts or AT.
    const layer = theInkLayer();
    expect(layer).toHaveAttribute("data-theme-ink-layer", "dark");
    expect(layer).toHaveClass("theme-ink-layer");
    expect(layer.parentElement).toBe(document.documentElement);
    expect(layer.previousElementSibling).toBe(document.body);
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(isInert(layer)).toBe(true);
    expect([...document.body.children]).toEqual(bodyChildrenBefore);

    clock.advance(WAVE_FULL_MS + 64);

    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(restoreTheme).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveClass("dark");
    expect(inkLayers()).toHaveLength(0);
  });

  it("spreads the mask radius over the full document instead of repainting elements", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    // Probes sit near, mid-document and far below the fold; none may repaint
    // mid-wave because the mask — not element paint — carries the reveal.
    const near = mountProbe({ centerX: 150, docTop: 490 });
    const mid = mountProbe({ centerX: 550, docTop: 480 });
    const far = mountProbe({ centerX: 1100, docTop: 1200 });

    startThemeReveal(waveOptions());

    // Before the first frame nothing may pre-paint: no flicker ahead of the
    // wave and the mask starts at zero coverage.
    expect(waveRadius()).toBe(0);
    for (const probe of [near, mid, far]) {
      expect(readsAs(probe, "light")).toBe(true);
    }
    const radii: number[] = [];
    for (let elapsed = 0; elapsed < WAVE_FULL_MS + 32; elapsed += 16) {
      clock.tick(16);
      radii.push(waveRadius());
      // Once the endpoint commits, live probes legitimately flip to the
      // committed palette — the no-repaint contract applies only mid-wave.
      if (document.documentElement.classList.contains("dark")) break;
      for (const probe of [near, mid, far]) {
        expect(readsAs(probe, "light")).toBe(true);
      }
    }
    // corner — origin (150,300) to (0,5000)/(1200,5000) is >4700px.
    const settled = radii.filter((radius) => radius > 0);
    for (let index = 1; index < settled.length; index += 1) {
      expect(settled[index]!).toBeGreaterThanOrEqual(settled[index - 1]!);
    }
    expect(settled.at(-1)!).toBeGreaterThan(DOC_HEIGHT - 300);
    // And it arrives progressively, not as a single full-coverage jump.
    expect(settled.at(-1)!).toBeGreaterThan(settled[0]!);

    // Once the full path elapses the committed palette owns the root and the
    // probes' final colors come from the real `.dark` commit, not the mask.
    expect(document.documentElement).toHaveClass("dark");
    for (const probe of [near, mid, far]) expect(readsAs(probe, "dark")).toBe(true);
  });

  it("spreads over the full 1200ms instead of finishing early", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));

    startThemeReveal(waveOptions({ applyTheme }));
    const layer = theInkLayer();
    clock.advance(400);
    expect(applyTheme).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveAttribute("data-theme-ink", "");
    expect(theInkLayer()).toBe(layer);
    clock.advance(400);
    expect(applyTheme).not.toHaveBeenCalled();
    clock.advance(432);
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).toHaveClass("dark");
    expect(inkLayers()).toHaveLength(0);
  });

  // The source palette remains live until the requested 600ms withdrawal endpoint.
  it("withdraws to light at 600ms without committing the palette early", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    document.documentElement.classList.add("dark");
    const applyTheme = vi.fn(() => document.documentElement.classList.remove("dark"));
    startThemeReveal(waveOptions({ fromTheme: "dark", toTheme: "light", applyTheme }));
    clock.tick(599);
    expect(applyTheme).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveClass("dark");
    clock.tick(1);
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(inkLayers()).toHaveLength(0);
  });

  it("reverses mid-flight back to the source palette without a restart", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));
    const restoreTheme = vi.fn(() => document.documentElement.classList.remove("dark"));

    const handle = startThemeReveal(waveOptions({ applyTheme, restoreTheme }));
    const layer = theInkLayer();
    clock.advance(500);
    const peak = waveRadius();
    expect(peak).toBeGreaterThan(0);

    // Reversing continues the same wave on the same layer: the markers stay,
    // the marker keeps naming the ORIGINAL target, and the mask retreats —
    // the endpoint is the source palette, not an instant jump or recapture.
    expect(handle.setDirection(false)).toBe(true);
    expect(restoreTheme).not.toHaveBeenCalled();
    clock.tick(100);
    expect(waveRadius()).toBeLessThan(peak);
    expect(theInkLayer()).toBe(layer);
    expect(layer).toHaveAttribute("data-theme-ink-layer", "dark");
    expect(document.documentElement).toHaveAttribute("data-theme-ink", "");
    expect(document.documentElement).toHaveAttribute("data-theme-wave", "dark");

    // A partial expansion still gets the same full 600ms withdrawal as
    // a committed dark theme; it must not collapse in a progress-scaled interval.
    clock.tick(499);
    expect(restoreTheme).not.toHaveBeenCalled();
    expect(theInkLayer()).toBe(layer);
    clock.tick(1);
    expect(restoreTheme).toHaveBeenCalledTimes(1);
    expect(applyTheme).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement).not.toHaveAttribute("data-theme-ink");
    expect(inkLayers()).toHaveLength(0);
    // A completed wave reports no direction; the next activation starts fresh.
    expect(handle.setDirection(true)).toBe(false);
  });

  it("continues forward from partial progress instead of restarting", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));

    const handle = startThemeReveal(waveOptions({ applyTheme }));
    const layer = theInkLayer();
    clock.advance(500);

    // Re-forward preserves current coverage, but grants the complete 1200ms
    // expansion interval rather than shortening time according to prior travel.
    expect(handle.setDirection(false)).toBe(true);
    clock.advance(200);
    const retreatRadius = waveRadius();
    expect(handle.setDirection(true)).toBe(true);
    expect(theInkLayer()).toBe(layer);
    clock.tick(16);
    // Coverage grows from the retreat point rather than sweeping to zero and
    // re-growing — the visible edge of a cancel-and-restart.
    expect(waveRadius()).toBeGreaterThan(retreatRadius);

    // Neither palette nor layer identity changes before the new segment ends.
    clock.tick(1183);
    expect(applyTheme).not.toHaveBeenCalled();
    expect(theInkLayer()).toBe(layer);
    clock.tick(1);
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).toHaveClass("dark");
    expect(inkLayers()).toHaveLength(0);
  });

  it("settles to the latest direction when skipped mid-flight", () => {
    installWaveEnvironment();
    installWaveClock();
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));
    const restoreTheme = vi.fn(() => document.documentElement.classList.remove("dark"));
    const probe = mountProbe({ centerX: 150, docTop: 360 });

    const forward = startThemeReveal(waveOptions({ applyTheme, restoreTheme }));
    // Skipping before the first frame still lands the requested palette and
    // removes the masked copy immediately.
    forward.skip();
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(restoreTheme).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).not.toHaveAttribute("data-theme-ink");
    expect(inkLayers()).toHaveLength(0);
    expect(forward.setDirection(true)).toBe(false);
    // Idempotent: repeated skips settle nothing further.
    forward.skip();
    expect(applyTheme).toHaveBeenCalledTimes(1);

    // Skipping a wave that is rolling back commits the SOURCE palette.
    document.documentElement.classList.remove("dark");
    const applySecond = vi.fn(() => document.documentElement.classList.add("dark"));
    const restoreSecond = vi.fn(() => document.documentElement.classList.remove("dark"));
    const reversed = startThemeReveal(
      waveOptions({ applyTheme: applySecond, restoreTheme: restoreSecond }),
    );
    reversed.setDirection(false);
    reversed.skip();
    expect(restoreSecond).toHaveBeenCalledTimes(1);
    expect(applySecond).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("dark");
    expect(readsAs(probe, "light")).toBe(true);
    expect(inkLayers()).toHaveLength(0);
  });

  it("never commits the root palette during alternating same-task retargets", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));
    const restoreTheme = vi.fn(() => document.documentElement.classList.remove("dark"));

    const handle = startThemeReveal(waveOptions({ applyTheme, restoreTheme }));
    const layer = theInkLayer();
    // Same-task spam before the first frame: parity must land forward and the
    // palette must not blink through intermediate commits.
    expect(handle.setDirection(true)).toBe(true);
    expect(handle.setDirection(false)).toBe(true);
    expect(handle.setDirection(true)).toBe(true);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(applyTheme).not.toHaveBeenCalled();
    expect(theInkLayer()).toBe(layer);

    clock.advance(WAVE_FULL_MS + 64);
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(restoreTheme).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveClass("dark");
  });

  it("clones the whole document into the layer, not just the viewport", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    // One probe above the fold, one far below it: a viewport-sized capture
    // could never include the second — the full-document clone must.
    const visible = mountProbe({ centerX: 150, docTop: 200 });
    const belowFold = mountProbe({ centerX: 150, docTop: 1600 });
    // The copy must be inert even at the markup level: no executable scripts
    // and no autonomous custom-element constructors run inside the clone.
    const script = document.createElement("script");
    script.dataset.marker = "live-script";
    document.body.appendChild(script);
    const executionCount = document.createElement("span");
    executionCount.id = "custom-executions";
    executionCount.textContent = "0";
    document.body.appendChild(executionCount);
    if (typeof customElements !== "undefined" && !customElements.get("probe-widget")) {
      customElements.define(
        "probe-widget",
        class extends HTMLElement {
          /** Models a real widget's visible initialization side effect, which a visual clone must not repeat. */
          constructor() {
            super();
            const count = document.getElementById("custom-executions");
            if (count) count.textContent = String(Number(count.textContent) + 1);
          }
        },
      );
    }
    const widget = document.createElement("probe-widget");
    widget.dataset.widget = "live";
    document.body.appendChild(widget);
    expect(executionCount).toHaveTextContent("1");

    startThemeReveal(waveOptions());
    clock.advance(200);

    const layer = theInkLayer();
    const liveProbes = document.body.querySelectorAll(".probe");
    const clonedProbes = layer.querySelectorAll(".probe");
    expect(clonedProbes.length).toBe(liveProbes.length);
    // Every mirrored surface already carries the target palette while the
    // live surfaces keep the committed source palette unchanged.
    for (const clone of clonedProbes) expect(readsAs(clone, "dark")).toBe(true);
    for (const probe of [visible, belowFold]) {
      expect(readsAs(probe, "light")).toBe(true);
      expect(probe.style.length).toBe(0);
    }
    // Scripts are dropped outright; the custom element is stubbed (never
    // upgraded inside the copy) while keeping its attributes and content.
    expect(layer.querySelector("script")).toBeNull();
    expect(layer.querySelectorAll("[data-widget]").length).toBe(1);
    expect(layer.querySelector("[data-widget]")!.tagName).not.toBe("PROBE-WIDGET");
    expect(executionCount).toHaveTextContent("1");
  });

  /** Namespacing must retain real layout/state rules without changing unrelated live cascade order. */
  it("preserves ID-scoped layout and state selectors in the ink copy", async () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const style = document.createElement("style");
    style.textContent = `
      [id="guide-article"], .unrelated-surface { width: 661px; }
      .unrelated-surface { width: 200px; }
      #guide-article[data-density="compact"] { width: 420px; }
      .probe-subject:where(.unrelated-surface, #guide-article) { height: 80px; }
      .unrelated-surface { height: 30px; }
    `;
    document.head.appendChild(style);
    const article = document.createElement("section");
    article.id = "guide-article";
    article.className = "guide-article probe-subject";
    const unrelated = document.createElement("aside");
    unrelated.className = "unrelated-surface probe-subject";
    document.body.append(article, unrelated);

    const handle = startThemeReveal(waveOptions());
    clock.advance(200);
    const copy = theInkLayer().querySelector(".guide-article")!;
    expect(getComputedStyle(article).width).toBe("661px");
    expect(getComputedStyle(copy).width).toBe("661px");
    expect(getComputedStyle(unrelated).width).toBe("200px");
    expect(getComputedStyle(copy).height).toBe("80px");
    expect(getComputedStyle(unrelated).height).toBe("30px");

    article.dataset.density = "compact";
    await Promise.resolve();
    expect(getComputedStyle(article).width).toBe("420px");
    expect(getComputedStyle(copy).width).toBe("420px");
    handle.skip();
    expect(getComputedStyle(unrelated).width).toBe("200px");
  });

  it("mirrors window and nested scrolling into the layer without repainting live elements", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    // A nested scroller with a tall child: the clone must track its scroll
    // offsets so masked content stays aligned with the live layout.
    const scroller = document.createElement("div");
    scroller.className = "nested-scroll";
    const child = document.createElement("div");
    child.className = "probe scroll-child";
    child.textContent = "nested content";
    scroller.appendChild(child);
    document.body.appendChild(scroller);
    let scrollTop = 0;
    let scrollLeft = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    place(scroller, { centerX: 300, docTop: 350, height: 300 });
    place(child, { centerX: 300, docTop: () => 950 - scrollTop });

    startThemeReveal(waveOptions());
    const layer = theInkLayer();
    clock.advance(400);
    const radiusBeforeScroll = waveRadius();
    // Fixed controls anchor the mask in viewport coordinates, not document space.
    expect(layer.dataset.themeInkX).toBe("150px");
    expect(layer.dataset.themeInkY).toBe("300px");

    // Scrolling moves the mirrored content, never the control-centered silhouette.
    window.scrollY = 350;
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    // Mirroring runs in a capture-phase listener: offsets apply during the
    // scroll event itself, before the next painted frame.
    expect(layer.dataset.themeInkY).toBe("300px");
    expect(layer.dataset.themeInkX).toBe("150px");
    clock.tick(16);
    expect(waveRadius()).toBeGreaterThan(0);

    // Nested scroll: the cloned scroller mirrors both offsets synchronously
    // inside the scroll event so its subtree stays aligned with the live one.
    scrollTop = 800;
    scrollLeft = 40;
    scroller.dispatchEvent(new Event("scroll"));
    const clonedScroller = layer.querySelector<HTMLElement>(".nested-scroll");
    expect(clonedScroller).not.toBeNull();
    expect(clonedScroller!.scrollTop).toBe(800);
    expect(clonedScroller!.scrollLeft).toBe(40);
    clock.tick(16);

    // Scroll synchronization never repaints live elements or resets the mask:
    // the radius keeps advancing from where it was, on the same single layer.
    expect(readsAs(child, "light")).toBe(true);
    expect(waveRadius()).toBeGreaterThan(radiusBeforeScroll);
    expect(theInkLayer()).toBe(layer);
  });

  it("mirrors DOM inserted while the wave is running without resetting the mask", async () => {
    installWaveEnvironment();
    const clock = installWaveClock();

    startThemeReveal(waveOptions());
    const layer = theInkLayer();
    clock.advance(500);
    const radiusBeforeInsert = waveRadius();
    // Newly mounted content must receive the target palette before the next
    // paint, without restarting the reveal or repainting its live source.
    const inserted = mountProbe({ centerX: 150, docTop: 380 });
    inserted.classList.add("probe-late");
    await Promise.resolve();
    clock.tick(16);
    const clone = layer.querySelector(".probe-late");
    expect(clone).not.toBeNull();
    expect(readsAs(clone!, "dark")).toBe(true);
    expect(readsAs(inserted, "light")).toBe(true);

    // Mirroring must not disturb the mask state or the active wave.
    expect(waveRadius()).toBeGreaterThanOrEqual(radiusBeforeInsert);
    expect(theInkLayer()).toBe(layer);
    expect(document.documentElement).toHaveAttribute("data-theme-ink", "");
  });

  it("restores element identity, styles and markers at the endpoint", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));
    const probes = [
      mountProbe({ centerX: 150, docTop: 380 }),
      mountProbe({ centerX: 900, docTop: 2600 }),
    ];
    const bodyChildrenBefore = [...document.body.children];

    startThemeReveal(waveOptions({ applyTheme }));
    clock.advance(WAVE_FULL_MS + 64);

    // Endpoint cleanup leaves the LIVE DOM it masked over: same elements in
    // the same document, the copy removed, no leftover flags or inline paint.
    expect([...document.body.children]).toEqual(bodyChildrenBefore);
    for (const probe of probes) {
      expect(probe.isConnected).toBe(true);
      expect(probe.style.length).toBe(0);
    }
    expect(inkLayers()).toHaveLength(0);
    const root = document.documentElement;
    expect(root).not.toHaveAttribute("data-theme-ink");
    expect(root).not.toHaveAttribute("data-theme-wave");
    expect(root).not.toHaveClass("theme-changing");
    expect(root.style.length).toBe(0);
    expect(root).toHaveClass("dark");
  });

  it("restores element styles when the wave reverses all the way back", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const restoreTheme = vi.fn(() => document.documentElement.classList.remove("dark"));
    const probe = mountProbe({ centerX: 150, docTop: 380 });

    const handle = startThemeReveal(waveOptions({ restoreTheme }));
    clock.advance(400);
    expect(waveRadius()).toBeGreaterThan(0);
    handle.setDirection(false);
    clock.advance(700);

    expect(restoreTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(readsAs(probe, "light")).toBe(true);
    expect(probe.style.length).toBe(0);
    expect(document.documentElement).not.toHaveAttribute("data-theme-ink");
    expect(inkLayers()).toHaveLength(0);
  });

  it("supersedes a running wave when a new reveal starts on the same document", () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    const applyFirst = vi.fn(() => document.documentElement.classList.add("dark"));
    const restoreFirst = vi.fn(() => document.documentElement.classList.remove("dark"));

    startThemeReveal(waveOptions({ applyTheme: applyFirst, restoreTheme: restoreFirst }));
    clock.advance(300);

    // A second start settles the first wave's latest direction and takes over
    // the document markers — the two masked copies never coexist.
    const applySecond = vi.fn(() => document.documentElement.classList.add("dark"));
    const second = startThemeReveal(waveOptions({ applyTheme: applySecond }));
    expect(second.kind).toBe("ink");
    expect(inkLayers()).toHaveLength(1);
    clock.advance(WAVE_FULL_MS + 64);

    expect(applySecond).toHaveBeenCalledTimes(1);
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).not.toHaveAttribute("data-theme-ink");
    expect(inkLayers()).toHaveLength(0);
  });

  it("commits instantly when the mask capability is missing", () => {
    // The full-motion path requires CSS mask support and rAF; missing
    // capability is an instant commit, never a dropped selection.
    vi.stubGlobal("CSS", { supports: () => false });
    installWaveClock();
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));

    const handle = startThemeReveal(waveOptions({ applyTheme }));

    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).toHaveClass("dark");
    expect(inkLayers()).toHaveLength(0);
    expect(() => handle.skip()).not.toThrow();
    expect(handle.setDirection(true)).toBe(false);
  });

  it("does not skip coverage or snap a reversal when the first frame stalls on priming", async () => {
    installWaveEnvironment();
    const clock = installWaveClock();
    // Model the layer's synchronous prime work (palette sampling, clone
    // build, style walk) stretching the first frame: once the masked copy
    // exists inside the layer, wall time has run ahead of the rAF timeline,
    // so the next painted frame arrives PRIME_MS later.
    const PRIME_MS = 400;
    let primed = false;
    vi.spyOn(performance, "now").mockImplementation(() => {
      const layer = document.querySelector("[data-theme-ink-layer]");
      if (!primed && layer && layer.childElementCount > 1) primed = true;
      return clock.now() + (primed ? PRIME_MS : 0);
    });
    /**
     * Browsers flush the microtask queue after EVERY rAF callback, so the
     * wave's prime-span credit lands between the layer's prime and the wave's
     * own tick within one frame batch. installWaveClock's pump can't express
     * that interleaving (it drains callbacks before returning), so this test
     * drives frames itself: each callback gets its own microtask checkpoint
     * while the shared virtual clock still supplies frame timestamps.
     */
    let pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      pending.push(callback);
      return pending.length;
    });
    const frame = async (timestamp: number) => {
      const batch = pending;
      pending = [];
      for (const callback of batch) {
        callback(timestamp);
        await Promise.resolve();
      }
    };
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));
    const restoreTheme = vi.fn(() => document.documentElement.classList.remove("dark"));

    const handle = startThemeReveal(waveOptions({ applyTheme, restoreTheme }));
    clock.tick(16);
    await frame(clock.now());
    const radiusAtPrime = waveRadius();

    // The stalled vsync arrives without jumping coverage: the prime span is
    // consumed by the clock, not banked into the mask radius.
    clock.tick(PRIME_MS);
    await frame(clock.now());
    const firstRadius = waveRadius();
    expect(firstRadius).toBeGreaterThanOrEqual(radiusAtPrime);
    expect(firstRadius).toBeLessThan(100);
    expect(applyTheme).not.toHaveBeenCalled();
    clock.tick(16);
    await frame(clock.now());
    const resumed = waveRadius();
    expect(resumed).toBeGreaterThan(firstRadius);
    expect(resumed - firstRadius).toBeLessThan(200);

    // A reversal right after the stall retreats from painted coverage — the
    // segment start must come from the last painted frame, not wall time.
    expect(handle.setDirection(false)).toBe(true);
    clock.tick(16);
    await frame(clock.now());
    expect(waveRadius()).toBeLessThan(resumed);
    for (let step = 0; step < 44; step += 1) {
      clock.tick(16);
      await frame(clock.now());
    }
    expect(restoreTheme).toHaveBeenCalledTimes(1);
    expect(applyTheme).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("dark");
    expect(inkLayers()).toHaveLength(0);
  });
});

describe("startThemeReveal blink", () => {
  /**
   * Installs a WAAPI stub whose `finished` never settles: blink scheduling is
   * timer/rAF driven in tests, and an unresolved animation mirrors a skipped
   * or backgrounded real one.
   */
  function installBlinkAnimation(): void {
    Object.defineProperty(document.documentElement, "animate", {
      configurable: true,
      value: () => ({ finished: new Promise<void>(() => {}), cancel: vi.fn() }),
    });
  }

  it("keeps the old theme until the blink midpoint, then settles by 200ms", () => {
    vi.useFakeTimers();
    installBlinkAnimation();
    const clock = installWaveClock();
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));

    const handle = startThemeReveal(waveOptions({ applyTheme, lowMotion: true }));

    expect(handle.kind).toBe("blink");
    // The selected palette appears inside the dimmed blink, not as a prior
    // full-opacity flash.
    expect(document.documentElement).not.toHaveClass("dark");
    expect(applyTheme).not.toHaveBeenCalled();

    vi.advanceTimersByTime(BLINK_MIDPOINT_MS);
    clock.advance(BLINK_MIDPOINT_MS);
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).toHaveClass("dark");

    vi.advanceTimersByTime(BLINK_MS);
    clock.advance(BLINK_MS);
    expect(applyTheme).toHaveBeenCalledTimes(1);
  });

  it("reports no direction and settles a skipped blink without a stale midpoint", () => {
    vi.useFakeTimers();
    installBlinkAnimation();
    const clock = installWaveClock();

    const handle = startThemeReveal(waveOptions({ lowMotion: true }));
    // Blinks carry no spatial direction: the contract returns false so
    // callers fall back to instant semantics.
    expect(handle.setDirection(false)).toBe(false);
    handle.skip();
    expect(document.documentElement).toHaveClass("dark");
    expect(() => handle.skip()).not.toThrow();

    // Interrupting the blink settles its selection; a cancelled midpoint
    // callback must never repaint the old palette afterwards.
    document.documentElement.classList.remove("dark");
    vi.advanceTimersByTime(BLINK_MS * 2);
    clock.advance(BLINK_MS * 2);
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("applies the theme instantly when WAAPI is unavailable", () => {
    // `root.animate` is left absent on purpose: the blink path guards for
    // missing WAAPI, so this exercises that real guard rather than a stub.
    const applyTheme = vi.fn(() => document.documentElement.classList.add("dark"));

    const handle = startThemeReveal(waveOptions({ applyTheme, lowMotion: true }));

    expect(handle.kind).toBe("blink");
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).toHaveClass("dark");
    expect(() => handle.skip()).not.toThrow();
    expect(() => handle.skip()).not.toThrow();
  });
});
