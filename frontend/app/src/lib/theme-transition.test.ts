// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { applyThemeImmediately } from "@meltiply/ui/theme-transition";

let frames: FrameRequestCallback[] = [];

/** Gives each scenario an isolated deterministic browser paint queue. */
beforeEach(() => {
  frames = [];
  document.documentElement.className = "";
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
});

/** Releases pending palette paint work before restoring browser globals. */
afterEach(() => {
  while (frames.length > 0) {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  }
  document.documentElement.className = "";
  vi.unstubAllGlobals();
});

it("commits the palette synchronously without exposing intermediate component fades", () => {
  applyThemeImmediately(() => {
    expect(document.documentElement).toHaveClass("theme-changing");
    document.documentElement.classList.add("dark");
  });
  expect(document.documentElement).toHaveClass("dark");
  const pending = frames;
  frames = [];
  for (const callback of pending) callback(0);
  expect(document.documentElement).toHaveClass("theme-changing");
  for (const callback of frames.splice(0)) callback(0);
  expect(document.documentElement).not.toHaveClass("theme-changing");
});

it("propagates a failed commit and releases suppression instead of wedging the page", () => {
  expect(() =>
    applyThemeImmediately(() => {
      throw new Error("commit failed");
    }),
  ).toThrow("commit failed");
  for (let paint = 0; paint < 2; paint += 1) {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  }
  expect(document.documentElement).not.toHaveClass("theme-changing");
});
