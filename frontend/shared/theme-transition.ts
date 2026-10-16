import { startThemeWave } from "./theme-wave";

export type Theme = "light" | "dark";

/** Viewport-space activation point in CSS pixels. */
export interface ThemeTransitionOrigin {
  readonly x: number;
  readonly y: number;
}

/** One active wave can change direction without replacing its paint or progress. */
export interface ThemeRevealHandle {
  readonly kind: "ink" | "blink";
  setDirection(forward: boolean): boolean;
  skip(): void;
}

/** Source/target palettes and endpoint commits for one deliberate theme activation. */
export interface ThemeRevealOptions {
  fromTheme: Theme;
  toTheme: Theme;
  applyTheme: () => void;
  restoreTheme: () => void;
  origin: ThemeTransitionOrigin;
  lowMotion: boolean;
}

let pendingPaletteChanges = 0;
let currentReveal: ThemeRevealHandle | null = null;
const blinkDurationMs = 200;

/** Anchors pointer and keyboard activation to the control's viewport center; absent controls fall back to event coordinates. */
export function themeOriginFromEvent(
  event: {
    clientX: number;
    clientY: number;
    detail: number;
    currentTarget: EventTarget | null;
  },
  control?: Element,
): ThemeTransitionOrigin {
  const target = control ?? event.currentTarget;
  if (target instanceof Element) {
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return { x: event.clientX, y: event.clientY };
}

/**
 * Keeps palette paints synchronous instead of running independent component
 * fades. Counted, idempotent releases survive overlapping cancellation; two
 * frames keep transitions disabled until the final root palette has painted.
 */
function suppressPaletteTransitions(): () => void {
  const root = document.documentElement;
  pendingPaletteChanges += 1;
  root.classList.add("theme-changing");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingPaletteChanges -= 1;
    if (typeof requestAnimationFrame !== "function") {
      if (pendingPaletteChanges === 0) root.classList.remove("theme-changing");
      return;
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (pendingPaletteChanges === 0) root.classList.remove("theme-changing");
      }),
    );
  };
}

/** Commits an originless palette change without per-component color fades. */
export function applyThemeImmediately(applyTheme: () => void): void {
  const release = suppressPaletteTransitions();
  try {
    applyTheme();
  } finally {
    release();
  }
}

/**
 * Starts the shared 1.2s masked ink reveal, or the non-spatial low-motion blink.
 * Its inert full-document target copy follows window and nested scrolling.
 * Endpoint callbacks commit only after coverage or collapse; retargeting preserves
 * the same mask and document-space seed. Live controls keep their input and focus.
 * Low motion commits at the 100ms midpoint; skip settles the latest choice once.
 */
export function startThemeReveal(options: ThemeRevealOptions): ThemeRevealHandle {
  // Suppression must precede the supersede: skip() commits the outgoing
  // wave's endpoint palette, and without theme-changing already on the root
  // that root mutation can feed unsuppressed transition paints (or callbacks
  // that synchronously resolve styles). If the skip throws, the count is
  // released so suppression never wedges on.
  const release = suppressPaletteTransitions();
  try {
    currentReveal?.skip();
  } catch (error) {
    release();
    throw error;
  }
  const root = document.documentElement;
  if (options.lowMotion && typeof root.animate === "function") {
    let applied = false;
    let active = true;
    const commit = () => {
      if (applied) return;
      applied = true;
      options.applyTheme();
    };
    const animation = root.animate([{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }], {
      duration: blinkDurationMs,
      easing: "ease-in-out",
      fill: "none",
    });
    const timer = window.setTimeout(commit, blinkDurationMs / 2);
    const settle = () => {
      if (!active) return;
      active = false;
      window.clearTimeout(timer);
      try {
        commit();
      } finally {
        release();
      }
    };
    animation.finished.then(settle, settle);
    const handle: ThemeRevealHandle = {
      kind: "blink",
      setDirection: () => false,
      skip() {
        try {
          settle();
        } finally {
          animation.cancel();
        }
      },
    };
    currentReveal = handle;
    return handle;
  }
  const supportsWave =
    typeof requestAnimationFrame === "function" &&
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("mask-image", "radial-gradient(circle, black, transparent)");
  if (options.lowMotion || !supportsWave || document.hidden) {
    try {
      options.applyTheme();
    } finally {
      release();
    }
    const handle: ThemeRevealHandle = {
      kind: options.lowMotion ? "blink" : "ink",
      setDirection: () => false,
      skip() {},
    };
    currentReveal = handle;
    return handle;
  }
  try {
    const handle = startThemeWave({ ...options, onFinish: release });
    currentReveal = handle;
    return handle;
  } catch (error) {
    release();
    throw error;
  }
}
