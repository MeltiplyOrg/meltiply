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

export function dispatchRuntimeStatus(detail: RuntimeStatusDetail | null) {
  window.dispatchEvent(new CustomEvent(runtimeStatusEvent, { detail }));
}
