import { describe, expect, it } from "vite-plus/test";

import {
  analyticsTerminalAgeSeconds,
  errorMessage,
  isAcceptedMediaType,
  isPlatform,
  isoDateTime,
  isoDateTimeOrNull,
  maximumDelayedDeliverySeconds,
  oauthCallbackPath,
  unavailableCapabilities,
} from "../src";

describe("provider capability baseline", () => {
  it("returns one truthful unavailable row for every target provider", () => {
    const capabilities = unavailableCapabilities();
    expect(capabilities.map((item) => item.platform)).toEqual([
      "tiktok",
      "youtube",
      "instagram",
      "facebook",
      "threads",
    ]);
    expect(
      capabilities.every(
        (item) =>
          !item.connect_available &&
          !item.publish &&
          !item.analytics &&
          !item.comments &&
          !item.reply,
      ),
    ).toBe(true);
  });
});

describe("platform paths", () => {
  it("oauthCallbackPath builds the canonical callback URL path", () => {
    expect(oauthCallbackPath("tiktok")).toBe("/api/v1/platforms/tiktok/callback");
    expect(oauthCallbackPath("youtube")).toBe("/api/v1/platforms/youtube/callback");
  });
});

describe("due work horizons", () => {
  it("terminates analytics scheduling beyond the delayed-delivery horizon", () => {
    expect(analyticsTerminalAgeSeconds).toBeGreaterThan(maximumDelayedDeliverySeconds);
  });
});

describe("domain primitives and guards", () => {
  it("narrows platforms and accepted media types safely", () => {
    expect(isPlatform("tiktok")).toBe(true);
    expect(isPlatform("unknown")).toBe(false);
    expect(isPlatform(null)).toBe(false);
    expect(isAcceptedMediaType("image/png")).toBe(true);
    expect(isAcceptedMediaType("toString")).toBe(false);
    expect(isAcceptedMediaType(undefined)).toBe(false);
  });

  it("extracts messages with fallback and normalizes ISO timestamps", () => {
    expect(errorMessage(new Error("boom"), "fallback")).toBe("boom");
    expect(errorMessage(new Error(""), "fallback")).toBe("fallback");
    expect(errorMessage("raw", "fallback")).toBe("fallback");
    expect(isoDateTime(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(isoDateTime("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(isoDateTimeOrNull(null)).toBeNull();
    expect(isoDateTimeOrNull("not-a-date")).toBeNull();
    expect(isoDateTimeOrNull("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
  });
});
