import {
  cancelEffects,
  disclosureEffect,
  morphHeightEffect,
  revealEffect,
} from "@meltiply/ui/effects";

export function animateDisclosure(element: HTMLElement): void {
  disclosureEffect(element);
}

export function animatePanel(panel: HTMLElement, previousHeight?: number): void {
  const container = panel.parentElement;
  if (container) morphHeightEffect(container, previousHeight);
  revealEffect(panel);
  panel.querySelectorAll(".post-list tbody tr").forEach((element, index) => {
    revealEffect(element, Math.min(index * 20, 80));
  });
}

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
  if (typeof IntersectionObserver === "undefined") return cancelEffects;
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
    cancelEffects();
  };
}
