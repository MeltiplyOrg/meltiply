import { ArrowRight, Check, CircleAlert, Info, LoaderCircle, X } from "lucide-react";
import { LazyMotion, domAnimation, m } from "motion/react";
import {
  type AriaRole,
  type CSSProperties,
  type MouseEventHandler,
  memo,
  type ReactElement,
  type ReactNode,
  type TransitionEventHandler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import "../../../sileo.css";
import {
  DEFAULT_TOAST_DURATION,
  dismissToast,
  getServerStoreSnapshot,
  getStoreSnapshot,
  store,
  subscribeStore,
  type SileoButton,
  type SileoItem,
  type SileoOptions,
  type SileoState,
  type SileoStyles,
} from "../../../sileo-store";

interface SileoProps {
  id: string;
  fill?: string;
  state?: SileoState;
  title?: string;
  description?: ReactNode | string;
  position?: "left" | "center" | "right";
  expand?: "top" | "bottom";
  width?: number;
  className?: string;
  icon?: ReactNode | null;
  styles?: SileoStyles;
  button?: SileoButton;
  roundness?: number;
  exiting?: boolean;
  pinned?: boolean;
  autoExpandDelayMs?: number;
  autoCollapseDelayMs?: number;
  canExpand?: boolean;
  interruptKey?: string;
  refreshKey?: string;
  role?: AriaRole;
  ariaLabel?: string;
  firstVisitMarker?: boolean;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onDismiss?: () => void;
}

/**
 * Snapshot of the painted toast payload. Upstream Sileo renders from a
 * committed `View` rather than live props so a refresh morph (collapse →
 * swap → expand) never flashes incoming copy mid-flight; the same stage
 * also carries `fill` so the SVG surface crossfades color with content.
 */
interface SileoView {
  title?: string;
  description?: ReactNode | string;
  state: SileoState;
  icon?: ReactNode | null;
  styles?: SileoStyles;
  button?: SileoButton;
  fill: string;
}

const HEIGHT = 40;
const DEFAULT_WIDTH = 360;
const DEFAULT_ROUNDNESS = 16;
const DURATION_MS = 600;
const DURATION_S = DURATION_MS / 1000;
const BLUR_RATIO = 0.5;
const PILL_PADDING = 10;
const MIN_EXPAND_RATIO = 2.25;
const SWAP_COLLAPSE_MS = 200;
const HEADER_EXIT_MS = DURATION_MS * 0.7;

const VIEWPORT_GUTTER = 24;

const SPRING = {
  type: "spring" as const,
  bounce: 0.25,
  duration: DURATION_S,
};

const STATE_ICON: Record<SileoState, ReactNode> = {
  success: <Check className="size-3.5" aria-hidden="true" />,
  loading: <LoaderCircle className="size-3.5" data-sileo-icon="spin" aria-hidden="true" />,
  error: <X className="size-3.5" aria-hidden="true" />,
  warning: <CircleAlert className="size-3.5" aria-hidden="true" />,
  info: <Info className="size-3.5" aria-hidden="true" />,
  action: <ArrowRight className="size-3.5" aria-hidden="true" />,
};

/**
 * Reads the viewport-width ceiling sileo.css applies to `[data-sileo-toast]`
 * (`100vw - 24px` of side gutter). Used as the geometry fallback whenever the
 * toast element is not measurable (jsdom, display-none), matching the cap the
 * CSS `min()` computes from the same gutter.
 *
 * @returns Maximum rendered toast width in CSS pixels, or Infinity without a viewport.
 */
function viewportToastCap(): number {
  if (typeof window === "undefined") return Number.POSITIVE_INFINITY;
  return Math.max(0, window.innerWidth - VIEWPORT_GUTTER);
}

/**
 * Renders the SVG Gaussian-blur + alpha-threshold filter that fuses Sileo's
 * header pill and expandable body into a single continuous liquid silhouette.
 *
 * @param props.filterId - Unique DOM id referenced by the SVG group's `filter` attribute.
 * @param props.blur - Standard deviation derived from the toast's corner radius.
 * @returns Memoized `<defs>` block containing the metaball filter pipeline.
 */
const GooeyDefs = memo(function GooeyDefs({
  filterId,
  blur,
}: {
  filterId: string;
  blur: number;
}): ReactElement {
  return (
    <defs>
      <filter
        id={filterId}
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="blur" />
        <feColorMatrix
          in="blur"
          mode="matrix"
          values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10"
          result="goo"
        />
        <feComposite in="SourceGraphic" in2="goo" operator="atop" />
      </filter>
    </defs>
  );
});

/**
 * Physics-based morphing toast surface adapted from `hiaaryan/sileo` to
 * Meltiply's shared token palette.
 *
 * Renders a compact header pill (`[data-sileo-header]`) and an expandable
 * body (`[data-sileo-content]`) backed by two spring-animated `<m.rect>`
 * shapes fused through `<GooeyDefs>`. When `pinned` is true (e.g. for an
 * interactive cookie consent prompt), the body stays open until an explicit
 * action transitions it into a confirmation status or closes it.
 *
 * The caller `width` acts as a ceiling rather than a fixed size: sileo.css
 * clamps the element to the viewport through `--sileo-width`, and a
 * ResizeObserver mirrors the rendered box back into the SVG canvas, pill,
 * and header geometry so narrow screens keep the whole toast on-screen.
 *
 * @param props - Toast state, copy, alignment, and lifecycle handlers.
 * @returns Memoized Sileo toast element.
 */
export const Sileo = memo(function Sileo({
  id,
  fill = "var(--sileo-fill)",
  state = "success",
  title = state,
  description,
  position = "left",
  expand = "bottom",
  width = DEFAULT_WIDTH,
  className,
  icon,
  styles,
  button,
  roundness,
  exiting = false,
  pinned = false,
  autoExpandDelayMs,
  autoCollapseDelayMs,
  canExpand,
  interruptKey,
  refreshKey,
  role,
  ariaLabel,
  firstVisitMarker = false,
  onMouseEnter,
  onMouseLeave,
  onDismiss,
}: SileoProps): ReactElement {
  // Incoming payload; the committed `view` state below is what paints, so
  // header/body/fill can stage behind a collapse before swapping.
  const next: SileoView = useMemo(
    () => ({ title, description, state, icon, styles, button, fill }),
    [title, description, state, icon, styles, button, fill],
  );

  const [view, setView] = useState<SileoView>(next);
  const [applied, setApplied] = useState(refreshKey);
  const [isExpanded, setIsExpanded] = useState(
    () => pinned || ((Boolean(description) || Boolean(button)) && (autoExpandDelayMs ?? 0) === 0),
  );
  const [ready, setReady] = useState(false);
  const [pillWidth, setPillWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  // Rendered toast box width: seeded from the caller width so SSR and
  // hydration geometry match, then synced to the CSS-clamped element below.
  const [boxWidth, setBoxWidth] = useState(width);

  const hasDesc = Boolean(view.description) || Boolean(view.button);
  const isLoading = view.state === "loading";
  const allowExpand = isLoading ? false : (canExpand ?? (!interruptKey || interruptKey === id));
  const open = hasDesc && (pinned || (allowExpand && !exiting && isExpanded)) && !isLoading;

  const headerKey = `${view.state}-${view.title}`;
  const filterId = `sileo-gooey-${id}`;
  const resolvedRoundness = Math.max(0, roundness ?? DEFAULT_ROUNDNESS);
  const blur = resolvedRoundness * BLUR_RATIO;

  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerExitRef = useRef<number | null>(null);
  const autoExpandRef = useRef<number | null>(null);
  const autoCollapseRef = useRef<number | null>(null);
  const autoCollapseActiveRef = useRef(false);
  const hoveringRef = useRef(false);
  const swapTimerRef = useRef<number | null>(null);
  const lastRefreshKeyRef = useRef(refreshKey);
  const pendingRef = useRef<{ key?: string; payload: SileoView } | null>(null);
  const headerPadRef = useRef<number | null>(null);
  const pillRoRef = useRef<ResizeObserver | null>(null);
  const pillRafRef = useRef(0);
  const pillObservedRef = useRef<Element | null>(null);

  // Outgoing header copy stays mounted for `HEADER_EXIT_MS` so the badge/title
  // crossfades instead of hard-swapping; `prev` renders behind `current`.
  const [headerLayer, setHeaderLayer] = useState<{
    current: { key: string; view: SileoView };
    prev: { key: string; view: SileoView } | null;
  }>({ current: { key: headerKey, view }, prev: null });

  // Crossfade bookkeeping as a render-phase state adjustment: a headerKey
  // change demotes the outgoing layer to `prev` (which exits over
  // HEADER_EXIT_MS) while the new layer enters; same key swaps the view in
  // place without adding another animation path.
  if (headerLayer.current.key === headerKey) {
    if (headerLayer.current.view !== view) {
      setHeaderLayer((state) => ({
        ...state,
        current: { key: headerKey, view },
      }));
    }
  } else {
    setHeaderLayer({
      prev: headerLayer.current,
      current: { key: headerKey, view },
    });
  }

  // Commits the staged refresh payload; called by the swap timer and by the
  // root transitionend listener so the view lands exactly when the collapse
  // finishes (whichever comes first), never while a morph is still pending.
  const commitPendingView = useCallback(() => {
    if (swapTimerRef.current) {
      clearTimeout(swapTimerRef.current);
      swapTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setView(pending.payload);
    setApplied(pending.key);
  }, []);

  // Keep JS-drawn geometry aligned with the box the viewport clamp actually
  // produced; otherwise the SVG canvas, pill, and header paint at the raw
  // caller width and stick out of narrow viewports. `offsetWidth` is 0 before
  // layout (and in jsdom), so the CSS cap formula stands in for the measurement.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      const measured = el.offsetWidth;
      setBoxWidth(measured > 0 ? measured : Math.min(width, viewportToastCap()));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  // Measures the header pill synchronously so a remounted inner (key change)
  // paints with the correct width on its first frame; the observer then keeps
  // pill width live for subsequent text/layout growth, batched through rAF.
  useLayoutEffect(() => {
    const el = innerRef.current;
    const header = headerRef.current;
    if (!el || !header) return;
    if (headerPadRef.current === null) {
      const cs = getComputedStyle(header);
      headerPadRef.current = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    }
    const px = headerPadRef.current;
    const w = el.scrollWidth + px + PILL_PADDING;
    if (w > PILL_PADDING) {
      setPillWidth((prev) => (prev === w ? prev : w));
    }

    if (typeof ResizeObserver === "undefined") return;
    if (!pillRoRef.current) {
      pillRoRef.current = new ResizeObserver(() => {
        cancelAnimationFrame(pillRafRef.current);
        pillRafRef.current = requestAnimationFrame(() => {
          const inner = innerRef.current;
          const pad = headerPadRef.current ?? 0;
          if (!inner) return;
          const nextWidth = inner.scrollWidth + pad + PILL_PADDING;
          if (nextWidth > PILL_PADDING) {
            setPillWidth((prev) => (prev === nextWidth ? prev : nextWidth));
          }
        });
      });
    }

    if (pillObservedRef.current !== el) {
      if (pillObservedRef.current) {
        pillRoRef.current.unobserve(pillObservedRef.current);
      }
      pillRoRef.current.observe(el);
      pillObservedRef.current = el;
    }

    // The observer itself is ref-owned and survives re-runs (the unmount effect
    // disconnects it), so this run releases exactly the element it registered:
    // clearing the tracking ref lets the next run observe the current pill.
    return () => {
      pillRoRef.current?.unobserve(el);
      if (pillObservedRef.current === el) pillObservedRef.current = null;
    };
  }, [headerLayer.current.key]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(pillRafRef.current);
      pillRoRef.current?.disconnect();
      clearTimeout(swapTimerRef.current ?? undefined);
      clearTimeout(headerExitRef.current ?? undefined);
    };
  }, []);

  // Measures body height synchronously so newly committed content sizes the
  // canvas on the same commit instead of one frame late; the observer then
  // feeds live resizes (pinned forms toggling controls) rAF-batched.
  useLayoutEffect(() => {
    let rafId = 0;
    const el = contentRef.current;
    const measure = () => {
      const h = hasDesc && el ? el.scrollHeight : 0;
      setContentHeight((prev) => (prev === h ? prev : h));
    };
    measure();
    if (!hasDesc || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(measure);
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [hasDesc, view.description]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // The header layer sync lives in the render phase above (React's
  // "adjusting state when props change" pattern) so the outgoing layer is
  // already demoted when this commit paints — an effect here would paint one
  // frame with the new key on the old layer first.

  useEffect(() => {
    if (!headerLayer.prev) return;
    clearTimeout(headerExitRef.current ?? undefined);
    headerExitRef.current = window.setTimeout(() => {
      headerExitRef.current = null;
      setHeaderLayer((state) => ({ ...state, prev: null }));
    }, HEADER_EXIT_MS);
    return () => {
      clearTimeout(headerExitRef.current ?? undefined);
      headerExitRef.current = null;
    };
  }, [headerLayer.prev]);

  // Staged refresh lifecycle, matching upstream Sileo: a new `refreshKey`
  // while open collapses the body and stages the incoming view for
  // SWAP_COLLAPSE_MS (or until the collapse transition ends), while a refresh
  // received collapsed or still pinned commits immediately. Pinned form
  // controls must not wait behind a hidden copy. Same-key updates replace any
  // staged payload without restarting the implemented collapse timer.
  useEffect(() => {
    // The staged morph lifecycle must commit/collapse synchronously inside
    // this effect (upstream parity), so the paint decisions live inside this
    // local routine; timers and transitionend use `commitPendingView`.
    const applyRefresh = () => {
      if (refreshKey === undefined) {
        pendingRef.current = null;
        setView(next);
        setApplied(undefined);
        lastRefreshKeyRef.current = refreshKey;
        return;
      }

      if (lastRefreshKeyRef.current === refreshKey) {
        if (pendingRef.current) {
          pendingRef.current = { ...pendingRef.current, payload: next };
        } else if (applied === refreshKey && view !== next) {
          setView(next);
        }
        return;
      }
      lastRefreshKeyRef.current = refreshKey;

      if (swapTimerRef.current) {
        clearTimeout(swapTimerRef.current);
        swapTimerRef.current = null;
      }

      if (pinned || !open) {
        pendingRef.current = null;
        setView(next);
        setApplied(refreshKey);
        return;
      }

      pendingRef.current = { key: refreshKey, payload: next };
      setIsExpanded(false);
      swapTimerRef.current = window.setTimeout(() => {
        swapTimerRef.current = null;
        commitPendingView();
      }, SWAP_COLLAPSE_MS);
    };
    applyRefresh();
  }, [pinned, open, refreshKey, next, applied, view, commitPendingView]);

  // Re-arm only after the incoming view commits. Unpinning a consent prompt
  // changes these dependencies before the swap finishes; expanding at that
  // point would cancel the collapse and jump straight to the new body size.
  useEffect(() => {
    clearTimeout(autoExpandRef.current ?? undefined);
    clearTimeout(autoCollapseRef.current ?? undefined);
    autoExpandRef.current = null;
    autoCollapseRef.current = null;

    if (pendingRef.current || !hasDesc || pinned || exiting || !allowExpand) return;
    if (autoExpandDelayMs == null && autoCollapseDelayMs == null) return;

    autoCollapseActiveRef.current = true;
    // Sub-frame timer keeps the expand on the external-callback path; 1ms is
    // below one paint frame so a delay of 0 still expands "immediately".
    autoExpandRef.current = window.setTimeout(
      () => setIsExpanded(true),
      Math.max(1, autoExpandDelayMs ?? 1),
    );

    const collapseDelay = autoCollapseDelayMs ?? 0;
    if (collapseDelay > 0) {
      autoCollapseRef.current = window.setTimeout(() => {
        autoCollapseActiveRef.current = false;
        if (!hoveringRef.current) setIsExpanded(false);
      }, collapseDelay);
    }

    return () => {
      clearTimeout(autoExpandRef.current ?? undefined);
      clearTimeout(autoCollapseRef.current ?? undefined);
    };
  }, [autoCollapseDelayMs, autoExpandDelayMs, hasDesc, allowExpand, exiting, pinned, applied]);

  const minExpanded = HEIGHT * MIN_EXPAND_RATIO;
  const rawExpanded = hasDesc ? Math.max(minExpanded, HEIGHT + contentHeight) : minExpanded;

  // Freeze the expanded canvas height on the last open measurement so a
  // collapse keeps drawing one fused silhouette while the body springs up;
  // unfrozen it would shrink the SVG instantly and paint two pills. Rendered
  // as render-phase state (refs may not be read during render).
  const [frozen, setFrozen] = useState({ open, expanded: rawExpanded });
  if (open !== frozen.open) {
    setFrozen({ open, expanded: rawExpanded });
  } else if (open && rawExpanded !== frozen.expanded) {
    setFrozen({ open: true, expanded: rawExpanded });
  }
  const expanded = open ? rawExpanded : frozen.expanded;

  const svgHeight = hasDesc ? Math.max(expanded, minExpanded) : HEIGHT;
  const expandedContent = Math.max(0, expanded - HEIGHT);
  const resolvedWidth = Math.min(boxWidth, width);
  const resolvedPillWidth = Math.min(resolvedWidth, Math.max(pillWidth || 180, HEIGHT));
  const pillHeight = HEIGHT + blur * 3;

  const pillX =
    position === "right"
      ? resolvedWidth - resolvedPillWidth
      : position === "center"
        ? (resolvedWidth - resolvedPillWidth) / 2
        : 0;

  const viewBox = `0 0 ${resolvedWidth} ${svgHeight}`;

  const handleEnter: MouseEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      hoveringRef.current = true;
      onMouseEnter?.(e);
      if (hasDesc) setIsExpanded(true);
    },
    [hasDesc, onMouseEnter],
  );

  const handleLeave: MouseEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      hoveringRef.current = false;
      onMouseLeave?.(e);
      if (!pinned && !autoCollapseActiveRef.current) setIsExpanded(false);
    },
    [onMouseLeave, pinned],
  );

  const handleButtonClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      view.button?.onClick();
    },
    [view.button],
  );

  // Commits the staged payload as soon as the collapse actually finishes
  // (height/transform transitions settle) instead of waiting out the full
  // SWAP_COLLAPSE_MS timer; bubbled transitionend events are filtered to the
  // properties the morph itself animates.
  const handleTransitionEnd: TransitionEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      if (e.propertyName !== "height" && e.propertyName !== "transform") {
        return;
      }
      if (open) return;
      commitPendingView();
    },
    [open, commitPendingView],
  );

  const pointerStartRef = useRef<number | null>(null);
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (exiting || !onDismiss || pinned) return;
      const target = e.target as HTMLElement;
      if (target.closest("button, a, input, label, [data-sileo-button]")) return;
      pointerStartRef.current = e.clientY;
      e.currentTarget.setPointerCapture(e.pointerId);
      const el = rootRef.current;
      if (!el) return;

      const onMove = (moveEvent: PointerEvent) => {
        if (pointerStartRef.current === null) return;
        const dy = moveEvent.clientY - pointerStartRef.current;
        const sign = dy > 0 ? 1 : -1;
        const clamped = Math.min(Math.abs(dy), 20) * sign;
        el.style.transform = `translateY(${clamped}px)`;
      };

      const onUp = (upEvent: PointerEvent) => {
        if (pointerStartRef.current === null) return;
        const dy = upEvent.clientY - pointerStartRef.current;
        pointerStartRef.current = null;
        el.style.transform = "";
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        if (Math.abs(dy) > 30) {
          onDismiss();
        }
      };

      el.addEventListener("pointermove", onMove, { passive: true });
      el.addEventListener("pointerup", onUp, { passive: true });
    },
    [exiting, onDismiss, pinned],
  );

  const renderHeaderInner = (layer: { key: string; view: SileoView }): ReactElement => (
    <>
      <div data-sileo-badge data-state={layer.view.state} className={layer.view.styles?.badge}>
        {layer.view.icon ?? STATE_ICON[layer.view.state]}
      </div>
      <span data-sileo-title data-state={layer.view.state} className={layer.view.styles?.title}>
        {layer.view.title}
      </span>
    </>
  );

  return (
    <div
      ref={rootRef}
      role={role}
      aria-label={ariaLabel}
      aria-live={role === "status" ? "polite" : undefined}
      aria-atomic={role === "status" ? "true" : undefined}
      data-sileo-toast
      data-cookie-first-visit={firstVisitMarker ? "" : undefined}
      data-dismissible={!pinned && Boolean(onDismiss)}
      data-ready={ready}
      data-expanded={open}
      data-exiting={exiting}
      data-edge={expand}
      data-position={position}
      data-state={view.state}
      className={className}
      style={
        {
          // Caller width is a ceiling; the CSS `min()` owns the actual clamp
          // and the ResizeObserver feeds the rendered box back as `boxWidth`.
          "--sileo-width": `${width}px`,
          height: `${open ? expanded : HEIGHT}px`,
        } as CSSProperties
      }
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onTransitionEnd={handleTransitionEnd}
      onPointerDown={handlePointerDown}
      onClick={
        !pinned && onDismiss
          ? (e) => {
              const target = e.target as HTMLElement;
              if (target.closest("button, a, input, label, [data-sileo-button]")) return;
              onDismiss();
            }
          : undefined
      }
    >
      <div data-sileo-canvas data-edge={expand}>
        <svg
          data-sileo-svg
          width={resolvedWidth}
          height={svgHeight}
          viewBox={viewBox}
          aria-hidden="true"
        >
          <GooeyDefs filterId={filterId} blur={blur} />
          <g filter={`url(#${filterId})`}>
            <LazyMotion features={domAnimation} strict>
              {/* The animated keys are SVG geometry attributes on a `<rect>`,
                  not CSS layout properties: a rect's x/width/height drive the
                  shape the gooey filter morphs, so they repaint the SVG instead
                  of reflowing the document and have no transform equivalent. */}
              <m.rect
                data-sileo-pill
                rx={resolvedRoundness}
                ry={resolvedRoundness}
                fill={view.fill}
                initial={false}
                animate={{
                  x: pillX,
                  width: resolvedPillWidth,
                  height: open ? pillHeight : HEIGHT,
                }}
                transition={ready ? SPRING : { duration: 0 }}
              />
              <m.rect
                data-sileo-body
                y={HEIGHT}
                width={resolvedWidth}
                rx={resolvedRoundness}
                ry={resolvedRoundness}
                fill={view.fill}
                initial={false}
                animate={{
                  height: open ? expandedContent : 0,
                  opacity: open ? 1 : 0,
                }}
                transition={open ? SPRING : { ...SPRING, bounce: 0 }}
              />
            </LazyMotion>
          </g>
        </svg>
      </div>

      <div
        ref={headerRef}
        data-sileo-header
        data-edge={expand}
        style={{
          left: `${pillX}px`,
          width: `${resolvedPillWidth}px`,
          transform: `translateY(${open ? (expand === "bottom" ? 3 : -3) : 0}px) scale(${open ? 0.94 : 1})`,
        }}
      >
        <div data-sileo-header-stack>
          <div
            ref={innerRef}
            key={headerLayer.current.key}
            data-sileo-header-inner
            data-layer="current"
          >
            {renderHeaderInner(headerLayer.current)}
          </div>
          {headerLayer.prev && (
            <div
              key={headerLayer.prev.key}
              data-sileo-header-inner
              data-layer="prev"
              data-exiting="true"
            >
              {renderHeaderInner(headerLayer.prev)}
            </div>
          )}
        </div>
      </div>

      {hasDesc && (
        <div data-sileo-content data-edge={expand} data-visible={open}>
          <div ref={contentRef} data-sileo-description className={view.styles?.description}>
            {view.description}
            {view.button && (
              <button
                type="button"
                data-sileo-button
                data-state={view.state}
                className={view.styles?.button}
                onClick={handleButtonClick}
              >
                {view.button.title}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

/**
 * Fixed-position Sileo toast viewport rendering all active notifications from
 * the shared store. Pauses dismissal timers while the pointer hovers over a
 * toast, while retaining the existing spring and morph lifecycle.
 *
 * @param props.children - Optional child tree rendered alongside the viewport.
 * Notifications always occupy the bottom-right corner and expand upward.
 * @param props.options - Default content and timing options merged into every toast.
 * @returns One fixed bottom-right viewport containing the shared notification list.
 */
export function Toaster({
  children,
  options,
}: {
  children?: ReactNode;
  options?: Partial<SileoOptions>;
}): ReactElement {
  const toasts = useSyncExternalStore(subscribeStore, getStoreSnapshot, getServerStoreSnapshot);
  const [hoveredId, setHoveredId] = useState<string>();

  const hoverRef = useRef(false);
  const timersRef = useRef(new Map<string, number>());
  const listRef = useRef(toasts);

  useEffect(() => {
    store.options = options;
  }, [options]);

  const clearAllTimers = useCallback(() => {
    for (const t of timersRef.current.values()) clearTimeout(t);
    timersRef.current.clear();
  }, []);

  const schedule = useCallback((items: SileoItem[]) => {
    if (hoverRef.current) return;

    for (const item of items) {
      if (item.exiting) continue;
      const key = `${item.id}:${item.instanceId}`;
      if (timersRef.current.has(key)) continue;

      if (item.duration === null) continue;
      const dur = item.duration ?? DEFAULT_TOAST_DURATION;
      if (dur <= 0) continue;

      timersRef.current.set(
        key,
        window.setTimeout(() => dismissToast(item), dur),
      );
    }
  }, []);

  useEffect(() => () => clearAllTimers(), [clearAllTimers]);

  useEffect(() => {
    listRef.current = toasts;

    const toastKeys = new Set(toasts.map((t) => `${t.id}:${t.instanceId}`));
    for (const [key, timer] of timersRef.current) {
      if (!toastKeys.has(key)) {
        clearTimeout(timer);
        timersRef.current.delete(key);
      }
    }

    schedule(toasts);
  }, [toasts, schedule]);

  const handleMouseEnter = useCallback(
    (toastId: string) => {
      setHoveredId((prev) => (prev === toastId ? prev : toastId));
      if (hoverRef.current) return;
      hoverRef.current = true;
      clearAllTimers();
    },
    [clearAllTimers],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredId(undefined);
    if (!hoverRef.current) return;
    hoverRef.current = false;
    schedule(listRef.current);
  }, [schedule]);

  const latest = useMemo(() => {
    for (let i = toasts.length - 1; i >= 0; i--) {
      const item = toasts[i];
      if (item && !item.exiting) return item.id;
    }
    return undefined;
  }, [toasts]);

  const activeId = hoveredId ?? latest;

  return (
    <>
      {children}
      {toasts.length > 0 && (
        <section data-sileo-viewport data-position="bottom-right" aria-live="polite">
          {toasts.map((item) => (
            <Sileo
              key={item.id}
              id={item.id}
              state={item.state}
              title={item.title}
              description={item.description}
              position="right"
              expand="top"
              icon={item.icon}
              fill={item.fill}
              styles={item.styles}
              button={item.button}
              roundness={item.roundness}
              exiting={item.exiting}
              autoExpandDelayMs={item.autoExpandDelayMs}
              autoCollapseDelayMs={item.autoCollapseDelayMs}
              refreshKey={item.instanceId}
              canExpand={activeId === undefined || activeId === item.id}
              onMouseEnter={() => handleMouseEnter(item.id)}
              onMouseLeave={handleMouseLeave}
              onDismiss={() => dismissToast(item)}
            />
          ))}
        </section>
      )}
    </>
  );
}
