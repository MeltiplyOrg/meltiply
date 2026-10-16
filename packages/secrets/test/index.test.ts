import { describe, expect, it, vi } from "vite-plus/test";

import { TokenCipher } from "../src";

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
    const writer = new TokenCipher({
      currentKeyId: "old",
      keys: [{ id: "old", material: oldKey }],
      randomBytes: () => fixedNonce,
    });
    const versionTwo = await writer.encrypt("legacy-token");
    const payload = versionTwo.split(":").at(-1)!;
    const legacy = `meltiply:v1:${payload}`;
    const reader = new TokenCipher({
      currentKeyId: "current",
      keys: [
        { id: "current", material: currentKey },
        { id: "old", material: oldKey },
      ],
    });

    await expect(reader.decrypt(legacy)).resolves.toBe("legacy-token");
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

  it("encrypts and decrypts via TokenCipher Effect methods", async () => {
    const { Effect } = await import("effect");
    const cipher = new TokenCipher({
      currentKeyId: "current",
      keys: [{ id: "current", material: currentKey }],
      randomBytes: () => fixedNonce,
    });

    const program = Effect.gen(function* () {
      const encrypted = yield* cipher.encryptEffect("secret-payload");
      const decrypted = yield* cipher.decryptEffect(encrypted);
      return { decrypted, encrypted };
    });

    const result = await Effect.runPromise(program);
    expect(result.encrypted).toMatch(/^meltiply:v2:current:/);
    expect(result.decrypted).toBe("secret-payload");
  });

  it("returns InvalidRequestError for malformed ciphertext in decryptEffect", async () => {
    const { Effect } = await import("effect");
    const cipher = new TokenCipher({
      currentKeyId: "current",
      keys: [{ id: "current", material: currentKey }],
    });

    const exit = await Effect.runPromiseExit(
      cipher.decryptEffect("meltiply:v2:current:invalid-payload-base64!"),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause.toString()).toContain("InvalidRequestError");
    }
  });

  it("SecretService works with createSecretServiceLive layer", async () => {
    const { Effect } = await import("effect");
    const { SecretService, createSecretServiceLive } = await import("../src");

    const liveLayer = createSecretServiceLive({
      currentKeyId: "current",
      keys: [{ id: "current", material: currentKey }],
      randomBytes: () => fixedNonce,
    });

    const program = Effect.gen(function* () {
      const service = yield* SecretService;
      const encrypted = yield* service.encrypt("api-token-value");
      const decrypted = yield* service.decrypt(encrypted);
      return { decrypted, encrypted };
    }).pipe(Effect.provide(liveLayer));

    const result = await Effect.runPromise(program);
    expect(result.encrypted).toMatch(/^meltiply:v2:current:/);
    expect(result.decrypted).toBe("api-token-value");
  });

  it("SecretService works with createSecretServiceTest layer", async () => {
    const { Effect } = await import("effect");
    const { SecretService, createSecretServiceTest } = await import("../src");

    const testLayer = createSecretServiceTest({
      encrypt: (plaintext) => Effect.succeed(`custom:${plaintext}`),
      decrypt: (ciphertext) => Effect.succeed(`decrypted:${ciphertext}`),
    });

    const program = Effect.gen(function* () {
      const service = yield* SecretService;
      const encrypted = yield* service.encrypt("test-secret");
      const decrypted = yield* service.decrypt(encrypted);
      return { decrypted, encrypted };
    }).pipe(Effect.provide(testLayer));

    const result = await Effect.runPromise(program);
    expect(result.encrypted).toBe("custom:test-secret");
    expect(result.decrypted).toBe("decrypted:custom:test-secret");
  });

  it("createSecretServiceLive accepts an existing TokenCipher instance", async () => {
    const { Effect } = await import("effect");
    const { SecretService, createSecretServiceLive } = await import("../src");

    const cipher = new TokenCipher({
      currentKeyId: "current",
      keys: [{ id: "current", material: currentKey }],
      randomBytes: () => fixedNonce,
    });

    const liveLayer = createSecretServiceLive(cipher);

    const program = Effect.gen(function* () {
      const service = yield* SecretService;
      return yield* service.encrypt("direct-instance-value");
    }).pipe(Effect.provide(liveLayer));

    const encrypted = await Effect.runPromise(program);
    expect(encrypted).toMatch(/^meltiply:v2:current:/);
  });

  it("createSecretServiceLive fails closed if options are invalid", async () => {
    const { Effect } = await import("effect");
    const { SecretService, createSecretServiceLive } = await import("../src");

    const invalidLayer = createSecretServiceLive({
      currentKeyId: "non-existent",
      keys: [{ id: "current", material: currentKey }],
    });

    const program = Effect.gen(function* () {
      const service = yield* SecretService;
      return yield* service.encrypt("will-fail");
    }).pipe(Effect.provide(invalidLayer));

    const exit = await Effect.runPromiseExit(program);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause.toString()).toContain("StorageUnavailableError");
    }
  });
});
