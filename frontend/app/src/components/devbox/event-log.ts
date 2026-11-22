import {
  authRefreshRequestEvent,
  authSessionRefreshedEvent,
  runtimeStatusEvent,
} from "@/lib/runtime-events";
import { frontendTelemetryEvent } from "@/lib/frontend-telemetry";

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function kindOf(detail: unknown): string | undefined {
  const record = asRecord(detail);
  return typeof record?.kind === "string" ? record.kind : undefined;
}

function severityFor(channel: string, detail: unknown): DevBoxEventSeverity {
  const kind = kindOf(detail);
  if (channel === frontendTelemetryEvent) {
    return kind === "api-error" || kind === "frontend-error" ? "error" : "warn";
  }
  if (channel === runtimeStatusEvent) {
    if (kind === "auth-expired" || kind === "maintenance") return "error";
    return "warn";
  }
  return "info";
}

function summarize(channel: string, detail: unknown): string {
  const record = asRecord(detail);
  if (channel === frontendTelemetryEvent) {
    const parts = [record?.kind, record?.code ?? record?.diagnosticCode, record?.status]
      .filter((part) => part !== undefined && part !== null)
      .join(" · ");
    return parts || "telemetry";
  }
  if (channel === runtimeStatusEvent) {
    if (detail === null) return "status cleared";
    return [record?.kind, record?.message].filter(Boolean).join(" — ") || "status";
  }
  return channel.replace("meltiply:", "");
}

export function subscribeDevBoxEvents(onEvent: (event: DevBoxEvent) => void): () => void {
  const handlers = watchedChannels.map((channel) => {
    const handler = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
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

export function appendDevBoxEvent(log: DevBoxEvent[], event: DevBoxEvent): DevBoxEvent[] {
  const next = [...log, event];
  return next.length > maxEvents ? next.slice(next.length - maxEvents) : next;
}
