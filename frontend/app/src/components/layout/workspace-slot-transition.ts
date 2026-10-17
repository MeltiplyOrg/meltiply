import { motionAllowed } from "@meltiply/ui/motion-state";
import { effectEasing, playEffect, watchMotionSuppression } from "@meltiply/ui/effects";

const SLOT_SELECTOR = "[data-workspace-transition-slot]";
const TRANSITION_LAYER_ATTRIBUTE = "data-workspace-slot-transition-layer";
const STANDARD_DURATION_MS = 220;
const DESTINATION_WAIT_MS = 1000;

interface SlotSnapshot {
  element: HTMLElement;
  collapsed: boolean;
  rect: DOMRect;
  currentRect: DOMRect;
  opacity: number;
  clone: HTMLElement;
}

let activeTransition: { cleanup: () => void; snapshots: Map<string, SlotSnapshot> } | undefined;

/**
 * Captures visible slot geometry and inert visual copies before hiding controls.
 * Collapsed slots retain their rectangle as a left-edge entry/exit anchor.
 * Zero-sized or CSS-hidden slots cannot supply a visible handoff and are skipped.
 */
function captureSlots(root: HTMLElement): Map<string, SlotSnapshot> {
  const snapshots = new Map<string, SlotSnapshot>();
  for (const element of root.querySelectorAll<HTMLElement>(SLOT_SELECTOR)) {
    const id = element.dataset.workspaceTransitionSlot;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!id || !rect.width || !rect.height || style.display === "none") continue;
    const clone = element.cloneNode(true) as HTMLElement;
    clone.removeAttribute("id");
    clone.removeAttribute("data-workspace-transition-slot");
    clone.removeAttribute("data-workspace-transition-collapsed");
    clone.removeAttribute("data-workspace-slot-hidden");
    clone.setAttribute("aria-hidden", "true");
    clone.setAttribute("inert", "");
    // Motion owns live inline transforms/opacity. A snapshot must not inherit them.
    clone.style.cssText += `;position:fixed!important;left:${rect.left}px!important;top:${rect.top}px!important;width:${rect.width}px!important;height:${rect.height}px!important;margin:0!important;pointer-events:none!important;transform-origin:top left!important;visibility:visible!important;transform:none;opacity:1;`;
    snapshots.set(id, {
      element,
      collapsed: element.dataset.workspaceTransitionCollapsed === "true",
      rect,
      currentRect: rect,
      opacity: 1,
      clone,
    });
  }
  return snapshots;
}

/**
 * Owns route-toolbar paint from the navigation event through destination commit.
 * Sources are hidden in the same task that installs their snapshots. Destinations
 * are hidden before paint by a mutation observer; only inert snapshots animate.
 * A CSS-owned marker survives Motion's inline visibility/opacity rewrites.
 * Each id has exactly one snapshot, anchored top-left in both directions. Cleanup
 * atomically restores visibility on completion, cancellation or timeout. A new
 * navigation takes over the painted rectangles/opacity before cancelling the
 * previous animations, so rapid reversal does not snap to resting geometry.
 *
 * The shared root/OS motion policy short-circuits the whole handoff:
 * starting while suppressed paints the destination directly, and suppression arriving
 * mid-flight lets the shared watcher cancel the active handoff — animations
 * cancelled, inert snapshots dropped, hidden live slots restored before the
 * next paint.
 */
export function startWorkspaceSlotTransition(root: HTMLElement | null): void {
  const previous = activeTransition;
  if (!motionAllowed()) {
    previous?.cleanup();
    return;
  }
  const sources = root ? captureSlots(root) : new Map<string, SlotSnapshot>();
  const interruptedStyles: Array<{ clone: HTMLElement; transform: string; opacity: string }> = [];
  if (root && previous) {
    for (const [id, snapshot] of previous.snapshots) {
      const style = getComputedStyle(snapshot.clone);
      sources.set(id, {
        ...snapshot,
        element: sources.get(id)?.element ?? snapshot.element,
        currentRect: snapshot.clone.getBoundingClientRect(),
        opacity: Number(style.opacity),
        collapsed: false,
      });
      interruptedStyles.push({
        clone: snapshot.clone,
        transform: style.transform,
        opacity: style.opacity,
      });
    }
  }
  previous?.cleanup();
  for (const { clone, transform, opacity } of interruptedStyles) {
    clone.style.transform = transform;
    clone.style.opacity = opacity;
  }
  if (!root) return;
  if (!sources.size) return;

  const layer = document.createElement("div");
  layer.setAttribute(TRANSITION_LAYER_ATTRIBUTE, "");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = "position:fixed;inset:0;z-index:60;pointer-events:none;overflow:hidden;";
  const hidden = new Set<HTMLElement>();
  const animations: Animation[] = [];
  const snapshots = new Map<string, SlotSnapshot>();
  let settled = false;
  let committed = false;
  let timeout = 0;

  /** Keeps offscreen filter snapshots inside the toolbar's horizontal scroll viewport. */
  const clipToToolbar = (): void => {
    const rect = root.querySelector("[data-workspace-toolbar]")?.getBoundingClientRect();
    layer.style.clipPath = rect
      ? `inset(${Math.max(0, rect.top)}px ${Math.max(0, window.innerWidth - rect.right)}px ${Math.max(0, window.innerHeight - rect.bottom)}px ${Math.max(0, rect.left)}px)`
      : "none";
  };

  /** Uses a CSS marker, not Motion-owned inline styles, to keep live copies out of paint. */
  const hide = (element: HTMLElement): void => {
    hidden.add(element);
    element.setAttribute("data-workspace-slot-hidden", "");
  };

  /** Removes host-owned markers and observers, leaving live animation styles untouched. */
  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    stopMotionWatch();
    window.clearTimeout(timeout);
    for (const element of hidden) element.removeAttribute("data-workspace-slot-hidden");
    for (const animation of animations) animation.cancel();
    layer.remove();
    if (activeTransition?.cleanup === cleanup) activeTransition = undefined;
  };

  /**
   * Projects one snapshot between viewport rectangles. Entries become visible
   * while growing from the left; exits fade late. Interrupted opacity is retained.
   * Only reachable with motion enabled — suppression returns before the layer exists.
   */
  const project = (
    id: string,
    snapshot: SlotSnapshot,
    from: DOMRect,
    to: DOMRect,
    fromOpacity: number,
    exiting: boolean,
  ): void => {
    const { clone, rect } = snapshot;
    const transform = (bounds: DOMRect): string =>
      `translate3d(${bounds.left - rect.left}px, ${bounds.top - rect.top}px, 0) scale(${bounds.width / rect.width}, ${bounds.height / rect.height})`;
    layer.append(clone);
    snapshots.set(id, snapshot);
    const frames: Keyframe[] = [{ opacity: fromOpacity, transform: transform(from) }];
    if (exiting) frames.push({ opacity: fromOpacity, offset: 0.72, transform: transform(to) });
    frames.push({ opacity: exiting ? 0 : 1, transform: transform(to) });
    const animation = playEffect(clone, frames, 0, {
      duration: STANDARD_DURATION_MS,
      easing: effectEasing,
      fill: "both",
    });
    if (animation) animations.push(animation);
  };

  /**
   * Waits for replacement elements, not an arbitrary animation frame. Once the
   * destination toolbar commits, replace held source copies with one snapshot
   * per matched/entering/exiting id. Never animate live React-owned elements.
   * Suppression already active when the observer runs cancels instead of
   * committing, so no effect starts only to be cancelled a microtask later.
   */
  const commit = (): void => {
    if (settled || committed) return;
    // Suppression set in the same task wins over a pending commit: restore live
    // slots instead of starting effects the shared watcher would cancel.
    if (!motionAllowed()) {
      cleanup();
      return;
    }
    const elements = root.querySelectorAll<HTMLElement>(SLOT_SELECTOR);
    if (
      ![...elements].some((element) => {
        const id = element.dataset.workspaceTransitionSlot;
        return id && sources.get(id)?.element !== element;
      })
    )
      return;
    committed = true;
    observer.disconnect();
    window.clearTimeout(timeout);
    clipToToolbar();
    const destinations = captureSlots(root);
    for (const destination of destinations.values()) hide(destination.element);
    layer.replaceChildren();
    snapshots.clear();

    for (const [id, source] of sources) {
      const destination = destinations.get(id);
      destinations.delete(id);
      if (destination && !destination.collapsed) {
        project(
          id,
          destination,
          source.currentRect,
          destination.rect,
          source.collapsed ? 0 : source.opacity,
          false,
        );
      } else if (!source.collapsed) {
        const to =
          destination?.rect ??
          new DOMRect(
            source.rect.left - 12,
            source.rect.top,
            source.rect.width,
            source.rect.height,
          );
        project(id, source, source.currentRect, to, source.opacity, true);
      }
    }
    for (const [id, destination] of destinations) {
      if (destination.collapsed) continue;
      const { rect } = destination;
      project(
        id,
        destination,
        new DOMRect(rect.left - 12, rect.top, rect.width, rect.height),
        rect,
        0,
        false,
      );
    }
    void Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))).then(
      cleanup,
    );
  };

  const observer = new MutationObserver(commit);
  /**
   * Cancels the handoff when effective motion is suppressed mid-flight — the
   * manual/OS `data-low-motion` marker, an unmatched OS flip, or an ink
   * capture. Marker removal is ignored; the transition only needs cancelling
   * on the transition into suppression.
   */
  const stopMotionWatch = watchMotionSuppression(cleanup);
  activeTransition = { cleanup, snapshots };
  for (const [id, source] of sources) {
    if (!source.collapsed) {
      layer.append(source.clone);
      snapshots.set(id, source);
    }
    hide(source.element);
  }
  clipToToolbar();
  document.body.append(layer);
  observer.observe(root, { childList: true, subtree: true });
  timeout = window.setTimeout(cleanup, DESTINATION_WAIT_MS);
}
