// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { formatHotkey, isApplePlatform, matchesHotkey, useHotkey } from "./hotkeys";

const commandK = { key: "k", mod: true };

function onPlatform(platform: string): void {
  vi.stubGlobal("navigator", { platform, userAgent: "" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isApplePlatform", () => {
  it.each([
    [
      "client hints naming macOS",
      { userAgentData: { platform: "macOS" }, platform: "Win32" },
      true,
    ],
    ["a Mac platform string", { platform: "MacIntel" }, true],
    ["only an iPhone user agent", { platform: "", userAgent: "Mozilla/5.0 (iPhone)" }, true],
    ["Windows", { platform: "Win32" }, false],
    ["nothing to read", { platform: "", userAgent: "" }, false],
    ["no navigator", undefined, false],
  ])("%s", (_example, navigator, apple) => {
    vi.stubGlobal("navigator", navigator);

    expect(isApplePlatform()).toEqual(apple);
  });
});

describe("formatHotkey", () => {
  it.each([
    ["MacIntel", commandK, "⌘K"],
    ["Win32", commandK, "Ctrl K"],
    ["MacIntel", { key: "p", mod: true, shift: true }, "⌘⇧P"],
    ["Linux x86_64", { key: "p", mod: true, shift: true }, "Ctrl Shift P"],
    ["Win32", { key: "k" }, "K"],
  ])("on %s: %j", (platform, hotkey, label) => {
    onPlatform(platform);

    expect(formatHotkey(hotkey)).toEqual(label);
  });
});

describe("matchesHotkey", () => {
  const pressed = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { key: "k", ...init });

  it.each([
    ["Command on a Mac", "MacIntel", { metaKey: true }, commandK, true],
    ["Control on a Mac", "MacIntel", { ctrlKey: true }, commandK, false],
    ["Control on Windows", "Win32", { ctrlKey: true }, commandK, true],
    ["Command on Windows", "Win32", { metaKey: true }, commandK, false],
    ["a capital key", "Win32", { key: "K", ctrlKey: true }, commandK, true],
    ["another key", "Win32", { key: "j", ctrlKey: true }, commandK, false],
    ["a missing modifier", "Win32", {}, commandK, false],
    ["an unwanted shift", "Win32", { ctrlKey: true, shiftKey: true }, commandK, false],
    [
      "a required shift",
      "Win32",
      { ctrlKey: true, shiftKey: true },
      { key: "k", mod: true, shift: true },
      true,
    ],
  ])("%s", (_example, platform, init, hotkey, matches) => {
    onPlatform(platform);

    expect(matchesHotkey(pressed(init), hotkey)).toEqual(matches);
  });
});

describe("useHotkey", () => {
  it("a replaced handler, then unmounting", () => {
    onPlatform("Win32");
    const ran: string[] = [];
    const press = () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    const { rerender, unmount } = renderHook(({ handler }) => useHotkey(commandK, handler), {
      initialProps: { handler: () => ran.push("first") },
    });

    press();
    rerender({ handler: () => ran.push("second") });
    press();
    unmount();
    press();

    expect(ran).toEqual(["first", "second"]);
  });
});
