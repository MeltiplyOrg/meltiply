import { afterEach, describe, expect, it } from "vite-plus/test";

import { applyAuthJwt, captureAuthJwt, clearAuthJwt } from "./auth-token";

const capture = (headers: Record<string, string>) =>
  captureAuthJwt(new Response(null, { headers }));

function appliedHeader(): string | null {
  const headers = new Headers();
  applyAuthJwt(headers);
  return headers.get("authorization");
}

afterEach(clearAuthJwt);

describe("auth token", () => {
  it("a captured token", () => {
    capture({ "set-auth-jwt": " jwt-1 " });

    expect(appliedHeader()).toEqual("Bearer jwt-1");
  });

  it.each([
    ["a response without the header", {}],
    ["a blank header", { "set-auth-jwt": "  " }],
  ])("%s keeps the earlier token", (_example, headers) => {
    capture({ "set-auth-jwt": "jwt-1" });

    capture(headers);

    expect(appliedHeader()).toEqual("Bearer jwt-1");
  });

  it("a cleared token", () => {
    capture({ "set-auth-jwt": "jwt-1" });

    clearAuthJwt();

    expect(appliedHeader()).toEqual(null);
  });
});
