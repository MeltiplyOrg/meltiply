import { describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/core-types";
import type { ApiWorkerEnv } from "../src/env";
import { tokenCipherFor } from "../src/token-credentials";

const primaryKey = "0123456789abcdef0123456789abcdef";
const rotatedKey = "abcdef0123456789abcdef0123456789";

function envWithKey(key?: string): ApiWorkerEnv {
  return { TOKEN_ENCRYPTION_KEY: key } as ApiWorkerEnv;
}

describe("tokenCipherFor", () => {
  it("reuses the cipher when TOKEN_ENCRYPTION_KEY is unchanged", () => {
    const first = tokenCipherFor(envWithKey(primaryKey));

    expect(tokenCipherFor(envWithKey(primaryKey))).toBe(first);
  });

  it("rebuilds the cipher when TOKEN_ENCRYPTION_KEY changes", () => {
    const first = tokenCipherFor(envWithKey(primaryKey));

    expect(tokenCipherFor(envWithKey(rotatedKey))).not.toBe(first);
  });

  it("fails closed with 503 service_unavailable when TOKEN_ENCRYPTION_KEY is missing", () => {
    let caught: unknown;
    try {
      tokenCipherFor(envWithKey());
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(
      new CoreApiError(503, "service_unavailable", "Token encryption is unavailable."),
    );
  });
});
