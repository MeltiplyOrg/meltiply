import { describe, expect, it } from "vite-plus/test";

import { idempotencyHeaders } from "../src/idempotent-response";

describe("idempotencyHeaders", () => {
  it("a replayed response", () => {
    expect(idempotencyHeaders(true)).toEqual({
      "Idempotency-Replayed": "true",
    });
  });

  it("a fresh response", () => {
    expect(idempotencyHeaders(false)).toEqual({});
  });
});
