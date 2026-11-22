import { describe, expect, it } from "vite-plus/test";

import {
  classifyProviderFailure,
  isHttp404,
  isUncertainFailure,
  malformed,
  ProviderAdapterError,
  rejection,
} from "../src/failures";
import { confirmedFailure } from "../src/results";
import { codePointLength, firstNonEmptyLine } from "../src/values";

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

  it("classifies uncertain failures consistently", () => {
    const ambiguous = classifyProviderFailure({ sideEffectPossible: true, timedOut: true });
    const timeout = classifyProviderFailure({ timedOut: true });
    const transient = classifyProviderFailure({ status: 503 });
    const rateLimit = classifyProviderFailure({ status: 429 });
    const deterministic = classifyProviderFailure({ status: 400 });

    expect(isUncertainFailure(ambiguous)).toBe(true);
    expect(isUncertainFailure(timeout)).toBe(true);
    expect(isUncertainFailure(transient)).toBe(true);
    expect(isUncertainFailure(rateLimit)).toBe(false);
    expect(isUncertainFailure(deterministic)).toBe(false);
  });

  it("builds confirmedFailure from a ProviderFailure", () => {
    const existing = classifyProviderFailure({ code: "tiktok_denied", status: 422 });
    expect(confirmedFailure(existing, "publish:1")).toEqual({
      failure: existing,
      outcome: "confirmed_failure",
      providerOperationId: "publish:1",
    });
    expect(confirmedFailure(rejection("instagram_reply_invalid", 400))).toMatchObject({
      failure: { classification: "deterministic", code: "instagram_reply_invalid" },
      outcome: "confirmed_failure",
    });
  });

  it("counts codepoints without allocating and extracts the first non-empty line", () => {
    expect(codePointLength("")).toBe(0);
    expect(codePointLength("🚀a👨‍👩‍👧")).toBe(7);
    expect(firstNonEmptyLine("  \r\n\n  First title \r\nSecond line")).toBe("First title");
    expect(firstNonEmptyLine("   \n\t  ")).toBeUndefined();
  });
});
