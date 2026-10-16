import type { QueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";

import { Skeleton } from "@meltiply/ui/skeleton";
import { useTheme } from "@/lib/theme";
import { cn } from "@meltiply/ui/utils";

import { appendDevBoxEvent, subscribeDevBoxEvents, type DevBoxEvent } from "./event-log";

// The official TanStack Query devtools panel is a devDependency loaded on
// demand — it never ships to production and only mounts while this tab is open.
const LazyQueryDevtools = lazy(async () => {
  const { ReactQueryDevtoolsPanel } = await import("@tanstack/react-query-devtools");
  return { default: ReactQueryDevtoolsPanel };
});

const severityClasses: Record<DevBoxEvent["severity"], string> = {
  error: "bg-red-tint text-red",
  warn: "bg-orange-tint text-orange",
  info: "bg-accent-tint text-accent-ink",
};

interface TraceTabProps {
  queryClient: QueryClient | null;
}

/**
 * Trace tab: embedded query cache inspector plus a live event stream.
 *
 * The official `ReactQueryDevtoolsPanel` covers query key filtering, fetch
 * statuses, observer counts, and manual refetch/invalidate/mutation controls.
 * Below it, a capped live log renders `meltiply:frontend-telemetry` and
 * runtime-status/auth events with severity badges and expandable payloads.
 */
export function TraceTab({ queryClient }: TraceTabProps): React.ReactElement {
  const [events, setEvents] = useState<DevBoxEvent[]>([]);
  const { theme } = useTheme();

  useEffect(
    () => subscribeDevBoxEvents((event) => setEvents((log) => appendDevBoxEvent(log, event))),
    [],
  );

  return (
    <div className="flex flex-col gap-3 text-[12px]">
      <div className="rounded-control border border-line">
        {queryClient ? (
          <Suspense fallback={<Skeleton className="h-40 w-full rounded-control" />}>
            <LazyQueryDevtools
              client={queryClient}
              theme={theme}
              style={{ height: "280px", width: "100%" }}
            />
          </Suspense>
        ) : (
          <p className="p-3 text-ink-3">Query client unavailable outside the workspace.</p>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="font-medium">Events</span>
        <button
          type="button"
          onClick={() => setEvents([])}
          className="rounded-control border border-line bg-inset px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-hover"
        >
          Clear
        </button>
      </div>

      {events.length === 0 ? (
        <p className="text-ink-3">No telemetry or runtime events yet.</p>
      ) : (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {[...events].reverse().map((event) => (
            <li key={event.id} className="rounded-control bg-inset px-2 py-1">
              <details>
                <summary className="flex cursor-pointer items-center gap-2">
                  <span
                    className={cn(
                      "rounded-chip px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                      severityClasses[event.severity],
                    )}
                  >
                    {event.severity}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2">
                    {event.summary}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-3">
                    {new Date(event.at).toLocaleTimeString()}
                  </span>
                </summary>
                <pre className="mt-1 max-h-32 overflow-auto rounded-chip bg-page p-1.5 font-mono text-[10px] text-ink-2">
                  {JSON.stringify({ channel: event.channel, detail: event.detail }, null, 2)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
