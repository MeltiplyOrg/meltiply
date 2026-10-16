import { describe, expect, it } from "vite-plus/test";

import { formatBytes, formatDuration } from "./format";

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
