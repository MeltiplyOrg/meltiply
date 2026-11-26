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

function ensureOverlayDom(): void {
  ensureStyleTag(overlayStyleId, overlayStylesheet);
  if (!document.getElementById(gridElementId)) {
    const grid = document.createElement("div");
    grid.id = gridElementId;
    grid.setAttribute("aria-hidden", "true");
    document.body.appendChild(grid);
  }
}

function pruneOverlayDom(): void {
  if (
    document.documentElement.hasAttribute(gridAttribute) ||
    document.documentElement.hasAttribute(outlinesAttribute)
  ) {
    return;
  }
  document.getElementById(gridElementId)?.remove();
  document.getElementById(overlayStyleId)?.remove();
}

export function setBaselineGrid(enabled: boolean): void {
  if (enabled) ensureOverlayDom();
  document.documentElement.toggleAttribute(gridAttribute, enabled);
  pruneOverlayDom();
}

export function setElementOutlines(enabled: boolean): void {
  if (enabled) ensureOverlayDom();
  document.documentElement.toggleAttribute(outlinesAttribute, enabled);
  pruneOverlayDom();
}

export function clearLayoutOverlays(): void {
  document.documentElement.removeAttribute(gridAttribute);
  document.documentElement.removeAttribute(outlinesAttribute);
  document.getElementById(gridElementId)?.remove();
  document.getElementById(overlayStyleId)?.remove();
}

export function overlayState(): { grid: boolean; outlines: boolean } {
  return {
    grid: document.documentElement.hasAttribute(gridAttribute),
    outlines: document.documentElement.hasAttribute(outlinesAttribute),
  };
}
