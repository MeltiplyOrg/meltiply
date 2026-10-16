/**
 * Layout inspection overlays for the DevBox Helpers tab.
 *
 * Two toggles, both delivered through a single injected stylesheet keyed off
 * `data-devbox-*` attributes on `<html>`:
 *
 * - **Baseline grid**: a fixed 8px repeating-linear-gradient overlay using the
 *   `--grid-line` token, for verifying vertical rhythm.
 * - **Element outlines**: a universal 1px outline on every element, for
 *   inspecting margins, padding, and clipping across nested layouts.
 *
 * Both skip the DevBox dock itself (`[data-devbox]` subtree) so the overlays
 * never obscure the controls that toggle them.
 */

import { ensureStyleTag } from "./dom";

const gridAttribute = "data-devbox-grid";
const outlinesAttribute = "data-devbox-outlines";
const overlayStyleId = "devbox-overlay-style";
const gridElementId = "devbox-grid-overlay";

const overlayStylesheet = `
#devbox-grid-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 2147483645;
  pointer-events: none;
  background-image: repeating-linear-gradient(
    to bottom,
    var(--grid-line) 0,
    var(--grid-line) 1px,
    transparent 1px,
    transparent 8px
  );
}
html[data-devbox-grid] #devbox-grid-overlay {
  display: block;
}
html[data-devbox-outlines] body *:not([data-devbox] *):not([data-devbox]) {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
`;

/**
 * Lazily injects the overlay stylesheet and grid element on first use.
 */
function ensureOverlayDom(): void {
  ensureStyleTag(overlayStyleId, overlayStylesheet);
  if (!document.getElementById(gridElementId)) {
    const grid = document.createElement("div");
    grid.id = gridElementId;
    grid.setAttribute("aria-hidden", "true");
    document.body.appendChild(grid);
  }
}

/**
 * Toggles the 8px baseline grid overlay.
 */
export function setBaselineGrid(enabled: boolean): void {
  if (enabled) ensureOverlayDom();
  document.documentElement.toggleAttribute(gridAttribute, enabled);
}

/**
 * Toggles the element boundary outline overlay.
 */
export function setElementOutlines(enabled: boolean): void {
  if (enabled) ensureOverlayDom();
  document.documentElement.toggleAttribute(outlinesAttribute, enabled);
}

/**
 * Reports current overlay state for restoring persisted toggles.
 */
export function overlayState(): { grid: boolean; outlines: boolean } {
  return {
    grid: document.documentElement.hasAttribute(gridAttribute),
    outlines: document.documentElement.hasAttribute(outlinesAttribute),
  };
}
