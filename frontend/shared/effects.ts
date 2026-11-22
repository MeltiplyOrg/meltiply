export const effectEasing = "cubic-bezier(0.16, 1, 0.3, 1)";
export const effectMoveEasing = "cubic-bezier(0.32, 0.72, 0, 1)";

const effectDurationMs = 240;

const revealEffectFrames: Keyframe[] = [
  { opacity: 0.45, transform: "translateY(10px)", filter: "blur(2px)" },
  { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
];

const disclosureEffectFrames: Keyframe[] = [
  { opacity: 0.6, transform: "translateY(-6px)" },
  { opacity: 1, transform: "translateY(0)" },
];

interface EffectTiming {
  duration?: number;
  easing?: string;
  fill?: FillMode;
}

const activeEffects = new Set<Animation>();
const elementEffects = new WeakMap<Element, Animation>();

function prefersReducedMotion(view: Window | null): boolean {
  return view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function playEffect(
  element: Element,
  frames: Keyframe[],
  delay = 0,
  timing: EffectTiming = {},
): Animation | null {
  elementEffects.get(element)?.cancel();
  if (prefersReducedMotion(element.ownerDocument.defaultView) || !("animate" in element))
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

export function cancelEffects(): void {
  for (const animation of activeEffects) animation.cancel();
  activeEffects.clear();
}

export function revealEffect(element: Element, delay = 0): Animation | null {
  return playEffect(element, revealEffectFrames, delay);
}

export function disclosureEffect(element: Element): Animation | null {
  return playEffect(element, disclosureEffectFrames);
}

export function morphHeightEffect(element: HTMLElement, previousHeight?: number): Animation | null {
  elementEffects.get(element)?.cancel();
  const nextHeight = element.offsetHeight;
  if (previousHeight === undefined || previousHeight === nextHeight) return null;
  return playEffect(element, [{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }]);
}

let activeViewTransition: ViewTransition | undefined;

export function transitionViewEffect(commit: () => void): void {
  activeViewTransition?.skipTransition();
  if (!("startViewTransition" in document) || prefersReducedMotion(window)) {
    commit();
    return;
  }
  const transition = document.startViewTransition(commit);
  activeViewTransition = transition;
  const release = () => {
    if (activeViewTransition === transition) activeViewTransition = undefined;
  };
  transition.finished.then(release, release);
}
