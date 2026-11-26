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
import { clearHelpersDom, HelpersTab } from "./helpers-tab";
import { clearLayoutOverlays } from "./layout-overlays";
import { clearViewportFrame } from "./viewport-frame";
import { SkeletonsTab } from "./skeletons-tab";
import { TraceTab } from "./trace-tab";
import { RoutesTab } from "./routes-tab";

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
      continue;
    }
  }
}

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
  trace: "Trace",
  helpers: "Helpers",
  routes: "Routes",
  preview: "Preview",
};

function measureDock(panel: HTMLDivElement | null): DevBoxSize | null {
  if (!panel) return null;
  const rect = panel.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null;
}

function clampPosition(position: DevBoxPosition, size: DevBoxSize): DevBoxPosition {
  return clampDevBoxPosition(position, size, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

function clearPageMutations(): void {
  clearLayoutOverlays();
  clearViewportFrame();
  clearHelpersDom();
  setPseudoLocalization(false);
}

export function DevBox({
  previewControls,
}: {
  previewControls?: React.ReactNode;
}): React.ReactElement | null {
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
  const tabs = devBoxTabs.filter((tab) => tab !== "preview" || previewControls);
  const activeTab = state.tab === "preview" && !previewControls ? "skeletons" : state.tab;

  const hasInteractedRef = useRef(false);
  const update = useCallback((patch: Partial<DevBoxState>) => {
    hasInteractedRef.current = true;
    setState((current) => ({ ...current, ...patch }));
  }, []);

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
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
    const timer = window.setTimeout(() => writeDevBoxState(state), 150);
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(() => () => writeDevBoxState(stateRef.current), []);
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

  useEffect(() => {
    installNetworkThrottle();
    return () => uninstallNetworkThrottle();
  }, []);
  useEffect(() => setThrottleLatency(state.latency), [state.latency]);

  useEffect(() => {
    if (state.hidden) clearPageMutations();
  }, [state.hidden]);
  useEffect(() => clearPageMutations, []);

  useHotkey(hotkeys.devBox, () => update({ hidden: !state.hidden }));
  const onDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
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
      return;
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
      return;
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
          "fixed z-(--z-devbox) font-sans text-ink",
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

            <Tabs value={activeTab} onValueChange={(tab) => update({ tab: tab as DevBoxTab })}>
              <TabsList
                aria-label="DevBox tools"
                className="h-auto flex-nowrap justify-start gap-1 overflow-x-auto rounded-none border-b border-line bg-transparent px-2 py-1.5 text-inherit"
                indicatorClassName="inset-y-1.5 rounded-control border-transparent bg-ink shadow-none"
              >
                {tabs.map((tab) => (
                  <TabsTrigger
                    key={tab}
                    value={tab}
                    className="shrink-0 rounded-control px-1.5 py-1 text-[11px] font-medium whitespace-nowrap text-ink-3 transition-colors hover:bg-hover hover:text-ink-2 data-[state=active]:text-surface data-[state=active]:hover:bg-transparent"
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
              <TabsContent
                value="routes"
                className="mt-0 max-h-[420px] overflow-y-auto p-3 focus-visible:ring-0"
              >
                <RoutesTab />
              </TabsContent>
              {previewControls && (
                <TabsContent
                  value="preview"
                  className="mt-0 max-h-[420px] overflow-y-auto p-3 focus-visible:ring-0"
                >
                  {previewControls}
                </TabsContent>
              )}
            </Tabs>
          </div>
        )}
      </div>

      {state.agentation && functionalConsent && (
        <Suspense fallback={<Skeleton className="fixed bottom-4 right-4 h-8 w-24 rounded-full" />}>
          <LazyAgentation
            copyToClipboard={false}
            onCopy={(markdown) => {
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
