import { describe, expect, it } from "vite-plus/test";

import {
  AccessDenied,
  analyticsTerminalAgeSeconds,
  DomainError,
  maximumDelayedDeliverySeconds,
  oauthCallbackPath,
  overdueRecoveryGraceSeconds,
  PLATFORM_IDS,
  StorageUnavailable,
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

describe("platform roster", () => {
  it("PLATFORM_IDS is the canonical roster of supported Platforms", () => {
    expect(PLATFORM_IDS).toEqual(["tiktok", "youtube", "instagram", "facebook", "threads"]);
  });

  it("oauthCallbackPath builds the canonical callback URL path", () => {
    expect(oauthCallbackPath("tiktok")).toBe("/api/v1/platforms/tiktok/callback");
    expect(oauthCallbackPath("youtube")).toBe("/api/v1/platforms/youtube/callback");
  });
});

describe("due work constants", () => {
  it("defines delivery horizon and overdue recovery grace constants", () => {
    expect(maximumDelayedDeliverySeconds).toBe(86_400);
    expect(overdueRecoveryGraceSeconds).toBe(300);
  });

  it("terminates analytics scheduling at the widest servable analytics range", () => {
    // GET /api/v1/analytics accepts at most a 366-day span
    // (workers/api/src/core-routes.ts), so nothing older can be read as a
    // current data point.
    expect(analyticsTerminalAgeSeconds).toBe(366 * 86_400);
    expect(analyticsTerminalAgeSeconds).toBeGreaterThan(maximumDelayedDeliverySeconds);
  });
});

describe("domain errors", () => {
  it("AccessDenied is a DomainError with code active_organization_required", () => {
    const err = new AccessDenied("no access");
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(AccessDenied);
    expect(err.code).toBe("active_organization_required");
    expect(err.message).toBe("no access");
    expect(err.name).toBe("AccessDenied");
  });

  it("StorageUnavailable is a DomainError with code service_unavailable", () => {
    const err = new StorageUnavailable();
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toBeInstanceOf(StorageUnavailable);
    expect(err.code).toBe("service_unavailable");
    expect(err.message).toBe("Storage is unavailable.");
    expect(err.name).toBe("StorageUnavailable");
  });

  it("provides a sensible default when no message is given", () => {
    expect(new AccessDenied().message).toBe("Access denied.");
  });
});
