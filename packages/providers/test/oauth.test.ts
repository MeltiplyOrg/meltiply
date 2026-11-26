import { beforeAll, describe, expect, it } from "vite-plus/test";

import { ProviderHttpClient } from "../src/http";
import {
  addSeconds,
  assertConfiguredRedirectUri,
  authorizationCodeUrl,
  exchangeAuthorizationCodeForm,
  postForm,
} from "../src/oauth";

const context = { operationId: "op-1", requestId: "req-1" };
const NOW = new Date("2026-01-02T00:00:00.000Z");
const REDIRECT = "https://app.test/callback";

function setup() {
  const requests: unknown[] = [];
  const http = new ProviderHttpClient({
    allowedOrigins: ["https://api.test"],
    platform: "threads",
    fetch: (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        type: new Headers(init?.headers).get("content-type"),
        body: String(init?.body),
      });
      return Promise.resolve(Response.json({ ok: 1 }));
    },
  });
  return { http, requests };
}

beforeAll(async () => {
  await postForm(setup().http, context, "https://api.test/token", {});
});

describe("addSeconds", () => {
  it.each([
    ["one second", 1, "2026-01-02T00:00:01.000Z"],
    ["the maximum", 60, "2026-01-02T00:01:00.000Z"],
  ])("%s", (_example, seconds, expected) => {
    expect(addSeconds(NOW, seconds, 60)).toEqual(expected);
  });

  it.each([
    ["zero", 0],
    ["one over the maximum", 61],
    ["a fraction", 1.5],
    ["a numeric string", "1"],
  ])("refuses %s", (_example, seconds) => {
    expect(() => addSeconds(NOW, seconds, 60)).toThrow("The provider is temporarily unavailable.");
  });
});

describe("assertConfiguredRedirectUri", () => {
  it("the configured URI", () => {
    expect(() => assertConfiguredRedirectUri(REDIRECT, REDIRECT)).not.toThrow();
  });

  it("another URI", () => {
    expect(() => assertConfiguredRedirectUri(`${REDIRECT}/x`, REDIRECT)).toThrow(
      new TypeError("OAuth redirect URI does not match configuration"),
    );
  });
});

describe("authorizationCodeUrl", () => {
  it("a state and extra parameters", () => {
    const input = { codeChallenge: "c", redirectUri: REDIRECT, state: " abc " };

    expect(authorizationCodeUrl("https://auth.test/go", input, REDIRECT, { scope: "a b" })).toEqual(
      "https://auth.test/go?scope=a+b&redirect_uri=https%3A%2F%2Fapp.test%2Fcallback&response_type=code&state=abc",
    );
  });

  it("a state of 1025 characters", () => {
    const input = { codeChallenge: "c", redirectUri: REDIRECT, state: "s".repeat(1_025) };

    expect(() => authorizationCodeUrl("https://auth.test", input, REDIRECT, {})).toThrow(
      new TypeError("state is invalid"),
    );
  });
});

describe("postForm", () => {
  it("fields as a form", async () => {
    const { http, requests } = setup();

    const body = await postForm(http, context, "https://api.test/token", { a: "1 2" });

    expect(body).toEqual({ ok: 1 });
    expect(requests).toEqual([
      {
        url: "https://api.test/token",
        method: "POST",
        type: "application/x-www-form-urlencoded",
        body: "a=1+2",
      },
    ]);
  });
});

describe("exchangeAuthorizationCodeForm", () => {
  const request = {
    clientId: "id",
    clientSecret: "secret",
    code: " code ",
    redirectUri: REDIRECT,
    tokenUrl: "https://api.test/token",
  };
  const redirect = "redirect_uri=https%3A%2F%2Fapp.test%2Fcallback";

  it.each([
    [
      "the default client field",
      {},
      `client_id=id&client_secret=secret&code=code&grant_type=authorization_code&${redirect}`,
    ],
    [
      "a client key and a verifier",
      { clientIdField: "client_key", codeVerifier: "v" } as const,
      `client_key=id&client_secret=secret&code=code&code_verifier=v&grant_type=authorization_code&${redirect}`,
    ],
  ])("%s", async (_example, patch, body) => {
    const { http, requests } = setup();

    await exchangeAuthorizationCodeForm(http, context, { ...request, ...patch });

    expect(requests).toEqual([expect.objectContaining({ body })]);
  });

  it("a blank code", () => {
    const { http } = setup();

    expect(() => exchangeAuthorizationCodeForm(http, context, { ...request, code: " " })).toThrow(
      new TypeError("authorizationCode is invalid"),
    );
  });
});
