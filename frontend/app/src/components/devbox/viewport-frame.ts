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

export function breakpointForWidth(width: number): TailwindBreakpoint {
  if (width >= 1536) return "2xl";
  if (width >= 1280) return "xl";
  if (width >= 1024) return "lg";
  if (width >= 768) return "md";
  if (width >= 640) return "sm";
  return "xs";
}

export function setViewportFrame(enabled: boolean): void {
  if (!enabled) {
    clearViewportFrame();
    return;
  }
  ensureStyleTag(styleElementId, viewportStylesheet);
  document.documentElement.setAttribute(viewportAttribute, "");

  if (!document.getElementById(labelElementId)) {
    const label = document.createElement("div");
    label.id = labelElementId;
    label.textContent = "390px";
    document.body.appendChild(label);
  }
}

export function clearViewportFrame(): void {
  document.documentElement.removeAttribute(viewportAttribute);
  document.getElementById(labelElementId)?.remove();
  document.getElementById(styleElementId)?.remove();
}

export function isViewportFrameActive(): boolean {
  return document.documentElement.hasAttribute(viewportAttribute);
}
