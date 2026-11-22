import { beforeEach, vi } from "vite-plus/test";

const nativeFetch = globalThis.fetch.bind(globalThis);

const offlineCollectorUrls = new Set([
  "http://127.0.0.1:4318/v1/traces",
  "http://127.0.0.1:3100/loki/api/v1/push",
]);

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (offlineCollectorUrls.has(url)) {
      return Promise.reject(new TypeError("Unit-test observability collector is offline"));
    }
    return nativeFetch(input, init);
  });
});
