// @vitest-environment jsdom
import type { ReactElement } from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useReducedMotionPreference } from "@meltiply/ui/use-reduced-motion";

type Listener = (event: MediaQueryListEvent) => void;

/**
 * Installs one controllable reduced-motion media query. The shared hook reads it
 * on every snapshot and subscribes to its change event, mirroring a browser.
 */
function installReducedMotionPreference(initial: boolean) {
  const listeners = new Set<Listener>();
  let matches = initial;
  const media = {
    get matches() {
      return matches;
    },
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: (_type: string, listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => {
      listeners.delete(listener);
    },
    addListener: (listener: Listener) => {
      listeners.add(listener);
    },
    removeListener: (listener: Listener) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => {
    if (query !== "(prefers-reduced-motion: reduce)") {
      throw new Error(`unexpected media query: ${query}`);
    }
    return media;
  }) as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      act(() => {
        for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
      });
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

/** Minimal consumer so the test observes re-renders, not an internal value. */
function PreferenceProbe(): ReactElement {
  return <span data-testid="preference">{String(useReducedMotionPreference())}</span>;
}

afterEach(() => {
  cleanup();
});

describe("reduced-motion preference", () => {
  it("re-renders when the operating system preference changes after mount", () => {
    const media = installReducedMotionPreference(false);
    try {
      render(<PreferenceProbe />);
      expect(screen.getByTestId("preference")).toHaveTextContent("false");

      media.set(true);
      expect(screen.getByTestId("preference")).toHaveTextContent("true");

      media.set(false);
      expect(screen.getByTestId("preference")).toHaveTextContent("false");
    } finally {
      media.restore();
    }
  });

  it("keeps a safe false snapshot for server rendering", () => {
    expect(renderToStaticMarkup(<PreferenceProbe />)).toContain("false");
  });
});
