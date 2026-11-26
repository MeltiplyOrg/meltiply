import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_MEDIA_ROUTE_PREFIX,
  signProviderMediaSignature,
  signProviderMediaUrl,
  verifyProviderMediaSignature,
} from "../src";

describe("provider-media signing and verification", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const key = "org-1/asset-1/original";
  const expires = 1_800_000_000;

  it("signs and verifies a valid provider-media URL", async () => {
    const signedUrl = await signProviderMediaUrl({
      appUrl: "https://app.meltiply.test",
      expiresAtSeconds: expires,
      key,
      secret,
    });
    expect(signedUrl).toBeDefined();
    const parsed = new URL(signedUrl!);
    expect(parsed.pathname).toBe(`${PROVIDER_MEDIA_ROUTE_PREFIX}${key}`);
    expect(parsed.searchParams.get("expires")).toBe(String(expires));
    const signature = parsed.searchParams.get("signature")!;
    await expect(verifyProviderMediaSignature(secret, expires, key, signature)).resolves.toBe(true);
    await expect(verifyProviderMediaSignature(secret, expires + 1, key, signature)).resolves.toBe(
      false,
    );
    await expect(
      verifyProviderMediaSignature(secret, expires, "org-1/asset-2/original", signature),
    ).resolves.toBe(false);
    await expect(verifyProviderMediaSignature(undefined, expires, key, signature)).resolves.toBe(
      false,
    );
    await expect(verifyProviderMediaSignature(secret, expires, key, "bad")).resolves.toBe(false);
  });

  it("returns undefined for insecure or incomplete verified delivery config", async () => {
    await expect(
      signProviderMediaUrl({
        appUrl: "http://127.0.0.1:3000",
        expiresAtSeconds: expires,
        key,
        secret,
      }),
    ).resolves.toBeUndefined();
    await expect(
      signProviderMediaUrl({
        appUrl: "https://user:pass@app.meltiply.test",
        expiresAtSeconds: expires,
        key,
        secret,
      }),
    ).resolves.toBeUndefined();
    await expect(
      signProviderMediaUrl({
        appUrl: "not-a-url",
        expiresAtSeconds: expires,
        key,
        secret,
      }),
    ).resolves.toBeUndefined();
    await expect(
      signProviderMediaUrl({
        appUrl: "https://app.meltiply.test",
        expiresAtSeconds: expires,
        key,
      }),
    ).resolves.toBeUndefined();
  });

  it("matches direct signature verification", async () => {
    const signature = await signProviderMediaSignature(secret, expires, key);
    await expect(verifyProviderMediaSignature(secret, expires, key, signature)).resolves.toBe(true);
  });
});
