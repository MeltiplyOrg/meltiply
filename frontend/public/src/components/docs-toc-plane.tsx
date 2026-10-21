import type { CSSProperties } from "react";

const planePath =
  "M21 3 C18.67 9 16.33 15 14 21 C13 18.67 12 16.33 11 14 C8.33 12.67 5.67 11.33 3 10 C9 7.67 15 5.33 21 3 Z";
const circlePath =
  "M12 3 C16.97 3 21 7.03 21 12 C21 16.97 16.97 21 12 21 C7.03 21 3 16.97 3 12 C3 7.03 7.03 3 12 3 Z";
const shapes: CSSProperties & {
  "--docs-toc-plane-shape": string;
  "--docs-toc-circle-shape": string;
} = {
  "--docs-toc-plane-shape": `path("${planePath}")`,
  "--docs-toc-circle-shape": `path("${circlePath}")`,
};

/** Matches the reading marker with compatible four-curve outlines, allowing a real plane↔ring morph rather than an icon swap. */
export function DocsTocPlane() {
  return (
    <svg
      data-toc-plane=""
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={shapes}
    >
      <path data-toc-plane-outline="" d={planePath} pathLength="100" />
      <path data-toc-plane-fold="" d="M21 3 L11 14" />
    </svg>
  );
}

/** A shell-owned marker survives the keyed guide swap; cancellation removes all animation layers and announcements. */
export function createLoadingPlane(marker: HTMLElement) {
  const outline = marker.querySelector<SVGPathElement>("[data-toc-plane-outline]")!;
  const fold = marker.querySelector<SVGPathElement>("[data-toc-plane-fold]")!;
  const icon = marker.querySelector<SVGSVGElement>("svg")!;
  const label = marker.querySelector<HTMLElement>("[data-toc-loading-label]")!;
  let animations: Animation[] = [];
  let generation = 0;

  /** Invalidates stale completions before cancelling their native animation layers. */
  const cancel = () => {
    generation++;
    for (const animation of animations) animation.cancel();
    animations = [];
  };

  /** Restores the plane from the currently painted ring and rotation, including an interrupted return. */
  const restore = async () => {
    const outlineStyle = getComputedStyle(outline);
    const start = {
      d: outlineStyle.d,
      strokeDasharray: outlineStyle.strokeDasharray,
    };
    const opacity = getComputedStyle(fold).opacity;
    const rotation = getComputedStyle(icon).transform;
    const direction = getComputedStyle(marker).transform;
    cancel();
    const owner = generation;
    marker.dataset.state = "returning";
    const options = {
      duration: 180,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      fill: "both" as const,
    };
    animations = [
      outline.animate(
        [
          start,
          {
            d: `path("${planePath}")`,
            strokeDasharray: "100 0",
          },
        ],
        options,
      ),
      fold.animate([{ opacity }, { opacity: 1 }], options),
      icon.animate([{ transform: rotation }, { transform: "rotate(0deg)" }], options),
    ];
    marker.style.transform = "rotate(135deg)";
    animations.push(
      marker.animate([{ transform: direction }, { transform: "rotate(135deg)" }], options),
    );
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
    if (generation !== owner) return;
    marker.dataset.state = "returning";
    cancel();
  };

  return {
    /** Preserves the arrived ring through every guide swap; only pending loads spin and announce, while ready guides retain a static ring. */
    show: (list: HTMLElement, loading: boolean) => {
      const track = list.querySelector<SVGPathElement>(".docs-reading-remaining");
      if (!track?.ownerSVGElement || track.getTotalLength() === 0) return;
      const rect = track.ownerSVGElement.getBoundingClientRect();
      const first = track.getPointAtLength(0);
      const next = track.getPointAtLength(1);
      marker.style.left = `${rect.left + first.x - 7}px`;
      marker.style.top = `${rect.top + first.y - 7}px`;
      marker.style.transform = `rotate(${(Math.atan2(next.y - first.y, next.x - first.x) * 180) / Math.PI + 225}deg)`;
      label.textContent = loading ? "Loading guide" : "";
      marker.dataset.state = loading ? "loading" : "ready";
    },
    /** Keeps the same visible node through commit, restoring its plane shape before the new rail unfolds. */
    restore: () => {
      label.textContent = "";
      return marker.dataset.state === "idle" ? Promise.resolve() : restore();
    },
    /** Removes the marker after handoff, abort, error, or unmount; a later navigation starts without stale state. */
    hide: () => {
      cancel();
      marker.dataset.state = "idle";
      label.textContent = "";
    },
  };
}
