import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getPublicEnv, isDevMode } from "./env";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getPublicEnv", () => {
  it.each([
    ["no configured value", {}],
    ["an empty value", { APP_URL: "" }],
    ["a blank value", { APP_URL: "   " }],
  ])("%s outside a browser", (_example, source) => {
    expect(getPublicEnv(source)).toEqual({ APP_URL: "http://localhost:8787" });
  });

  it("no configured value on a page", () => {
    vi.stubGlobal("location", { origin: "https://app.example.com" });

    expect(getPublicEnv({})).toEqual({ APP_URL: "https://app.example.com" });
  });

  it.each([
    ["a padded origin with a slash", " https://api.example.com/ ", "https://api.example.com"],
    ["a plain http origin", "http://api.example.com", "http://api.example.com"],
  ])("%s", (_example, APP_URL, origin) => {
    expect(getPublicEnv({ APP_URL })).toEqual({ APP_URL: origin });
  });

  it.each([
    ["text that is not a URL", "not-a-url"],
    ["an ftp URL", "ftp://api.example.com"],
    ["a script URL", "javascript:alert(1)"],
    ["a path", "https://api.example.com/base"],
    ["a query", "https://api.example.com/?x=1"],
    ["a hash", "https://api.example.com/#frag"],
  ])("%s", (_example, APP_URL) => {
    expect(() => getPublicEnv({ APP_URL })).toThrow(
      "Invalid public environment: APP_URL must be a valid URL",
    );
  });
});

describe("isDevMode", () => {
  it.each([
    ["a development build", { DEV: true }, true],
    ["a built bundle", { DEV: false }, false],
    ["an isolated preview", { DEV: false, MODE: "ui-preview" }, true],
    ["production", { DEV: false, MODE: "production" }, false],
    ["staging", { DEV: false, MODE: "staging" }, false],
    ["an empty environment", {}, false],
  ])("%s", (_example, source, devMode) => {
    expect(isDevMode(source)).toEqual(devMode);
  });
});
