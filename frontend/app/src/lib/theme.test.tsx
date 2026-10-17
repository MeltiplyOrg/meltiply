// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { themeStorageKey } from "@meltiply/ui/theme-preference";
import { resolveTheme, ThemeProvider, useTheme } from "./theme";

/** Exposes the committed and requested palette while driving the real theme provider. */
function ToggleProbe(): React.ReactElement {
  const { requestedTheme, theme, toggleTheme } = useTheme();
  return (
    <>
      <span data-testid="committed">{theme}</span>
      <span data-testid="requested">{requestedTheme}</span>
      <button type="button" onClick={() => toggleTheme()}>
        toggle
      </button>
    </>
  );
}

/** Drives explicit selections and re-selection without replacing the provider. */
function SelectProbe(): React.ReactElement {
  const { requestedTheme, setTheme, theme } = useTheme();
  return (
    <>
      <span data-testid="committed">{theme}</span>
      <span data-testid="requested">{requestedTheme}</span>
      <button type="button" onClick={() => setTheme("light")}>
        light
      </button>
      <button type="button" onClick={() => setTheme("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setTheme("light")}>
        light-instant
      </button>
      <button type="button" onClick={() => setTheme("dark")}>
        dark-instant
      </button>
      <button type="button" onClick={() => setTheme(theme)}>
        same
      </button>
    </>
  );
}
/** Isolates current-page intent, consent, and optional storage between scenarios. */
beforeEach(() => {
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
  document.documentElement.removeAttribute("data-theme-preference");
  window.localStorage.clear();
  writeCookieConsent({ functional: true, analytics: false, marketing: false });
});

/** Removes hydrated page intent so later scenarios cannot inherit a transferred palette. */
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme-preference");
  document.documentElement.style.removeProperty("color-scheme");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
});

describe("theme resolution", () => {
  it("prefers a stored choice over the system preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("falls back to the system preference for unknown values", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("sepia", true)).toBe("dark");
  });
});

/** Hydration and an initial optional-cookie rejection preserve transferred light intent without storage, even on a dark OS. */
it("preserves a transferred light palette through hydration without functional consent", () => {
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.documentElement.removeAttribute("data-cookie-functional");
  document.documentElement.removeAttribute("data-cookie-decided");
  document.documentElement.setAttribute("data-theme-preference", "light");
  document.documentElement.classList.remove("dark");
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  expect(document.documentElement).not.toHaveClass("dark");
  expect(screen.getByTestId("committed")).toHaveTextContent("light");
  expect(screen.getByTestId("requested")).toHaveTextContent("light");
  expect(window.localStorage.getItem(themeStorageKey)).toBeNull();
  act(() => writeCookieConsent({ functional: false, analytics: false, marketing: false }));
  expect(document.documentElement).not.toHaveClass("dark");
  expect(document.documentElement.style.colorScheme).toBe("light");
});

it("keeps theme usable in memory without reading or writing optional storage", () => {
  writeCookieConsent({ functional: false, analytics: false, marketing: false });
  window.localStorage.setItem(themeStorageKey, "light");
  const get = vi.spyOn(Storage.prototype, "getItem");
  const set = vi.spyOn(Storage.prototype, "setItem");

  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  act(() => screen.getByRole("button", { name: "dark-instant" }).click());

  expect(screen.getByTestId("committed")).toHaveTextContent("dark");
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  get.mockRestore();
  set.mockRestore();
});

/**
 * Preserves a theme selected in memory before acceptance, then proves
 * withdrawal clears both optional stores and returns to the OS palette.
 */
it("persists the current choice on acceptance and clears it on withdrawal", () => {
  act(() => {
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
  });
  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  act(() => screen.getByRole("button", { name: "dark-instant" }).click());
  expect(window.localStorage.getItem(themeStorageKey)).toBeNull();

  act(() => {
    writeCookieConsent({ functional: true, analytics: false, marketing: false });
  });
  expect(window.localStorage.getItem(themeStorageKey)).toBe("dark");

  act(() => {
    writeCookieConsent({ functional: false, analytics: false, marketing: false });
  });
  expect(window.localStorage.getItem(themeStorageKey)).toBeNull();
  expect(document.cookie).not.toContain("meltiply-theme=dark");
  expect(screen.getByTestId("committed")).toHaveTextContent("light");
});

describe("ThemeProvider", () => {
  it("applies the stored theme to the document root", () => {
    window.localStorage.setItem(themeStorageKey, "dark");

    render(
      <ThemeProvider>
        <ToggleProbe />
      </ThemeProvider>,
    );

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByTestId("committed")).toHaveTextContent("dark");
    expect(screen.getByTestId("requested")).toHaveTextContent("dark");
  });

  it("persists an instant change and swaps the root class", () => {
    window.localStorage.setItem(themeStorageKey, "dark");
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light-instant" }).click());

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(screen.getByTestId("committed")).toHaveTextContent("light");
    expect(window.localStorage.getItem(themeStorageKey)).toBe("light");
  });

  it("applies the request and records it when storage writes are denied", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    render(
      <ThemeProvider>
        <SelectProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByRole("button", { name: "light" }).click());

    // A denied write must not swallow the selection: the palette still
    // commits for the current session even though nothing was persisted.
    expect(screen.getByTestId("requested")).toHaveTextContent("light");
    expect(screen.getByTestId("committed")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
