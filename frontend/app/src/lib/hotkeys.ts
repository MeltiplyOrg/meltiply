import { useEffect, useRef } from "react";

/**
 * A keyboard shortcut declared once so its handler and its on-screen hint read
 * from the same definition and cannot drift apart.
 */
export type Hotkey = {
  /** Printable key, compared case-insensitively. */
  key: string;
  /** Command on Apple keyboards, Control everywhere else. */
  mod?: boolean;
  shift?: boolean;
};

/**
 * Every application shortcut. Add an entry here, bind it with `useHotkey`, and
 * render its hint with `formatHotkey`; nothing else should hardcode key names.
 */
export const hotkeys = {
  commandMenu: { key: "k", mod: true },
  /** Dev-only: toggles the DevBox dock. Bound only inside the dev-gated dock. */
  devBox: { key: "d", mod: true, shift: true },
} as const satisfies Record<string, Hotkey>;

/**
 * Detects whether the user is on an Apple platform (macOS, iOS, iPadOS) by checking
 * `navigator.userAgentData.platform`, `navigator.platform`, and `navigator.userAgent`.
 * Used to conditionally bind `Command` (metaKey) vs `Control` (ctrlKey) modifiers.
 *
 * @returns `true` if executing in an Apple environment, `false` otherwise or when running server-side.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const agentPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  const platform = agentPlatform || navigator.platform || navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Produces a human-readable shortcut badge or hint string suitable for tooltips and buttons
 * (e.g. `⌘K` on Apple devices, `Ctrl K` on other platforms).
 *
 * @param hotkey Shortcut configuration defining key and modifier flags.
 * @returns Formatted label string reflecting platform-specific glyphs.
 */
export function formatHotkey(hotkey: Hotkey): string {
  const apple = isApplePlatform();
  const parts: string[] = [];
  if (hotkey.mod) parts.push(apple ? "⌘" : "Ctrl");
  if (hotkey.shift) parts.push(apple ? "⇧" : "Shift");
  parts.push(hotkey.key.toUpperCase());
  return parts.join(apple ? "" : " ");
}

/**
 * Checks whether a native keyboard event strictly matches the specified hotkey definition.
 * Compares the platform modifier strictly (`metaKey` on Apple, `ctrlKey` elsewhere) so that
 * native macOS Emacs-style editing shortcuts remain unaffected.
 *
 * @param event Native DOM KeyboardEvent triggered by user key press.
 * @param hotkey Target hotkey specification to match against.
 * @returns `true` if all keys and modifiers match, `false` otherwise.
 */
export function matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) return false;
  const modifier = isApplePlatform() ? event.metaKey : event.ctrlKey;
  return modifier === Boolean(hotkey.mod) && event.shiftKey === Boolean(hotkey.shift);
}

/**
 * React hook that binds a global window `keydown` listener for the specified hotkey.
 * Automatically prevents default browser behavior and executes the latest handler callback
 * without triggering re-registration when the handler reference changes.
 *
 * @param hotkey The shortcut specification to listen for.
 * @param handler Callback to invoke when the shortcut is triggered.
 */
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
