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
const CURRENT_CIPHERTEXT =
  "meltiply:v2:current:AAECAwQFBgcICQoLXZfUCrB8t96FqB7VFKGNMefcRDGv564aUK8jGEE6";
const LEGACY_CIPHERTEXT = "meltiply:v1:AQIDBAUGBwgJCgsMKfH4s3YtSa1xMlA1V2L1sFMHzNCl1B3p7i1p2A";

function cipherOf(...keys: { id: string; material: string }[]) {
  return new TokenCipher({ currentKeyId: "current", keys, randomBytes: () => fixedNonce });
}

const currentCipher = () => cipherOf({ id: "current", material: currentKey });

describe("TokenCipher", () => {
  describe("constructor", () => {
    it.each([
      ["a current key ID outside the ring", "missing"],
      ["a blank current key ID", "   "],
    ])("%s", (_example, currentKeyId) => {
      expect(
        () => new TokenCipher({ currentKeyId, keys: [{ id: "current", material: currentKey }] }),
      ).toThrow("current token key ID must reference a configured key");
    });

    it("key material that is not 32 bytes", () => {
      expect(() => cipherOf({ id: "current", material: "too-short" })).toThrow(
        "token key material must decode to 32 bytes",
      );
    });
  });

  describe("encrypt", () => {
    it.each([
      ["a token under the current key of a ring", "provider-token", CURRENT_CIPHERTEXT],
      [
        "a token outside ASCII",
        "tök🚀",
        "meltiply:v2:current:AAECAwQFBgcICQoLWSYNFymHSCwfJXSL32yrcU-rzGB0oTAF",
      ],
      ["an empty token", "", "meltiply:v2:current:AAECAwQFBgcICQoLUZJP08yieN3vntriEyAWqg"],
    ])("%s", async (_example, plaintext, ciphertext) => {
      const cipher = cipherOf(
        { id: "old", material: oldKey },
        { id: "current", material: currentKey },
      );

      expect(await cipher.encrypt(plaintext)).toEqual(ciphertext);
    });

    it("base64 key material", async () => {
      const cipher = cipherOf({
        id: "current",
        material: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      });

      expect(await cipher.encrypt("provider-token")).toEqual(CURRENT_CIPHERTEXT);
    });

    it("a nonce source of the wrong length", async () => {
      const cipher = new TokenCipher({
        currentKeyId: "current",
        keys: [{ id: "current", material: currentKey }],
        randomBytes: () => new Uint8Array(11),
      });

      await expect(cipher.encrypt("provider-token")).rejects.toEqual(
        new TypeError("token nonce source returned an invalid length"),
      );
    });
  });

  describe("decrypt", () => {
    it("a version-two value", async () => {
      expect(await currentCipher().decrypt(CURRENT_CIPHERTEXT)).toEqual("provider-token");
    });

    it("a version-one value sealed by a later key of the ring", async () => {
      const cipher = cipherOf(
        { id: "current", material: currentKey },
        { id: "old", material: oldKey },
      );

      expect(await cipher.decrypt(LEGACY_CIPHERTEXT)).toEqual("legacy-token");
    });

    it("an unprefixed plaintext row", async () => {
      expect(await currentCipher().decrypt("plaintext-token")).toEqual("plaintext-token");
    });

    it("a version-one value no key opens", async () => {
      await expect(currentCipher().decrypt(LEGACY_CIPHERTEXT)).rejects.toEqual(
        new TokenCiphertextError("legacy token ciphertext cannot be decrypted"),
      );
    });

    it.each([
      ["an unknown key ID", "meltiply:v2:missing:AAAA"],
      ["no key ID", "meltiply:v2::AAAA"],
      ["no payload", "meltiply:v2:current"],
      ["an extra segment", `${CURRENT_CIPHERTEXT}:extra`],
    ])("%s", async (_example, value) => {
      await expect(currentCipher().decrypt(value)).rejects.toEqual(
        new TokenCiphertextError("token ciphertext references an unknown key"),
      );
    });

    it.each([
      ["a payload that is not base64", "meltiply:v2:current:invalid-payload-base64!"],
      ["a payload of only a nonce", "meltiply:v2:current:AAECAwQFBgcICQoL"],
      ["a tampered ciphertext", `${CURRENT_CIPHERTEXT.slice(0, -1)}7`],
    ])("%s", async (_example, value) => {
      await expect(currentCipher().decrypt(value)).rejects.toEqual(
        new TokenCiphertextError("token ciphertext is invalid"),
      );
    });

    it("two reads after a write import the key once", async () => {
      const importKey = vi.spyOn(crypto.subtle, "importKey");
      try {
        const cipher = currentCipher();

        const encrypted = await cipher.encrypt("provider-token");
        await Promise.all([cipher.decrypt(encrypted), cipher.decrypt(encrypted)]);

        expect(importKey).toHaveBeenCalledOnce();
      } finally {
        importKey.mockRestore();
      }
    });
  });
});

describe("createIsolateTokenCipherCache", () => {
  it.each([
    ["no key binding", {}, "Token encryption is unavailable."],
    [
      "an unusable key binding",
      { TOKEN_ENCRYPTION_KEY: "too-short" },
      "token key material must decode to 32 bytes",
    ],
  ])("%s", (_example, env, message) => {
    const resolve = createIsolateTokenCipherCache();

    expect(() => resolve(env)).toThrow(new TokenCipherUnavailableError(message));
  });

  it("the same key twice", () => {
    const resolve = createIsolateTokenCipherCache();

    const first = resolve({ TOKEN_ENCRYPTION_KEY: currentKey });

    expect(resolve({ TOKEN_ENCRYPTION_KEY: currentKey })).toBe(first);
  });

  it("a rotated key", async () => {
    const resolve = createIsolateTokenCipherCache();
    resolve({ TOKEN_ENCRYPTION_KEY: currentKey });

    const rotated = resolve({ TOKEN_ENCRYPTION_KEY: oldKey });

    const sealedWithOldKey = await new TokenCipher({
      currentKeyId: "primary",
      keys: [{ id: "primary", material: oldKey }],
    }).encrypt("rotated-token");
    expect(await rotated.decrypt(sealedWithOldKey)).toEqual("rotated-token");
  });
});
