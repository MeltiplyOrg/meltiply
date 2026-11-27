import { describe, expect, it } from "vite-plus/test";

import {
  accountStatus,
  analyticsTerminalAgeSeconds,
  codePointLength,
  errorMessage,
  isAcceptedMediaType,
  isAccountUsable,
  isDevelopmentEnvironment,
  isLoopbackHostname,
  isPlatform,
  isRequestScopedDatabasePool,
  isUuid,
  isoDateTime,
  isoDateTimeOrNull,
  isoPeriodKey,
  maximumDelayedDeliverySeconds,
  mediaUploadExtension,
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
    expect(isoPeriodKey(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01");
    expect(isoPeriodKey()).toMatch(/^\d{4}-\d{2}$/);
  });

  it("validates UUIDs, development environments, loopback hosts, and media extensions", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isDevelopmentEnvironment("local")).toBe(true);
    expect(isDevelopmentEnvironment({ ENVIRONMENT: "test" })).toBe(true);
    expect(isDevelopmentEnvironment({ ENVIRONMENT: "production" })).toBe(false);
    expect(isDevelopmentEnvironment(undefined)).toBe(false);
    expect(isRequestScopedDatabasePool({ ENVIRONMENT: "local" })).toBe(true);
    expect(
      isRequestScopedDatabasePool({ DATABASE_POOL_MODE: "request", ENVIRONMENT: "production" }),
    ).toBe(true);
    expect(isRequestScopedDatabasePool({ ENVIRONMENT: "production" })).toBe(false);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("sub.localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);
    expect(mediaUploadExtension("image/jpeg")).toBe("jpg");
    expect(mediaUploadExtension("application/octet-stream")).toBeNull();
  });

  it("derives account status and usability consistently across expiry and revocation", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    const farFuture = "2026-07-01T00:00:00Z";
    const soon = "2026-06-02T00:00:00Z";
    const past = "2026-05-31T23:59:59Z";

    expect(accountStatus({ connection_status: "connected", token_expires_at: null }, now)).toBe(
      "connected",
    );
    expect(
      accountStatus({ connection_status: "connected", token_expires_at: farFuture }, now),
    ).toBe("connected");
    expect(accountStatus({ connection_status: "connected", token_expires_at: soon }, now)).toBe(
      "expiring",
    );
    expect(accountStatus({ connection_status: "expiring", token_expires_at: farFuture }, now)).toBe(
      "expiring",
    );
    expect(accountStatus({ connection_status: "expiring", token_expires_at: past }, now)).toBe(
      "expired",
    );
    expect(
      accountStatus(
        { connection_status: "connected", revoked_at: past, token_expires_at: farFuture },
        now,
      ),
    ).toBe("revoked");
    expect(accountStatus({ connection_status: "reconnect_required" }, now)).toBe(
      "reconnect_required",
    );

    expect(isAccountUsable({ connection_status: "connected", token_expires_at: null }, now)).toBe(
      true,
    );
    expect(isAccountUsable({ connection_status: "connected", token_expires_at: soon }, now)).toBe(
      true,
    );
    expect(isAccountUsable({ connection_status: "expiring", token_expires_at: soon }, now)).toBe(
      true,
    );
    expect(isAccountUsable({ connection_status: "expiring", token_expires_at: past }, now)).toBe(
      false,
    );
    expect(
      isAccountUsable(
        { connection_status: "connected", revoked_at: past, token_expires_at: farFuture },
        now,
      ),
    ).toBe(false);
    expect(isAccountUsable({ connection_status: "reconnect_required" }, now)).toBe(false);
  });
});
