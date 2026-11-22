import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { navigate } from "astro:transitions/client";

let scroll: Lenis | undefined;
let listenersBound = false;

function destroyScroll() {
  if (listenersBound) {
    document.removeEventListener("click", pullAnchor, true);
    document.removeEventListener("keydown", interruptPull);
    document.removeEventListener("touchstart", interruptPull);
    listenersBound = false;
  }
  scroll?.destroy();
  scroll = undefined;
}

function syncMotion() {
  scroll ??= new Lenis({
    autoRaf: true,
    anchors: false,
    allowNestedScroll: true,
    lerp: 0.1,
    wheelMultiplier: 1.5,
    syncTouch: false,
  });
  if (!listenersBound) {
    document.addEventListener("click", pullAnchor, true);
    document.addEventListener("keydown", interruptPull);
    document.addEventListener("touchstart", interruptPull, { passive: true });
    listenersBound = true;
  }
}

function loadPage() {
  destroyScroll();
  syncMotion();
}

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
  if (
    !link.hash ||
    link.origin !== location.origin ||
    link.pathname !== location.pathname ||
    link.search !== location.search
  )
    return;
  let id: string;
  try {
    id = decodeURIComponent(link.hash.slice(1));
  } catch {
    return;
  }
  const heading = document.getElementById(id);
  if (!heading) return;
  event.preventDefault();
  const origin = window.scrollY;
  void navigate(link.href);
  window.scrollTo({ top: origin, behavior: "instant" });
  scroll.resize();
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

function interruptPull(event: KeyboardEvent | TouchEvent) {
  if (
    event instanceof KeyboardEvent &&
    !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
  )
    return;
  scroll?.stop();
  scroll?.start();
}

document.addEventListener("astro:before-preparation", destroyScroll);
document.addEventListener("astro:page-load", loadPage);
window.addEventListener("pagehide", destroyScroll);
window.addEventListener("pageshow", loadPage);
loadPage();
