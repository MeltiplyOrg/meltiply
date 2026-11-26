import { describe, expect, it } from "vite-plus/test";

import { codePointLength } from "../src";

describe("codePointLength", () => {
  it("counts BMP characters, astral surrogate pairs, and ZWJ sequences accurately", () => {
    expect(codePointLength("")).toBe(0);
    expect(codePointLength("hello")).toBe(5);
    expect(codePointLength("🚀")).toBe(1);
    expect(codePointLength("🚀a👨‍👩‍👧")).toBe(7);
    expect(codePointLength("\uD800")).toBe(1);
  });
});
