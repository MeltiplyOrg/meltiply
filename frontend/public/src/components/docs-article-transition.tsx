import { useEffect, useLayoutEffect, useRef } from "react";
import { effectEasing } from "@meltiply/ui/effects";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ArticleTransition {
  reveal: () => void;
  dispose: () => void;
}

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
    const duration = 140;
    for (const section of sections)
      for (const block of section) {
        const style = getComputedStyle(block);
        animations.push(
          block.animate(
            [
              { opacity: style.opacity, filter: style.filter },
              { opacity: 0, filter: "blur(2px)" },
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

  const reveal = () => {
    if (!pending) return;
    reset();
    const article = document.getElementById("nd-page");
    if (!article) return;
    const sections = articleSections(article);
    const sectionDuration = 160;
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
    dispose: () => {
      document.removeEventListener("astro:before-preparation", prepare);
      reset();
    },
  };
}

export function DocsArticleTransition({ pathname }: { pathname: string }) {
  const controller = useRef<ArticleTransition | null>(null);

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
  return null;
}
