import * as React from "react";
import { motionAllowed } from "@meltiply/ui/motion-state";

/**
 * Coordinates centered dialog handoffs before paint. One opaque destination
 * owns the resizing shell; an inert copy of the previous contents slides out
 * inside it. Covered dialogs remain mounted for Radix focus and form state.
 * Only the first entrance and final dismissal travel to the bottom edge.
 */

/** A measured box in viewport CSS pixels, reduced to what a morph interpolates. */
interface RestingBox {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/** One registered dialog surface and the last box it held at rest. */
interface DialogSurface {
  /** The dialog's animated content element, carrying Radix's `data-state`. */
  element: HTMLElement;
  /** Last measured box with no animation in flight; `null` until measured. */
  resting: RestingBox | null;
  /** Last painted geometry, retained when `data-state=closed` cancels the size track. */
  visible: RestingBox | null;
}

/**
 * Dialog surfaces in mount order. An entry outlives its own unmount by one
 * microtask so a dialog opening in the same commit still finds the box it is
 * replacing, even where Radix unmounts the closed content immediately.
 */
const surfaces: DialogSurface[] = [];

/**
 * Two boxes only morph when their centers agree within measurement noise. The
 * mobile navigation panel rests against the top edge, so it hands off to and
 * from centered dialogs as a pop instead of sliding across the viewport.
 */
const CENTER_EPSILON_PX = 1;

/**
 * Measures a dialog box. Returns `null` for a box with no area — an element
 * inside a hidden subtree, or a DOM without layout such as the unit-test
 * environment — and the caller then treats it as a plain pop.
 */
function measureBox(element: HTMLElement): RestingBox | null {
  const isAnimating =
    typeof element.getAnimations === "function" && element.getAnimations().length > 0;
  const target = isAnimating ? stripAnimation(element) : element;
  const rect = target.getBoundingClientRect();
  if (isAnimating) target.remove();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    width: rect.width,
    height: rect.height,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
  };
}

/** Measures resting layout without briefly changing the live animated surface. */
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

/**
 * Whether the box holds its resting geometry, which is only true while no
 * animation of its own is in flight. `getAnimations` is absent in DOMs without
 * the Web Animations API, where boxes never animate and are always at rest.
 */
function isSettled(element: HTMLElement): boolean {
  if (typeof element.getAnimations !== "function") return true;
  return element.getAnimations().every((animation) => animation.playState !== "running");
}

/** Caches resting geometry while a surface is moving; refreshes after it settles. */
function restingBox(surface: DialogSurface): RestingBox | null {
  if (surface.resting === null || isSettled(surface.element)) {
    surface.resting = measureBox(surface.element);
  }
  return surface.resting;
}

/** Whether two boxes sit on the same resting center, so one can become the other. */
function sharesCenter(from: RestingBox, to: RestingBox): boolean {
  return (
    Math.abs(from.centerX - to.centerX) <= CENTER_EPSILON_PX &&
    Math.abs(from.centerY - to.centerY) <= CENTER_EPSILON_PX
  );
}

/**
 * The most recently registered surface other than `self`, or `undefined` when
 * this dialog is alone. `isCandidate` narrows the search: an entrance accepts
 * the dialog it replaces even mid-exit, while an exit only hands its box to a
 * dialog that is open and still in the document.
 */
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

/**
 * Points one side of a handoff at the other's measured box. Writing the track
 * before the next paint is what keeps the outgoing dialog from ever rendering a
 * frame of its own pop-out.
 */
function writeMorphTrack(element: HTMLElement, from: RestingBox, to: RestingBox): void {
  element.style.setProperty("--dialog-morph-from-width", `${from.width}px`);
  element.style.setProperty("--dialog-morph-from-height", `${from.height}px`);
  element.style.setProperty("--dialog-morph-to-width", `${to.width}px`);
  element.style.setProperty("--dialog-morph-to-height", `${to.height}px`);
}

/**
 * Hides a covered surface and its own backdrop without unmounting either.
 * The backdrop is the marked sibling rendered immediately before Radix content.
 */
function coverSurface(surface: DialogSurface, covered: boolean): void {
  surface.element.toggleAttribute("data-dialog-covered", covered);
  const backdrop = surface.element.previousElementSibling;
  if (backdrop instanceof HTMLElement && backdrop.hasAttribute("data-dialog-backdrop")) {
    backdrop.toggleAttribute("data-dialog-covered", covered);
    backdrop.toggleAttribute("data-dialog-handoff", !covered);
  }
}

/**
 * Copies only presentation for the departing content. The inert, aria-hidden
 * copy cannot receive input or duplicate accessible IDs and is removed when
 * the shell finishes or is retargeted. Live controls never move or remount.
 */
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

/**
 * Transfers visual ownership to the arriving live surface. Its opaque shell
 * morphs from the currently visible box, including interrupted transitions.
 * Only contents crossfade; fading two backgrounds would expose the page.
 */
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
  const animate = motionAllowed();
  const snapshot = animate ? snapshotContent(replaced.element, start) : null;
  arriving.element.querySelectorAll("[data-dialog-snapshot]").forEach((node) => node.remove());
  // A return to a still-mounted parent must start a fresh track.
  arriving.element.dataset.dialogMotion = "settled";
  void arriving.element.offsetWidth;
  writeMorphTrack(arriving.element, start, to);
  coverSurface(arriving, false);
  coverSurface(replaced, true);
  if (replaced.element.dataset.state === "closed") {
    replaced.element.dataset.dialogMotion = "morph-out";
  }
  if (snapshot === null) {
    arriving.visible = to;
    return;
  }
  arriving.element.appendChild(snapshot);
  arriving.element.dataset.dialogMotion = "morph-in";
  arriving.visible = start;
}

/**
 * Registers a centered dialog's content element and keeps its handoff state
 * current, returning the ref callback to put on that element. `forwardedRef`
 * still receives the node for callers that need it.
 *
 * The box is tracked as state rather than a ref because Radix portals the
 * content in a follow-up layout render, after this component's first commit.
 * Both handoff decisions then still land before the browser paints the dialog:
 * the arriving box reads the surface it replaces in the layout effect that
 * receives its node, and a box leaving for one still open behind it reads that
 * successor from a `MutationObserver` on `data-state`, since Radix commits that
 * attribute in the very commit that starts the exit animation.
 *
 * Animation completion removes only the inert content copy. The motion marker
 * stays until the next state change, so finishing never restarts the pop-in.
 *
 * @param forwardedRef - The caller's ref for the content element, published
 *   through React once the box mounts.
 * @returns A ref callback that feeds the morph observer.
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
    // ResizeObserver records the last rendered size, not the natural size that
    // Radix's closed state restores before its mutation observer can run.
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (element.dataset.state !== "open" || element.hasAttribute("data-dialog-covered"))
              return;
            const rect = element.getBoundingClientRect();
            surface.visible = {
              width: rect.width,
              height: rect.height,
              centerX: rect.left + rect.width / 2,
              centerY: rect.top + rect.height / 2,
            };
          });
    resize?.observe(element);
    const replaced = neighbourSurface(surface, () => true);
    if (own !== null && replaced !== undefined) {
      const from = restingBox(replaced);
      if (from !== null && sharesCenter(from, own)) {
        morphHandoff(surface, replaced, from, own);
      }
    }

    // Nothing claims a box on its way out, so watch for the successor here:
    // cancelling a confirmation puts the box back into the dialog behind it
    // rather than dropping it to the bottom edge.
    const observer = new MutationObserver(() => {
      // Radix can reopen the same node before its retained exit unmounts.
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
      queueMicrotask(() => {
        const index = surfaces.indexOf(surface);
        if (index >= 0) surfaces.splice(index, 1);
      });
    };
  }, [element]);

  return React.useCallback((node: T | null) => setElement(node), []);
}
