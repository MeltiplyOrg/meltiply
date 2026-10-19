import Lenis from "lenis";
import { useEffect, useState, type RefCallback } from "react";

const nestedScrollSelector = "[data-lenis-prevent]";

/**
 * Predicate determining whether an element or any ancestor opt out of Lenis smooth scrolling.
 * Checks for the presence of the `[data-lenis-prevent]` attribute so the document controller
 * leaves those regions to their own scrolling owner.
 *
 * @param node - The DOM element initiating a scroll event.
 * @returns True if the element is within a container marked with data-lenis-prevent.
 */
function preventNestedScroll(node: HTMLElement): boolean {
  return node.closest(nestedScrollSelector) !== null;
}

/**
 * Initializes the document-level Lenis smooth scrolling controller with autoRaf and anchor handling.
 * Stays out of regions marked `[data-lenis-prevent]`, which are either native scrollers or the
 * containers smoothed by `useSmoothScrollContainer`.
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
 * Smooths one nested scroll container with its own Lenis instance.
 *
 * The document controller deliberately leaves `[data-lenis-prevent]` regions alone,
 * so a workspace list that owns its own viewport (Posts table, Grid, Calendar,
 * Channels directory) needs its own controller to keep wheel inertia. Lenis
 * respects `prefers-reduced-motion` by default, so a reduced-motion visitor keeps
 * native scrolling, and destroying the instance restores native scrolling for
 * every other teardown path.
 *
 * Returns a stable callback ref so setup follows the mounted element, including
 * conditional mounts and replacements. Replacing the first child rebuilds Lenis
 * with the current content; detaching the viewport destroys its controller.
 *
 * @returns Ref for the scrollable element that owns the viewport.
 */
export function useSmoothScrollContainer(): RefCallback<HTMLElement> {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!element) return;
    // Lenis needs a real layout engine: it reads reduced-motion preferences and
    // observes element boxes. A DOM without them (server rendering, a jsdom test
    // surface) has nothing to smooth, so the viewport keeps native scrolling.
    if (typeof window.matchMedia !== "function" || typeof ResizeObserver === "undefined") return;
    let content = element.firstElementChild ?? element;
    let lenis = new Lenis({
      wrapper: element,
      content,
      autoRaf: true,
    });
    // An element wrapper's scroll limit is measured from the wrapper, and the
    // wrapper's own box never changes while a list grows, so its resize observer
    // cannot notice new rows. Re-measure when the list's children change instead,
    // batched to one frame.
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextContent = element.firstElementChild ?? element;
        if (nextContent !== content) {
          lenis.destroy();
          content = nextContent;
          lenis = new Lenis({ wrapper: element, content, autoRaf: true });
        } else {
          lenis.resize();
        }
      });
    });
    observer.observe(element, { childList: true, subtree: true });
    // Lenis animates through fractional offsets, and a `position: sticky` header
    // inside such a container repaints at each of them, which reads as a flicker
    // along the header's top edge. Snapping the container's own scroll position to
    // whole pixels after the write keeps the header still; the correction is under
    // a pixel, so Lenis's animation values are untouched.
    const snapToWholePixel = () => {
      const rounded = Math.round(element.scrollTop);
      if (rounded !== element.scrollTop) element.scrollTop = rounded;
    };
    element.addEventListener("scroll", snapToWholePixel, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", snapToWholePixel);
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, [element]);
  return setElement;
}

/**
 * Headless controller component that mounts document-level Lenis smooth scrolling on the root window.
 * Mounts in `main.tsx` and unmounts cleanly without rendering any DOM nodes.
 * The existing Lenis implementation owns wheel inertia; native touch, keyboard,
 * and nested scroll behavior remain intact. Unmount destroys the controller.
 *
 * @returns null as this is a purely lifecycle-driven headless component.
 */
export function SmoothScroll(): null {
  useEffect(() => {
    return createSmoothScroll();
  }, []);

  return null;
}
