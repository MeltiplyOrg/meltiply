import { describe, expect, it } from "vite-plus/test";

import { otlpTracePayload } from "../src/otlp-payload";

const span = {
  endTimeMs: 2,
  name: "load",
  service: "api",
  startTimeMs: 1,
  status: "ok",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
} as const;

const payload = (attributes: unknown[], fields: Record<string, unknown>) => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "api" } },
          { key: "deployment.environment", value: { stringValue: "test" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "meltiply-tracer" },
          spans: [
            {
              attributes,
              endTimeUnixNano: "2000000",
              kind: 1,
              name: "load",
              startTimeUnixNano: "1000000",
              status: { code: 1 },
              traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
              ...fields,
            },
          ],
        },
      ],
    },
  ],
});

describe("otlpTracePayload", () => {
  it("every field with attributes of each kind", () => {
    const attributes = {
      count: 2,
      cached: true,
      nested: { a: 1 },
      empty: null,
      route: "/x",
      token: "secret",
    };
    const input = {
      ...span,
      attributes,
      parentSpanId: "0123456789ABCDEF",
      spanId: "fedcba9876543210",
    };

    expect(otlpTracePayload("test", input)).toEqual(
      payload(
        [
          { key: "count", value: { intValue: 2 } },
          { key: "cached", value: { boolValue: true } },
          { key: "nested", value: { stringValue: '{"a":1}' } },
          { key: "empty", value: { stringValue: "" } },
          { key: "route", value: { stringValue: "/x" } },
          { key: "token", value: { stringValue: "[REDACTED]" } },
        ],
        { parentSpanId: "0123456789abcdef", spanId: "fedcba9876543210" },
      ),
    );
  });

  it("a failed span with a UUID trace and no IDs", () => {
    const input = { ...span, status: "error", traceId: "4bf92f35-77b3-4da6-a3ce-929d0e0e4736" };

    expect(otlpTracePayload("test", { ...input, status: "error" })).toEqual(
      payload([], { spanId: "00000000416ad6f6", status: { code: 2 } }),
    );
  });

  it("IDs that are not hexadecimal", () => {
    const input = { ...span, parentSpanId: "span_parent", traceId: "trace-é" };

    expect(otlpTracePayload("test", input)).toEqual(
      payload([], {
        parentSpanId: "000000000657d8c1",
        spanId: "00000000416ad6f6",
        traceId: "3f9f459f00ace0000000000000000000",
      }),
    );
  });
});
