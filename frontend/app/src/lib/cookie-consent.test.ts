// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  consentCookieName,
  hasCookieConsent,
  readCookieConsent,
  readFunctionalStorage,
  subscribeCookieConsent,
  writeCookieConsent,
  writeFunctionalStorage,
} from "@meltiply/ui/cookie-consent";

/** Each case starts without a consent record or optional preferences; auth fixtures never enter this isolated store. */
beforeEach(() => {
  document.cookie = `${consentCookieName}=; Path=/; Max-Age=0`;
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = `${consentCookieName}=; Path=/; Max-Age=0`;
  document.cookie = "meltiply-theme=; Path=/; Max-Age=0";
  window.localStorage.clear();
});

describe("optional cookie and storage consent", () => {
  it("does not read or write optional preference values before a choice", () => {
    window.localStorage.setItem("meltiply.theme", "dark");
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    expect(readFunctionalStorage("meltiply.theme")).toBeNull();
    writeFunctionalStorage("meltiply.language", "es");
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(hasCookieConsent("functional")).toBe(false);
  });

  it("allows only the accepted optional purpose and remembers an explicit rejection", () => {
    writeCookieConsent({ functional: true });
    writeFunctionalStorage("meltiply.theme", "dark");
    expect(readFunctionalStorage("meltiply.theme")).toBe("dark");
    expect(hasCookieConsent("functional")).toBe(true);
    writeCookieConsent({ functional: false });
    expect(readFunctionalStorage("meltiply.theme")).toBeNull();
    expect(hasCookieConsent("functional")).toBe(false);
    expect(readCookieConsent()).toEqual({ functional: false });
  });

  /** Consent written before the model narrowed to the one implemented purpose keeps its explicit decision. */
  it("keeps a saved decision that still carries retired category fields", () => {
    const record = {
      v: 1,
      functional: true,
      analytics: false,
      marketing: false,
      expires: Date.now() + 10000,
    };
    document.cookie = `${consentCookieName}=${encodeURIComponent(JSON.stringify(record))}; Path=/`;
    expect(readCookieConsent()).toEqual({ functional: true });
    expect(hasCookieConsent("functional")).toBe(true);
  });

  it("withdrawal removes optional recovery and theme records without deleting unrelated or essential data", () => {
    writeCookieConsent({ functional: true });
    for (const key of [
      "meltiply.theme",
      "meltiply.language",
      "meltiply.composer.v2.brand",
      "meltiply.upload.v1.file",
      "meltiply.upload.create.v1.file",
    ])
      writeFunctionalStorage(key, "saved");
    window.localStorage.setItem("essential-operation", "keep");
    document.cookie = "meltiply-theme=dark; Path=/";
    document.cookie = "session-fixture=keep; Path=/";
    writeCookieConsent({ functional: false });
    expect(Object.keys(window.localStorage)).toEqual(["essential-operation"]);
    expect(document.cookie).not.toContain("meltiply-theme=");
    expect(document.cookie).toContain("session-fixture=keep");
    expect(document.cookie).toContain(`${consentCookieName}=`);
    document.cookie = "session-fixture=; Path=/; Max-Age=0";
  });

  it("treats expired, invalid-version, and malformed records as no consent", () => {
    for (const value of [
      "not-json",
      JSON.stringify({ v: 2, functional: true, expires: Date.now() + 10000 }),
      JSON.stringify({ v: 1, functional: true, expires: Date.now() - 1 }),
      JSON.stringify({ v: 1, expires: Date.now() + 10000 }),
      JSON.stringify({ v: 1, functional: "yes", expires: Date.now() + 10000 }),
    ]) {
      document.cookie = `${consentCookieName}=${encodeURIComponent(value)}; Path=/`;
      expect(readCookieConsent()).toBeNull();
      expect(hasCookieConsent("functional")).toBe(false);
    }
  });

  it("observes sibling-site withdrawal on focus and clears this origin's optional data", () => {
    writeCookieConsent({ functional: true });
    writeFunctionalStorage("meltiply.theme", "dark");
    const changed = vi.fn();
    const stop = subscribeCookieConsent(changed);
    document.cookie = `${consentCookieName}=${encodeURIComponent(JSON.stringify({ v: 1, functional: false, expires: Date.now() + 10000 }))}; Path=/`;
    window.dispatchEvent(new Event("focus"));
    expect(changed).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem("meltiply.theme")).toBeNull();
    stop();
  });
});
