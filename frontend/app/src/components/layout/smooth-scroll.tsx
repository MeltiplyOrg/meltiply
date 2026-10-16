import Lenis from "lenis";
import { useEffect } from "react";

import { useMotionPreference } from "@meltiply/ui/motion-preference";

const nestedScrollSelector = "[data-lenis-prevent]";

/**
 * Predicate determining whether an element or any ancestor opt out of Lenis smooth scrolling.
 * Checks for the presence of the `[data-lenis-prevent]` attribute to retain native scrolling on nested containers.
 *
 * @param node - The DOM element initiating a scroll event.
 * @returns True if the element is within a container marked with data-lenis-prevent.
 */
function preventNestedScroll(node: HTMLElement): boolean {
  return node.closest(nestedScrollSelector) !== null;
}

/**
 * Initializes the document-level Lenis smooth scrolling controller with autoRaf and anchor handling.
 * Exempts nested scroll containers marked with `[data-lenis-prevent]` so they retain native scroll behavior.
 * Low-motion gating lives in {@link SmoothScroll}; callers that mount Lenis directly must gate it themselves.
 *
 * @returns Cleanup function that destroys the Lenis instance on unmount.
 */
export function createSmoothScroll(): () => void {
  const lenis = new Lenis({
    allowNestedScroll: false,
    anchors: true,
    autoRaf: true,
    prevent: preventNestedScroll,
  });

  return () => lenis.destroy();
}

/**
 * Headless controller component that mounts document-level Lenis smooth scrolling on the root window.
 * Mounts in `main.tsx` and unmounts cleanly without rendering any DOM nodes.
 * When {@link useMotionPreference} reports effective low motion (manual toggle or OS
 * `prefers-reduced-motion`), Lenis is not created — or is destroyed mid-session if the
 * preference flips — so scrolling stays fully native; the effect re-runs on every
 * `lowMotion` change, and its cleanup destroys the previous instance.
 *
 * @returns null as this is a purely lifecycle-driven headless component.
 */
export function SmoothScroll(): null {
  const { lowMotion } = useMotionPreference();

  useEffect(() => {
    if (lowMotion) return;
    return createSmoothScroll();
  }, [lowMotion]);

  return null;
}
