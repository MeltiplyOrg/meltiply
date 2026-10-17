import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { motionAllowed, reducedMotionQuery } from "@meltiply/ui/motion-state";
import { navigate } from "astro:transitions/client";

let scroll: Lenis | undefined;
const systemMotion = window.matchMedia(reducedMotionQuery);
const preferenceObserver = new MutationObserver(syncMotion);

/** Releases inertia before Astro's native route scroll, root replacement, or low motion. */
function destroyScroll() {
  scroll?.destroy();
  scroll = undefined;
}

/**
 * Gives the public document longer wheel travel and slip (Facebook-FYP-like
 * inertia) without changing native touch, keyboard, or nested overflow
 * scrolling. A lower 0.1 lerp keeps a coasting tail and a raised wheel
 * multiplier covers more distance per gesture; live manual/OS low motion and
 * theme capture release the controller.
 */
function syncMotion() {
  if (!motionAllowed()) {
    destroyScroll();
    return;
  }
  scroll ??= new Lenis({
    autoRaf: true,
    anchors: false,
    allowNestedScroll: true,
    lerp: 0.1,
    wheelMultiplier: 1.5,
    syncTouch: false,
  });
}

/**
 * Rebinds preferences after Astro replaces the root and restores scroll position.
 * One controller survives hydration, never a route swap; deep links and Back use
 * Astro's native positioning before new wheel input starts smoothing.
 */
function loadPage() {
  destroyScroll();
  preferenceObserver.disconnect();
  preferenceObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-low-motion"],
  });
  syncMotion();
}

/**
 * Pulls same-page anchors to their CSS heading offset in a bounded 320ms ease-out
 * (440ms for non-TOC links). Astro commits fragment history before travel; focus
 * and mobile callbacks stay intact, and modified or missing links stay native.
 * No controller means no interception, preserving immediate low-motion anchors.
 */
function pullAnchor(event: MouseEvent) {
  if (
    !scroll ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const link =
    event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
  const url = new URL(link.href);
  if (
    !url.hash ||
    url.origin !== location.origin ||
    url.pathname !== location.pathname ||
    url.search !== location.search
  )
    return;
  let id: string;
  try {
    id = decodeURIComponent(url.hash.slice(1));
  } catch {
    return;
  }
  const heading = document.getElementById(id);
  if (!heading) return;
  event.preventDefault();
  const origin = window.scrollY;
  // Astro's same-page navigation commits history synchronously. Restore the
  // starting position in the same task, before paint, then animate from there;
  // committing on arrival would record the destination as Back's saved position.
  void navigate(url.href);
  window.scrollTo({ top: origin, behavior: "instant" });
  scroll.resize();
  // Focus before travel so keyboard users land at the heading and new input can
  // interrupt without a delayed completion callback stealing focus back.
  if (!heading.hasAttribute("tabindex")) {
    heading.tabIndex = -1;
    heading.addEventListener("blur", () => heading.removeAttribute("tabindex"), { once: true });
  }
  heading.focus({ preventScroll: true });
  scroll.scrollTo(heading, {
    duration: link.matches(".docs-reading-link") ? 0.32 : 0.44,
    lerp: 0,
    easing: (progress) => 1 - Math.pow(1 - progress, 4),
  });
}

/** Stops a scripted heading pull before native keyboard or touch input takes over. */
function interruptPull(event: KeyboardEvent | TouchEvent) {
  if (
    event instanceof KeyboardEvent &&
    !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
  )
    return;
  // stop/start cancels even an animation whose first frame has not moved yet.
  scroll?.stop();
  scroll?.start();
}

document.addEventListener("click", pullAnchor, true);
document.addEventListener("keydown", interruptPull);
document.addEventListener("touchstart", interruptPull, { passive: true });
document.addEventListener("astro:before-preparation", destroyScroll);
document.addEventListener("astro:page-load", loadPage);
window.addEventListener("pagehide", destroyScroll);
window.addEventListener("pageshow", loadPage);
systemMotion.addEventListener("change", syncMotion);
loadPage();
