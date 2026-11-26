import { describe, expect, it } from "vite-plus/test";

import {
  analyticsTerminalAgeSeconds,
  codePointLength,
  errorMessage,
  isoDateTime,
  isoDateTimeOrNull,
  isPlatform,
  maximumDelayedDeliverySeconds,
  oauthCallbackPath,
  unavailableCapabilities,
} from "../src";

describe("unavailableCapabilities", () => {
  it("with no provider configured", () => {
    const unavailable = {
      accepted_mime_types: [],
      analytics: false,
      asset_types: [],
      comments: false,
      connect_available: false,
      max_caption_length: null,
      max_file_size: null,
      max_hashtags: null,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: 0,
      multi_asset_types: [],
      notes: ["Provider configuration and live capability acceptance are pending."],
      publish: false,
      reply: false,
    };

    expect(unavailableCapabilities()).toEqual([
      { ...unavailable, platform: "tiktok" },
      { ...unavailable, platform: "youtube" },
      { ...unavailable, platform: "instagram" },
      { ...unavailable, platform: "facebook" },
      { ...unavailable, platform: "threads" },
    ]);
  });
});

describe("oauthCallbackPath", () => {
  it.each([
    ["tiktok", "/api/v1/platforms/tiktok/callback"],
    ["youtube", "/api/v1/platforms/youtube/callback"],
  ] as const)("%s", (platform, path) => {
    expect(oauthCallbackPath(platform)).toEqual(path);
  });
});

describe("isPlatform", () => {
  it.each([
    ["a listed platform", "tiktok", true],
    ["an unlisted name", "unknown", false],
    ["a null value", null, false],
  ])("%s", (_example, value, expected) => {
    expect(isPlatform(value)).toEqual(expected);
  });
});

describe("codePointLength", () => {
  it.each([
    ["an empty string", "", 0],
    ["ASCII text", "hello", 5],
    ["one astral character", "🚀", 1],
    ["a joined emoji sequence", "🚀a👨‍👩‍👧", 7],
    ["a high surrogate at the end", "\uD800", 1],
    ["a high surrogate before a letter", "\uD800a", 2],
    ["a low surrogate alone", "\uDC00", 1],
    ["the highest surrogate pair", "\uDBFF\uDFFF", 1],
    ["a unit just below the high surrogates", "\uD7FF\uDC00", 2],
    ["two high surrogates", "\uD800\uDBFF", 2],
    ["a unit just above the low surrogates", "\uD800\uE000", 2],
  ])("%s", (_example, text, length) => {
    expect(codePointLength(text)).toEqual(length);
  });
});

describe("errorMessage", () => {
  it.each([
    ["an error with a message", new Error("boom"), "boom"],
    ["an error with an empty message", new Error(""), "fallback"],
    ["a thrown string", "raw", "fallback"],
  ])("%s", (_example, cause, message) => {
    expect(errorMessage(cause, "fallback")).toEqual(message);
  });
});

describe("isoDateTime", () => {
  it.each([
    ["a date", new Date("2026-01-02T03:04:05.000Z")],
    ["a timestamp without milliseconds", "2026-01-02T03:04:05Z"],
    ["a timestamp with an offset", "2026-01-02T10:04:05+07:00"],
  ])("%s", (_example, value) => {
    expect(isoDateTime(value)).toEqual("2026-01-02T03:04:05.000Z");
  });

  it("an unparseable string", () => {
    expect(() => isoDateTime("not-a-date")).toThrow(RangeError);
  });
});

describe("isoDateTimeOrNull", () => {
  it.each([
    ["a date", new Date("2026-01-02T03:04:05.000Z"), "2026-01-02T03:04:05.000Z"],
    ["a timestamp string", "2026-01-02T03:04:05Z", "2026-01-02T03:04:05.000Z"],
    ["a null value", null, null],
    ["no value", undefined, null],
    ["an unparseable string", "not-a-date", null],
    ["an invalid date", new Date("not-a-date"), null],
  ])("%s", (_example, value, expected) => {
    expect(isoDateTimeOrNull(value)).toEqual(expected);
  });
});

describe("due work horizons", () => {
  it("analytics stops beyond the delayed-delivery horizon", () => {
    expect(analyticsTerminalAgeSeconds).toBeGreaterThan(maximumDelayedDeliverySeconds);
  });
});
