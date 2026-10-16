import { describe, expect, it } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import { decryptStoredToken, tokenCipherFor } from "../src/provider-credentials";

const primaryKey = "0123456789abcdef0123456789abcdef";
const rotatedKey = "abcdef0123456789abcdef0123456789";

function envWithKey(key?: string): AutomationEnv {
  return { TOKEN_ENCRYPTION_KEY: key } as AutomationEnv;
}

describe("automation provider credentials", () => {
  it("reuses the cipher until the token key binding changes", () => {
    const first = tokenCipherFor(envWithKey(primaryKey));

    expect(tokenCipherFor(envWithKey(primaryKey))).toBe(first);
    expect(tokenCipherFor(envWithKey(rotatedKey))).not.toBe(first);
  });

  it("binds a decryptor to the reused cipher", async () => {
    const env = envWithKey(primaryKey);
    const ciphertext = await tokenCipherFor(env).encrypt("provider-token");

    await expect(decryptStoredToken(env)(ciphertext)).resolves.toBe("provider-token");
  });

  it("defers missing-key failure until the decryptor is used", () => {
    const decrypt = decryptStoredToken(envWithKey());

    expect(() => void decrypt("stored-token")).toThrowError("token encryption is unavailable");
  });

  it("fails closed when token encryption is unavailable", () => {
    expect(() => tokenCipherFor(envWithKey())).toThrowError("token encryption is unavailable");
  });
});
