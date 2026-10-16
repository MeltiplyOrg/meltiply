import { motionAllowed, reducedMotionQuery } from "./motion-state";

/*
 * Shared WAAPI effect engine and animation vocabulary for both frontends.
 * The CSS-facing keyframes live in `motion.css`; the recipes below are their
 * imperative twins for elements that cannot be animated declaratively
 * (viewport entrances, height morphs, inert transition snapshots). WAAPI
 * timing strings cannot resolve CSS variables, so `effectEasing` mirrors
 * `--ease-enter` from `motion.css` — keep the two values in sync.
 */

/** Emphatic entrance settle; mirrors `--ease-enter` in `motion.css`. */
export const effectEasing = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Default bounded duration for one shared effect, in milliseconds. */
export const effectDurationMs = 240;

/**
 * Lift-and-clear entrance: the WAAPI twin of the `fade-up` keyframe, extended
 * with a short blur settle. Elements keep their own styles as the final state,
 * so a cancelled reveal never hides content.
 */
export const revealEffectFrames: Keyframe[] = [
  { opacity: 0.45, transform: "translateY(10px)", filter: "blur(2px)" },
  { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
];

/**
 * Short downward settle for native disclosures (menus, drawers). The content
 * is already visible at its resting layout, so cancellation is free.
 */
export const disclosureEffectFrames: Keyframe[] = [
  { opacity: 0.6, transform: "translateY(-6px)" },
  { opacity: 1, transform: "translateY(0)" },
];

/** Partial timing overrides merged over the shared effect defaults. */
export interface EffectTiming {
  duration?: number;
  easing?: string;
  fill?: FillMode;
}

/** Every in-flight shared effect, so preference changes and ink capture can cancel them all. */
const activeEffects = new Set<Animation>();

/** Latest effect per element; a new effect on the same element replaces the previous one. */
const elementEffects = new WeakMap<Element, Animation>();
const suppressionCleanups = new Set<() => void>();
let cancellingEffects = false;

/**
 * Plays one bounded WAAPI effect on a mounted element, replacing any effect
 * already running on it. The shared `motionAllowed` rule — manual root
 * low-motion OR live OS `prefers-reduced-motion` OR an active `data-theme-ink`
 * capture — is evaluated at call time: when disallowed, the previous effect is
 * still cancelled but no new one starts, so underlying styles are the final
 * state and cancellation never hides content or leaves a fixed height behind.
 * Completion and cancellation both release tracking.
 *
 * @returns The started `Animation`, or `null` when suppressed or when the
 *   platform lacks `element.animate`.
 */
export function playEffect(
  element: Element,
  frames: Keyframe[],
  delay = 0,
  timing: EffectTiming = {},
): Animation | null {
  elementEffects.get(element)?.cancel();
  if (!motionAllowed() || typeof element.animate !== "function") return null;
  const animation = element.animate(frames, {
    duration: effectDurationMs,
    delay,
    easing: effectEasing,
    fill: "none",
    ...timing,
  });
  elementEffects.set(element, animation);
  activeEffects.add(animation);
  const release = (): void => {
    activeEffects.delete(animation);
  };
  animation.finished.then(release, release);
  return animation;
}

/**
 * Cancels tracked effects and synchronously restores their owners' live DOM.
 * Ink capture calls this before cloning, including held toolbar snapshots that
 * have not started WAAPI yet. The reentry guard permits an owner to register
 * cancelEffects itself without recursively flushing the same cancellation.
 */
export function cancelEffects(): void {
  if (cancellingEffects) return;
  cancellingEffects = true;
  try {
    for (const cleanup of suppressionCleanups) cleanup();
  } finally {
    for (const animation of activeEffects) animation.cancel();
    activeEffects.clear();
    cancellingEffects = false;
  }
}

/**
 * Reveals a mounted element from its visible baseline with a small lift.
 * `delay` sequences siblings without making content wait to become usable.
 */
export function revealEffect(element: Element, delay = 0): Animation | null {
  return playEffect(element, revealEffectFrames, delay);
}

/** Gives a just-opened native disclosure its short shared entrance. */
export function disclosureEffect(element: Element): Animation | null {
  return playEffect(element, disclosureEffectFrames);
}

/**
 * Morphs a container from `previousHeight` (viewport-space CSS pixels) to its
 * current `offsetHeight`. Any in-flight effect on the container is cancelled
 * first so rapid re-selection never layers morphs; absent or equal heights
 * measure but skip, and the resting styles remain the truth afterwards.
 */
export function morphHeightEffect(element: HTMLElement, previousHeight?: number): Animation | null {
  elementEffects.get(element)?.cancel();
  const nextHeight = element.offsetHeight;
  if (previousHeight === undefined || previousHeight === nextHeight) return null;
  return playEffect(element, [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }]);
}

/**
 * Grows an element vertically from a compressed baseline (`scaleY(0.85)` to
 * `scaleY(1)`). The consumer owns `transform-origin` — e.g. the landing's
 * `.bar-chart` bars pin `bottom` in CSS.
 */
export function riseEffect(element: Element, delay = 0): Animation | null {
  return playEffect(element, [{ transform: "scaleY(0.85)" }, { transform: "scaleY(1)" }], delay);
}

/**
 * Calls the owner's cleanup when root/OS policy suppresses spatial motion.
 * Explicit cancelEffects also flushes registered owners synchronously before
 * ink capture, so temporary snapshots and hidden live controls cannot leak
 * into the captured document. Returns a disposer for both policy observation
 * and the cancellation registration.
 */
export function watchMotionSuppression(onSuppressed: () => void): () => void {
  suppressionCleanups.add(onSuppressed);
  const check = (): void => {
    if (!motionAllowed()) onSuppressed();
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-low-motion", "data-theme-ink"],
  });
  let media: MediaQueryList | null = null;
  try {
    media = window.matchMedia(reducedMotionQuery);
    // Test stubs can provide `matches` without listener APIs.
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", check);
    } else {
      media = null;
    }
  } catch {
    media = null;
  }
  return () => {
    suppressionCleanups.delete(onSuppressed);
    observer.disconnect();
    if (media) media.removeEventListener("change", check);
  };
}
