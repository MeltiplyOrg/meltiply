import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  installNetworkThrottle,
  setThrottleLatency,
  uninstallNetworkThrottle,
} from "./network-throttle";

afterEach(() => {
  uninstallNetworkThrottle();
  vi.unstubAllGlobals();
});

describe("DevBox network throttle", () => {
  it("releases requests held by infinite latency when the latency changes", async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", base);
    installNetworkThrottle();
    setThrottleLatency("infinite");

    const pending = fetch("https://example.test/");
    await Promise.resolve();
    expect(base).not.toHaveBeenCalled();

    setThrottleLatency(0);
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(base).toHaveBeenCalledOnce();
  });
});
