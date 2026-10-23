import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getPublicEnv, isDevMode } from "./env";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public env parsing", () => {
  it("defaults to the page origin in browsers and the local API elsewhere", () => {
    // Node test environments have no `location`, so the local dev API applies.
    expect(getPublicEnv({})).toEqual({
      APP_URL: "http://localhost:8787",
    });

    vi.stubGlobal("location", { origin: "https://app.example.com" });
    expect(getPublicEnv({})).toEqual({
      APP_URL: "https://app.example.com",
    });
  });

  it("falls back to the same-origin default for empty or whitespace values", () => {
    expect(getPublicEnv({ APP_URL: "" })).toEqual({
      APP_URL: "http://localhost:8787",
    });
    expect(getPublicEnv({ APP_URL: "   " })).toEqual({
      APP_URL: "http://localhost:8787",
    });
  });

  it("trims and normalizes configured backend origins", () => {
    expect(
      getPublicEnv({
        APP_URL: " https://api.example.com/ ",
      }),
    ).toEqual({
      APP_URL: "https://api.example.com",
    });
  });

  it("rejects invalid backend origins", () => {
    expect(() =>
      getPublicEnv({
        APP_URL: "not-a-url",
      }),
    ).toThrow("APP_URL");
  });

  it("rejects non-http/https URL schemes", () => {
    for (const scheme of ["ftp://api.example.com", "javascript:alert(1)"]) {
      expect(() =>
        getPublicEnv({
          APP_URL: scheme,
        }),
      ).toThrow("Invalid public environment: APP_URL must be a valid URL");
    }
  });

  it("rejects backend origins with a path, query, or hash", () => {
    for (const apiBaseUrl of [
      "https://api.example.com/base",
      "https://api.example.com/base?x=1",
      "https://api.example.com/base#frag",
    ]) {
      expect(() =>
        getPublicEnv({
          APP_URL: apiBaseUrl,
        }),
      ).toThrow("Invalid public environment: APP_URL must be a valid URL");
    }
  });
});

describe("dev mode accessor", () => {
  it("reports development mode only for an explicit true flag", () => {
    expect(isDevMode({ DEV: true })).toBe(true);
    expect(isDevMode({ DEV: false })).toBe(false);
    expect(isDevMode({})).toBe(false);
  });
});
