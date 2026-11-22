import Lenis from "lenis";
import { useEffect, useState, type RefCallback } from "react";

const nestedScrollSelector = "[data-lenis-prevent]";

function preventNestedScroll(node: HTMLElement): boolean {
  return node.closest(nestedScrollSelector) !== null;
}

export function createSmoothScroll(): () => void {
  const lenis = new Lenis({
    allowNestedScroll: false,
    anchors: true,
    autoRaf: true,
    prevent: preventNestedScroll,
  });

  return () => lenis.destroy();
}

export function useSmoothScrollContainer(): RefCallback<HTMLElement> {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!element) return;
    if (typeof window.matchMedia !== "function" || typeof ResizeObserver === "undefined") return;
    let content = element.firstElementChild ?? element;
    let lenis = new Lenis({
      wrapper: element,
      content,
      autoRaf: true,
    });
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

export function SmoothScroll(): null {
  useEffect(() => {
    return createSmoothScroll();
  }, []);

  return null;
}
