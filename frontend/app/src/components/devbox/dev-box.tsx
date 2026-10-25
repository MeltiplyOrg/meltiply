import { useQueryClient } from "@tanstack/react-query";
import { GripVertical, Minus, Wrench, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { hasCookieConsent, subscribeCookieConsent } from "@meltiply/ui/cookie-consent";

import { Skeleton } from "@meltiply/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@meltiply/ui/tabs";
import { toast } from "@meltiply/ui/toast";
import { copyText } from "@meltiply/ui/copy-text";
import { hotkeys, useHotkey } from "@/lib/hotkeys";
import { setPseudoLocalization } from "@/lib/pseudo-locale";
import { cn } from "@meltiply/ui/utils";

import {
  clampDevBoxPosition,
  devBoxTabs,
  readDevBoxState,
  writeDevBoxState,
  type DevBoxPosition,
  type DevBoxSize,
  type DevBoxState,
  type DevBoxTab,
} from "./devbox-state";
import {
  getDevBoxQueryClient,
  registerDevBoxQueryClient,
  subscribeDevBoxQueryClient,
} from "./query-client-registry";
import {
  installNetworkThrottle,
  setThrottleLatency,
  uninstallNetworkThrottle,
} from "./network-throttle";
import { BenchmarkTab } from "./benchmark-tab";
import { clearHelpersDom, HelpersTab } from "./helpers-tab";
import { clearLayoutOverlays } from "./layout-overlays";
import { stopRenderScanner } from "./render-scanner";
import { clearViewportFrame } from "./viewport-frame";
import { SkeletonsTab } from "./skeletons-tab";
import { TraceTab } from "./trace-tab";

const LazyAgentation = lazy(async () => {
  const { Agentation } = await import("agentation");
  return { default: Agentation };
});

const agentationStoragePrefixes = [
  "feedback-annotations-",
  "agentation-design-",
  "agentation-rearrange-",
  "agentation-wireframe-",
  "agentation-session-",
] as const;
const agentationStorageKeys = ["feedback-toolbar-settings"] as const;

/**
 * Removes Agentation's optional durable and tab-scoped records after consent
 * is denied. It inspects key names only, deletes matching keys without using
 * their values, and tolerates browsers that block either storage area.
 */
function clearAgentationStorage(): void {
  if (typeof window === "undefined") return;
  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[storageName];
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (
          key &&
          (agentationStorageKeys.includes(key as (typeof agentationStorageKeys)[number]) ||
            agentationStoragePrefixes.some((prefix) => key.startsWith(prefix)))
        ) {
          keys.push(key);
        }
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      // Storage cleanup must not prevent the in-memory developer dock from working.
    }
  }
}

/**
 * Bridge rendered inside `ScopedAppProviders` (dashboard layout) that exposes
 * the per-workspace `QueryClient` to the root-mounted DevBox dock through the
 * module registry. Rendered only in development builds.
 */
export function DevBoxClientBridge(): null {
  const queryClient = useQueryClient();
  useEffect(() => {
    registerDevBoxQueryClient(queryClient);
    return () => registerDevBoxQueryClient(null);
  }, [queryClient]);
  return null;
}

const tabLabels: Record<DevBoxTab, string> = {
  skeletons: "Skeletons",
  benchmark: "Benchmark",
  trace: "Trace",
  helpers: "Helpers",
};

/**
 * Measures the live dock box, including borders. Returns `null` when the panel
 * has no usable geometry (for example before layout or in a headless DOM).
 */
function measureDock(panel: HTMLDivElement | null): DevBoxSize | null {
  if (!panel) return null;
  const rect = panel.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null;
}

/**
 * Clamps a dock position to the current viewport using the measured dock size.
 */
function clampPosition(position: DevBoxPosition, size: DevBoxSize): DevBoxPosition {
  return clampDevBoxPosition(position, size, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

/**
 * Removes every page-level mutation the dock can install: layout overlays, the
 * viewport frame, audit highlights, scanner outlines, and pseudo-localization.
 * Runs when the dock is hidden or unmounted so no inspection state outlives the
 * control surface that owns it.
 */
function clearPageMutations(): void {
  clearLayoutOverlays();
  clearViewportFrame();
  clearHelpersDom();
  stopRenderScanner();
  setPseudoLocalization(false);
}

/**
 * Unified in-app developer toolbox dock ("Meltiply DevBox").
 *
 * A draggable, collapsible floating dock anchored bottom-left, mounted only in
 * development builds. Hosts four Radix tabs — Skeletons, Benchmark, Trace,
 * Helpers — covering loading-state auditing, render profiling, query/telemetry
 * tracing, design-system/accessibility helpers; `Tabs` supplies the tablist
 * roving-focus keyboard contract the former hand-rolled buttons lacked.
 * Position, collapsed state, active tab, and latency selection persist across
 * refreshes only after functional consent. The collapsed pill is itself a drag
 * surface: presses inside a small dead zone expand the dock, while real
 * movement repositions it.
 *
 * The dock renders outside the router tree; the query client reaches it
 * through `DevBoxClientBridge` + the module registry. Heavy developer
 * dependencies load lazily; Agentation mounts only with functional consent
 * because it maintains its own browser storage outside the shared helpers.
 * Agentation-owned local and session keys are removed by name when consent is
 * absent, preventing its private persistence from bypassing withdrawal cleanup.
 * Copying Agentation's feedback markdown surfaces the shared Sileo toast so
 * developers see success, or failure with guidance, instead of silence.
 */
export function DevBox(): React.ReactElement | null {
  const [state, setState] = useState<DevBoxState>(readDevBoxState);
  const [functionalConsent, setFunctionalConsent] = useState(() => hasCookieConsent("functional"));
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    dx: number;
    dy: number;
    size: DevBoxSize;
  } | null>(null);
  const queryClient = useSyncExternalStore(subscribeDevBoxQueryClient, getDevBoxQueryClient);

  const hasInteractedRef = useRef(false);
  /**
   * Applies a dock patch in memory and remembers user changes made before
   * consent so later acceptance persists those choices instead of replacing them.
   *
   * @param patch Partial dock state to apply.
   */
  const update = useCallback((patch: Partial<DevBoxState>) => {
    hasInteractedRef.current = true;
    setState((current) => ({ ...current, ...patch }));
  }, []);

  /**
   * Re-clamps a persisted or dragged position against the dock's current
   * measured box. Runs before paint on mount, after expand/collapse, on window
   * resize, and whenever the dock's own box changes.
   */
  const revalidatePosition = useCallback(() => {
    setState((current) => {
      if (!current.position) return current;
      const size = measureDock(panelRef.current);
      if (!size) return current;
      const next = clampPosition(current.position, size);
      return next.x === current.position.x && next.y === current.position.y
        ? current
        : { ...current, position: next };
    });
  }, []);

  // Persisted coordinates may come from a wider window, an older dock width, or
  // hand-edited storage. Validate before paint and whenever the viewport or the
  // dock itself (expand/collapse, content reflow) changes size.
  useLayoutEffect(() => {
    revalidatePosition();
    window.addEventListener("resize", revalidatePosition);
    const panel = panelRef.current;
    const observer =
      typeof ResizeObserver === "undefined" || !panel
        ? null
        : new ResizeObserver(() => revalidatePosition());
    if (panel) observer?.observe(panel);
    return () => {
      window.removeEventListener("resize", revalidatePosition);
      observer?.disconnect();
    };
  }, [revalidatePosition, state.hidden]);
  useLayoutEffect(() => {
    revalidatePosition();
  }, [revalidatePosition, state.collapsed]);
  // Persist state changes, debounced: drag emits a position update per
  // pointermove, so writes are coalesced to one trailing flush per burst. A
  // ref keeps the latest state reachable so unmount can flush synchronously.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
    const timer = window.setTimeout(() => writeDevBoxState(state), 150);
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(() => () => writeDevBoxState(stateRef.current), []);
  // Keep DevBox and its third-party feedback tool in step with consent changes;
  // cleanup removes Agentation's own keys that shared storage cannot identify.
  useEffect(() => {
    if (!hasCookieConsent("functional")) clearAgentationStorage();
    return subscribeCookieConsent(() => {
      const accepted = hasCookieConsent("functional");
      setFunctionalConsent(accepted);
      if (!accepted) {
        clearAgentationStorage();
      } else if (hasInteractedRef.current) {
        writeDevBoxState(stateRef.current);
      } else {
        setState(readDevBoxState());
      }
    });
  }, []);

  // The throttle wraps fetch for the dock's whole lifetime so the latency
  // slider and skeleton hold apply to every request, not just query fetches.
  useEffect(() => {
    installNetworkThrottle();
    return () => uninstallNetworkThrottle();
  }, []);
  useEffect(() => setThrottleLatency(state.latency), [state.latency]);

  // Developer tools mutate the page outside their own React tree. Remove those
  // mutations when the dock is hidden or unmounted; hiding already unmounts
  // tab-local effects, and overlays/frame must not remain without their
  // controls.
  useEffect(() => {
    if (state.hidden) clearPageMutations();
  }, [state.hidden]);
  useEffect(() => clearPageMutations, []);

  useHotkey(hotkeys.devBox, () => update({ hidden: !state.hidden }));
  const onDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    // Header buttons must keep their click: pointer capture retargets the
    // release to the header, so a press that starts on a control would swallow
    // its click and leave Collapse/Hide inert.
    if (!panel || event.target !== event.currentTarget) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      size: { width: rect.width, height: rect.height },
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some headless/test environments.
    }
  };
  const onDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    update({
      position: clampPosition(
        { x: event.clientX - drag.dx, y: event.clientY - drag.dy },
        drag.size,
      ),
    });
  };
  const onDragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  // Collapsed-pill drag: the whole pill is the drag surface, so a dead zone
  // separates a click (expand) from a drag (reposition). `suppressClickRef`
  // swallows the click event that follows a real drag; it is re-armed on every
  // new press so a cancelled drag can never eat a later click.
  const pillDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    size: DevBoxSize;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const onPillDragStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    suppressClickRef.current = false;
    const rect = panel.getBoundingClientRect();
    pillDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      size: { width: rect.width, height: rect.height },
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in some headless/test environments.
    }
  };
  const onPillDragMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = pillDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) {
      return;
    }
    drag.moved = true;
    update({
      position: clampPosition(
        { x: event.clientX - drag.dx, y: event.clientY - drag.dy },
        drag.size,
      ),
    });
  };
  const onPillDragEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = pillDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    pillDragRef.current = null;
  };

  if (state.hidden) return null;

  return (
    <>
      <div
        ref={panelRef}
        data-devbox
        role="region"
        aria-label="Meltiply DevBox"
        className={cn(
          "fixed z-[2147483000] font-sans text-ink",
          state.position === null && "bottom-4 left-4",
          state.collapsed
            ? "rounded-full border border-tooltip-border bg-tooltip-bg text-tooltip-fg shadow-overlay"
            : "max-h-(--overlay-max-height) w-[380px] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-window border border-line bg-surface shadow-overlay",
        )}
        style={state.position ? { left: state.position.x, top: state.position.y } : undefined}
      >
        {state.collapsed ? (
          <button
            type="button"
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              update({ collapsed: false });
            }}
            onPointerDown={onPillDragStart}
            onPointerMove={onPillDragMove}
            onPointerUp={onPillDragEnd}
            onPointerCancel={onPillDragEnd}
            className="flex cursor-grab touch-none items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium active:cursor-grabbing"
            aria-label="Expand DevBox"
          >
            <Wrench className="size-3.5" aria-hidden />
            DevBox
          </button>
        ) : (
          <div className="flex flex-col">
            <div
              className="flex cursor-grab touch-none items-center gap-1 rounded-t-window border-b border-line bg-inset px-2 py-1.5 active:cursor-grabbing"
              onPointerDown={onDragStart}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
            >
              <GripVertical className="size-3.5 text-ink-3" aria-hidden />
              <span className="text-[12px] font-semibold">DevBox</span>
              <span className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label="Collapse DevBox"
                  onClick={() => update({ collapsed: true })}
                  className="rounded-chip p-1 text-ink-3 hover:bg-hover hover:text-ink"
                >
                  <Minus className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="Hide DevBox"
                  onClick={() => update({ hidden: true })}
                  className="rounded-chip p-1 text-ink-3 hover:bg-hover hover:text-ink"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </span>
            </div>

            <Tabs
              value={state.tab}
              onValueChange={(tab) =>
                // Radix only emits registered trigger values, so the string is already a DevBoxTab.
                update({ tab: tab as DevBoxTab })
              }
            >
              <TabsList
                aria-label="DevBox tools"
                className="h-auto justify-start gap-1 rounded-none border-b border-line bg-transparent px-2 py-1.5 text-inherit"
                indicatorClassName="inset-y-1.5 rounded-control border-transparent bg-ink shadow-none"
              >
                {devBoxTabs.map((tab) => (
                  <TabsTrigger
                    key={tab}
                    value={tab}
                    className="rounded-control px-2 py-1 text-[12px] font-medium text-ink-3 transition-colors hover:bg-hover hover:text-ink-2 data-[state=active]:text-surface data-[state=active]:hover:bg-transparent"
                  >
                    {tabLabels[tab]}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent
                value="skeletons"
                className="mt-0 max-h-[420px] overflow-y-auto p-3 focus-visible:ring-0"
              >
                <SkeletonsTab
                  latency={state.latency}
                  onLatencyChange={(latency) => update({ latency })}
                  queryClient={queryClient}
                  agentation={state.agentation}
                  onAgentationChange={(agentation) => update({ agentation })}
                />
              </TabsContent>
              <TabsContent
                value="benchmark"
                className="mt-0 max-h-[420px] overflow-y-auto p-3 focus-visible:ring-0"
              >
                <BenchmarkTab />
              </TabsContent>
              <TabsContent
                value="trace"
                className="mt-0 max-h-[420px] overflow-y-auto p-3 focus-visible:ring-0"
              >
                <TraceTab queryClient={queryClient} />
              </TabsContent>
              <TabsContent
                value="helpers"
                className="mt-0 max-h-[420px] overflow-y-auto p-3 focus-visible:ring-0"
              >
                <HelpersTab />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </div>

      {state.agentation && functionalConsent && (
        <Suspense fallback={<Skeleton className="fixed bottom-4 right-4 h-8 w-24 rounded-full" />}>
          <LazyAgentation
            copyToClipboard={false}
            onCopy={(markdown) => {
              // Agentation hands off the markdown because its own clipboard
              // write is disabled; the shared copyText handles insecure-origin
              // fallbacks. Surface the outcome through Sileo — Agentation's
              // toolbar gives no visible copy feedback of its own.
              void copyText(markdown)
                .then(() =>
                  toast("Feedback copied to clipboard", {
                    description: "Paste it into an issue or message to share it.",
                    variant: "success",
                  }),
                )
                .catch((error: unknown) => {
                  console.error("Failed to copy feedback to clipboard:", error);
                  toast("Could not copy feedback", {
                    description: "Clipboard access failed — select the text and copy it manually.",
                    variant: "error",
                  });
                });
            }}
          />
        </Suspense>
      )}
    </>
  );
}
