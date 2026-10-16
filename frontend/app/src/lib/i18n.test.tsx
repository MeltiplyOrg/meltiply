// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { writeCookieConsent } from "@meltiply/ui/cookie-consent";

import { I18nProvider, translate, useI18n } from "./i18n";

const storageKey = "meltiply.language";

function wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

beforeEach(() => {
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
  window.localStorage.clear();
  writeCookieConsent({ functional: true, analytics: false, marketing: false });
});

afterEach(() => {
  window.localStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
  document.documentElement.lang = "en";
});

describe("I18nProvider", () => {
  it("uses English when no saved language exists", () => {
    const { result } = renderHook(useI18n, { wrapper });

    expect(result.current.language).toBe("en");
    expect(result.current.t("Settings")).toBe("Settings");
    expect(document.documentElement.lang).toBe("en");
  });

  it("prioritizes a saved supported language", () => {
    window.localStorage.setItem(storageKey, "es");

    const { result } = renderHook(useI18n, { wrapper });

    expect(result.current.language).toBe("es");
    expect(result.current.t("Settings")).toBe("Configuración");
    expect(document.documentElement.lang).toBe("es");
  });

  it("reloads the persisted Spanish language", () => {
    const first = renderHook(useI18n, { wrapper });
    act(() => first.result.current.setLanguage("es"));
    first.unmount();

    const reloaded = renderHook(useI18n, { wrapper });

    expect(reloaded.result.current.language).toBe("es");
    expect(reloaded.result.current.t("Dashboard")).toBe("Panel");
    expect(document.documentElement.lang).toBe("es");
  });

  it("interpolates named values in translated messages", () => {
    expect(translate("es", "Expires {date}", { date: "mañana" })).toBe("Caduca el mañana");
    expect(translate("en", "Week {week}", { week: 42 })).toBe("Week 42");
  });

  it("translates the generic error copy", () => {
    expect(translate("en", "An error has occurred.")).toBe("An error has occurred.");
    expect(translate("es", "An error has occurred.")).toBe("Se ha producido un error.");
  });

  it("keeps the hashtag placeholder covered in Spanish", () => {
    expect(translate("es", "#viral #shorts")).toBe("#viral #shorts");
  });

  it("persists an explicit language change", () => {
    const { result } = renderHook(useI18n, { wrapper });

    act(() => result.current.setLanguage("es"));

    expect(result.current.t("Dashboard")).toBe("Panel");
    expect(window.localStorage.getItem(storageKey)).toBe("es");
    expect(document.documentElement.lang).toBe("es");
  });

  it("ignores unsupported saved values", () => {
    window.localStorage.setItem(storageKey, "fr");

    const { result } = renderHook(useI18n, { wrapper });

    expect(result.current.language).toBe("en");
  });
});
