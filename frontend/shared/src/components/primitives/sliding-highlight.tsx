import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LazyMotion, domAnimation, m } from "motion/react";
import { cn } from "@meltiply/ui/utils";
import { useReducedMotionPreference } from "./use-reduced-motion";

/**
 * Attributes that name the active item. Every consumer family writes one of
 * them: Radix menus mark the hovered row `data-highlighted`, Radix tabs mark the
 * selected trigger `data-state="active"`, the segmented atom marks its checked
 * choice `aria-checked`, and page-composed strips may mark `data-selected`.
 */
const ACTIVE_ATTRIBUTES = [
  "data-highlighted",
  "data-state",
  "aria-pressed",
  "aria-checked",
  "data-selected",
];

/**
 * Measuring must land before the first paint: the highlight *is* the selected
 * fill, so a post-paint measure would flash an unselected control. Astro renders
 * the same shared library on the server, where a layout effect is unavailable.
 */
const useMeasureEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Box the active item occupies, in its container's coordinate space. */
interface ItemBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * What still separates the highlight from its committed box. The committed box is
 * the truth at rest and travel always animates to `SETTLED`, so a resize, a
 * scroll, or a settled selection leaves no residual scale or offset behind.
 */
interface Travel {
  x: number;
  y: number;
  scaleX: number;
}

const SETTLED: Travel = { x: 0, y: 0, scaleX: 1 };

/** Sub-pixel tolerance for "the item has not moved": below it a re-measure is noise. */
const BOX_EPSILON = 0.01;

/** Whether two measured boxes are the same box, within sub-pixel noise. */
function isSameBox(a: ItemBox, b: ItemBox): boolean {
  return (
    Math.abs(a.top - b.top) < BOX_EPSILON &&
    Math.abs(a.left - b.left) < BOX_EPSILON &&
    Math.abs(a.width - b.width) < BOX_EPSILON &&
    Math.abs(a.height - b.height) < BOX_EPSILON
  );
}

/** The reference spring for every travelling highlight. */
const TRAVEL_SPRING = { type: "spring", stiffness: 450, damping: 32, mass: 0.8 } as const;

/** Moves that are corrections, not transitions: first appearance, resize, scroll. */
const NO_TRAVEL = { duration: 0 } as const;

export interface SlidingHighlightProps {
  /**
   * Container whose items are tracked, and the coordinate space the highlight is
   * placed in. It must be the items' offset parent (`relative`), and this
   * component renders directly inside it.
   */
  containerRef: React.RefObject<HTMLElement | null>;
  /** CSS selector identifying the items the highlight can move between. @defaultValue `"[data-dropdown-item]"` */
  itemSelector?: string;
  /** CSS selector identifying the active item. @defaultValue `"[data-highlighted]"` */
  activeSelector?: string;
  /**
   * Axis the highlight travels along.
   *
   * - `"y"` — uniform, full-width rows (menus, vertical strips). The box snaps and
   *   the absolute position animates, which is only visible on a resize or a row
   *   whose height differs, where snapping is the correct reading.
   * - `"x"` — a row of items with different widths (segmented controls, tab
   *   strips). The committed box stays where the last travel settled and the
   *   transform carries the delta — translate plus `scaleX` from the left edge —
   *   so width and position move together, and the spring's completion commits the
   *   arrival so the fill is crisp and un-stretched at rest. The consumer styles
   *   the vertical box (`inset-y-*` for a fill, `bottom-* h-*` for an underline).
   *
   * @defaultValue `"y"`
   */
  axis?: "x" | "y";
  /**
   * Ignore the active selector until the user interacts inside the container, and
   * track the pointer between items. Radix menus highlight a row the moment they
   * open, which must not paint the pill; tab strips and segmented controls hold a
   * real selection from the first paint and only need the attribute watch.
   *
   * @defaultValue `false`
   */
  deferUntilInteraction?: boolean;
  /** Styling overrides merged over the default menu pill (fill, border, radius, elevation). */
  className?: string;
}

/**
 * One highlight that travels to the active item, shared by menus, tab strips, and
 * segmented controls so a selected state never paints twice or moves differently.
 *
 * Only transforms animate, so travel stays off the layout path, and a selection
 * that lands mid-flight retargets the running spring instead of jumping. Items
 * must paint above the highlight (`relative z-10`). When the operating system
 * asks for reduced motion — including a change made while the page is open —
 * travel commits instantly while the opacity fade still marks appearance and
 * disappearance, so selection keeps working without a spring.
 *
 * @param props - Tracked container, item/active selectors, travel axis, and styling.
 * @returns An absolutely positioned motion element rendered behind the items.
 */
export function SlidingHighlight({
  containerRef,
  itemSelector = "[data-dropdown-item]",
  activeSelector = "[data-highlighted]",
  axis = "y",
  deferUntilInteraction = false,
  className,
}: SlidingHighlightProps) {
  const prefersReducedMotion = useReducedMotionPreference();
  const travelTransition = prefersReducedMotion ? NO_TRAVEL : TRAVEL_SPRING;
  const [box, setBox] = useState<ItemBox | null>(null);
  const [travel, setTravel] = useState<Travel>(SETTLED);
  const [isTravelling, setIsTravelling] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const activeItemRef = useRef<HTMLElement | null>(null);
  const anchorRef = useRef<ItemBox | null>(null);
  const targetRef = useRef<ItemBox | null>(null);
  const pendingRef = useRef<ItemBox | null>(null);
  const travelRef = useRef<Travel>(SETTLED);
  const isVisibleRef = useRef(false);
  const hasInteractedRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  /**
   * The container to measure against. On mount the highlight's own layout effect
   * runs before its container's ref is attached (children commit first), so the
   * direct parent — where every consumer renders this component — is the fallback
   * that keeps the first measure before the first paint.
   */
  const resolveContainer = useCallback(
    (): HTMLElement | null => containerRef.current ?? highlightRef.current?.parentElement ?? null,
    [containerRef],
  );

  /** Commits the geometry the element sits at, and the offset the spring travels from it. */
  const commitGeometry = useCallback(
    (nextBox: ItemBox | null, nextTravel: Travel, travelling: boolean) => {
      anchorRef.current = nextBox;
      travelRef.current = nextTravel;
      setBox(nextBox);
      setTravel(nextTravel);
      setIsTravelling(travelling);
    },
    [],
  );

  const commit = useCallback(
    (item: HTMLElement | null, moves: boolean) => {
      const container = resolveContainer();
      if (!container || !item || !container.contains(item)) {
        activeItemRef.current = null;
        targetRef.current = null;
        pendingRef.current = null;
        isVisibleRef.current = false;
        commitGeometry(null, SETTLED, false);
        setIsVisible(false);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const nextBox: ItemBox = {
        top: itemRect.top - containerRect.top + container.scrollTop,
        left: itemRect.left - containerRect.left + container.scrollLeft,
        width: itemRect.width,
        height: itemRect.height,
      };

      // A correction that measures the box the highlight already targets is noise —
      // the ResizeObserver announces every newly observed item — and reacting to it
      // would cancel a running travel.
      if (!moves && targetRef.current && isSameBox(targetRef.current, nextBox)) return;

      const anchor = anchorRef.current;
      const travelling = moves && anchor !== null && anchor.width > BOX_EPSILON;
      targetRef.current = nextBox;
      activeItemRef.current = item;
      isVisibleRef.current = true;
      resizeObserverRef.current?.observe(item);
      setIsVisible(true);

      if (!travelling || !anchor) {
        commitGeometry(
          nextBox,
          axis === "y" ? { x: 0, y: nextBox.top, scaleX: 1 } : SETTLED,
          false,
        );
        pendingRef.current = null;
        return;
      }

      if (axis === "y") {
        // Row heights and widths come from the container, so the box snaps and the
        // absolute position carries the move: the spring animates y directly.
        commitGeometry(nextBox, { x: 0, y: nextBox.top, scaleX: 1 }, true);
        pendingRef.current = null;
        return;
      }

      // Variable widths: keep the committed box where the spring started and hand
      // the arrival to the transform, so position and width move as one.
      pendingRef.current = nextBox;
      commitGeometry(
        anchor,
        { x: nextBox.left - anchor.left, y: 0, scaleX: nextBox.width / anchor.width },
        true,
      );
    },
    [axis, commitGeometry, resolveContainer],
  );

  /**
   * Commits the arrival once the horizontal spring settles, so no stretched scale
   * survives at rest. A completion that belongs to a superseded travel is ignored.
   */
  const handleTravelComplete = useCallback(() => {
    const pending = pendingRef.current;
    const anchor = anchorRef.current;
    if (axis !== "x" || !pending || !anchor) return;
    if (Math.abs(travelRef.current.x - (pending.left - anchor.left)) > BOX_EPSILON) return;
    if (Math.abs(travelRef.current.scaleX - pending.width / anchor.width) > BOX_EPSILON) return;
    pendingRef.current = null;
    commitGeometry(pending, SETTLED, false);
  }, [axis, commitGeometry]);

  useMeasureEffect(() => {
    const container = resolveContainer();
    if (!container) return;

    const activeItem = () => container.querySelector<HTMLElement>(activeSelector);
    /** Follow the active attribute; whether that is a move or a correction is decided by identity. */
    const syncActive = () => {
      const item = activeItem();
      if (item) commit(item, item !== activeItemRef.current);
    };
    /** Re-place the highlight on the item it already tracks, without motion. */
    const remeasure = () => {
      const item = activeItemRef.current;
      if (item) commit(item, false);
    };

    // Radix moves focus into the menu content (a popper sibling of the tracked
    // viewport), so keydown is observed at document level and scoped back to this
    // menu's popper wrapper — or the content parent when no wrapper exists.
    const interactionRoot =
      container.closest<HTMLElement>("[data-radix-popper-content-wrapper]") ??
      container.parentElement ??
      container;
    const handlePointerMove = (event: PointerEvent) => {
      hasInteractedRef.current = true;
      const item =
        document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>(itemSelector) ?? null;
      if (!item || !container.contains(item) || item === activeItemRef.current) return;
      commit(item, true);
    };
    const handlePointerLeave = () => {
      hasInteractedRef.current = false;
      commit(null, false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Node && interactionRoot.contains(event.target)) {
        hasInteractedRef.current = true;
      }
    };

    // One observer covers every family: attribute changes name the new active item,
    // and content changes in the tracked container (a count badge, a reordered
    // strip) shift the committed box under an unchanged selection. The attribute
    // filter also keeps the highlight's own per-frame style writes from re-entering.
    const observer = new MutationObserver(() => {
      if (deferUntilInteraction && !hasInteractedRef.current) return;
      syncActive();
    });
    observer.observe(container, {
      attributes: true,
      attributeFilter: ACTIVE_ATTRIBUTES,
      childList: true,
      characterData: true,
      subtree: true,
    });

    // Items can resize without any mutation of the container (a swapped font, a
    // shorter label) and a horizontally scrolling strip moves the box under the
    // highlight, so both re-measure as corrections rather than travels.
    if (typeof ResizeObserver !== "undefined" && resizeObserverRef.current === null) {
      resizeObserverRef.current = new ResizeObserver(remeasure);
    }
    resizeObserverRef.current?.observe(container);

    container.addEventListener("scroll", remeasure, { passive: true });
    window.addEventListener("resize", remeasure);
    document.fonts?.ready.then(remeasure, () => {});

    if (deferUntilInteraction) {
      container.addEventListener("pointermove", handlePointerMove);
      container.addEventListener("pointerleave", handlePointerLeave);
      document.addEventListener("keydown", handleKeyDown);
    } else {
      syncActive();
    }

    return () => {
      observer.disconnect();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      container.removeEventListener("scroll", remeasure);
      window.removeEventListener("resize", remeasure);
      container.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("pointerleave", handlePointerLeave);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeSelector, commit, containerRef, deferUntilInteraction, itemSelector, resolveContainer]);

  return (
    <LazyMotion features={domAnimation} strict>
      <m.div
        ref={highlightRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute z-0 rounded-control border border-line-soft bg-hover shadow-xs",
          axis === "x" && "origin-left",
          className,
        )}
        style={
          axis === "y"
            ? {
                top: 0,
                left: box?.left ?? 0,
                width: box?.width ?? 0,
                height: box?.height ?? 0,
              }
            : { left: box?.left ?? 0, width: box?.width ?? 0 }
        }
        initial={false}
        animate={{
          x: travel.x,
          y: travel.y,
          scaleX: travel.scaleX,
          opacity: isVisible && box ? 1 : 0,
        }}
        transition={{
          x: isTravelling ? travelTransition : NO_TRAVEL,
          y: isTravelling ? travelTransition : NO_TRAVEL,
          scaleX: isTravelling ? travelTransition : NO_TRAVEL,
          opacity: { duration: 0.14, ease: "easeOut" },
        }}
        onAnimationComplete={handleTravelComplete}
      />
    </LazyMotion>
  );
}
