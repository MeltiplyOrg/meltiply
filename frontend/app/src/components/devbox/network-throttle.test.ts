import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  installNetworkThrottle,
  setSkeletonHold,
  setThrottleLatency,
  uninstallNetworkThrottle,
} from "./network-throttle";

const URL_UNDER_TEST = "https://example.test/";
let sent: string[];

const record: typeof fetch = (_input, init) => {
  sent.push(init?.method ?? "GET");
  return Promise.resolve(new Response("ok"));
};

beforeAll(() => {
  void new Response("ok");
  void new Request(URL_UNDER_TEST);
});

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", record);
  installNetworkThrottle();
});

afterEach(() => {
  uninstallNetworkThrottle();
  vi.unstubAllGlobals();
});

describe("network throttle", () => {
  it("no latency", async () => {
    await fetch(URL_UNDER_TEST);

    expect(sent).toEqual(["GET"]);
  });

  it("a short latency", async () => {
    setThrottleLatency(1 as never);

    const pending = fetch(URL_UNDER_TEST);
    const sentBeforeDelay = [...sent];
    await pending;

    expect(sentBeforeDelay).toEqual([]);
    expect(sent).toEqual(["GET"]);
  });

  it("infinite latency holds a request", async () => {
    setThrottleLatency("infinite");

    void fetch(URL_UNDER_TEST);
    await Promise.resolve();

    expect(sent).toEqual([]);
  });

  it("a held request released by a new latency", async () => {
    setThrottleLatency("infinite");
    const pending = fetch(URL_UNDER_TEST);

    setThrottleLatency(0);
    await pending;

    expect(sent).toEqual(["GET"]);
  });

  it("a held request released by uninstalling", async () => {
    setThrottleLatency("infinite");
    const pending = fetch(URL_UNDER_TEST);

    uninstallNetworkThrottle();
    await pending;

    expect(sent).toEqual(["GET"]);
  });

  it("a held request that is aborted", async () => {
    setThrottleLatency("infinite");
    const controller = new AbortController();
    const pending = fetch(URL_UNDER_TEST, { signal: controller.signal });

    controller.abort(new Error("left the page"));

    await expect(pending).rejects.toEqual(new Error("left the page"));
    expect(sent).toEqual([]);
  });

  it("a request aborted before it starts", async () => {
    setThrottleLatency("infinite");

    const pending = fetch(URL_UNDER_TEST, { signal: AbortSignal.abort(new Error("gone")) });

    await expect(pending).rejects.toEqual(new Error("gone"));
  });

  it("a skeleton hold lets writes through and holds reads", async () => {
    setSkeletonHold(true);

    void fetch(URL_UNDER_TEST);
    await fetch(URL_UNDER_TEST, { method: "POST" });

    expect(sent).toEqual(["POST"]);
  });

  it("a read released from the skeleton hold", async () => {
    setSkeletonHold(true);
    const pending = fetch(URL_UNDER_TEST);

    setSkeletonHold(false);
    await pending;

    expect(sent).toEqual(["GET"]);
  });

  it("an aborted read in the skeleton hold", async () => {
    setSkeletonHold(true);
    const controller = new AbortController();
    const pending = fetch(URL_UNDER_TEST, { signal: controller.signal });

    controller.abort(new Error("left the page"));

    await expect(pending).rejects.toEqual(new Error("left the page"));
  });

  it("installing twice then uninstalling restores the original fetch", () => {
    installNetworkThrottle();

    uninstallNetworkThrottle();

    expect(globalThis.fetch).toBe(record);
  });
});
