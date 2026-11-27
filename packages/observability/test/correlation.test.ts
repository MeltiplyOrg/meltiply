import { describe, expect, it } from "vite-plus/test";

import { createRequestId, createTraceId, elapsedMilliseconds } from "../src/correlation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";

describe("createRequestId", () => {
  it.each([
    ["a safe ID", "request-valid-1", "request-valid-1"],
    ["a padded ID", "  request.a:b_c  ", "request.a:b_c"],
    ["an ID of 8 characters", "a".repeat(8), "a".repeat(8)],
    ["an ID of 128 characters", "a".repeat(128), "a".repeat(128)],
  ])("%s", (_example, incoming, id) => {
    expect(createRequestId(incoming)).toEqual(id);
  });

  it.each([
    ["an ID of 7 characters", "a".repeat(7)],
    ["an ID of 129 characters", "a".repeat(129)],
    ["an ID with a space", "bad id value"],
    ["an ID outside ASCII", "requête-1234"],
    ["an empty ID", ""],
    ["no ID", undefined],
    ["a null ID", null],
  ])("%s", (_example, incoming) => {
    expect(createRequestId(incoming)).toEqual(expect.stringMatching(UUID));
  });
});

describe("createTraceId", () => {
  it.each([
    ["a W3C traceparent", `00-${TRACE}-${PARENT}-01`],
    ["a padded upper-case traceparent", `  00-${TRACE.toUpperCase()}-${PARENT}-01  `],
  ])("%s", (_example, traceparent) => {
    expect(createTraceId(traceparent, "request-fallback-1")).toEqual(TRACE);
  });

  it.each([
    ["no traceparent", undefined],
    ["an unparseable traceparent", "invalid"],
    ["another version", `01-${TRACE}-${PARENT}-01`],
    ["a zero trace ID", `00-${"0".repeat(32)}-${PARENT}-01`],
    ["a zero parent ID", `00-${TRACE}-${"0".repeat(16)}-01`],
  ])("%s", (_example, traceparent) => {
    expect(createTraceId(traceparent, "request-fallback-1")).toEqual("request-fallback-1");
  });

  it("neither a traceparent nor a fallback", () => {
    expect(createTraceId(null)).toEqual(expect.stringMatching(UUID));
  });
});

describe("elapsedMilliseconds", () => {
  it.each([
    ["a fractional duration", 10, 12.345, 2.35],
    ["a finish before the start", 12, 10, 0],
    ["a start that is not a number", Number.NaN, 10, 0],
    ["an infinite finish", 10, Number.POSITIVE_INFINITY, 0],
  ])("%s", (_example, startedAt, finishedAt, elapsed) => {
    expect(elapsedMilliseconds(startedAt, finishedAt)).toEqual(elapsed);
  });
});
