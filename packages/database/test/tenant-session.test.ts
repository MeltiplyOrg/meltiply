import { describe, expect, it } from "vite-plus/test";

import { serializeAuthenticatedClaims, statementTimeoutMilliseconds } from "../src/tenant-session";

const userId = "10000000-0000-4000-8000-000000000001";
const orgId = "20000000-0000-4000-8000-000000000001";

describe("serializeAuthenticatedClaims", () => {
  it("a personal session", () => {
    expect(serializeAuthenticatedClaims({ sub: userId })).toEqual(`{"sub":"${userId}"}`);
  });

  it("a Workspace session with every claim", () => {
    const claims = { org_id: orgId, org_role: "admin", sub: userId };

    expect(serializeAuthenticatedClaims(claims)).toEqual(
      `{"org_id":"${orgId}","org_role":"admin","sub":"${userId}"}`,
    );
  });

  it("padded claims", () => {
    const claims = { org_id: " org ", org_role: " rôle ", sub: " user " };

    expect(serializeAuthenticatedClaims(claims)).toEqual(
      '{"org_id":"org","org_role":"rôle","sub":"user"}',
    );
  });

  it("blank optional claims", () => {
    expect(serializeAuthenticatedClaims({ org_id: " ", org_role: "", sub: "user" })).toEqual(
      '{"sub":"user"}',
    );
  });

  it("a blank subject", () => {
    expect(() => serializeAuthenticatedClaims({ sub: " " })).toThrow(
      new TypeError("authenticated database claims require sub"),
    );
  });
});

describe("statementTimeoutMilliseconds", () => {
  it.each([
    ["no requested timeout", undefined, 10_000],
    ["the shortest timeout", 1, 1],
    ["zero", 0, undefined],
    ["a negative timeout", -1, undefined],
    ["a fraction", 1.5, undefined],
    ["not a number", Number.NaN, undefined],
    ["past the safe integers", Number.MAX_SAFE_INTEGER + 1, undefined],
  ])("%s", (_example, requested, timeout) => {
    expect(statementTimeoutMilliseconds(requested)).toEqual(timeout);
  });
});
