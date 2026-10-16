import {
  cancelEffects,
  disclosureEffect,
  morphHeightEffect,
  revealEffect,
  watchMotionSuppression,
} from "@meltiply/ui/effects";

/*
 * Landing motion orchestration on top of the shared WAAPI engine in
 * `@meltiply/ui/effects`. The engine owns the shared manual-OR-OS low-motion
 * rule, ink-capture suppression, per-element replacement, and tracked
 * cancellation; this file only maps landing selectors onto those recipes.
 */

/**
 * Gives the mobile disclosure a short entrance without delaying visibility,
 * focus, or native hidden-state dismissal; low motion uses the resting layout.
 */
export function animateDisclosure(element: HTMLElement): void {
  disclosureEffect(element);
}

/**
 * Animates a newly selected demo panel and any change in the containing
 * window's height, preserving mounted tab controls and keyboard focus.
 * `previousHeight` is the container's previous viewport-space height in CSS
 * pixels; absent/equal heights skip morphing. Landing-owned selectors pick
 * which descendants join the stagger.
 */
export function animatePanel(panel: HTMLElement, previousHeight?: number): void {
  const container = panel.parentElement;
  if (container) morphHeightEffect(container, previousHeight);
  revealEffect(panel);
  panel.querySelectorAll(".post-list tbody tr").forEach((element, index) => {
    revealEffect(element, Math.min(index * 20, 80));
  });
}

/**
 * Orchestrates one-time viewport entrances for every landing component family.
 * Content stays visible without JS/IntersectionObserver. Preference or
 * ink-capture changes cancel active WAAPI effects back to their normal styles,
 * including height morphs; new entrances always recheck the shared manual OR
 * live OS rule inside the engine. Returns cleanup for Astro route swaps so
 * observers and suppression subscriptions cannot retain a detached homepage.
 */
export function initializeMotion(): () => void {
  const targets = document.querySelectorAll(
    [
      ".site-header .brand",
      ".desktop-nav",
      ".header-actions",
      ".hero h1",
      ".hero-description",
      ".hero-actions",
      ".hero-note",
      ".hero-feature-pills",
      ".preview-topline",
      ".product-window",
      ".preview-caption",
      ".platforms > p",
      ".platform-list > div",
      ".section-heading",
      ".feature-card",
      ".workflow-grid article",
      ".cta-section",
      ".site-footer > div",
      ".site-footer nav",
      ".copyright",
    ].join(","),
  );
  const stopWatching = watchMotionSuppression(cancelEffects);
  if (typeof IntersectionObserver === "undefined") return stopWatching;
  const observer = new IntersectionObserver(
    (entries) => {
      let stagger = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        revealEffect(entry.target, Math.min(stagger++ * 20, 100));
      }
    },
    { threshold: 0.08, rootMargin: "0px 0px -20px 0px" },
  );
  for (const target of targets) observer.observe(target);
  return () => {
    observer.disconnect();
    stopWatching();
    cancelEffects();
  };
}
