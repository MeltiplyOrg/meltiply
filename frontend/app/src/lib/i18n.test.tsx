// @vitest-environment jsdom

import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { writeCookieConsent } from "@meltiply/ui/cookie-consent";

import { I18nProvider, Trans, supportedLanguages, translate, useI18n } from "./i18n";
import { setPseudoLocalization } from "./pseudo-locale";

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

  it("resolves every supported target language from locale data", () => {
    for (const { code } of supportedLanguages) {
      const output = translate(code, "Settings");
      if (code === "en") expect(output).toBe("Settings");
      else expect(output, `${code} should translate Settings`).not.toBe("Settings");
      expect(translate(code, "Not a catalog key")).toBe("Not a catalog key");
    }
  });

  it("localizes status labels for every target language", () => {
    for (const { code } of supportedLanguages) {
      if (code === "en") continue;
      window.localStorage.setItem(storageKey, code);
      const { result, unmount } = renderHook(useI18n, { wrapper });
      expect(result.current.tStatus("awaiting_provider"), code).not.toBe("Awaiting provider");
      unmount();
    }
  });

  it("translates status identifiers and falls back to readable labels", () => {
    const english = renderHook(useI18n, { wrapper });
    expect(english.result.current.tStatus("awaiting_provider")).toBe("Awaiting provider");
    expect(english.result.current.tStatus("some_unknown_status")).toBe("some unknown status");

    window.localStorage.setItem(storageKey, "es");
    const spanish = renderHook(useI18n, { wrapper });
    expect(spanish.result.current.tStatus("awaiting_provider")).toBe("Esperando al proveedor");
    expect(spanish.result.current.tStatus("some_unknown_status")).toBe("some unknown status");
  });

  it("pseudo-localizes after locale lookup", () => {
    setPseudoLocalization(true);
    try {
      const output = translate("es", "Dashboard");
      expect(output).toMatch(/^⟦.*⟧$/);
      expect(output).not.toBe("Panel");
    } finally {
      setPseudoLocalization(false);
    }
  });

  it("interpolates named values in translated messages", () => {
    expect(translate("es", "Expires {date}", { date: "mañana" })).toBe("Caduca el mañana");
    expect(translate("en", "Week {week}", { week: 42 })).toBe("Week 42");
  });

  it("interpolates nodes into a translated sentence", () => {
    const { result } = renderHook(useI18n, { wrapper });
    act(() => result.current.setLanguage("es"));

    const { container } = render(
      <I18nProvider>
        <Trans message="{count} selected" values={{ count: <strong>3</strong> }} />
      </I18nProvider>,
    );

    expect(container.textContent).toBe("3 seleccionados");
    expect(container.querySelector("strong")?.textContent).toBe("3");
  });

  it("keeps an unmapped node placeholder as its own text", () => {
    const { container } = render(
      <Trans message="{count} accounts" values={{ other: <strong>1</strong> }} />,
    );

    expect(container.textContent).toBe("{count} accounts");
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
    window.localStorage.setItem(storageKey, "ja");

    const { result } = renderHook(useI18n, { wrapper });

    expect(result.current.language).toBe("en");
  });
});
