import { describe, expect, it } from "vite-plus/test";

import {
  defaultSignatureTemplate,
  instantToWallClock,
  resolveSignature,
  wallClockToInstant,
} from "./publishing-preferences";
import type { SignatureTemplate } from "@/types";

describe("publishing timezone conversion", () => {
  it("moves a spring-forward gap forward by the missing hour", () => {
    expect(wallClockToInstant("2026-03-08T02:30", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  it("uses the earlier occurrence for a repeated fall-back time", () => {
    expect(wallClockToInstant("2026-11-01T01:30", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("round-trips an instant through a selected zone without changing it", () => {
    const instant = "2026-01-01T15:45:00.000Z";
    const wallClock = instantToWallClock(instant, "Asia/Tokyo", false);
    expect(wallClock).toBe("2026-01-02T00:45");
    expect(wallClockToInstant(wallClock, "Asia/Tokyo")).toBe(instant);
  });

  it("preserves local midnight when restoring an existing schedule", () => {
    const instant = "2026-07-04T04:00:00.000Z";
    expect(instantToWallClock(instant, "America/New_York", false)).toBe("2026-07-04T00:00");
    expect(instantToWallClock(instant, "America/New_York")).toBe("2026-07-04T10:00");
  });

  it("rejects malformed wall-clock input", () => {
    expect(wallClockToInstant("2026-13-40T99:99", "UTC")).toBeNull();
    expect(wallClockToInstant("not-a-time", "UTC")).toBeNull();
  });
});

describe("signature resolution", () => {
  const template: SignatureTemplate = {
    body: "Follow {brand_profile} on {platform} at {channel}.",
    id: "00000000-0000-4000-8000-000000000901",
    is_default: true,
    name: "Footer",
    position: 0,
  };

  it("resolves every supported placeholder against the actual target", () => {
    expect(
      resolveSignature(template.body, {
        brandProfileName: "Alpha Studio",
        channelName: "@alpha",
        platform: "instagram",
      }),
    ).toBe("Follow Alpha Studio on Instagram at @alpha.");
  });

  it("selects only the template explicitly marked default", () => {
    expect(defaultSignatureTemplate([{ ...template, is_default: false }])).toBeNull();
    expect(defaultSignatureTemplate([template])?.id).toBe(template.id);
  });
});
