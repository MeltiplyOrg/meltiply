import { describe, expect, it } from "vite-plus/test";

import { apiErrorCode, userFacingErrorMessage } from "./frontend-errors";

const GENERIC = "An error has occurred.";
const NO_ACCESS = "Your session no longer has access to this workspace.";
const GONE = "That item is no longer available.";

describe("userFacingErrorMessage", () => {
  it.each([
    ["active_organization_required", "Choose an active workspace to continue."],
    ["asset_in_use", "This asset cannot be deleted while it is in use."],
    ["conflict", "This changed while you were working. Refresh and try again."],
    ["quota_exceeded", "Your storage or upload quota has been reached."],
    ["rate_limited", "Too many requests. Wait a moment and try again."],
  ])("the %s code", (code, message) => {
    const error = { code, message: "database detail", status: 409 };

    expect(userFacingErrorMessage(error)).toEqual(message);
  });

  it.each([
    ["a public code on a 403", { code: "conflict", status: 403 }],
    ["a public code on a 404", { code: "conflict", status: 404 }],
  ])("%s", (_example, error) => {
    expect(userFacingErrorMessage(error)).toEqual(
      "This changed while you were working. Refresh and try again.",
    );
  });

  it.each([
    ["a status of 401", { status: 401 }, NO_ACCESS],
    ["a status of 403", { status: 403 }, NO_ACCESS],
    ["a status of 404", { status: 404 }, GONE],
    [
      "a status of 499",
      { code: "rate_limited", status: 499 },
      "Too many requests. Wait a moment and try again.",
    ],
    ["a status of 500", { code: "rate_limited", status: 500 }, GENERIC],
    ["a status of 599", { status: 599 }, GENERIC],
    ["an unmapped status", { status: 400 }, GENERIC],
    ["an unavailable dependency", { code: "dependency_unavailable", status: 404 }, GENERIC],
    ["an unavailable provider", { code: "provider_unavailable", status: 404 }, GENERIC],
    ["an unknown code", { code: "unknown_failure" }, GENERIC],
    ["a constructor code", { code: "constructor" }, GENERIC],
    ["a toString code", { code: "toString" }, GENERIC],
    ["a prototype code", { code: "__proto__" }, GENERIC],
    ["a thrown error", new Error("secret provider response and SQL detail"), GENERIC],
    ["a thrown null", null, GENERIC],
  ])("%s", (_example, error, message) => {
    expect(userFacingErrorMessage(error)).toEqual(message);
  });

  it("a missing item in Spanish", () => {
    expect(userFacingErrorMessage({ status: 404 }, "es")).toEqual(
      "Ese elemento ya no está disponible.",
    );
  });
});

describe("apiErrorCode", () => {
  it.each([
    ["a coded error", { code: "provider_unavailable", status: 503 }, "provider_unavailable"],
    ["a thrown error", new Error("plain"), undefined],
    ["an object without a code", { status: 503 }, undefined],
    ["a numeric code", { code: 42 }, undefined],
    ["a null value", null, undefined],
    ["an array", ["provider_unavailable"], undefined],
  ])("%s", (_example, error, code) => {
    expect(apiErrorCode(error)).toEqual(code);
  });
});
