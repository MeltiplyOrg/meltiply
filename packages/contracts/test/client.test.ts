import { describe, expect, it, vi } from "vite-plus/test";

import { apiVersionPath, createMeltiplyClient } from "../src/client";

describe("createMeltiplyClient", () => {
  it("appends the version path exactly once", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          version: "1.0.0-target.0",
          environment: "test",
        }),
        {
          headers: {
            "content-type": "application/json",
            "x-request-id": "request-1",
          },
        },
      ),
    );

    const client = createMeltiplyClient("https://api.example.test", fetchImpl);
    await client.GET("/health");

    expect(apiVersionPath).toBe("/api/v1");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [request] = fetchImpl.mock.calls[0] ?? [];
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).url).toBe("https://api.example.test/api/v1/health");
  });

  it.each([
    "https://api.example.test/api",
    "https://api.example.test?tenant=one",
    "https://api.example.test#fragment",
  ])("rejects a non-origin base URL: %s", (baseUrl) => {
    expect(() => createMeltiplyClient(baseUrl)).toThrow(TypeError);
  });
});
