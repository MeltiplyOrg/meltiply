import { describe, expect, it } from "vite-plus/test";

import { transportStatus } from "./providers";

describe("transportStatus", () => {
  it("names an unreachable API when the browser is online", () => {
    expect(transportStatus(new TypeError("Failed to fetch"), true)).toEqual({
      kind: "recoverable",
      message: "Meltiply could not reach the API. Check your connection and try again.",
    });
  });

  it("reports the offline state when the browser has no connection", () => {
    expect(transportStatus(new TypeError("Load failed"), false)).toEqual({
      kind: "offline",
      message: "Changes are paused until your connection returns.",
    });
  });

  it("keeps the generic notice for unexpected client failures", () => {
    expect(transportStatus(new RangeError("bad index"), true)).toEqual({
      kind: "recoverable",
      message: "We could not refresh this view. Try again in a moment.",
    });
  });
});
