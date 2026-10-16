import { describe, expect, it } from "vite-plus/test";

import { isHttp404, malformed } from "../src/adapter-helpers";
import { classifyProviderFailure, ProviderAdapterError } from "../src/failures";

describe("shared provider adapter helpers", () => {
  it("classifies malformed responses with the side-effect boundary", () => {
    expect(malformed().failure.classification).toBe("transient");
    expect(malformed(true).failure.classification).toBe("ambiguous");
  });

  it("recognizes only the canonical provider 404 adapter error", () => {
    const notFound = new ProviderAdapterError(
      classifyProviderFailure({ code: "provider_http_404", status: 404 }),
    );
    const other = new ProviderAdapterError(
      classifyProviderFailure({ code: "provider_http_500", status: 500 }),
    );

    expect(isHttp404(notFound)).toBe(true);
    expect(isHttp404(other)).toBe(false);
    expect(isHttp404(new Error("provider_http_404"))).toBe(false);
  });
});
