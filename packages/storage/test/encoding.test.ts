import { describe, expect, it } from "vite-plus/test";

import { assertValidByteRange, bytesToHex } from "../src/encoding";

describe("bytesToHex", () => {
  it.each([
    ["bytes with leading zeros", new Uint8Array([0, 10, 255]), "000aff"],
    ["a buffer", new Uint8Array([171]).buffer, "ab"],
    ["no bytes", new Uint8Array(), ""],
  ])("%s", (_example, value, hex) => {
    expect(bytesToHex(value)).toEqual(hex);
  });
});

describe("assertValidByteRange", () => {
  it.each([
    ["the first byte", 0, 1],
    ["exactly 1 MiB", 0, 1024 * 1024],
  ])("%s", (_example, offset, maximumBytes) => {
    expect(() => assertValidByteRange(offset, maximumBytes)).not.toThrow();
  });

  it.each([
    ["a negative offset", -1],
    ["a fractional offset", 0.5],
  ])("%s", (_example, offset) => {
    expect(() => assertValidByteRange(offset, 1)).toThrow(
      new RangeError("offset must be a non-negative safe integer"),
    );
  });

  it.each([
    ["zero bytes", 0],
    ["a fraction of bytes", 1.5],
    ["one byte over 1 MiB", 1024 * 1024 + 1],
  ])("%s", (_example, maximumBytes) => {
    expect(() => assertValidByteRange(0, maximumBytes)).toThrow(
      new RangeError("maximumBytes must be between 1 and 1048576"),
    );
  });
});
