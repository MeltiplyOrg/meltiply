import { describe, expect, it } from "vite-plus/test";

import type { RateLimitBudget } from "../src/rate-limit";
import { extractRateLimitBudget } from "../src/rate-limit";

const metaPlatforms = ["facebook", "instagram", "threads"] as const;
const allPlatforms = [...metaPlatforms, "tiktok", "youtube"] as const;

/** Every unstated field of an extracted budget must be reported as unknown. */
function budget(patch: Partial<RateLimitBudget>): RateLimitBudget {
  return {
    percentUsed: null,
    remaining: null,
    resetsInSeconds: null,
    ...patch,
  };
}

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

function appUsage(value: unknown): Headers {
  return headers({ "x-app-usage": JSON.stringify(value) });
}

describe("extractRateLimitBudget", () => {
  it("reads the Meta call-count percentage for every Meta platform", () => {
    const usage = appUsage({
      call_count: 27,
      total_cputime: 12,
      total_time: 19,
    });

    for (const platform of metaPlatforms) {
      expect(extractRateLimitBudget(platform, usage)).toEqual(budget({ percentUsed: 27 }));
    }
  });

  it("keeps a zero-usage Meta window distinct from an unknown budget", () => {
    expect(
      extractRateLimitBudget(
        "instagram",
        appUsage({ call_count: 0, total_cputime: 0, total_time: 0 }),
      ),
    ).toEqual(budget({ percentUsed: 0 }));
  });

  it("reports no remaining Meta calls when any metric reaches the ceiling", () => {
    expect(
      extractRateLimitBudget(
        "facebook",
        appUsage({ call_count: 92, total_cputime: 100, total_time: 41 }),
      ),
    ).toEqual(budget({ percentUsed: 92, remaining: 0 }));
  });

  it("clamps an over-range Meta percentage to the documented ceiling", () => {
    expect(extractRateLimitBudget("threads", appUsage({ call_count: 137 }))).toEqual(
      budget({ percentUsed: 100, remaining: 0 }),
    );
  });

  it("takes the highest business use case usage across assets", () => {
    const extracted = extractRateLimitBudget(
      "instagram",
      headers({
        "x-app-usage": JSON.stringify({ call_count: 10 }),
        "x-business-use-case-usage": JSON.stringify({
          "1789": [{ call_count: 44, total_cputime: 8, total_time: 12 }],
          "9012": [{ call_count: 61, total_cputime: 9, total_time: 15 }],
        }),
      }),
    );

    expect(extracted).toEqual(budget({ percentUsed: 61 }));
  });

  it("reads business use case usage without an app usage header", () => {
    expect(
      extractRateLimitBudget(
        "threads",
        headers({
          "x-business-use-case-usage": JSON.stringify({
            "1789": [{ call_count: 100 }],
          }),
        }),
      ),
    ).toEqual(budget({ percentUsed: 100, remaining: 0 }));
  });

  it("ignores malformed Meta usage headers", () => {
    for (const value of [
      "not-json",
      "[1,2,3]",
      '"25"',
      "null",
      "",
      `{"call_count":${"9".repeat(8_200)}}`,
    ]) {
      expect(extractRateLimitBudget("facebook", headers({ "x-app-usage": value }))).toBeNull();
    }
  });

  it("ignores non-numeric and non-finite Meta usage metrics", () => {
    expect(
      extractRateLimitBudget(
        "facebook",
        appUsage({ call_count: "48", total_cputime: null, total_time: -3 }),
      ),
    ).toBeNull();
    expect(extractRateLimitBudget("facebook", headers({ "x-app-usage": "{}" }))).toBeNull();
  });

  it("ignores malformed business use case entries", () => {
    expect(
      extractRateLimitBudget(
        "instagram",
        headers({
          "x-business-use-case-usage": JSON.stringify({
            "1789": "not-an-array",
            "9012": [null, 7],
          }),
        }),
      ),
    ).toBeNull();
  });

  it("reads the standard TikTok rate limit headers", () => {
    expect(
      extractRateLimitBudget(
        "tiktok",
        headers({
          "x-ratelimit-remaining": "17",
          "x-ratelimit-reset": "600",
        }),
      ),
    ).toEqual(budget({ remaining: 17, resetsInSeconds: 600 }));
  });

  it("reads the standard YouTube rate limit headers", () => {
    expect(
      extractRateLimitBudget(
        "youtube",
        headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "86400",
        }),
      ),
    ).toEqual(budget({ remaining: 0, resetsInSeconds: 86_400 }));
  });

  it("keeps a partial standard budget when only one header is present", () => {
    expect(extractRateLimitBudget("tiktok", headers({ "x-ratelimit-remaining": "5" }))).toEqual(
      budget({ remaining: 5 }),
    );
    expect(extractRateLimitBudget("youtube", headers({ "x-ratelimit-reset": "30" }))).toEqual(
      budget({ resetsInSeconds: 30 }),
    );
  });

  it("ignores invalid, fractional, signed, and over-range header values", () => {
    for (const value of ["", "  ", "NaN", "12.5", "-4", "1e3", "many", "0x10"]) {
      expect(
        extractRateLimitBudget(
          "tiktok",
          headers({
            "x-ratelimit-remaining": value,
            "x-ratelimit-reset": value,
          }),
        ),
      ).toBeNull();
    }
    expect(
      extractRateLimitBudget(
        "youtube",
        headers({
          "x-ratelimit-remaining": "1000000001",
          "x-ratelimit-reset": "86401",
        }),
      ),
    ).toBeNull();
  });

  it("ignores Meta usage headers on standard-header platforms", () => {
    expect(extractRateLimitBudget("tiktok", appUsage({ call_count: 80 }))).toBeNull();
  });

  it("returns null when a response carries no budget headers", () => {
    for (const platform of allPlatforms) {
      expect(extractRateLimitBudget(platform, headers({}))).toBeNull();
      expect(extractRateLimitBudget(platform, headers({ "x-request-id": "req-1" }))).toBeNull();
    }
  });
});
