export const authRefreshRequestEvent = "meltiply:auth-refresh-request";
export const authSessionRefreshedEvent = "meltiply:auth-session-refreshed";
export const runtimeStatusEvent = "meltiply:runtime-status";

type RuntimeStatusKind =
  | "active-organization"
  | "auth-expired"
  | "maintenance"
  | "offline"
  | "recoverable";

export interface RuntimeStatusDetail {
  kind: RuntimeStatusKind;
  message: string;
  requestId?: string | null;
}

/**
 * Dispatches a global runtime status notification (or clears it with `null`).
 * Listened to by the application shell's `RuntimeStatus` banner to present offline,
 * maintenance, recoverable, or session expiry overlays.
 *
 * @param detail Notice payload describing the status kind, message, and optional request ID, or `null` to clear.
 */
export function dispatchRuntimeStatus(detail: RuntimeStatusDetail | null) {
  window.dispatchEvent(new CustomEvent(runtimeStatusEvent, { detail }));
}
