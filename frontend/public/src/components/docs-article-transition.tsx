import { useEffect, useLayoutEffect, useRef } from "react";
import { useMotionPreference } from "@meltiply/ui/motion-preference";
import { motionAllowed } from "@meltiply/ui/motion-state";
import { effectEasing } from "@meltiply/ui/effects";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ArticleTransition {
  reveal: () => void;
  settle: () => void;
  dispose: () => void;
}

/**
 * Groups the preface and each heading with its following blocks, including
 * nested heading sections. Only layout-neutral content/prose wrappers flatten;
 * lists, tables, callouts and pagination retain their internal layout.
 */
function articleSections(article: HTMLElement): HTMLElement[][] {
  const sections: HTMLElement[][] = [[]];
  const visit = (parent: HTMLElement) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.matches(".contents, .docs-prose")) {
        visit(child);
        continue;
      }
      if (child.matches("h2, h3, h4, h5, h6") && sections.at(-1)!.length) sections.push([]);
      sections.at(-1)!.push(child);
    }
  };
  visit(article);
  return sections.filter((section) => section.length > 0);
}

/**
 * Replaces each painted text line with a rounded loading bar at the same
 * article-relative coordinates. Adjacent inline fragments merge, but table
 * columns remain separate. The overlay is decorative and never changes layout.
 */
function articleSkeleton(article: HTMLElement): HTMLElement {
  const bounds = article.getBoundingClientRect();
  const lines: { left: number; top: number; right: number; height: number }[] = [];
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim()) continue;
    if (node.parentElement?.closest("svg, button, [aria-hidden='true']")) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      lines.push({
        left: rect.left - bounds.left,
        top: rect.top - bounds.top,
        right: rect.right - bounds.left,
        height: rect.height,
      });
    }
  }
  lines.sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: typeof lines = [];
  for (const line of lines) {
    const previous = merged.at(-1);
    if (
      previous &&
      Math.abs(previous.top - line.top) < 2 &&
      Math.abs(previous.height - line.height) < 3 &&
      line.left <= previous.right + 12
    ) {
      previous.right = Math.max(previous.right, line.right);
    } else merged.push(line);
  }
  const overlay = document.createElement("div");
  overlay.className = "docs-article-skeleton";
  overlay.setAttribute("aria-hidden", "true");
  for (const [index, line] of merged.entries()) {
    const bar = document.createElement("span");
    bar.style.left = `${line.left}px`;
    bar.style.top = `${line.top + line.height * 0.18}px`;
    bar.style.width = `${line.right - line.left}px`;
    bar.style.height = `${line.height * 0.64}px`;
    bar.style.animationDelay = `${(index % 8) * -80}ms`;
    overlay.append(bar);
  }
  return overlay;
}

/**
 * Owns article-only navigation effects while Astro and the TOC controller own
 * fetching, scrolling and route commits. Abort, failure and supersession restore
 * the outgoing article; initial hydration remains static. Sections cascade in
 * over a bounded ~200ms stagger; reduced motion settles immediately.
 */
function createArticleTransition(): ArticleTransition {
  let pending: {
    article: HTMLElement;
    overlay: HTMLElement;
    signal: AbortSignal;
    abort: () => void;
    inert: boolean;
  } | null = null;
  let animations: Animation[] = [];
  let generation = 0;

  /** Releases temporary layers and restores interaction, including on an outgoing detached article. */
  const reset = () => {
    generation++;
    for (const animation of animations) animation.cancel();
    animations = [];
    if (!pending) return;
    pending.signal.removeEventListener("abort", pending.abort);
    pending.overlay.remove();
    pending.article.removeAttribute("aria-busy");
    pending.article.removeAttribute("data-article-loading");
    pending.article.inert = pending.inert;
    pending = null;
  };

  /** Starts the text-to-bars cross-morph immediately; fetching runs concurrently without a synthetic loading delay. */
  const prepare = (event: DocumentEventMap["astro:before-preparation"]) => {
    if (event.from.pathname === event.to.pathname) return;
    reset();
    const article = document.getElementById("nd-page");
    if (!article) return;
    const sections = articleSections(article);
    const overlay = articleSkeleton(article);
    const inert = article.inert;
    article.dataset.articleLoading = "true";
    article.setAttribute("aria-busy", "true");
    article.inert = true;
    article.append(overlay);
    const duration = motionAllowed() ? 140 : 0;
    for (const section of sections)
      for (const block of section) {
        const style = getComputedStyle(block);
        animations.push(
          block.animate(
            [
              { opacity: style.opacity, filter: style.filter },
              { opacity: 0, filter: duration ? "blur(2px)" : "none" },
            ],
            { duration, easing: effectEasing, fill: "both" },
          ),
        );
      }
    animations.push(
      overlay.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration,
        easing: effectEasing,
        fill: "both",
      }),
    );
    const morph = Promise.all(
      animations.map((animation) => animation.finished.catch(() => undefined)),
    );
    const abort = () => {
      if (pending === cycle) reset();
    };
    const cycle = { article, overlay, signal: event.signal, abort, inert };
    pending = cycle;
    event.signal.addEventListener("abort", abort, { once: true });
    const loader = event.loader;
    event.loader = async () => {
      try {
        await Promise.all([loader(), morph]);
        if (event.defaultPrevented && pending === cycle) reset();
      } catch (error) {
        if (pending === cycle) reset();
        throw error;
      }
    };
  };

  /** Reveals sections in order with a gentle six-pixel rise; a softer ease-out avoids the outgoing morph's sharp acceleration. */
  const reveal = () => {
    if (!pending) return;
    reset();
    const article = document.getElementById("nd-page");
    if (!article || !motionAllowed()) return;
    const sections = articleSections(article);
    const sectionDuration = 160;
    // Fixed stagger budget: sections still cascade top-down, but the whole
    // sequence fits in ~360ms regardless of heading count (the previous
    // index * 160ms serial reveal pushed long guides past a second).
    const stagger = sections.length > 1 ? Math.min(200 / (sections.length - 1), 40) : 0;
    const owner = generation;
    for (const [index, section] of sections.entries())
      for (const block of section)
        animations.push(
          block.animate(
            [
              { opacity: 0, transform: "translateY(6px)" },
              { opacity: 1, transform: "translateY(0px)" },
            ],
            {
              duration: sectionDuration,
              delay: index * stagger,
              easing: "cubic-bezier(0.25, 1, 0.5, 1)",
              fill: "both",
            },
          ),
        );
    void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(
      () => {
        if (generation === owner) reset();
      },
    );
  };

  document.addEventListener("astro:before-preparation", prepare);
  return {
    reveal,
    /** Ends spatial effects when manual/OS low motion is enabled during a transition. */
    settle: () => {
      for (const animation of animations) animation.finish();
    },
    /** Removes the route listener and all transient effects when the persisted shell unmounts. */
    dispose: () => {
      document.removeEventListener("astro:before-preparation", prepare);
      reset();
    },
  };
}

/**
 * Persists article animation ownership across keyed guide replacements. The
 * pathname layout effect stages entrances before paint; ordinary first loads
 * do not animate or wait for the controller. Low motion also stops live effects.
 */
export function DocsArticleTransition({ pathname }: { pathname: string }) {
  const controller = useRef<ArticleTransition | null>(null);
  const { lowMotion } = useMotionPreference();
  useEffect(() => {
    controller.current = createArticleTransition();
    return () => {
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);
  useClientLayoutEffect(() => {
    controller.current?.reveal();
  }, [pathname]);
  useClientLayoutEffect(() => {
    if (lowMotion) controller.current?.settle();
  }, [lowMotion]);
  return null;
}
