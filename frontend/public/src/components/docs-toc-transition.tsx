import { useEffect, useLayoutEffect, useRef } from "react";
import { createLoadingPlane, DocsTocPlane } from "./docs-toc-plane";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
/**
 * Per-phase budgets keep the full navigation under ~700ms: the closing
 * collapse gates Astro's DOM swap (shorter, it only needs to read as a
 * retract), while the opening unfold and plane flights run post-swap where
 * the article's own entrance masks their tail.
 */
const rowTimings = {
  opening: { row: 140, motion: 240 },
  closing: { row: 120, motion: 160 },
} as const;
const easing = "cubic-bezier(0.4, 0, 0.2, 1)";
/** Bound on waiting for a scrolled guide to reach the top before committing. */
const scrollBudgetMs = 250;

interface ContentsTransition {
  reveal: () => void;
  dispose: () => void;
}

/** One navigation owns its transient rail; completing the exit releases its animation before the route commits. */
interface ContentsCycle {
  rail: HTMLElement;
  list: HTMLElement;
  exit: TocMotion | null;
  signal: AbortSignal;
  abort: () => void;
}

interface TocMotion {
  finished: Promise<void>;
  play: () => void;
  finish: () => void;
  cancel: () => void;
}

interface PlaneStart {
  distance: string;
  rotation: string;
}

/**
 * Rows retract bottom-first or unfold top-first, without moving article layout.
 * The 80ms stagger budget keeps any heading count within the phase's row +
 * motion window (see rowTimings); native motion-path animation returns the
 * plane along the actual bent rail as it morphs into a ring. Incoming rows
 * pause before paint; the shell marker owns the plane's handoff. Cancellation
 * restores plane positioning so scroll tracking can resume.
 */
function animateContents(
  list: HTMLElement,
  opening: boolean,
  rowStarts: Keyframe[] = [],
  planeStart?: PlaneStart,
): TocMotion {
  const { row: rowDuration, motion: motionDuration } = opening
    ? rowTimings.opening
    : rowTimings.closing;
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".docs-reading-items > li"));
  const stagger = rows.length > 1 ? Math.min(24, 80 / (rows.length - 1)) : 0;
  const animations = rows.map((row, index) =>
    row.animate(
      opening
        ? [
            { opacity: 0, transform: "translateY(-12px)" },
            { opacity: 1, transform: "translateY(0px)" },
          ]
        : [
            rowStarts[index] ?? { opacity: 1, transform: "none" },
            { opacity: 0, transform: "translateY(-24px)" },
          ],
      {
        duration: rowDuration,
        delay: (opening ? index : rows.length - 1 - index) * stagger,
        easing,
        fill: "both",
      },
    ),
  );
  const track = list.querySelector<SVGPathElement>(".docs-reading-remaining");
  const progress = list.querySelector<SVGPathElement>(".docs-reading-progress");
  const artwork = list.querySelector<SVGElement>(".docs-reading-track");
  const plane = list.querySelector<HTMLElement>(".docs-reading-plane");
  let restorePlane: (() => void) | undefined;
  const clip = artwork ? getComputedStyle(artwork).clipPath : "none";
  if (artwork)
    animations.push(
      artwork.animate(
        opening
          ? [{ clipPath: "inset(0% 0% 100% 0%)" }, { clipPath: "inset(0%)" }]
          : [
              { clipPath: clip === "none" ? "inset(0%)" : clip },
              { clipPath: "inset(0% 0% 100% 0%)" },
            ],
        { duration: motionDuration, easing, fill: "both" },
      ),
    );
  if (plane && !opening && track && progress) {
    const saved = plane.style.cssText;
    const distance = Math.max(
      0,
      track.getTotalLength() - Number.parseFloat(progress.style.strokeDashoffset || "0"),
    );
    plane.style.transform = "none";
    plane.style.insetInlineStart = "0px";
    plane.style.top = "0px";
    plane.style.offsetPath = `path("${track.getAttribute("d")}")`;
    animations.push(
      plane.animate(
        [
          {
            offsetDistance: planeStart?.distance ?? `${distance}px`,
            offsetRotate: planeStart?.rotation ?? "auto 45deg",
          },
          { offsetDistance: "0px", offsetRotate: "auto 225deg" },
        ],
        { duration: motionDuration, easing, fill: "both" },
      ),
    );
    const outline = plane.querySelector<SVGPathElement>("[data-toc-plane-outline]");
    const fold = plane.querySelector<SVGPathElement>("[data-toc-plane-fold]");
    const morphOptions = { duration: 160, easing, fill: "both" as const };
    if (outline) {
      const style = getComputedStyle(outline);
      animations.push(
        outline.animate(
          [
            { d: style.d, strokeDasharray: style.strokeDasharray },
            {
              d: getComputedStyle(plane.querySelector("svg")!).getPropertyValue(
                "--docs-toc-circle-shape",
              ),
              strokeDasharray: "78 22",
            },
          ],
          morphOptions,
        ),
      );
    }
    if (fold)
      animations.push(
        fold.animate([{ opacity: getComputedStyle(fold).opacity }, { opacity: 0 }], morphOptions),
      );
    restorePlane = () => {
      plane.style.cssText = saved;
    };
  }
  if (opening) for (const animation of animations) animation.pause();
  return {
    finished: Promise.all(
      animations.map((animation) => animation.finished.catch(() => undefined)),
    ).then(() => undefined),
    play: () => {
      for (const animation of animations) animation.play();
    },
    finish: () => {
      for (const animation of animations) animation.finish();
    },
    cancel: () => {
      for (const animation of animations) animation.cancel();
      restorePlane?.();
    },
  };
}
/**
 * Native smooth scrolling returns the outgoing article to its top without a
 * custom scroll timeline. Navigation waits for arrival, user interruption, or
 * `maxMs`, after which the remaining distance snaps instantly so the swap is
 * never hostage to scroll depth. Abort stops the old scroll, and reduced
 * motion settles without delay. A stale scrollend from earlier scrolling
 * cannot release navigation before arrival.
 */
function scrollGuideToTop(signal: AbortSignal, maxMs: number): Promise<void> {
  if (signal.aborted || (window.scrollY === 0 && window.scrollX === 0)) return Promise.resolve();
  if (document.hidden) {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  let frame = 0;
  let lastY = window.scrollY;
  let stillFrames = 0;
  let deadline: number | undefined;
  const finish = () => {
    clearTimeout(deadline);
    cancelAnimationFrame(frame);
    document.removeEventListener("scrollend", ended);
    document.removeEventListener("visibilitychange", visibility);
    signal.removeEventListener("abort", abort);
    window.removeEventListener("wheel", finish);
    window.removeEventListener("touchstart", finish);
    window.removeEventListener("keydown", interrupt);
    resolve();
  };
  const ended = () => {
    if (window.scrollY === 0) finish();
  };
  const abort = () => {
    window.scrollTo({
      top: window.scrollY,
      left: window.scrollX,
      behavior: "instant",
    });
    finish();
  };
  const visibility = () => {
    if (!document.hidden) return;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    finish();
  };
  const interrupt = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
      finish();
  };
  const check = () => {
    const y = window.scrollY;
    stillFrames = y === lastY ? stillFrames + 1 : 0;
    lastY = y;
    if (y === 0 || (!("onscrollend" in document) && stillFrames >= 4)) finish();
    else frame = requestAnimationFrame(check);
  };
  document.addEventListener("scrollend", ended);
  document.addEventListener("visibilitychange", visibility);
  signal.addEventListener("abort", abort, { once: true });
  window.addEventListener("wheel", finish, { once: true, passive: true });
  window.addEventListener("touchstart", finish, { once: true, passive: true });
  window.addEventListener("keydown", interrupt);
  window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
  frame = requestAnimationFrame(check);
  // Past the budget the remaining distance snaps so deep scrolls cannot hold
  // the swap open; short hops still arrive under native smooth scrolling.
  deadline = window.setTimeout(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    finish();
  }, maxMs);
  return promise;
}

/**
 * Fetches alongside bounded smooth scrolling, bottom-to-top retraction and
 * the plane's return flight. A shell-owned loading marker survives the guide
 * swap; its ring→plane morph starts the moment the fetch lands so incoming
 * rows only wait for two paint frames before unfolding. Stale or aborted
 * loaders cannot own another navigation.
 */
function createContentsTransition(marker: HTMLElement): ContentsTransition {
  const loadingPlane = createLoadingPlane(marker);
  let pending: ContentsCycle | null = null;
  let entrance: TocMotion | null = null;
  let enteringList: HTMLElement | null = null;
  let entranceFrame = 0;
  // Ring→plane return morph started during the loader so reveal only awaits
  // the tail instead of the full 180ms after commit.
  let restoring: Promise<void> | null = null;

  /** Clears only transient route state; heading links and document layout retain their identity. */
  const clear = (rail: HTMLElement, list: HTMLElement) => {
    rail.removeAttribute("data-toc-transition");
    rail.removeAttribute("aria-busy");
    list.style.removeProperty("visibility");
    list.querySelector<HTMLElement>(".docs-reading-plane")?.style.removeProperty("visibility");
    list.inert = false;
  };

  /** Cancels batches and playback; reveal alone preserves the shell-owned loading marker for its handoff. */
  const reset = (preserveMarker = false) => {
    cancelAnimationFrame(entranceFrame);
    entranceFrame = 0;
    if (!preserveMarker) {
      loadingPlane.hide();
      restoring = null;
    }
    if (pending) {
      const previous = pending;
      pending = null;
      previous.signal.removeEventListener("abort", previous.abort);
      previous.exit?.cancel();
      clear(previous.rail, previous.list);
    }
    entrance?.cancel();
    entrance = null;
    if (enteringList) {
      const rail = enteringList.closest<HTMLElement>("#nd-toc");
      if (rail) clear(rail, enteringList);
      enteringList = null;
    }
  };

  /** Fetches immediately; bounded scroll, row retraction and plane flight settle before the next guide commits. */
  const prepare = (event: DocumentEventMap["astro:before-preparation"]) => {
    if (event.from.pathname === event.to.pathname) return;
    const rail = document.getElementById("nd-toc");
    const list = rail?.querySelector<HTMLElement>("[data-docs-toc-list]");
    const rowStarts = list
      ? Array.from(list.querySelectorAll<HTMLElement>(".docs-reading-items > li"), (row) => {
          const style = getComputedStyle(row);
          return { opacity: style.opacity, transform: style.transform };
        })
      : [];
    const plane = list?.querySelector<HTMLElement>(".docs-reading-plane");
    const planeStyle = plane?.style.offsetPath ? getComputedStyle(plane) : null;
    const planeStart = planeStyle
      ? {
          distance: planeStyle.offsetDistance,
          rotation: planeStyle.offsetRotate,
        }
      : undefined;
    reset();
    if (!rail || !list || rail.getClientRects().length === 0) {
      const loader = event.loader;
      event.loader = async () => {
        await Promise.all([loader(), scrollGuideToTop(event.signal, scrollBudgetMs)]);
      };
      return;
    }
    rail.dataset.tocTransition = "closing";
    rail.setAttribute("aria-busy", "true");
    list.inert = true;
    const exit = animateContents(list, false, rowStarts, planeStart);
    const abort = () => {
      if (pending === cycle) reset();
    };
    const cycle: ContentsCycle = { rail, list, exit, signal: event.signal, abort };
    pending = cycle;
    event.signal.addEventListener("abort", abort, { once: true });
    const loader = event.loader;
    event.loader = async () => {
      let loaded = false;
      const loading = loader().finally(() => {
        loaded = true;
      });
      let markerShown = false;
      /** Starts the ring→plane morph once the marker exists and the fetch landed, whichever order those occur in. */
      const startRestore = () => {
        if (!markerShown || restoring || pending !== cycle || event.signal.aborted) return;
        restoring = loadingPlane.restore();
      };
      try {
        const scrolling = scrollGuideToTop(event.signal, scrollBudgetMs);
        await Promise.all([
          loading.then(startRestore),
          scrolling,
          exit.finished.then(() => {
            if (pending !== cycle || event.signal.aborted) return;
            loadingPlane.show(list, !loaded);
            markerShown = true;
            if (loaded) startRestore();
            list.style.visibility = "hidden";
            exit.cancel();
            cycle.exit = null;
            rail.dataset.tocTransition = loaded ? "closing" : "loading";
          }),
        ]);
        if (event.defaultPrevented && pending === cycle) reset();
      } catch (error) {
        if (pending === cycle) reset();
        throw error;
      }
    };
  };

  /** Pauses incoming rows before paint; keeps their plane hidden until the restored shell marker hands off at full opacity. */
  const reveal = () => {
    if (!pending) return;
    reset(true);
    const rail = document.getElementById("nd-toc");
    const list = rail?.querySelector<HTMLElement>("[data-docs-toc-list]");
    if (!rail || !list || rail.getClientRects().length === 0) {
      loadingPlane.hide();
      return;
    }
    enteringList = list;
    rail.dataset.tocTransition = "opening";
    list.inert = true;
    const plane = list.querySelector<HTMLElement>(".docs-reading-plane");
    if (plane) plane.style.visibility = "hidden";
    const animation = animateContents(list, true);
    entrance = animation;
    void (restoring ?? loadingPlane.restore()).then(() => {
      if (entrance !== animation) return;
      entranceFrame = requestAnimationFrame(() => {
        entranceFrame = requestAnimationFrame(() => {
          entranceFrame = 0;
          if (entrance !== animation) return;
          plane?.style.removeProperty("visibility");
          loadingPlane.hide();
          animation.play();
        });
      });
    });
    void animation.finished.then(() => {
      if (entrance !== animation) return;
      clear(rail, list);
      loadingPlane.hide();
      animation.cancel();
      entrance = null;
      enteringList = null;
    });
  };

  document.addEventListener("astro:before-preparation", prepare);
  return {
    reveal,
    /** Releases navigation listeners, queued frames and native animation layers on unmount. */
    dispose: () => {
      document.removeEventListener("astro:before-preparation", prepare);
      reset();
    },
  };
}

/**
 * The persisted shell owns navigation and the loading plane across guide swaps.
 * Its layout effect stages incoming TOC motion before paint; playback follows
 * the marker handoff. Initial hydration is static; unmount releases all layers.
 */
export function DocsTocTransition({ pathname }: { pathname: string }) {
  const controller = useRef<ContentsTransition | null>(null);
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!marker.current) return;
    controller.current = createContentsTransition(marker.current);
    return () => {
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);
  useClientLayoutEffect(() => {
    controller.current?.reveal();
  }, [pathname]);
  return (
    <span
      ref={marker}
      className="docs-toc-status"
      data-state="idle"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <DocsTocPlane />
      <span className="sr-only" data-toc-loading-label="" />
    </span>
  );
}
