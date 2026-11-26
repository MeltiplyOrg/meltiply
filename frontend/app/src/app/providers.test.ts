import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ApiError } from "@/lib/api";
import { frontendTelemetryEvent } from "@/lib/frontend-telemetry";
import { authRefreshRequestEvent, runtimeStatusEvent } from "@/lib/runtime-events";

import { reportQueryError, transportStatus } from "./providers";

const UNREACHABLE = {
  kind: "recoverable",
  message: "Meltiply could not reach the API. Check your connection and try again.",
};
const OFFLINE = { kind: "offline", message: "Changes are paused until your connection returns." };
const UNREFRESHED = {
  kind: "recoverable",
  message: "We could not refresh this view. Try again in a moment.",
};

describe("transportStatus", () => {
  it.each([
    ["an unreachable API while online", new TypeError("Failed to fetch"), true, UNREACHABLE],
    ["no connection", new TypeError("Load failed"), false, OFFLINE],
    ["another client failure", new RangeError("bad index"), true, UNREFRESHED],
  ])("%s", (_example, error, online, status) => {
    expect(transportStatus(error, online)).toEqual(status);
  });
});

describe("reportQueryError", () => {
  let seen: string[];
  let statuses: unknown[];

  beforeEach(() => {
    seen = [];
    statuses = [];
    const page = new EventTarget();
    for (const name of [authRefreshRequestEvent, frontendTelemetryEvent, runtimeStatusEvent]) {
      page.addEventListener(name, (event) => {
        seen.push(name);
        if (name === runtimeStatusEvent) statuses.push((event as CustomEvent).detail);
      });
    }
    vi.stubGlobal("window", page);
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(null)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function apiError(status: number, code: string, retryable: boolean) {
    const error = new ApiError(new Response(null, { status }), {
      error: { code, details: [], message: "never shown", request_id: "req", retryable },
    });
    seen.length = 0;
    return error;
  }

  it("an expired session", () => {
    reportQueryError(apiError(401, "token_expired", false));

    expect(seen).toEqual([authRefreshRequestEvent]);
  });

  it.each([
    [
      "no active workspace",
      403,
      "active_organization_required",
      false,
      { kind: "active-organization", message: "Choose an active workspace to continue." },
    ],
    [
      "an unavailable service",
      503,
      "dependency_unavailable",
      false,
      { kind: "maintenance", message: "An error has occurred." },
    ],
    [
      "a retryable failure",
      429,
      "rate_limited",
      true,
      { kind: "recoverable", message: "Too many requests. Wait a moment and try again." },
    ],
  ])("%s", (_example, status, code, retryable, shown) => {
    reportQueryError(apiError(status, code, retryable));

    expect(statuses).toEqual([shown]);
  });

  it("a final API failure", () => {
    reportQueryError(apiError(404, "not_found", false));

    expect(seen).toEqual([]);
  });

  it("a client failure", () => {
    reportQueryError(new RangeError("bad index"));

    expect(seen).toEqual([frontendTelemetryEvent, runtimeStatusEvent]);
    expect(statuses).toEqual([UNREFRESHED]);
  });
});
