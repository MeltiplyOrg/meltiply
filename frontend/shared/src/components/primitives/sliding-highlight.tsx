import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LazyMotion, domAnimation, m } from "motion/react";
import { cn } from "@meltiply/ui/utils";
import { useReducedMotionPreference } from "./use-reduced-motion";

const ACTIVE_ATTRIBUTES = [
  "data-highlighted",
  "data-state",
  "aria-pressed",
  "aria-checked",
  "data-selected",
];

const useMeasureEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface ItemBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Travel {
  x: number;
  y: number;
  scaleX: number;
}

const SETTLED: Travel = { x: 0, y: 0, scaleX: 1 };

const BOX_EPSILON = 0.01;

function isSameBox(a: ItemBox, b: ItemBox): boolean {
  return (
    Math.abs(a.top - b.top) < BOX_EPSILON &&
    Math.abs(a.left - b.left) < BOX_EPSILON &&
    Math.abs(a.width - b.width) < BOX_EPSILON &&
    Math.abs(a.height - b.height) < BOX_EPSILON
  );
}

const TRAVEL_SPRING = { type: "spring", stiffness: 450, damping: 32, mass: 0.8 } as const;

const NO_TRAVEL = { duration: 0 } as const;

export interface SlidingHighlightProps {
  containerRef: React.RefObject<HTMLElement | null>;
  itemSelector?: string;
  activeSelector?: string;
  axis?: "x" | "y";
  deferUntilInteraction?: boolean;
  className?: string;
}

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
  const mountedRef = useRef(true);
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

  const resolveContainer = useCallback(
    (): HTMLElement | null => containerRef.current ?? highlightRef.current?.parentElement ?? null,
    [containerRef],
  );

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
        commitGeometry(nextBox, { x: 0, y: nextBox.top, scaleX: 1 }, true);
        pendingRef.current = null;
        return;
      }

      pendingRef.current = nextBox;
      commitGeometry(
        anchor,
        { x: nextBox.left - anchor.left, y: 0, scaleX: nextBox.width / anchor.width },
        true,
      );
    },
    [axis, commitGeometry, resolveContainer],
  );

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
    mountedRef.current = true;
    const container = resolveContainer();
    if (!container) return;

    const activeItem = () => container.querySelector<HTMLElement>(activeSelector);
    const syncActive = () => {
      const item = activeItem();
      if (item) commit(item, item !== activeItemRef.current);
    };
    const remeasure = () => {
      const item = activeItemRef.current;
      if (item) commit(item, false);
    };

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

    if (typeof ResizeObserver !== "undefined" && resizeObserverRef.current === null) {
      resizeObserverRef.current = new ResizeObserver(remeasure);
    }
    resizeObserverRef.current?.observe(container);

    container.addEventListener("scroll", remeasure, { passive: true });
    window.addEventListener("resize", remeasure);
    document.fonts?.ready.then(
      () => {
        if (mountedRef.current) remeasure();
      },
      () => {},
    );

    if (deferUntilInteraction) {
      container.addEventListener("pointermove", handlePointerMove);
      container.addEventListener("pointerleave", handlePointerLeave);
      document.addEventListener("keydown", handleKeyDown);
    } else {
      syncActive();
    }

    return () => {
      mountedRef.current = false;
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
