import { describe, expect, it } from "vite-plus/test";

import { idempotencyHeaders } from "../src/idempotent-response";

describe("idempotency response headers", () => {
  it("marks replayed responses", () => {
    expect(idempotencyHeaders(true)).toEqual({
      "Idempotency-Replayed": "true",
    });
  });

  it("does not add a header to fresh responses", () => {
    expect(idempotencyHeaders(false)).toEqual({});
  });
});
