// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { formatHotkey, hotkeys, isApplePlatform, matchesHotkey, useHotkey } from "./hotkeys";

function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => setPlatform(""));

describe("hotkey platform detection", () => {
  it("treats Apple platforms as Command and everything else as Control", () => {
    setPlatform("MacIntel");
    expect(isApplePlatform()).toBe(true);
    expect(formatHotkey(hotkeys.commandMenu)).toBe("⌘K");

    setPlatform("Win32");
    expect(isApplePlatform()).toBe(false);
    expect(formatHotkey(hotkeys.commandMenu)).toBe("Ctrl K");
  });

  it("formats additional modifiers per platform", () => {
    setPlatform("MacIntel");
    expect(formatHotkey({ key: "p", mod: true, shift: true })).toBe("⌘⇧P");

    setPlatform("Linux x86_64");
    expect(formatHotkey({ key: "p", mod: true, shift: true })).toBe("Ctrl Shift P");
  });
});

describe("matchesHotkey", () => {
  it("requires the platform modifier rather than accepting either one", () => {
    setPlatform("MacIntel");
    expect(
      matchesHotkey(new KeyboardEvent("keydown", { key: "k", metaKey: true }), hotkeys.commandMenu),
    ).toBe(true);
    // Ctrl+K stays available to macOS text editing.
    expect(
      matchesHotkey(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }), hotkeys.commandMenu),
    ).toBe(false);

    setPlatform("Win32");
    expect(
      matchesHotkey(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }), hotkeys.commandMenu),
    ).toBe(true);
    expect(
      matchesHotkey(new KeyboardEvent("keydown", { key: "k", metaKey: true }), hotkeys.commandMenu),
    ).toBe(false);
  });

  it("rejects a different key, a missing modifier, and an unwanted shift", () => {
    setPlatform("Win32");
    expect(
      matchesHotkey(new KeyboardEvent("keydown", { key: "j", ctrlKey: true }), hotkeys.commandMenu),
    ).toBe(false);
    expect(matchesHotkey(new KeyboardEvent("keydown", { key: "k" }), hotkeys.commandMenu)).toBe(
      false,
    );
    expect(
      matchesHotkey(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true }),
        hotkeys.commandMenu,
      ),
    ).toBe(false);
  });

  it("matches the key case-insensitively", () => {
    setPlatform("Win32");
    expect(
      matchesHotkey(new KeyboardEvent("keydown", { key: "K", ctrlKey: true }), hotkeys.commandMenu),
    ).toBe(true);
  });
});

describe("useHotkey", () => {
  it("runs the latest handler while mounted and stops after unmount", () => {
    setPlatform("Win32");
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ handler }) => useHotkey(hotkeys.commandMenu, handler),
      {
        initialProps: { handler: first },
      },
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(first).toHaveBeenCalledOnce();

    rerender({ handler: second });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();

    unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    expect(second).toHaveBeenCalledOnce();
  });
});
