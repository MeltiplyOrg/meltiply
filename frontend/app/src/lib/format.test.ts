import { describe, expect, it } from "vite-plus/test";

import { abbreviateRecordId, formatBytes, formatDuration, postDateFormatters } from "./format";

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});

describe("formatDuration", () => {
  it("formats zero seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
  });

  it("pads seconds below one minute", () => {
    expect(formatDuration(1)).toBe("0:01");
    expect(formatDuration(59)).toBe("0:59");
  });

  it("rolls over at minute boundaries", () => {
    expect(formatDuration(60)).toBe("1:00");
    expect(formatDuration(65)).toBe("1:05");
  });
});

describe("abbreviateRecordId", () => {
  it("distinguishes records whose prefixes are identical", () => {
    expect(abbreviateRecordId("48000000-0000-4000-8000-000000000001")).toBe("000001");
    expect(abbreviateRecordId("48000000-0000-4000-8000-000000000002")).toBe("000002");
  });

  it("keeps ids that are already short", () => {
    expect(abbreviateRecordId("abc123")).toBe("abc123");
    expect(abbreviateRecordId("3f7c1a92-5b4e-4d21-9a77-0c8f2e1b6d40")).toBe("1b6d40");
  });
});

describe("postDateFormatters", () => {
  it("reuses one formatter pair for each publishing timezone", () => {
    const newYork = postDateFormatters("America/New_York");
    expect(postDateFormatters("America/New_York")).toBe(newYork);
    expect(postDateFormatters("Asia/Tokyo")).not.toBe(newYork);
  });

  it("formats a stored instant in the selected zone", () => {
    const value = new Date("2026-01-01T04:30:00.000Z");
    const formatters = postDateFormatters("America/New_York");
    expect(formatters.day.format(value)).toBe("Dec 31");
    expect(formatters.time.format(value)).toContain("11:30");
    expect(postDateFormatters("Asia/Tokyo").day.format(value)).toBe("Jan 1");
  });
});
