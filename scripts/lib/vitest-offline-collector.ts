import { beforeEach, vi } from "vite-plus/test";

const nativeFetch = globalThis.fetch.bind(globalThis);

/**
 * Worker suites exercise best-effort tracing without requiring a Compose collector.
 * Fail only Tempo exports immediately; all other requests retain native fetch.
 * Reinstall per test because suites restore their spies after each scenario.
 */
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "http://127.0.0.1:4318/v1/traces") {
      return Promise.reject(new TypeError("Unit-test Tempo collector is offline"));
    }
    return nativeFetch(input, init);
  });
});
