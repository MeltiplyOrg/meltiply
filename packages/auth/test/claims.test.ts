import { describe, expect, it } from "vite-plus/test";

import { accessClaims, bearerToken, jwtClaims } from "../src/claims";

describe("bearerToken", () => {
  it.each([
    ["one exact bearer token", "Bearer token-value", "token-value"],
    ["a token outside ASCII", "Bearer tökén", "tökén"],
    ["a lower-case scheme", "bearer token-value", undefined],
    ["two values", "Bearer two values", undefined],
    ["a scheme with no token", "Bearer ", undefined],
    ["an empty header", "", undefined],
    ["no header", undefined, undefined],
  ])("%s", (_example, authorization, token) => {
    expect(bearerToken(authorization)).toEqual(token);
  });
});

const identity = { email: "alpha@example.test", subject: "user-alpha" };

describe("jwtClaims", () => {
  it("every claim", () => {
    const payload = {
      email: "alpha@example.test",
      name: "Alpha Üser",
      sid: "session-1",
      sub: "user-alpha",
    };

    expect(jwtClaims(payload)).toEqual({ ...identity, name: "Alpha Üser", sessionId: "session-1" });
  });

  it("a padded email with capitals", () => {
    const payload = { email: "  ALPHA@Example.test  ", sub: " user-alpha " };

    expect(jwtClaims(payload)).toEqual(identity);
  });

  it("a blank name and session", () => {
    const payload = { email: "alpha@example.test", name: "  ", sid: "", sub: "user-alpha" };

    expect(jwtClaims(payload)).toStrictEqual(identity);
  });

  it.each([
    ["no subject", { email: "alpha@example.test" }],
    ["a blank subject", { email: "alpha@example.test", sub: "  " }],
    ["no email", { sub: "user-alpha" }],
    ["an email that is not text", { email: 7, sub: "user-alpha" }],
  ])("%s", (_example, payload) => {
    expect(() => jwtClaims(payload)).toThrow(
      new TypeError("JWT requires an identity subject and email"),
    );
  });
});

describe("accessClaims", () => {
  it("an application identity with a capitalised email", () => {
    const payload = { email: "OPERATOR@example.test", sub: "access-user", type: "app" };

    expect(accessClaims(payload)).toEqual({
      email: "operator@example.test",
      subject: "access-user",
    });
  });

  it.each([
    ["a service token", { email: "operator@example.test", sub: "access-user", type: "service" }],
    ["a token with no type", { email: "operator@example.test", sub: "access-user" }],
    ["no subject", { email: "operator@example.test", type: "app" }],
    ["no email", { sub: "access-user", type: "app" }],
  ])("%s", (_example, payload) => {
    expect(() => accessClaims(payload)).toThrow(
      new TypeError("Access token requires an identity subject and email"),
    );
  });
});
