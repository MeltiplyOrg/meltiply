import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  DeviceAuthorizationError,
  normalizeDeviceUserCode,
  verifyDeviceAuthorization,
} from "./device-authorization";

let sent: { url: string; method: string | undefined; body: unknown }[];
let answer: Response;

beforeEach(() => {
  sent = [];
  answer = Response.json({});
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method, body: init.body });
    return Promise.resolve(answer);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const AUTH = "http://localhost:8787/api/auth";

describe("normalizeDeviceUserCode", () => {
  it.each([
    ["abc-def 12", "ABCDEF12"],
    ["ABC234", "ABC234"],
    ["é-1", "1"],
    ["", ""],
  ])("the code %j", (value, code) => {
    expect(normalizeDeviceUserCode(value)).toEqual(code);
  });
});

describe("verifyDeviceAuthorization", () => {
  it("a pending request naming its client and scope", async () => {
    const review = { client_id: "melti-cli", scope: "posts", status: "pending", user_code: "ABC" };
    answer = Response.json({ ...review, device_code: "never exposed" });

    expect(await verifyDeviceAuthorization("ABC")).toEqual(review);
    expect(sent).toEqual([{ url: `${AUTH}/device?user_code=ABC`, method: "GET", body: undefined }]);
  });

  it.each(["approved", "denied"])("an %s request without a client or scope", async (status) => {
    answer = Response.json({ client_id: "", status, user_code: "ABC" });

    expect(await verifyDeviceAuthorization("ABC")).toEqual({ status, user_code: "ABC" });
  });

  it.each([
    ["an unknown status", { status: "later", user_code: "ABC" }],
    ["no user code", { status: "pending" }],
    ["a list", []],
  ])("%s", async (_example, body) => {
    answer = Response.json(body);

    await expect(verifyDeviceAuthorization("ABC")).rejects.toEqual(
      new DeviceAuthorizationError({ code: "unknown", status: 200 }),
    );
  });

  it.each([
    [
      "an OAuth error",
      { error: "expired_token", error_description: "Too late" },
      { code: "expired_token", description: "Too late" },
    ],
    [
      "an API envelope",
      { error: { code: "rate_limited", message: "Slow down" } },
      { code: "rate_limited", description: "Slow down" },
    ],
    ["an unlisted code", { error: "teapot", error_description: " " }, { code: "unknown" }],
    ["a body without an error", {}, { code: "unknown" }],
  ] as const)("%s", async (_example, body, details) => {
    answer = Response.json(body, { status: 400 });

    await expect(verifyDeviceAuthorization("ABC")).rejects.toEqual(
      new DeviceAuthorizationError({ ...details, status: 400 }),
    );
  });

  it.each([
    ["whole seconds", "12", 12],
    ["a date", "Wed, 21 Oct 2015 07:28:00 GMT", undefined],
    ["an unsafe number", "9".repeat(20), undefined],
  ])("a rate limit retried after %s", async (_example, header, retryAfterSeconds) => {
    answer = new Response("<html>", { headers: { "Retry-After": header }, status: 429 });

    const error = await verifyDeviceAuthorization("ABC").catch((caught: unknown) => caught);

    expect((error as DeviceAuthorizationError).retryAfterSeconds).toEqual(retryAfterSeconds);
  });
});

describe.each([
  ["approveDeviceAuthorization", approveDeviceAuthorization, "device/approve"],
  ["denyDeviceAuthorization", denyDeviceAuthorization, "device/deny"],
])("%s", (_name, decide, path) => {
  it("an accepted decision", async () => {
    answer = Response.json({ success: true });

    await decide("ABC");

    expect(sent).toEqual([{ url: `${AUTH}/${path}`, method: "POST", body: '{"userCode":"ABC"}' }]);
  });

  it("an answer without success", async () => {
    answer = Response.json({ success: false });

    await expect(decide("ABC")).rejects.toEqual(
      new DeviceAuthorizationError({ code: "unknown", status: 200 }),
    );
  });

  it("a refused decision", async () => {
    answer = Response.json({ error: "access_denied" }, { status: 403 });

    await expect(decide("ABC")).rejects.toEqual(
      new DeviceAuthorizationError({ code: "access_denied", status: 403 }),
    );
  });
});
