import type { DevBoxLatency } from "./devbox-state";

type FetchLike = typeof globalThis.fetch;

let originalFetch: FetchLike | null = null;
let latency: DevBoxLatency = 0;
let skeletonHold = false;
let installed = false;

const latencyWaiters = new Set<() => void>();

function waitForLatency(ms: number | null, signal: AbortSignal | null | undefined): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;
  const onAbort = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    latencyWaiters.delete(release);
    reject(signal?.reason);
  };
  const release = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    latencyWaiters.delete(release);
    resolve();
  };
  const timer = ms === null ? undefined : setTimeout(release, ms);
  if (signal?.aborted) {
    onAbort();
    return promise;
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  latencyWaiters.add(release);
  return promise;
}

function releaseLatencyWaiters(): void {
  for (const release of [...latencyWaiters]) release();
}

const skeletonWaiters = new Set<() => void>();

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

function isReadRequest(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  return method === "GET" || method === "HEAD";
}

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

export function installNetworkThrottle(): void {
  if (installed) return;
  originalFetch = globalThis.fetch;
  globalThis.fetch = throttledFetch;
  installed = true;
}

export function uninstallNetworkThrottle(): void {
  if (!installed) return;
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
  installed = false;
  releaseLatencyWaiters();
  setSkeletonHold(false);
  latency = 0;
}

export function setThrottleLatency(next: DevBoxLatency): void {
  latency = next;
  if (next !== "infinite") releaseLatencyWaiters();
}

export function getThrottleLatency(): DevBoxLatency {
  return latency;
}

export function setSkeletonHold(enabled: boolean): void {
  skeletonHold = enabled;
  if (enabled) return;
  for (const release of skeletonWaiters) release();
}

export function isSkeletonHoldActive(): boolean {
  return skeletonHold;
}
