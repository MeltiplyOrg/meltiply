import { describe, expect, it } from "vite-plus/test";

import { apiErrorCode, userFacingErrorMessage } from "./frontend-errors";

describe("userFacingErrorMessage", () => {
  it("retains safe domain recovery copy", () => {
    expect(
      userFacingErrorMessage({
        code: "active_organization_required",
        message: "database detail must never reach the browser",
        status: 409,
      }),
    ).toBe("Choose an active workspace to continue.");
    expect(userFacingErrorMessage({ code: "asset_in_use", status: 409 })).toBe(
      "This asset cannot be deleted while it is in use.",
    );
  });

  it.each([
    new Error("secret provider response and SQL detail"),
    { code: "dependency_unavailable", status: 503 },
    { code: "provider_unavailable", status: 502 },
    { code: "provider_unavailable", status: 404 },
    { code: "rate_limited", status: 503 },
    { status: 503 },
    { status: 599 },
    { code: "unknown_failure" },
  ])("uses generic copy for system failures: %s", (error) => {
    expect(userFacingErrorMessage(error)).toBe("An error has occurred.");
  });

  it("retains safe actionable status mappings", () => {
    expect(userFacingErrorMessage({ status: 403 })).toBe(
      "Your session no longer has access to this workspace.",
    );
    expect(userFacingErrorMessage({ status: 404 })).toBe("That item is no longer available.");
  });
});

describe("apiErrorCode", () => {
  it("exposes the code so a surface can branch on a masked infrastructure state", () => {
    expect(apiErrorCode({ code: "provider_unavailable", status: 503 })).toBe("provider_unavailable");
  });

  it("returns undefined when no code is present", () => {
    expect(apiErrorCode(new Error("plain"))).toBeUndefined();
    expect(apiErrorCode({ status: 503 })).toBeUndefined();
    expect(apiErrorCode({ code: 42 })).toBeUndefined();
    expect(apiErrorCode(null)).toBeUndefined();
    expect(apiErrorCode(["provider_unavailable"])).toBeUndefined();
  });
});
