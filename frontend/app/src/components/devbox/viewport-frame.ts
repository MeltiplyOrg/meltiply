/**
 * Dev-only 390px viewport frame and breakpoint readout for the DevBox dock.
 *
 * The frame constrains `#root` to a centered 390px column with a dimmed
 * ambient backdrop and a floating boundary label, so responsive checks against
 * the mandatory 390px mobile gate run without browser devtools. Styling is
 * delivered through a dedicated stylesheet toggled by a `data-devbox-viewport`
 * attribute on `<html>` — no inline styles on the app tree, and removal is a
 * single attribute flip.
 *
 * `breakpointForWidth` mirrors the Tailwind default ramp so the dock can show
 * which media-query rules are active for the *real* window width (the frame is
 * a visual constraint; viewport media queries still follow the real window).
 */

import { ensureStyleTag } from "./dom";

const viewportAttribute = "data-devbox-viewport";
const styleElementId = "devbox-viewport-style";
const labelElementId = "devbox-viewport-label";

const viewportStylesheet = `
html[data-devbox-viewport] body {
  background: color-mix(in srgb, var(--ink) 35%, var(--page));
}
html[data-devbox-viewport] #root {
  width: 390px;
  max-width: 390px;
  min-height: 100dvh;
  margin-inline: auto;
  background: var(--page);
  box-shadow: 0 0 0 1px var(--line-strong), 0 24px 64px oklch(0 0 0 / 0.25);
  overflow-x: clip;
}
#devbox-viewport-label {
  display: none;
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483646;
  padding: 2px 8px;
  border-radius: 6px;
  font: 11px/1.4 ui-monospace, monospace;
  color: var(--tooltip-fg);
  background: var(--tooltip-bg);
  border: 1px solid var(--tooltip-border);
  pointer-events: none;
}
html[data-devbox-viewport] #devbox-viewport-label {
  display: block;
}
`;

export type TailwindBreakpoint = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

/**
 * Maps a viewport width in pixels to the active Tailwind breakpoint label.
 * Mirrors the default Tailwind ramp (sm 640, md 768, lg 1024, xl 1280, 2xl 1536).
 */
export function breakpointForWidth(width: number): TailwindBreakpoint {
  if (width >= 1536) return "2xl";
  if (width >= 1280) return "xl";
  if (width >= 1024) return "lg";
  if (width >= 768) return "md";
  if (width >= 640) return "sm";
  return "xs";
}

/**
 * Enables or disables the 390px frame. Lazily injects the stylesheet and the
 * floating "390px" boundary label on first enable; disabling only flips the
 * attribute and hides the label.
 */
export function setViewportFrame(enabled: boolean): void {
  if (enabled) ensureStyleTag(styleElementId, viewportStylesheet);
  document.documentElement.toggleAttribute(viewportAttribute, enabled);

  let label = document.getElementById(labelElementId);
  if (enabled && !label) {
    label = document.createElement("div");
    label.id = labelElementId;
    label.textContent = "390px";
    document.body.appendChild(label);
  }
}

/**
 * Reports whether the 390px frame is currently applied.
 */
export function isViewportFrameActive(): boolean {
  return document.documentElement.hasAttribute(viewportAttribute);
}
