import { describe, expect, it } from "vite-plus/test";

describe("provider HTTP runtime contract", () => {
  it("rejects redirect: 'error' before any socket is opened", async () => {
    await expect(fetch("https://127.0.0.1:9/", { redirect: "error" })).rejects.toThrow(
      /Invalid redirect value/,
    );
  });
});
