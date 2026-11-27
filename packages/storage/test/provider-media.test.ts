import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  signProviderMediaSignature,
  signProviderMediaUrl,
  verifyProviderMediaSignature,
} from "../src/provider-media";

const secret = "0123456789abcdef0123456789abcdef";
const key = "org-1/asset-1/original";
const expiresAtSeconds = 1_800_000_000;
const SIGNATURE = "9K1QGriZ14O5DY9bmWSQlIUOw7lOAykT39xndJtLWgQ";
const input = { appUrl: "https://app.meltiply.test", expiresAtSeconds, key, secret };

beforeAll(async () => {
  await signProviderMediaSignature(secret, expiresAtSeconds, key);
});

describe("signProviderMediaSignature", () => {
  it("a key", async () => {
    expect(await signProviderMediaSignature(secret, expiresAtSeconds, key)).toEqual(SIGNATURE);
  });
});

describe("verifyProviderMediaSignature", () => {
  it("the matching signature", async () => {
    expect(await verifyProviderMediaSignature(secret, expiresAtSeconds, key, SIGNATURE)).toEqual(
      true,
    );
  });

  it.each([
    ["another expiry", secret, expiresAtSeconds + 1, key, SIGNATURE],
    ["another key", secret, expiresAtSeconds, "org-1/asset-2/original", SIGNATURE],
    ["another secret", "f".repeat(32), expiresAtSeconds, key, SIGNATURE],
    ["no secret", undefined, expiresAtSeconds, key, SIGNATURE],
    ["a short signature", secret, expiresAtSeconds, key, "bad"],
    ["a padded signature", secret, expiresAtSeconds, key, `${SIGNATURE}=`],
    ["an empty signature", secret, expiresAtSeconds, key, ""],
  ])("%s", async (_example, withSecret, expiry, objectKey, signature) => {
    expect(await verifyProviderMediaSignature(withSecret, expiry, objectKey, signature)).toEqual(
      false,
    );
  });
});

describe("signProviderMediaUrl", () => {
  it("an https application origin", async () => {
    expect(await signProviderMediaUrl({ ...input, appUrl: " https://app.meltiply.test " })).toEqual(
      `https://app.meltiply.test/api/v1/provider-media/${key}?expires=1800000000&signature=${SIGNATURE}`,
    );
  });

  it("a key with a space outside ASCII", async () => {
    expect(await signProviderMediaUrl({ ...input, key: "org 1/asset-1/post é.png" })).toEqual(
      `https://app.meltiply.test/api/v1/provider-media/org%201/asset-1/post%20%C3%A9.png?expires=1800000000&signature=uQQaN_fjYPhi_0TdMZGZ2UJqISk0Y5KUr6GdMWg6j2w`,
    );
  });

  it.each([
    ["a plain-http origin", { appUrl: "http://127.0.0.1:3000" }],
    ["a username", { appUrl: "https://user@app.meltiply.test" }],
    ["a password", { appUrl: "https://:pass@app.meltiply.test" }],
    ["an origin that is not a URL", { appUrl: "not-a-url" }],
    ["a blank origin", { appUrl: " " }],
    ["no origin", { appUrl: undefined }],
    ["no secret", { secret: undefined }],
  ])("%s", async (_example, override) => {
    expect(await signProviderMediaUrl({ ...input, ...override })).toEqual(undefined);
  });

  it("a traversal key", async () => {
    await expect(signProviderMediaUrl({ ...input, key: "org/../x" })).rejects.toThrow(
      new TypeError("key must be a non-empty path segment"),
    );
  });
});
