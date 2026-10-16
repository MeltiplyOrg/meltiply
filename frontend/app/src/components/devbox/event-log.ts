import {
  authRefreshRequestEvent,
  authSessionRefreshedEvent,
  runtimeStatusEvent,
} from "@/lib/runtime-events";
import { frontendTelemetryEvent } from "@/lib/frontend-telemetry";

/**
 * Live event stream backing the DevBox Trace tab.
 *
 * Subscribes to the window-level CustomEvent channels the app already uses —
 * `meltiply:frontend-telemetry` (API errors, contract mismatches, diagnostics)
 * and `meltiply:runtime-status` plus the auth refresh pair — and renders them
 * as a capped, color-coded log with expandable payloads. Entries are capped at
 * 200 so a chatty session cannot grow memory unboundedly.
 */

type DevBoxEventSeverity = "error" | "warn" | "info";

export interface DevBoxEvent {
  id: number;
  at: number;
  channel: string;
  severity: DevBoxEventSeverity;
  summary: string;
  detail: unknown;
}

const maxEvents = 200;
const watchedChannels = [
  frontendTelemetryEvent,
  runtimeStatusEvent,
  authRefreshRequestEvent,
  authSessionRefreshedEvent,
] as const;

let nextId = 1;

/**
 * Maps a channel + payload to a display severity. Telemetry `api-error` and
 * `frontend-error` kinds and runtime `auth-expired`/`maintenance` notices are
 * errors; everything else on those channels is a warning, and the auth
 * refresh pair is informational.
 */
function severityFor(channel: string, detail: unknown): DevBoxEventSeverity {
  if (channel === frontendTelemetryEvent) {
    const kind = (detail as { kind?: string } | null)?.kind;
    return kind === "api-error" || kind === "frontend-error" ? "error" : "warn";
  }
  if (channel === runtimeStatusEvent) {
    const kind = (detail as { kind?: string } | null)?.kind;
    if (kind === "auth-expired" || kind === "maintenance") return "error";
    return "warn";
  }
  return "info";
}

/**
 * Builds the one-line summary shown in the log row: `kind · code · status`
 * for telemetry, `kind — message` for runtime status, and the bare channel
 * suffix for the auth refresh pair.
 */
function summarize(channel: string, detail: unknown): string {
  const record = (detail ?? {}) as Record<string, unknown>;
  if (channel === frontendTelemetryEvent) {
    const parts = [record.kind, record.code ?? record.diagnosticCode, record.status]
      .filter((part) => part !== undefined && part !== null)
      .join(" · ");
    return parts || "telemetry";
  }
  if (channel === runtimeStatusEvent) {
    if (detail === null) return "status cleared";
    return [record.kind, record.message].filter(Boolean).join(" — ") || "status";
  }
  return channel.replace("meltiply:", "");
}

/**
 * Subscribes to all watched channels. `onEvent` receives each new entry.
 * Returns an unsubscribe function removing every listener.
 */
export function subscribeDevBoxEvents(onEvent: (event: DevBoxEvent) => void): () => void {
  const handlers = watchedChannels.map((channel) => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      onEvent({
        id: nextId++,
        at: Date.now(),
        channel,
        severity: severityFor(channel, detail),
        summary: summarize(channel, detail),
        detail,
      });
    };
    window.addEventListener(channel, handler);
    return { channel, handler };
  });
  return () => {
    for (const { channel, handler } of handlers) window.removeEventListener(channel, handler);
  };
}

/**
 * Appends an entry to the bounded log, dropping the oldest beyond the cap.
 * Always returns a fresh array so React state updates re-render.
 */
export function appendDevBoxEvent(log: DevBoxEvent[], event: DevBoxEvent): DevBoxEvent[] {
  const next = [...log, event];
  return next.length > maxEvents ? next.slice(next.length - maxEvents) : next;
}
