import { useEffect, useRef } from "react";

const applePlatformPattern = /mac|iphone|ipad|ipod/i;

export type Hotkey = {
  key: string;
  mod?: boolean;
  shift?: boolean;
};

export const hotkeys = {
  commandMenu: { key: "k", mod: true },
  devBox: { key: "d", mod: true, shift: true },
} as const satisfies Record<string, Hotkey>;

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const agentPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  const platform = agentPlatform || navigator.platform || navigator.userAgent || "";
  return applePlatformPattern.test(platform);
}

export function formatHotkey(hotkey: Hotkey): string {
  const apple = isApplePlatform();
  const parts: string[] = [];
  if (hotkey.mod) parts.push(apple ? "⌘" : "Ctrl");
  if (hotkey.shift) parts.push(apple ? "⇧" : "Shift");
  parts.push(hotkey.key.toUpperCase());
  return parts.join(apple ? "" : " ");
}

export function matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) return false;
  const modifier = isApplePlatform() ? event.metaKey : event.ctrlKey;
  return modifier === Boolean(hotkey.mod) && event.shiftKey === Boolean(hotkey.shift);
}

export function useHotkey(hotkey: Hotkey, handler: () => void): void {
  const latest = useRef(handler);

  useEffect(() => {
    latest.current = handler;
  }, [handler]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!matchesHotkey(event, hotkey)) return;
      event.preventDefault();
      latest.current();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hotkey]);
}
