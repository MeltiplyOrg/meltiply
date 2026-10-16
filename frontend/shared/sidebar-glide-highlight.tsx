import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  animate,
  domAnimation,
  LazyMotion,
  m,
  useMotionValue,
  type MotionValue,
} from "motion/react";
import { useMotionPreference } from "./motion-preference";

/** Avoids React's server-render warning; commit-time FLIP needs a layout effect on the client. */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * One measured highlight target in content coordinates: the row's box offset
 * from the container's content origin — `rect` minus container rect, plus the
 * active scroller's scroll offsets. Content space keeps the measurement
 * invariant while scrolling (the row and its scroll origin move together), so
 * scroll resyncs measure the same numbers and never retarget the springs.
 */
interface GlideRect {
  top: number;
  left: number;
  width: number;
  height: number;
  /** Resolved `borderRadius` (falls back to the shared 7px row radius). */
  borderRadius: string;
}

/** Insets of the nested scroll viewport's visible region inside the container; clips the overlay. */
interface ClipInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Configuration for `SidebarGlideHighlight`. The app passes only its scrolling
 * `<nav>` via `containerRef`; the docs adapter additionally resolves its
 * enclosing `aside` as container plus the nested Radix ScrollArea viewport.
 */
export interface SidebarGlideHighlightProps {
  /**
   * Element that establishes the positioning containing block rows are measured
   * against. When it scrolls itself (the app `<nav>`), the rendered pill rides
   * the scroll content and the container's own overflow clips it. When it does
   * not (the docs `aside`), pass `viewportSelector` so the overlay can clip to
   * and follow the nested scroller's visible region.
   */
  containerRef: RefObject<HTMLElement | null>;
  /** CSS selector identifying navigable item elements within the container. Defaults to `[data-sidebar-item]`. */
  itemSelector?: string;
  /** Optional additional CSS classes applied to the visible pill element. */
  className?: string;
  /** Maximum pixel distance from cursor to candidate item edge for snapping to activate. Defaults to 52px. */
  snapThreshold?: number;
  /**
   * Selector for a nested scroll viewport inside the container (the docs Radix
   * ScrollArea). When set, the pill renders inside a non-scrolling overlay
   * clipped to the viewport's visible rect — the travelling spring can never
   * paint over the sidebar header or footer — while an inner layer counter-
   * translates by the scroller's `scrollTop/scrollLeft` to keep the pill glued
   * to its row. Omit when `containerRef` is itself the scroller.
   */
  viewportSelector?: string;
}

/** Shared glide spring — the app's sidebar motion language (stiffness 380, damping 28, mass 0.7). */
const SPRING = {
  type: "spring" as const,
  stiffness: 380,
  damping: 28,
  mass: 0.7,
};
/** Short opacity fade for entry/exit; independent of the position spring. */
const FADE = { duration: 0.2, ease: "easeOut" as const };
/**
 * Attributes that can change the highlighted row or its geometry without a
 * childList mutation. `style` is deliberately absent: the pill's own motion
 * writes would retrigger the observer every frame.
 */
const OBSERVED_ATTRIBUTES = ["data-active", "aria-current", "aria-selected", "class", "hidden"];

/**
 * Drives one motion value through a velocity-preserving spring: retargeting
 * mid-flight seeds the animation with the captured velocity, so rapid pointer
 * hops chain momentum instead of restarting at rest. `lowMotion` `jump()`s the
 * value to its destination synchronously, which also cancels any in-flight
 * animation — the preference's snap behaviour.
 */
function springTo(mv: MotionValue<number>, to: number, velocity: number, lowMotion: boolean): void {
  if (lowMotion) {
    mv.jump(to);
    return;
  }
  animate(mv, to, { ...SPRING, velocity });
}

/**
 * Tracks pointer hover and row geometry independently of painting. Returns
 * changed content-space boxes and viewport clips; scroll offsets update stable
 * motion values directly, without a render. Selection keeps its own row paint.
 * The bind effect owns every observer/listener and releases them on rebinding.
 */
function useGlideTracking({
  containerRef,
  itemSelector = "[data-sidebar-item]",
  snapThreshold = 52,
  viewportSelector,
}: SidebarGlideHighlightProps): {
  target: GlideRect | null;
  clip: ClipInsets | null;
  scrollOffsetX: MotionValue<number>;
  scrollOffsetY: MotionValue<number>;
} {
  const [target, setTarget] = useState<GlideRect | null>(null);
  const [clip, setClip] = useState<ClipInsets | null>(null);
  const scrollOffsetX = useMotionValue(0);
  const scrollOffsetY = useMotionValue(0);
  // Mirrors containerRef.current in state: refs attach after mount, and the
  // docs adapter resolves its `aside` a commit later — keeping the element in
  // state makes the bind effect re-run deterministically when it appears.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const hoverRef = useRef<HTMLElement | null>(null);
  const measuredRef = useRef<GlideRect | null>(null);
  const clipRef = useRef<ClipInsets | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  /**
   * Recomputes the overlay clip insets: the nested viewport's visible box
   * projected into container coordinates. Identical results skip the state
   * write so scroll bursts never re-render.
   */
  const measureClip = useCallback((): void => {
    if (!viewportSelector) return;
    const viewport = viewportRef.current;
    if (!container || !viewport) return;
    const c = container.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    const next: ClipInsets = {
      top: v.top - c.top,
      right: c.right - v.right,
      bottom: c.bottom - v.bottom,
      left: v.left - c.left,
    };
    const prev = clipRef.current;
    if (
      prev &&
      prev.top === next.top &&
      prev.right === next.right &&
      prev.bottom === next.bottom &&
      prev.left === next.left
    ) {
      return;
    }
    clipRef.current = next;
    setClip(next);
  }, [container, viewportSelector, setClip]);

  /**
   * Mirrors the container ref into state on mount. Refs attach after the first
   * render, and adapters that discover their container (the docs banner probe)
   * write it a commit later — the mirror re-runs the bind effect in both cases
   * without reading the ref during render.
   */
  useEffect(() => {
    setContainer(containerRef.current);
  }, [containerRef]);

  /**
   * Measures `element` against the container's content origin. The scroll
   * offset of the *actual scroller* (the nested viewport when present, else
   * the container) is added — that's the piece that glues the pill to the row
   * instead of letting it double-scroll, and what lets the overlay layer
   * counter-translate the pill back into view.
   */
  const measure = useCallback(
    (element: HTMLElement): GlideRect | null => {
      if (!container) return null;
      const scroller = viewportRef.current ?? container;
      const c = container.getBoundingClientRect();
      const r = element.getBoundingClientRect();
      return {
        top: r.top - c.top + scroller.scrollTop,
        left: r.left - c.left + scroller.scrollLeft,
        width: r.width,
        height: r.height,
        borderRadius: window.getComputedStyle(element).borderRadius || "7px",
      };
    },
    [container],
  );

  /**
   * Measures the live hovered row and commits changed geometry. A row removed
   * by navigation or a drawer remount clears the hover target; unchanged boxes
   * skip state writes so observer noise and scrolling never restart springs.
   */
  const resync = useCallback((): void => {
    if (!container) return;
    if (hoverRef.current && !hoverRef.current.isConnected) {
      hoverRef.current = null;
    }
    const element = hoverRef.current;
    const next = element?.isConnected ? measure(element) : null;
    const prev = measuredRef.current;
    if (
      prev === next ||
      (prev !== null &&
        next !== null &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.height === next.height &&
        prev.borderRadius === next.borderRadius)
    ) {
      measureClip();
      return;
    }
    measuredRef.current = next;
    setTarget(next);
    measureClip();
  }, [container, measure, measureClip, setTarget]);
  /**
   * Binds interaction and geometry listeners to the resolved container.
   * Pointer hit-tests short-circuit on the same row before any geometry read;
   * scroll (capture covers nested scrollers) refreshes the counter-translate
   * motion values and re-measures; resize and mutation only re-measure.
   */
  useEffect(() => {
    if (!container) return;
    const viewport = viewportSelector
      ? (container.querySelector<HTMLElement>(viewportSelector) ?? null)
      : null;
    viewportRef.current = viewport;
    const scroller = viewport ?? container;

    const nearest = (clientX: number, clientY: number): HTMLElement | null => {
      let closest: HTMLElement | null = null;
      let minDistance = Infinity;
      for (const item of container.querySelectorAll<HTMLElement>(itemSelector)) {
        const r = item.getBoundingClientRect();
        // Exclude hidden elements (e.g. display: none in collapsed mode).
        if (r.height <= 0 && item.offsetParent === null) continue;
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
          return item;
        }
        const dx = Math.max(r.left - clientX, 0, clientX - r.right);
        const dy = Math.max(r.top - clientY, 0, clientY - r.bottom);
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < minDistance) {
          minDistance = distance;
          closest = item;
        }
      }
      return minDistance <= snapThreshold ? closest : null;
    };

    const onPointerMove = (e: PointerEvent) => {
      const direct =
        e.target instanceof Element ? e.target.closest<HTMLElement>(itemSelector) : null;
      // Same-row fast path: a live hit on the current row never re-measures.
      if (direct) {
        if (direct === hoverRef.current) return;
        hoverRef.current = direct;
        resync();
        return;
      }
      const row = nearest(e.clientX, e.clientY);
      if (row) {
        if (row === hoverRef.current) return;
        hoverRef.current = row;
        resync();
      } else if (hoverRef.current) {
        hoverRef.current = null;
        resync();
      }
    };

    const onPointerLeave = () => {
      if (hoverRef.current) {
        hoverRef.current = null;
        resync();
      }
    };

    /**
     * Scroll resync: refreshes the overlay's counter-translation (instant,
     * spring-free) and re-measures — the content-coordinate target normally
     * stays identical, so the springs don't chase the scroll.
     */
    const syncScroll = () => {
      scrollOffsetX.set(-scroller.scrollLeft);
      scrollOffsetY.set(-scroller.scrollTop);
      resync();
    };

    const observer = new MutationObserver(resync);
    const resizeObserver = new ResizeObserver(resync);
    const pointerTarget = viewport ?? container;
    pointerTarget.addEventListener("pointermove", onPointerMove);
    pointerTarget.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("scroll", syncScroll, {
      capture: true,
      passive: true,
    });
    observer.observe(viewport ?? container, {
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
      childList: true,
      subtree: true,
    });
    resizeObserver.observe(container);
    if (viewport) {
      resizeObserver.observe(viewport);
      // Row reflow (wrapped titles, late fonts) resizes the scroll content without resizing the viewport.
      if (viewport.firstElementChild instanceof HTMLElement) {
        resizeObserver.observe(viewport.firstElementChild);
      }
    }
    syncScroll();

    return () => {
      pointerTarget.removeEventListener("pointermove", onPointerMove);
      pointerTarget.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("scroll", syncScroll, { capture: true });
      observer.disconnect();
      resizeObserver.disconnect();
      viewportRef.current = null;
      scrollOffsetX.set(0);
      scrollOffsetY.set(0);
    };
  }, [
    container,
    itemSelector,
    snapThreshold,
    viewportSelector,
    resync,
    scrollOffsetX,
    scrollOffsetY,
  ]);
  return { target, clip, scrollOffsetX, scrollOffsetY };
}

/**
 * Shared compositor-only, hover-only spring highlight with plain or nested-scroll
 * paint layers. Entry fades in at the hovered row; exit fades out in place.
 * Tracking drops unchanged geometry before state writes; this renderer owns
 * clipping and FLIP projection, preserving position and velocity on retargets.
 * Manual/OS low motion jumps to rest instead of interpolating.
 */
export function SidebarGlideHighlight(props: SidebarGlideHighlightProps) {
  const { className, viewportSelector } = props;
  const { lowMotion } = useMotionPreference();
  const { target, clip, scrollOffsetX, scrollOffsetY } = useGlideTracking(props);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scaleX = useMotionValue(1);
  const scaleY = useMotionValue(1);
  const opacity = useMotionValue(0);

  const committedRef = useRef<GlideRect | null>(null);

  /**
   * Commits the measured box and drives every motion value to rest at it.
   * Velocities are captured *before* the FLIP `set()`s so retargets preserve
   * momentum; scale velocities are re-expressed in the new unit box so visual
   * growth speed survives the projection. Low motion `jump()`s everything,
   * instantly settling the pill and cancelling in-flight movement.
   */
  useIsomorphicLayoutEffect(() => {
    const prev = committedRef.current;
    committedRef.current = target;
    if (!target) {
      if (lowMotion) {
        opacity.jump(0);
      } else {
        animate(opacity, 0, FADE);
      }
      return;
    }
    if (!prev) {
      // First paint or re-entry: park at the target, then fade in — no travel.
      x.jump(0);
      y.jump(0);
      scaleX.jump(1);
      scaleY.jump(1);
      if (lowMotion) {
        opacity.jump(1);
      } else {
        animate(opacity, 1, FADE);
      }
      return;
    }
    const velocityX = x.getVelocity();
    const velocityY = y.getVelocity();
    // Scale velocity in old units → new units keeps the visual growth rate.
    const velocitySX = target.width > 0 ? scaleX.getVelocity() * (prev.width / target.width) : 0;
    const velocitySY = target.height > 0 ? scaleY.getVelocity() * (prev.height / target.height) : 0;
    // FLIP: transform back to where the previous commit painted, then spring to rest.
    const visualLeft = prev.left + x.get();
    const visualTop = prev.top + y.get();
    const visualWidth = prev.width * scaleX.get();
    const visualHeight = prev.height * scaleY.get();
    x.set(visualLeft - target.left);
    y.set(visualTop - target.top);
    scaleX.set(target.width > 0 ? visualWidth / target.width : 1);
    scaleY.set(target.height > 0 ? visualHeight / target.height : 1);
    springTo(x, 0, velocityX, lowMotion);
    springTo(y, 0, velocityY, lowMotion);
    springTo(scaleX, 1, velocitySX, lowMotion);
    springTo(scaleY, 1, velocitySY, lowMotion);
    if (lowMotion) {
      opacity.jump(1);
    } else {
      animate(opacity, 1, FADE);
    }
  }, [target, lowMotion, x, y, scaleX, scaleY, opacity]);

  /**
   * Static paint and layer roles come from shared data hooks in
   * `motion.css` ([data-glide-highlight]/[data-glide-clip]/[data-glide-scroll]);
   * this element only feeds CSS custom properties — committed geometry once
   * per retarget, motion values per frame — so the no-inline-styles boundary
   * holds and the compositor owns every animated value. Motion forwards `--*`
   * style keys straight to `style.setProperty`.
   */
  const pillVars = {
    "--glide-top": `${target?.top ?? 0}px`,
    "--glide-left": `${target?.left ?? 0}px`,
    "--glide-width": `${target?.width ?? 0}px`,
    "--glide-height": `${target?.height ?? 0}px`,
    "--glide-radius": target?.borderRadius ?? "7px",
    "--glide-x": x,
    "--glide-y": y,
    "--glide-scale-x": scaleX,
    "--glide-scale-y": scaleY,
    "--glide-opacity": opacity,
  } as CSSProperties;

  const pill = <m.div aria-hidden data-glide-highlight="" className={className} style={pillVars} />;

  if (!viewportSelector) {
    // The container is the scroller: the pill rides its scroll content and the
    // container's own overflow clips it — no overlay machinery.
    return (
      <LazyMotion features={domAnimation} strict>
        {pill}
      </LazyMotion>
    );
  }

  // Non-scrolling container: clip the whole travelling overlay to the nested
  // viewport's visible rect (never the header/footer), and counter-translate
  // the inner layer by the live scroll offset so the pill tracks its row.
  return (
    <LazyMotion features={domAnimation} strict>
      <m.div
        aria-hidden
        data-glide-clip=""
        style={
          {
            "--glide-clip-top": clip ? `${clip.top}px` : "50%",
            "--glide-clip-right": clip ? `${clip.right}px` : "50%",
            "--glide-clip-bottom": clip ? `${clip.bottom}px` : "50%",
            "--glide-clip-left": clip ? `${clip.left}px` : "50%",
          } as CSSProperties
        }
      >
        <m.div
          data-glide-scroll=""
          style={
            {
              "--glide-scroll-x": scrollOffsetX,
              "--glide-scroll-y": scrollOffsetY,
            } as CSSProperties
          }
        >
          {pill}
        </m.div>
      </m.div>
    </LazyMotion>
  );
}
