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

/**
 * The reference drawer curve (`--ease-drawer` in `motion.css`), mirrored for the
 * same reason as `effectEasing`: a soft pull that settles decisively, for an
 * effect that moves or resizes something the user is already watching. The
 * entrance curve above spends most of its travel in its first frames, which reads
 * as a jump on a move.
 */
export const effectMoveEasing = "cubic-bezier(0.32, 0.72, 0, 1)";

/** Default bounded duration for one shared effect, in milliseconds. */
export const effectDurationMs = 240;

/**
 * Lift-and-clear entrance with a bounded blur settle. Elements keep their own
 * styles as the final state, so a cancelled reveal never hides content.
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

/** Tracks shared effects so navigation can cancel them together. */
const activeEffects = new Set<Animation>();

/** Latest effect per element; a new effect on the same element replaces the previous one. */
const elementEffects = new WeakMap<Element, Animation>();

/**
 * Plays one bounded WAAPI effect on a mounted element, replacing any effect
 * already running on it. Underlying styles remain the final state, so
 * cancellation never hides content or leaves a fixed height behind.
 * Completion and cancellation both release tracking. Native reduced-motion
 * preferences skip the effect and retain the caller's resting styles.
 *
 * @returns The started animation, or null when reduced motion is requested or WAAPI is absent.
 */
export function playEffect(
  element: Element,
  frames: Keyframe[],
  delay = 0,
  timing: EffectTiming = {},
): Animation | null {
  elementEffects.get(element)?.cancel();
  if (
    element.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    typeof element.animate !== "function"
  )
    return null;
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

/** Cancels every tracked effect during navigation; resting styles remain visible. */
export function cancelEffects(): void {
  for (const animation of activeEffects) animation.cancel();
  activeEffects.clear();
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

/** Minimal native View Transition surface; kept structural so supported browsers gain it without a lib-version type dependency. */
interface ViewTransitionLike {
  finished: Promise<void>;
  skipTransition: () => void;
}

let activeViewTransition: ViewTransitionLike | undefined;

/**
 * Commits one synchronous view change with native snapshot/geometry
 * interpolation. Repeated choices skip the previous visual transition, never
 * its state commit. Unsupported browsers and native reduced motion commit
 * immediately; a rejected transition still releases its tracking. Callers name
 * only the elements that should morph; shared CSS keeps the rest still.
 */
export function transitionViewEffect(commit: () => void): void {
  activeViewTransition?.skipTransition();
  const start = (
    document as Document & {
      startViewTransition?: (callback: () => void) => ViewTransitionLike;
    }
  ).startViewTransition;
  if (
    typeof start !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    commit();
    return;
  }
  const transition = start.call(document, commit);
  activeViewTransition = transition;
  const release = () => {
    if (activeViewTransition === transition) activeViewTransition = undefined;
  };
  transition.finished.then(release, release);
}
