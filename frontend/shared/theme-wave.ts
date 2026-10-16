import { cancelEffects } from "./effects";
import { createThemeInkLayer } from "./theme-ink-layer";
import type { ThemeRevealHandle, ThemeRevealOptions } from "./theme-transition";

interface WaveOptions extends ThemeRevealOptions {
  onFinish(): void;
}
const durationMs = 1200;

/**
 * Samples the target palette without painting: the root marker flips
 * synchronously, `--*` declarations resolve, and the source restores before
 * any frame can commit — two full-document recalcs, contained inside the
 * layer's deferred prime frame so the click task never pays them.
 * Inheritance can't substitute here: on a dark document the root's dark vars
 * reach every descendant, so a probe element reads the source palette.
 */
function targetPalette(theme: ThemeRevealOptions["toTheme"]): Record<string, string> {
  const root = document.documentElement;
  const originalDark = root.classList.contains("dark");
  const originalTheme = root.getAttribute("data-theme");
  try {
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
    const style = getComputedStyle(root);
    const palette: Record<string, string> = {};
    for (let index = 0; index < style.length; index += 1) {
      const name = style.item(index);
      if (name.startsWith("--") && !name.startsWith("--theme-"))
        palette[name] = style.getPropertyValue(name);
    }
    return palette;
  } finally {
    root.classList.toggle("dark", originalDark);
    if (originalTheme === null) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", originalTheme);
  }
}

/**
 * Captures an inert target-palette copy after settling shared entrance effects,
 * with live window/nested scrolling synchronized by the layer. The source stays
 * interactive on its committed palette; one normalized timeline reverses without
 * recapture, palette interpolation, focus loss or a viewport-only snapshot.
 * Dark coverage always expands toward dark and retracts toward light, including
 * interrupted reversals; the light target uses the complementary mask.
 * Withdrawal uses the visible viewport and 0.6s ease-out travel; expansion covers
 * the document in 1.2s. Both hold the button's viewport center fixed on scroll.
 */
export function startThemeWave(options: WaveOptions): ThemeRevealHandle {
  const root = document.documentElement;
  // Exposed for tests/diagnostics via a data attribute: an attribute write on
  // <html> costs one element's mutation check, while a custom-property write
  // would invalidate the entire document's computed styles every frame.
  const originalRadius = root.dataset.themeWaveRadius ?? null;
  cancelEffects();
  const origin = options.origin;
  // The clock baseline sits at the click, but the layer's palette/clone/
  // measure prime runs synchronously inside the first animation frame.
  // Unadjusted, that span lands in the next frame's rAF timestamp delta and
  // coverage would jump past its opening steps — visibly snapping, and
  // letting a mid-stall reversal retreat from a radius that never painted.
  let lastTime = 0;
  const layer = createThemeInkLayer({
    theme: options.toTheme,
    origin,
    // prime() invokes this hook first. A microtask observes the moment its
    // synchronous body unwinds — browsers checkpoint microtasks after every
    // frame callback — and credits the measured span into the clock
    // watermark. advance() never lets the baseline regress, so a same-batch
    // tick holding the pre-credit timestamp cannot leak the stall into the
    // next delta. jsdom's aligned manual clock measures a zero span.
    palette: () => {
      const primeStart = performance.now();
      queueMicrotask(() => {
        lastTime += performance.now() - primeStart;
      });
      return targetPalette(options.toTheme);
    },
  });
  let withdrawalExtent = 0;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let position = 0;
  let segmentStart = 0;
  let segmentElapsed = 0;
  let forward = true;
  let active = true;
  lastTime = performance.now();
  let frame = 0;
  root.setAttribute("data-theme-ink", "");
  root.dataset.themeWave = options.toTheme;

  /** Fits withdrawal to the visible screen on resize; scrolling changes content, never its fixed control origin. */
  function paint(): void {
    if (
      options.toTheme === "light" &&
      (viewportWidth !== innerWidth || viewportHeight !== innerHeight)
    ) {
      viewportWidth = innerWidth;
      viewportHeight = innerHeight;
      const { x, y } = origin;
      withdrawalExtent =
        Math.hypot(Math.max(x, viewportWidth - x), Math.max(y, viewportHeight - y)) + 24;
    }
    const darkCoverage = options.toTheme === "dark" ? position : 1 - position;
    const radius =
      (options.toTheme === "light" ? withdrawalExtent : layer.extent + 24) * darkCoverage;
    root.dataset.themeWaveRadius = `${radius}`;
    layer.paint(radius);
  }

  /** Commits only the latest endpoint, removing the masked copy/listeners even when application callbacks throw. */
  function settle(): void {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    document.removeEventListener("visibilitychange", onVisibility);
    try {
      if (forward) options.applyTheme();
      else options.restoreTheme();
    } finally {
      layer.destroy();
      root.removeAttribute("data-theme-ink");
      root.removeAttribute("data-theme-wave");
      if (originalRadius) root.dataset.themeWaveRadius = originalRadius;
      else delete root.dataset.themeWaveRadius;
      options.onFinish();
    }
  }

  /** Gives every nonempty retarget a full 1.2s expansion or 0.6s shrink from its current coverage, without recapture. */
  function advance(now: number, finish: boolean): void {
    const expanding = options.toTheme === "dark" ? forward : !forward;
    const travelDuration = expanding ? durationMs : 600;
    const endpoint = forward ? 1 : 0;
    segmentElapsed =
      segmentStart === endpoint
        ? 1
        : Math.min(1, segmentElapsed + Math.max(0, now - lastTime) / travelDuration);
    const eased = expanding
      ? segmentElapsed * segmentElapsed * (3 - 2 * segmentElapsed)
      : segmentElapsed * (2 - segmentElapsed);
    position = segmentStart + (endpoint - segmentStart) * eased;
    // Watermark, not assignment: the prime credit may land before a same-batch
    // tick still carrying its stale timestamp — the baseline must never move
    // backwards, or the forgiven span leaks back into the next frame's delta.
    lastTime = Math.max(lastTime, now);
    paint();
    if (finish && segmentElapsed === 1) settle();
  }

  /** Paints the same masked layer every frame; native scroll listeners synchronize its content immediately. */
  function tick(now: number): void {
    if (!active) return;
    advance(now, true);
    if (active) frame = requestAnimationFrame(tick);
  }

  /** A hidden tab settles its latest choice rather than retaining a dormant masked copy. */
  function onVisibility(): void {
    if (document.hidden) settle();
  }

  paint();
  document.addEventListener("visibilitychange", onVisibility);
  lastTime = performance.now();
  frame = requestAnimationFrame(tick);
  return {
    kind: "ink",
    setDirection(nextForward) {
      if (!active) return false;
      // Snapshot the last painted frame, not wall time: during a stall (the
      // layer's prime window) wall-clock advance would bank unpainted
      // progress into the reversal segment and the retreat would visibly
      // snap from a radius that never painted.
      advance(lastTime, false);
      if (nextForward === forward) return true;
      segmentStart = position;
      segmentElapsed = 0;
      forward = nextForward;
      return true;
    },
    skip: settle,
  };
}
