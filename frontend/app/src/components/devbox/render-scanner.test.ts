import { describe, expect, it, vi } from "vite-plus/test";

const scanner = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    gate,
    release: () => release(),
    scan: vi.fn(),
    setOptions: vi.fn(),
  };
});

vi.mock("react-scan", async () => {
  await scanner.gate;
  return { scan: scanner.scan, setOptions: scanner.setOptions };
});

import { startRenderScanner, stopRenderScanner } from "./render-scanner";

describe("render scanner lifecycle", () => {
  it("does not enable a scan whose start was stopped during the lazy import", async () => {
    const pending = startRenderScanner("fast");
    stopRenderScanner();
    scanner.release();

    await expect(pending).resolves.toBe(false);
    expect(scanner.scan).not.toHaveBeenCalled();
  });

  it("enables and stops the scanner once the module is available", async () => {
    await expect(startRenderScanner("slow")).resolves.toBe(true);
    expect(scanner.scan).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, animationSpeed: "slow" }),
    );

    stopRenderScanner();
    expect(scanner.setOptions).toHaveBeenCalledWith({ enabled: false });
  });
});
