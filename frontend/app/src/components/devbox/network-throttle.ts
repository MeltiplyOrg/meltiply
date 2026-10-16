import type { DevBoxLatency } from "./devbox-state";

/**
 * Dev-only network throttle installed by the DevBox dock.
 *
 * Wraps `globalThis.fetch` once per session so every HTTP path — the generated
 * API client, Better Auth calls, uploads, and telemetry — observes the same
 * artificial latency. Two independent controls:
 *
 * - **Latency**: delays every request by 0/300/1500 ms, or `"infinite"` which
 *   holds requests until aborted (simulates a dead connection).
 * - **Skeleton preview**: holds GET/HEAD requests until Rendered is selected,
 *   while leaving mutations untouched so native query-loading components stay
 *   visible without freezing writes.
 *
 * Held requests still reject on `AbortSignal` so TanStack Query cancellation
 * and component unmounts never leak promises.
 */

type FetchLike = typeof globalThis.fetch;

let originalFetch: FetchLike | null = null;
let latency: DevBoxLatency = 0;
let skeletonHold = false;
let installed = false;

/**
 * Returns a promise that resolves after `ms`, or rejects when the abort signal
 * fires. `null` ms models infinite latency and can only settle via abort.
 */
function waitForLatency(ms: number | null, signal: AbortSignal | null | undefined): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = ms === null ? undefined : setTimeout(resolve, ms);
  if (signal?.aborted) {
    clearTimeout(timer);
    reject(signal.reason);
    return promise;
  }
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      reject(signal.reason);
    },
    { once: true },
  );
  return promise;
}

const skeletonWaiters = new Set<() => void>();

/**
 * Waits for the Skeleton preview to be released or for query cancellation.
 * Each waiter unregisters on either outcome, so route changes cannot retain
 * pending promises; selecting Rendered resolves every currently held read.
 */
function waitForSkeletonRelease(signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const release = () => {
      signal?.removeEventListener("abort", abort);
      skeletonWaiters.delete(release);
      resolve();
    };
    const abort = () => {
      skeletonWaiters.delete(release);
      reject(signal?.reason);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    skeletonWaiters.add(release);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Determines whether a request should be held by the skeleton freeze.
 * Only idempotent reads (GET/HEAD, the default) are held; mutations must keep
 * flowing so the workspace stays usable while skeletons are pinned.
 */
function isReadRequest(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  return method === "GET" || method === "HEAD";
}

/**
 * The installed fetch wrapper. Infinite latency holds every method; Skeleton
 * preview holds only reads until it is released; finite latency otherwise
 * delays before delegating to the captured native fetch.
 */
const throttledFetch: FetchLike = (input, init) => {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
  const base = originalFetch ?? globalThis.fetch;
  if (latency === "infinite") {
    return waitForLatency(null, signal).then(() => base(input, init));
  }
  if (skeletonHold && isReadRequest(input, init)) {
    return waitForSkeletonRelease(signal).then(() => base(input, init));
  }
  if (latency === 0) return base(input, init);
  return waitForLatency(latency, signal).then(() => base(input, init));
};

/**
 * Installs the fetch wrapper. Idempotent: repeated calls keep the original
 * fetch reference so uninstall always restores the true native function.
 */
export function installNetworkThrottle(): void {
  if (installed) return;
  originalFetch = globalThis.fetch;
  globalThis.fetch = throttledFetch;
  installed = true;
}

/**
 * Restores the native fetch and releases any Skeleton-preview read waiters.
 * Safe to call when not installed; teardown must not leave query promises
 * pending after the DevBox is removed.
 */
export function uninstallNetworkThrottle(): void {
  if (!installed) return;
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
  installed = false;
  setSkeletonHold(false);
  latency = 0;
}

/**
 * Selects the artificial latency applied to every request.
 */
export function setThrottleLatency(next: DevBoxLatency): void {
  latency = next;
}

/**
 * Returns the currently configured latency.
 */
export function getThrottleLatency(): DevBoxLatency {
  return latency;
}

/**
 * Enables Skeleton preview or releases its pending reads. Enabling holds new
 * GET/HEAD requests; disabling resolves all current holds so query refetches
 * may render normally again.
 */
export function setSkeletonHold(enabled: boolean): void {
  skeletonHold = enabled;
  if (enabled) return;
  for (const release of skeletonWaiters) release();
}

/**
 * Reports whether the skeleton hold is active.
 */
export function isSkeletonHoldActive(): boolean {
  return skeletonHold;
}
