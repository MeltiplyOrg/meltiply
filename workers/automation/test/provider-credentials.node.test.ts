import { describe, expect, it } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import { decryptStoredToken, tokenCipherFor } from "../src/provider-credentials";

const primaryKey = "0123456789abcdef0123456789abcdef";
const rotatedKey = "abcdef0123456789abcdef0123456789";

function envWithKey(key?: string): AutomationEnv {
  return { TOKEN_ENCRYPTION_KEY: key } as AutomationEnv;
}

describe("provider credentials", () => {
  it("reuses the cipher when TOKEN_ENCRYPTION_KEY is unchanged", () => {
    const first = tokenCipherFor(envWithKey(primaryKey));

    expect(tokenCipherFor(envWithKey(primaryKey))).toBe(first);
  });

  it("rebuilds the cipher when TOKEN_ENCRYPTION_KEY changes", () => {
    const first = tokenCipherFor(envWithKey(primaryKey));

    expect(tokenCipherFor(envWithKey(rotatedKey))).not.toBe(first);
  });

  it("binds decryptStoredToken to the active cipher", async () => {
    const env = envWithKey(primaryKey);
    const ciphertext = await tokenCipherFor(env).encrypt("provider-token");

    expect(await decryptStoredToken(env)(ciphertext)).toEqual("provider-token");
  });

  it("defers missing-key failure until decryptStoredToken is invoked", () => {
    const decrypt = decryptStoredToken(envWithKey());

    expect(() => void decrypt("stored-token")).toThrow("token encryption is unavailable");
  });

  it("fails closed in tokenCipherFor when TOKEN_ENCRYPTION_KEY is missing", () => {
    expect(() => tokenCipherFor(envWithKey())).toThrow("token encryption is unavailable");
  });
});
