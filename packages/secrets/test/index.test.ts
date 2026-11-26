import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createIsolateTokenCipherCache,
  TokenCipher,
  TokenCiphertextError,
  TokenCipherUnavailableError,
} from "../src";

const currentKey = "0123456789abcdef0123456789abcdef";
const oldKey = "abcdef0123456789abcdef0123456789";
const fixedNonce = Uint8Array.from({ length: 12 }, (_, index) => index);

describe("TokenCipher", () => {
  it("writes key-ID ciphertext and reads it through the configured ring", async () => {
    const cipher = new TokenCipher({
      currentKeyId: "current",
      keys: [
        { id: "old", material: oldKey },
        { id: "current", material: currentKey },
      ],
      randomBytes: () => fixedNonce,
    });

    const encrypted = await cipher.encrypt("provider-token");
    expect(encrypted).toMatch(/^meltiply:v2:current:/);
    await expect(cipher.decrypt(encrypted)).resolves.toBe("provider-token");
  });

  it("reads the Go-compatible version-one nonce/ciphertext layout", async () => {
    const payload = Buffer.from(
      "000102030405060708090a0bb11e4f390222fcbdb91f7ced35df66d09ed766b87499f9f13852214d",
      "hex",
    );
    const legacy = `meltiply:v1:${payload.toString("base64url")}`;
    const reader = new TokenCipher({
      currentKeyId: "current",
      keys: [
        { id: "current", material: currentKey },
        { id: "old", material: oldKey },
      ],
    });

    await expect(reader.decrypt(legacy)).resolves.toBe("legacy-token");

    const unrelated = new TokenCipher({
      currentKeyId: "current",
      keys: [{ id: "current", material: currentKey }],
    });
    await expect(unrelated.decrypt(legacy)).rejects.toBeInstanceOf(TokenCiphertextError);
  });

  it("keeps plaintext legacy rows readable during migration", async () => {
    const cipher = new TokenCipher({
      currentKeyId: "current",
      keys: [{ id: "current", material: currentKey }],
    });
    await expect(cipher.decrypt("plaintext-token")).resolves.toBe("plaintext-token");
  });

  it("imports each configured CryptoKey once per cipher", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    try {
      const cipher = new TokenCipher({
        currentKeyId: "current",
        keys: [{ id: "current", material: currentKey }],
        randomBytes: () => fixedNonce,
      });

      const encrypted = await cipher.encrypt("provider-token");
      await Promise.all([cipher.decrypt(encrypted), cipher.decrypt(encrypted)]);

      expect(importKey).toHaveBeenCalledOnce();
    } finally {
      importKey.mockRestore();
    }
  });

  it("classifies tampered AES-GCM ciphertexts with TokenCiphertextError", async () => {
    const cipher = new TokenCipher({
      currentKeyId: "current",
      keys: [{ id: "current", material: currentKey }],
      randomBytes: () => fixedNonce,
    });
    const encrypted = await cipher.encrypt("secret");
    const lastChar = encrypted.endsWith("A") ? "B" : "A";
    const tampered = encrypted.slice(0, -1) + lastChar;
    await expect(cipher.decrypt(tampered)).rejects.toBeInstanceOf(TokenCiphertextError);
    await expect(
      cipher.decrypt("meltiply:v2:current:invalid-payload-base64!"),
    ).rejects.toBeInstanceOf(TokenCiphertextError);
    await expect(cipher.decrypt("meltiply:v2:missing:AAAA")).rejects.toBeInstanceOf(
      TokenCiphertextError,
    );
  });

  it("caches isolate TokenCipher per key and rebuilds on rotation", async () => {
    const resolve = createIsolateTokenCipherCache();
    expect(() => resolve({})).toThrow(TokenCipherUnavailableError);
    expect(() => resolve({ TOKEN_ENCRYPTION_KEY: "too-short" })).toThrow(
      TokenCipherUnavailableError,
    );
    const first = resolve({ TOKEN_ENCRYPTION_KEY: currentKey });
    expect(resolve({ TOKEN_ENCRYPTION_KEY: currentKey })).toBe(first);
    const rotated = resolve({ TOKEN_ENCRYPTION_KEY: oldKey });
    expect(rotated).not.toBe(first);
    const encrypted = await rotated.encrypt("rotated-token");
    await expect(rotated.decrypt(encrypted)).resolves.toBe("rotated-token");
  });
});
