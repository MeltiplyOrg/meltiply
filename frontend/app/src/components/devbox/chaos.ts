import { dispatchRuntimeStatus } from "@/lib/runtime-events";

/**
 * Chaos & fault simulators for the DevBox Helpers tab.
 *
 * Each trigger exercises a real user-facing failure path rather than mocking
 * the UI: auth expiry and offline go through the same `runtimeStatusEvent`
 * channel the API layer uses, and the crash button throws inside the React
 * tree so the root `FrontendErrorBoundary` fallback is what actually renders.
 */

/**
 * Simulates an expired auth session — the runtime status overlay shows the
 * "Your session expired" alert with its sign-in action.
 */
export function simulateAuthExpired(): void {
  dispatchRuntimeStatus({
    kind: "auth-expired",
    message: "Your session expired",
  });
}

/**
 * Simulates losing connectivity. `RuntimeStatus` listens to the native
 * offline/online events, so dispatching them exercises the real path.
 */
export function simulateOffline(offline: boolean): void {
  window.dispatchEvent(new Event(offline ? "offline" : "online"));
}

/**
 * Clears any active runtime status notice.
 */
export function clearRuntimeStatus(): void {
  dispatchRuntimeStatus(null);
}
