import * as React from "react";

interface RestingBox {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

interface DialogSurface {
  element: HTMLElement;
  resting: RestingBox | null;
  visible: RestingBox | null;
}

const surfaces: DialogSurface[] = [];

const CENTER_EPSILON_PX = 1;

function unregister(surface: DialogSurface): void {
  const index = surfaces.indexOf(surface);
  if (index >= 0) surfaces.splice(index, 1);
}

function boxOf(rect: DOMRect): RestingBox {
  return {
    width: rect.width,
    height: rect.height,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
  };
}

function measureBox(element: HTMLElement): RestingBox | null {
  const isAnimating =
    typeof element.getAnimations === "function" && element.getAnimations().length > 0;
  const target = isAnimating ? stripAnimation(element) : element;
  const rect = target.getBoundingClientRect();
  if (isAnimating) target.remove();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return boxOf(rect);
}

function stripAnimation(element: HTMLElement): HTMLElement {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.animation = "none";
  clone.style.transition = "none";
  clone.style.pointerEvents = "none";
  clone.style.visibility = "hidden";
  clone.removeAttribute("data-dialog-motion");
  document.body.appendChild(clone);
  return clone;
}

function isSettled(element: HTMLElement): boolean {
  if (typeof element.getAnimations !== "function") return true;
  return element.getAnimations().every((animation) => animation.playState !== "running");
}

function restingBox(surface: DialogSurface): RestingBox | null {
  if (surface.resting === null || isSettled(surface.element)) {
    surface.resting = measureBox(surface.element);
  }
  return surface.resting;
}

function sharesCenter(from: RestingBox, to: RestingBox): boolean {
  return (
    Math.abs(from.centerX - to.centerX) <= CENTER_EPSILON_PX &&
    Math.abs(from.centerY - to.centerY) <= CENTER_EPSILON_PX
  );
}

function neighbourSurface(
  self: DialogSurface,
  isCandidate: (surface: DialogSurface) => boolean,
): DialogSurface | undefined {
  for (let index = surfaces.length - 1; index >= 0; index -= 1) {
    const candidate = surfaces[index];
    if (candidate !== undefined && candidate !== self && isCandidate(candidate)) return candidate;
  }
  return undefined;
}

function writeMorphTrack(element: HTMLElement, from: RestingBox, to: RestingBox): void {
  element.style.setProperty("--dialog-morph-from-width", `${from.width}px`);
  element.style.setProperty("--dialog-morph-from-height", `${from.height}px`);
  element.style.setProperty("--dialog-morph-to-width", `${to.width}px`);
  element.style.setProperty("--dialog-morph-to-height", `${to.height}px`);
}

function coverSurface(surface: DialogSurface, covered: boolean): void {
  surface.element.toggleAttribute("data-dialog-covered", covered);
  const backdrop = surface.element.previousElementSibling;
  if (backdrop instanceof HTMLElement && backdrop.hasAttribute("data-dialog-backdrop")) {
    backdrop.toggleAttribute("data-dialog-covered", covered);
    backdrop.toggleAttribute("data-dialog-handoff", !covered);
  }
}

function snapshotContent(element: HTMLElement, box: RestingBox): HTMLElement {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.removeAttribute("data-dialog-surface");
  clone.removeAttribute("data-dialog-covered");
  clone.removeAttribute("data-dialog-motion");
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  clone.querySelectorAll("[data-dialog-snapshot]").forEach((node) => node.remove());
  clone.dataset.dialogSnapshot = "";
  clone.inert = true;
  clone.setAttribute("aria-hidden", "true");
  clone.removeAttribute("role");
  clone.style.cssText = "";
  clone.style.width = `${box.width}px`;
  clone.style.height = `${box.height}px`;
  return clone;
}

function forceStyleFlush(element: HTMLElement): void {
  void element.offsetWidth;
}

function morphHandoff(
  arriving: DialogSurface,
  replaced: DialogSurface,
  from: RestingBox,
  to: RestingBox,
): void {
  const visible = replaced.element.getBoundingClientRect();
  const start =
    replaced.element.dataset.state === "closed" && replaced.visible !== null
      ? replaced.visible
      : visible.width > 0 && visible.height > 0
        ? { ...from, width: visible.width, height: visible.height }
        : from;
  const snapshot = snapshotContent(replaced.element, start);
  arriving.element.querySelectorAll("[data-dialog-snapshot]").forEach((node) => node.remove());
  arriving.element.dataset.dialogMotion = "settled";
  forceStyleFlush(arriving.element);
  writeMorphTrack(arriving.element, start, to);
  coverSurface(arriving, false);
  coverSurface(replaced, true);
  if (replaced.element.dataset.state === "closed") {
    replaced.element.dataset.dialogMotion = "morph-out";
  }
  arriving.element.appendChild(snapshot);
  arriving.element.dataset.dialogMotion = "morph-in";
  arriving.visible = start;
}

/**
 * Registers a centered dialog surface so that opening one dialog over another with the same center
 * morphs a single shell between their sizes instead of popping both. Covered dialogs stay mounted
 * for focus and form state. Returns the ref callback for the content element.
 */
export function useCenterDialogMorph<T extends HTMLElement>(
  forwardedRef: React.ForwardedRef<T>,
): React.RefCallback<T> {
  const [element, setElement] = React.useState<T | null>(null);
  React.useImperativeHandle<T | null, T | null>(forwardedRef, () => element, [element]);

  React.useLayoutEffect(() => {
    if (element === null) return;
    const surface: DialogSurface = { element, resting: null, visible: null };
    surfaces.push(surface);

    const own = restingBox(surface);
    surface.visible = own;
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (element.dataset.state !== "open" || element.hasAttribute("data-dialog-covered"))
              return;
            surface.visible = boxOf(element.getBoundingClientRect());
          });
    resize?.observe(element);
    const replaced = neighbourSurface(surface, () => true);
    if (own !== null && replaced !== undefined) {
      const from = restingBox(replaced);
      if (from !== null && sharesCenter(from, own)) {
        morphHandoff(surface, replaced, from, own);
      }
    }

    const observer = new MutationObserver(() => {
      if (element.dataset.state === "open" && element.hasAttribute("data-dialog-covered")) {
        const previous = neighbourSurface(
          surface,
          (candidate) =>
            candidate.element.dataset.state === "open" &&
            !candidate.element.hasAttribute("data-dialog-covered") &&
            candidate.element.isConnected,
        );
        const to = restingBox(surface);
        const from = previous === undefined ? null : restingBox(previous);
        if (previous !== undefined && from !== null && to !== null && sharesCenter(from, to)) {
          morphHandoff(surface, previous, from, to);
        }
        return;
      }
      if (element.dataset.state !== "closed" || element.dataset.dialogMotion === "morph-out")
        return;
      const successor = neighbourSurface(
        surface,
        (candidate) => candidate.element.dataset.state === "open" && candidate.element.isConnected,
      );
      if (successor === undefined) return;
      const from = restingBox(surface);
      const to = restingBox(successor);
      if (from === null || to === null || !sharesCenter(from, to)) return;
      morphHandoff(successor, surface, from, to);
    });
    observer.observe(element, { attributes: true, attributeFilter: ["data-state"] });

    const releaseTrack = (event: AnimationEvent): void => {
      if (event.target !== element || event.animationName !== "dialog-morph-size") return;
      element.querySelectorAll("[data-dialog-snapshot]").forEach((node) => node.remove());
      element.dataset.dialogMotion = "settled";
    };
    element.addEventListener("animationend", releaseTrack);

    return () => {
      element.querySelectorAll("[data-dialog-snapshot]").forEach((node) => node.remove());
      observer.disconnect();
      resize?.disconnect();
      element.removeEventListener("animationend", releaseTrack);
      queueMicrotask(() => unregister(surface));
    };
  }, [element]);

  return React.useCallback((node: T | null) => setElement(node), []);
}
