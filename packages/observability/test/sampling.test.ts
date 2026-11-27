import { describe, expect, it } from "vite-plus/test";

import { emitsLine, samplingRate } from "../src/sampling";

describe("samplingRate", () => {
  it.each([
    ["no rate", undefined, 1],
    ["an empty string", "", 1],
    ["a blank string", "  ", 1],
    ["a numeric string", "0.5", 0.5],
    ["zero", 0, 0],
    ["one", 1, 1],
    ["a rate below zero", -1, 0],
    ["a rate above one", 2, 1],
    ["text", "invalid", 1],
    ["an infinite rate", Number.POSITIVE_INFINITY, 1],
  ])("%s", (_example, input, rate) => {
    expect(samplingRate(input)).toEqual(rate);
  });
});

describe("emitsLine", () => {
  it.each([
    ["a warning at a zero rate", "warn", "trace-dropped", 0, true],
    ["an error at a zero rate", "error", "trace-dropped", 0, true],
    ["info at a zero rate", "info", "trace-deterministic", 0, false],
    ["debug at a full rate", "debug", "trace-dropped", 1, true],
    ["a trace inside half the rate", "info", "trace-deterministic", 0.5, true],
    ["a trace outside half the rate", "info", "trace-dropped", 0.5, false],
    ["debug on a trace outside the rate", "debug", "trace-dropped", 0.5, false],
  ] as const)("%s", (_example, level, traceId, rate, emitted) => {
    expect(emitsLine(level, traceId, rate)).toEqual(emitted);
  });
});
