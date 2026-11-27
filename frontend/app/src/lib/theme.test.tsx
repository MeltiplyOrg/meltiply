// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { themeStorageKey } from "@meltiply/ui/theme-preference";
import { ThemeProvider, useTheme } from "./theme";

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
      <button type="button" onClick={() => setTheme("system")}>
        system
      </button>
      <button type="button" onClick={() => setTheme(theme)}>
        same
      </button>
    </>
  );
}
beforeEach(() => {
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
  document.documentElement.removeAttribute("data-theme-preference");
  document.documentElement.classList.remove("dark");
  window.localStorage.clear();
  writeCookieConsent({ functional: true });
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme-preference");
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("color-scheme");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
});

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
  act(() => writeCookieConsent({ functional: false }));
  expect(document.documentElement).not.toHaveClass("dark");
  expect(document.documentElement.style.colorScheme).toBe("light");
});

it("keeps theme usable in memory without reading or writing optional storage", () => {
  writeCookieConsent({ functional: false });
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

it("persists the current choice on acceptance and clears it on withdrawal", () => {
  act(() => {
    writeCookieConsent({ functional: false });
  });
  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  act(() => screen.getByRole("button", { name: "dark-instant" }).click());
  expect(window.localStorage.getItem(themeStorageKey)).toBeNull();

  act(() => {
    writeCookieConsent({ functional: true });
  });
  expect(window.localStorage.getItem(themeStorageKey)).toBe("dark");

  act(() => {
    writeCookieConsent({ functional: false });
  });
  expect(window.localStorage.getItem(themeStorageKey)).toBeNull();
  expect(document.cookie).not.toContain("meltiply-theme=dark");
  expect(screen.getByTestId("committed")).toHaveTextContent("light");
});

it("retains current-page intent when optional stores are cleared", () => {
  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  act(() => screen.getByRole("button", { name: "dark-instant" }).click());
  expect(document.documentElement).toHaveClass("dark");

  act(() => {
    window.localStorage.removeItem(themeStorageKey);
    document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
    window.dispatchEvent(new Event("focus"));
  });

  expect(document.documentElement).toHaveClass("dark");
  expect(document.documentElement).toHaveAttribute("data-theme-preference", "dark");
  expect(screen.getByTestId("requested")).toHaveTextContent("dark");
});

it("drops current-page intent when functional consent is withdrawn", () => {
  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  act(() => screen.getByRole("button", { name: "dark-instant" }).click());
  expect(document.documentElement).toHaveAttribute("data-theme-preference", "dark");

  act(() => {
    window.localStorage.removeItem(themeStorageKey);
    document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
    window.dispatchEvent(new Event("focus"));
  });
  expect(document.documentElement).toHaveAttribute("data-theme-preference", "dark");
  expect(screen.getByTestId("requested")).toHaveTextContent("dark");

  act(() => {
    writeCookieConsent({ functional: false });
  });
  expect(document.documentElement).not.toHaveAttribute("data-theme-preference");
  expect(document.documentElement).not.toHaveClass("dark");
  expect(screen.getByTestId("requested")).toHaveTextContent("system");
});

it("follows live OS changes only while System is selected", () => {
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  render(
    <ThemeProvider>
      <SelectProbe />
    </ThemeProvider>,
  );
  act(() => screen.getByRole("button", { name: "system" }).click());
  expect(window.localStorage.getItem(themeStorageKey)).toBe("system");
  act(() => {
    media.matches = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement).toHaveClass("dark");
  expect(screen.getByTestId("requested")).toHaveTextContent("system");
  act(() => screen.getByRole("button", { name: "light" }).click());
  act(() => {
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement).not.toHaveClass("dark");
  act(() => screen.getByRole("button", { name: "system" }).click());
  expect(document.documentElement).toHaveClass("dark");
  act(() => {
    media.matches = false;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement).not.toHaveClass("dark");
  expect(window.localStorage.getItem(themeStorageKey)).toBe("system");
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

    expect(screen.getByTestId("requested")).toHaveTextContent("light");
    expect(screen.getByTestId("committed")).toHaveTextContent("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
