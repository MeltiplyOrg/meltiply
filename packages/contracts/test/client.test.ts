import { describe, expect, it, vi } from "vite-plus/test";

import { apiVersionPath, createMeltiplyClient } from "../src/client";

describe("createMeltiplyClient", () => {
  it("appends the version path exactly once", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          contract_version: "1.0.0",
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

    // Independent literal: the spec's `servers[].url` entries all end in
    // `/api/v1` (openapi.yaml:13-17), so a client that drifts from the version
    // segment fails here rather than only in the generated types.
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
    // Keeping the TypeError class *and* the guard's own message makes this a
    // per-branch control: a TypeError raised anywhere else in the factory (URL
    // parsing, createClient) can no longer satisfy the case.
    const create = () => createMeltiplyClient(baseUrl);
    expect(create).toThrow(TypeError);
    expect(create).toThrow(
      /^Meltiply API base URL must be an origin without a path, query, or hash$/,
    );
  });
});
