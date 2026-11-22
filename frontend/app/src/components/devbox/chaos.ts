import { dispatchRuntimeStatus } from "@/lib/runtime-events";

export function simulateAuthExpired(): void {
  dispatchRuntimeStatus({
    kind: "auth-expired",
    message: "Your session expired",
  });
}

export function simulateOffline(offline: boolean): void {
  window.dispatchEvent(new Event(offline ? "offline" : "online"));
}

export function clearRuntimeStatus(): void {
  dispatchRuntimeStatus(null);
}
