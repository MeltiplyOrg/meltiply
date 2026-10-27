// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import themeBootstrapRuntime from "@meltiply/ui/theme-bootstrap-runtime?raw";
import {
  renderThemeBootstrap,
  themeBootstrapMarker,
  type ThemeBootstrapSettings,
} from "@meltiply/ui/theme-bootstrap-source";
import {
  themeCookieName,
  themePreferenceAttribute,
  themeQueryParam,
  themeStorageKey,
} from "@meltiply/ui/theme-preference";

const defaultSettings: ThemeBootstrapSettings = { mode: "class" };

/** Executes the exact checked-in runtime as a blocking classic script would. */
function runBootstrap(settings: ThemeBootstrapSettings = defaultSettings): void {
  new Function(renderThemeBootstrap(themeBootstrapRuntime, settings))();
}

/** Restores the runtime's delegated listener so scenarios cannot leak into one another. */
function releaseListeners(): void {
  document.dispatchEvent(new Event("meltiply:theme-link-reset"));
}

/** Activates a link without letting jsdom navigate away from the test document. */
function clickAnchor(anchor: HTMLAnchorElement): void {
  anchor.addEventListener("click", (event) => event.preventDefault(), { once: true });
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** Clears root intent, consent attributes, optional stores, and history between scenarios. */
function clearBrowserState(): void {
  releaseListeners();
  document.documentElement.className = "";
  document.documentElement.removeAttribute(themePreferenceAttribute);
  document.documentElement.removeAttribute("data-cookie-functional");
  document.documentElement.removeAttribute("data-cookie-decided");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
  document.body.innerHTML = "";
  document.cookie = `${themeCookieName}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

/** Records a valid explicit choice without invoking the runtime under test. */
function grantFunctionalConsent(): void {
  document.documentElement.setAttribute("data-cookie-functional", "");
}

beforeEach(clearBrowserState);
afterEach(clearBrowserState);

describe("before-paint theme runtime", () => {
  it("commits a transferred choice, strips only that parameter, and preserves the hash", () => {
    window.history.replaceState(null, "", `/start?${themeQueryParam}=light&tab=all#top`);
    runBootstrap();

    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.getAttribute(themePreferenceAttribute)).toBe("light");
    expect(window.location.pathname).toBe("/start");
    expect(window.location.search).toBe("?tab=all");
    expect(window.location.hash).toBe("#top");

    releaseListeners();
  });

  it("uses page intent before persisted stores and follows the OS for System", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    grantFunctionalConsent();
    window.localStorage.setItem(themeStorageKey, "light");
    document.documentElement.setAttribute(themePreferenceAttribute, "system");
    runBootstrap();

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.getAttribute(themePreferenceAttribute)).toBe("system");

    releaseListeners();
  });

  it("prefers the shared cookie over origin storage", () => {
    grantFunctionalConsent();
    document.cookie = `${themeCookieName}=light; Path=/`;
    window.localStorage.setItem(themeStorageKey, "dark");
    runBootstrap();

    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.getAttribute(themePreferenceAttribute)).toBe("light");

    releaseListeners();
  });

  it("falls back to valid storage when the encoded cookie is malformed", () => {
    grantFunctionalConsent();
    document.cookie = `${themeCookieName}=%E0%A4%A; Path=/`;
    window.localStorage.setItem(themeStorageKey, "dark");
    runBootstrap();

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.getAttribute(themePreferenceAttribute)).toBe("dark");

    releaseListeners();
  });

  it("still applies a transferred choice when cookies and storage are blocked", () => {
    grantFunctionalConsent();
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
      set() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    window.history.replaceState(null, "", `/?${themeQueryParam}=light`);
    try {
      runBootstrap();
      expect(document.documentElement).not.toHaveClass("dark");
      expect(document.documentElement.getAttribute(themePreferenceAttribute)).toBe("light");
    } finally {
      Reflect.deleteProperty(document, "cookie");
      releaseListeners();
    }
  });

  it("does not read or write optional stores without functional consent", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    window.history.replaceState(null, "", `/?${themeQueryParam}=light`);
    runBootstrap();

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.cookie).not.toContain(`${themeCookieName}=`);

    releaseListeners();
  });

  it("persists a resolved choice through both stores only with consent", () => {
    grantFunctionalConsent();
    window.history.replaceState(null, "", `/?${themeQueryParam}=dark`);
    runBootstrap();

    expect(window.localStorage.getItem(themeStorageKey)).toBe("dark");
    expect(document.cookie).toContain(`${themeCookieName}=dark`);

    releaseListeners();
  });

  it("re-reads the live choice for marked links and configured origins", () => {
    grantFunctionalConsent();
    document.documentElement.setAttribute(themePreferenceAttribute, "dark");
    document.body.innerHTML = `
      <a id="marked" data-theme-link href="https://docs.example.test/guide?tab=one#setup">Guide</a>
      <a id="configured" href="https://app.example.test/posts?tab=all#top">App</a>
      <a id="external" href="https://other.example.test/docs?tab=two">Other</a>
    `;
    runBootstrap({ mode: "class", siteUrls: ["https://app.example.test"] });

    for (const id of ["marked", "configured"]) {
      const anchor = document.getElementById(id);
      if (!(anchor instanceof HTMLAnchorElement)) throw new Error(`${id} anchor missing`);
      clickAnchor(anchor);
      const url = new URL(anchor.href);
      expect(url.searchParams.get(themeQueryParam)).toBe("dark");
    }
    const marked = new URL(
      (document.getElementById("marked") as HTMLAnchorElement | null)?.href ?? "",
    );
    expect(marked.searchParams.get("tab")).toBe("one");
    expect(marked.hash).toBe("#setup");
    const external = new URL(
      (document.getElementById("external") as HTMLAnchorElement | null)?.href ?? "",
    );
    expect(external.searchParams.has(themeQueryParam)).toBe(false);

    // The delegated listener observes the newest intent instead of the first-paint palette.
    document.documentElement.setAttribute(themePreferenceAttribute, "light");
    const configured = document.getElementById("configured");
    if (!(configured instanceof HTMLAnchorElement)) throw new Error("configured anchor missing");
    clickAnchor(configured);
    expect(new URL(configured.href).searchParams.get(themeQueryParam)).toBe("light");

    releaseListeners();
  });

  it("removes a stale transfer parameter when no explicit choice exists", () => {
    document.body.innerHTML = `<a id="marked" data-theme-link href="https://docs.example.test/guide?${
      themeQueryParam
    }=dark">Guide</a>`;
    runBootstrap();
    const anchor = document.getElementById("marked");
    if (!(anchor instanceof HTMLAnchorElement)) throw new Error("marked anchor missing");
    clickAnchor(anchor);
    expect(new URL(anchor.href).searchParams.has(themeQueryParam)).toBe(false);

    releaseListeners();
  });

  it("supports the data-theme adapter without leaving a stale class", () => {
    grantFunctionalConsent();
    window.localStorage.setItem(themeStorageKey, "dark");
    document.documentElement.classList.add("dark");
    runBootstrap({ mode: "data-theme" });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement).not.toHaveClass("dark");

    releaseListeners();
  });

  it("keeps applying the palette when reduced motion is requested", () => {
    grantFunctionalConsent();
    window.localStorage.setItem(themeStorageKey, "dark");
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    }));
    runBootstrap();

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    releaseListeners();
  });
});

describe("theme bootstrap source", () => {
  it("serializes options without terminating the surrounding script", () => {
    const source = renderThemeBootstrap(themeBootstrapRuntime, {
      mode: "class",
      siteUrls: ["https://example.test/</script><script>alert(1)</script>"],
    });

    expect(themeBootstrapMarker).not.toBe("");
    expect(source).toContain("window.__meltiplyThemeBootstrapOptions = ");
    expect(source).not.toContain("</script><script>");
  });
});
