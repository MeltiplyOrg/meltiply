// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { writeCookieConsent } from "@meltiply/ui/cookie-consent";
import { loadRecentNavigation, recordRecentNavigation } from "./recent-navigation";

beforeEach(() => {
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
  window.localStorage.clear();
  writeCookieConsent({ functional: true });
});

afterEach(() => {
  window.localStorage.clear();
  document.cookie = "meltiply-consent=; Path=/; Max-Age=0";
});

describe("recent navigation", () => {
  it("keeps the four most recent distinct section paths in visit order", () => {
    recordRecentNavigation("/assets");
    recordRecentNavigation("/calendar");
    recordRecentNavigation("/assets");
    recordRecentNavigation("/analytics");
    recordRecentNavigation("/inbox");
    recordRecentNavigation("/platforms");

    expect(loadRecentNavigation()).toEqual(["/platforms", "/inbox", "/analytics", "/assets"]);
  });

  it("ignores invalid stored history", () => {
    window.localStorage.setItem("meltiply.recent-navigation", "not-json");

    expect(loadRecentNavigation()).toEqual([]);
  });
});

describe("recent navigation without optional consent", () => {
  it("does not read or persist recent routes after functional consent is rejected", () => {
    writeCookieConsent({ functional: false });
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");

    expect(loadRecentNavigation()).toEqual([]);
    recordRecentNavigation("/analytics");

    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    get.mockRestore();
    set.mockRestore();
    expect(window.localStorage.getItem("meltiply.recent-navigation")).toBeNull();
  });
});
