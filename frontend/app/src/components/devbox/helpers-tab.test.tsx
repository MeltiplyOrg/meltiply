// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { I18nProvider } from "@/lib/i18n";

import type { AxeScanResult } from "./axe-scan";
import { HelpersTab } from "./helpers-tab";

const deferred = vi.hoisted(() => {
  let resolve: (value: AxeScanResult) => void = () => undefined;
  const promise = new Promise<AxeScanResult>((complete) => {
    resolve = complete;
  });
  return {
    promise,
    resolve: (value: AxeScanResult) => resolve(value),
    highlight: vi.fn(),
    clear: vi.fn(),
  };
});

vi.mock("./axe-scan", () => ({
  runAxeScan: () => deferred.promise,
  highlightAxeViolations: deferred.highlight,
  clearAxeHighlights: deferred.clear,
}));

afterEach(() => cleanup());

describe("HelpersTab axe lifecycle", () => {
  it("discards a scan result and highlights after unmount", async () => {
    const result: AxeScanResult = { violations: [], nodeCount: 0, scannedAt: 0 };
    const { unmount } = render(
      <I18nProvider>
        <HelpersTab />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Scan route" }));
    expect(screen.getByRole("button", { name: "Scanning…" })).toBeDisabled();

    unmount();
    await act(async () => {
      deferred.resolve(result);
      await Promise.resolve();
    });

    expect(deferred.highlight).not.toHaveBeenCalled();
    expect(deferred.clear).toHaveBeenCalled();
  });
});
