import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ApiError } from "@/lib/api";
import { reportFrontendError } from "@/lib/frontend-telemetry";

import { reportQueryError, transportStatus } from "./providers";

vi.mock("@/lib/frontend-telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontend-telemetry")>()),
  reportFrontendError: vi.fn(),
}));

describe("reportQueryError", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(reportFrontendError).mockClear();
  });

  it("leaves an API failure to its own api-error record", () => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));

    reportQueryError(new ApiError(new Response(null, { status: 404 }), null));

    expect(reportFrontendError).not.toHaveBeenCalled();
  });

  it("reports a client failure as one query-cache exception", () => {
    vi.stubGlobal("window", new EventTarget());
    const failure = new RangeError("bad index");

    reportQueryError(failure);

    expect(reportFrontendError).toHaveBeenCalledTimes(1);
    expect(reportFrontendError).toHaveBeenCalledWith(failure, "query-cache");
  });
});

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
