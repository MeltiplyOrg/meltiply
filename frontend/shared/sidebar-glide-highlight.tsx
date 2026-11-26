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
  LazyMotion,
  animate,
  domAnimation,
  m,
  useMotionValue,
  type MotionValue,
} from "motion/react";
import { useLatchedValue } from "./use-latched-value";
import { useReducedMotionPreference } from "./src/components/primitives/use-reduced-motion";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface GlideRect {
  top: number;
  left: number;
  width: number;
  height: number;
  borderRadius: string;
}

interface ClipInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SidebarGlideHighlightProps {
  containerRef: RefObject<HTMLElement | null>;
  itemSelector?: string;
  className?: string;
  snapThreshold?: number;
  viewportSelector?: string;
}

const SPRING = {
  type: "spring" as const,
  stiffness: 380,
  damping: 28,
  mass: 0.7,
};
const FADE = { duration: 0.2, ease: "easeOut" as const };

const GLIDE_IGNORE_SELECTOR = "[data-glide-ignore]";

const OBSERVED_ATTRIBUTES = ["data-active", "aria-current", "aria-selected", "class", "hidden"];

function springTo(mv: MotionValue<number>, to: number, velocity: number): void {
  animate(mv, to, { ...SPRING, velocity });
}

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
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const hoverRef = useRef<HTMLElement | null>(null);
  const measuredRef = useRef<GlideRect | null>(null);
  const clipRef = useRef<ClipInsets | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
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

  useEffect(() => {
    setContainer(containerRef.current);
  }, [containerRef]);

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
  useEffect(() => {
    if (!container) return;
    const viewport = viewportSelector
      ? (container.querySelector<HTMLElement>(viewportSelector) ?? null)
      : null;
    viewportRef.current = viewport;
    const scroller = viewport ?? container;

    const nearest = (clientX: number, clientY: number): HTMLElement | null => {
      const underPointer = document.elementFromPoint(clientX, clientY);
      if (underPointer?.closest(GLIDE_IGNORE_SELECTOR)) return null;
      let closest: HTMLElement | null = null;
      let minDistance = Infinity;
      for (const item of container.querySelectorAll<HTMLElement>(itemSelector)) {
        const r = item.getBoundingClientRect();
        if (r.height <= 0 || r.width <= 0) continue;
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

export function SidebarGlideHighlight(props: SidebarGlideHighlightProps) {
  const { className, viewportSelector } = props;
  const prefersReducedMotion = useReducedMotionPreference();

  const { target, clip, scrollOffsetX, scrollOffsetY } = useGlideTracking(props);
  const box = useLatchedValue(target);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scaleX = useMotionValue(1);
  const scaleY = useMotionValue(1);
  const opacity = useMotionValue(0);

  const committedRef = useRef<GlideRect | null>(null);

  useIsomorphicLayoutEffect(() => {
    const prev = committedRef.current;
    committedRef.current = target;
    if (!target) {
      animate(opacity, 0, FADE);
      return;
    }
    if (!prev || prefersReducedMotion) {
      x.jump(0);
      y.jump(0);
      scaleX.jump(1);
      scaleY.jump(1);
      animate(opacity, 1, FADE);
      return;
    }
    const velocityX = x.getVelocity();
    const velocityY = y.getVelocity();
    const velocitySX = target.width > 0 ? scaleX.getVelocity() * (prev.width / target.width) : 0;
    const velocitySY = target.height > 0 ? scaleY.getVelocity() * (prev.height / target.height) : 0;
    const visualLeft = prev.left + x.get();
    const visualTop = prev.top + y.get();
    const visualWidth = prev.width * scaleX.get();
    const visualHeight = prev.height * scaleY.get();
    x.set(visualLeft - target.left);
    y.set(visualTop - target.top);
    scaleX.set(target.width > 0 ? visualWidth / target.width : 1);
    scaleY.set(target.height > 0 ? visualHeight / target.height : 1);
    springTo(x, 0, velocityX);
    springTo(y, 0, velocityY);
    springTo(scaleX, 1, velocitySX);
    springTo(scaleY, 1, velocitySY);
    animate(opacity, 1, FADE);
  }, [target, prefersReducedMotion, x, y, scaleX, scaleY, opacity]);

  const pillVars = {
    "--glide-top": `${box?.top ?? 0}px`,
    "--glide-left": `${box?.left ?? 0}px`,
    "--glide-width": `${box?.width ?? 0}px`,
    "--glide-height": `${box?.height ?? 0}px`,
    "--glide-radius": box?.borderRadius ?? "7px",
    "--glide-x": x,
    "--glide-y": y,
    "--glide-scale-x": scaleX,
    "--glide-scale-y": scaleY,
    "--glide-opacity": opacity,
  } as CSSProperties;

  const pill = <m.div aria-hidden data-glide-highlight="" className={className} style={pillVars} />;

  if (!viewportSelector) {
    return (
      <LazyMotion features={domAnimation} strict>
        {pill}
      </LazyMotion>
    );
  }

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
