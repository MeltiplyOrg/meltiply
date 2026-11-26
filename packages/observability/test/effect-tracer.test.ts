import { Effect, Layer, Tracer } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { effectTracerLayer, type EffectTracerOptions } from "../src/effect-tracer";
import type { OtlpSpanInput } from "../src/otlp";

class FakeExporter {
  readonly spans: OtlpSpanInput[] = [];
  readonly environments: string[] = [];

  export = async (env: { ENVIRONMENT: string }, span: OtlpSpanInput) => {
    this.environments.push(env.ENVIRONMENT);
    this.spans.push(span);
  };
}

const context = {
  environment: "test",
  request_id: "span_parent_123",
  service: "api",
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  version: "1.0.0",
};

const SPAN_ID = expect.stringMatching(/^[0-9a-f]{16}$/);
const exported = {
  attributes: {},
  endTimeMs: expect.any(Number),
  name: "work",
  parentSpanId: "span_parent_123",
  service: "api",
  spanId: SPAN_ID,
  startTimeMs: expect.any(Number),
  status: "ok",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
};

function run<A, E>(effect: Effect.Effect<A, E>, options: EffectTracerOptions, from = context) {
  return Effect.runPromiseExit(effect.pipe(Effect.provide(effectTracerLayer(from, options))));
}

const work = Effect.withSpan("work")(Effect.succeed("done"));

beforeAll(async () => {
  await run(work, { exporter: new FakeExporter().export });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("effectTracerLayer", () => {
  it("a completed span with attributes", async () => {
    const exporter = new FakeExporter();
    const spanned = Effect.withSpan("work", { attributes: { "tenant.id": "org_456" } })(
      Effect.succeed("done"),
    );

    await run(spanned, { exporter: exporter.export });

    expect(exporter.spans).toEqual([{ ...exported, attributes: { "tenant.id": "org_456" } }]);
    expect(exporter.environments).toEqual(["test"]);
  });

  it("a failed span", async () => {
    const exporter = new FakeExporter();

    await run(Effect.withSpan("work")(Effect.fail("boom")), { exporter: exporter.export });

    expect(exporter.spans).toEqual([{ ...exported, status: "error" }]);
  });

  it("a span inside another span", async () => {
    const exporter = new FakeExporter();

    await run(Effect.withSpan("outer")(work), { exporter: exporter.export });

    const [inner, outer] = exporter.spans;
    expect(inner?.parentSpanId).toEqual(outer?.spanId);
  });

  it("a context with no request ID", async () => {
    const exporter = new FakeExporter();
    const { request_id: _omitted, ...anonymous } = context;

    await run(work, { exporter: exporter.export }, anonymous as typeof context);

    expect(exporter.spans).toEqual([{ ...exported, parentSpanId: "root-span" }]);
  });

  it("an unsampled span", async () => {
    const exporter = new FakeExporter();
    const unsampled = Effect.withSpan("work", { sampled: false })(Effect.succeed(42));

    await run(unsampled, { exporter: exporter.export });

    expect(exporter.spans).toEqual([]);
  });

  it("spans suppressed by the minimum trace level", async () => {
    const exporter = new FakeExporter();

    await run(work.pipe(Effect.provide(Layer.succeed(Tracer.MinimumTraceLevel, "None"))), {
      exporter: exporter.export,
    });

    expect(exporter.spans).toEqual([]);
  });

  it("an injected exporter outside local and test", async () => {
    const exporter = new FakeExporter();

    await run(work, { exporter: exporter.export }, { ...context, environment: "production" });

    expect(exporter.environments).toEqual(["production"]);
  });

  it("an export promise handed back", async () => {
    const promises: Promise<void>[] = [];
    const exporter = new FakeExporter();

    await run(work, {
      exporter: exporter.export,
      onExportPromise: (promise) => promises.push(promise),
    });

    expect(await Promise.all(promises)).toEqual([undefined]);
  });

  it("no exporter in the local environment", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response();
    });

    await run(work, {}, { ...context, environment: "local" });

    expect(urls).toEqual(["http://127.0.0.1:4318/v1/traces"]);
  });

  it("no exporter in production", async () => {
    const promises: Promise<void>[] = [];

    await run(
      work,
      { onExportPromise: (promise) => promises.push(promise) },
      { ...context, environment: "production" },
    );

    expect(promises).toEqual([]);
  });
});
