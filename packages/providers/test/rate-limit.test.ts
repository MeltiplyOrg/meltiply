import { PLATFORM_IDS } from "@meltiply/domain";
import { describe, expect, it } from "vite-plus/test";

import { extractRateLimitBudget } from "../src/rate-limit";

const metaPlatforms = PLATFORM_IDS.filter(
  (platform) => platform !== "tiktok" && platform !== "youtube",
);

const appUsage = (value: unknown) => ({ "x-app-usage": JSON.stringify(value) });
const businessUsage = (value: unknown) => ({ "x-business-use-case-usage": JSON.stringify(value) });
const usage = (percentUsed: number | null, remaining: number | null = null) => ({
  percentUsed,
  remaining,
  resetsInSeconds: null,
});

describe("extractRateLimitBudget", () => {
  it.each(metaPlatforms)("a %s call-count window", (platform) => {
    const headers = new Headers(appUsage({ call_count: 27, total_cputime: 12, total_time: 19 }));

    expect(extractRateLimitBudget(platform, headers)).toEqual(usage(27));
  });

  it.each([
    ["an unused Meta window", appUsage({ call_count: 0 }), usage(0)],
    [
      "another metric just under the ceiling",
      appUsage({ call_count: 5, total_time: 99 }),
      usage(5),
    ],
    ["a CPU metric at the ceiling", appUsage({ call_count: 92, total_cputime: 100 }), usage(92, 0)],
    ["a time metric at the ceiling", appUsage({ total_time: 100 }), usage(null, 0)],
    ["a call count over the ceiling", appUsage({ call_count: 137 }), usage(100, 0)],
    [
      "the highest of app and business usage",
      {
        ...appUsage({ call_count: 10 }),
        ...businessUsage({ "1789": [{ call_count: 44 }], "9012": [{ call_count: 61 }] }),
      },
      usage(61),
    ],
    ["business usage alone", businessUsage({ "1789": [{ call_count: 100 }] }), usage(100, 0)],
    [
      "a header of 8192 characters",
      appUsage({ call_count: 27, padding: "x".repeat(8_162) }),
      usage(27),
    ],
  ])("%s", (_example, values, budget) => {
    expect(extractRateLimitBudget("facebook", new Headers(values))).toEqual(budget);
  });

  it.each([
    ["no headers", {}],
    ["a header that is not JSON", { "x-app-usage": "not-json" }],
    ["a JSON array", { "x-app-usage": "[1,2,3]" }],
    ["a JSON string", { "x-app-usage": '"25"' }],
    ["a JSON null", { "x-app-usage": "null" }],
    ["an empty header", { "x-app-usage": "" }],
    ["an empty object", { "x-app-usage": "{}" }],
    ["a header of 8193 characters", appUsage({ call_count: 27, padding: "x".repeat(8_163) })],
    [
      "metrics that are not non-negative numbers",
      appUsage({ call_count: "48", total_cputime: null, total_time: -3 }),
    ],
    ["business entries that are not a list", businessUsage({ "1789": "not-an-array" })],
    ["business entries that are not objects", businessUsage({ "9012": [null, 7] })],
    ["only standard headers", { "x-ratelimit-remaining": "5" }],
  ])("a Meta response with %s", (_example, values) => {
    expect(extractRateLimitBudget("facebook", new Headers(values))).toEqual(null);
  });

  it.each([
    [
      "both standard headers",
      { "x-ratelimit-remaining": "17", "x-ratelimit-reset": "600" },
      17,
      600,
    ],
    ["an exhausted window", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "30" }, 0, 30],
    ["only the remaining header", { "x-ratelimit-remaining": " 5 " }, 5, null],
    ["only the reset header", { "x-ratelimit-reset": "30" }, null, 30],
    [
      "both values at their maximum",
      { "x-ratelimit-remaining": "1000000000", "x-ratelimit-reset": "86400" },
      1_000_000_000,
      86_400,
    ],
  ])("%s", (_example, values, remaining, resetsInSeconds) => {
    expect(extractRateLimitBudget("tiktok", new Headers(values))).toEqual({
      percentUsed: null,
      remaining,
      resetsInSeconds,
    });
  });

  it.each([
    ["no headers", {}],
    ["blank values", { "x-ratelimit-remaining": "  ", "x-ratelimit-reset": "" }],
    ["a word", { "x-ratelimit-remaining": "many" }],
    ["a fraction", { "x-ratelimit-remaining": "12.5" }],
    ["a negative number", { "x-ratelimit-remaining": "-4" }],
    ["an exponent", { "x-ratelimit-reset": "1e3" }],
    ["a hexadecimal number", { "x-ratelimit-reset": "0x10" }],
    ["a remaining count over its maximum", { "x-ratelimit-remaining": "1000000001" }],
    ["a reset over its maximum", { "x-ratelimit-reset": "86401" }],
    ["only Meta usage headers", appUsage({ call_count: 80 })],
  ])("a standard response with %s", (_example, values) => {
    expect(extractRateLimitBudget("youtube", new Headers(values))).toEqual(null);
  });
});
