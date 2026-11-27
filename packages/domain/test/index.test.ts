import { describe, expect, it } from "vite-plus/test";

import {
  accountStatus,
  analyticsTerminalAgeSeconds,
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
