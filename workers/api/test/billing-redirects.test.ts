import { describe, expect, it } from "vite-plus/test";

import { validateBillingRedirect } from "../src/billing-redirects";

const allowedOrigins = "https://app.example.test,http://localhost:3000";

function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (cause) {
    return cause;
  }
  throw new Error("expected validation to fail");
}

describe("billing redirect validation", () => {
  it("accepts exact HTTPS and loopback origins", () => {
    expect(
      validateBillingRedirect(
        "https://app.example.test/billing?done=1",
        "success_url",
        allowedOrigins,
      ),
    ).toBe("https://app.example.test/billing?done=1");
    expect(
      validateBillingRedirect("http://localhost:3000/billing", "return_url", allowedOrigins),
    ).toBe("http://localhost:3000/billing");
  });

  it("rejects an unapproved origin and lookalike host", () => {
    expect(
      capture(() =>
        validateBillingRedirect(
          "https://app.example.test.evil.example/billing",
          "success_url",
          allowedOrigins,
        ),
      ),
    ).toMatchObject({ code: "redirect_not_allowed", status: 422 });
  });

  it("rejects insecure non-loopback and malformed URLs", () => {
    expect(
      capture(() =>
        validateBillingRedirect("http://app.example.test/billing", "return_url", allowedOrigins),
      ),
    ).toMatchObject({ code: "validation_error", status: 422 });
    expect(
      capture(() => validateBillingRedirect("not a URL", "return_url", allowedOrigins)),
    ).toMatchObject({ code: "validation_error", status: 422 });
  });
});
