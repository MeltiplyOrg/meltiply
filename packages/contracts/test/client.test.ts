import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createMeltiplyClient } from "../src/client";

async function requestedUrls(baseUrl: string) {
  const urls: string[] = [];
  const client = createMeltiplyClient(baseUrl, async (input) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return Response.json({ status: "ok" });
  });
  await client.GET("/health");
  return urls;
}

beforeAll(async () => {
  await requestedUrls("https://api.example.test");
});

describe("createMeltiplyClient", () => {
  it.each([
    ["an https origin", "https://api.example.test", "https://api.example.test/api/v1/health"],
    ["a trailing slash", "https://api.example.test/", "https://api.example.test/api/v1/health"],
    ["a local http origin", "http://localhost:8787", "http://localhost:8787/api/v1/health"],
  ])("%s", async (_example, baseUrl, url) => {
    expect(await requestedUrls(baseUrl)).toEqual([url]);
  });

  it.each([
    ["a path", "https://api.example.test/api"],
    ["a query", "https://api.example.test?tenant=one"],
    ["a fragment", "https://api.example.test#fragment"],
    ["another protocol", "ftp://api.example.test/"],
  ])("a base URL with %s", (_example, baseUrl) => {
    expect(() => createMeltiplyClient(baseUrl)).toThrow(
      new TypeError("Meltiply API base URL must be an origin without a path, query, or hash"),
    );
  });

  it("a base URL that is not a URL", () => {
    expect(() => createMeltiplyClient("api.example.test")).toThrow(TypeError);
  });
});
