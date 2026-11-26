import { Effect } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { effectLoggerLayer } from "../src/effect-logger";

const context = {
  environment: "test",
  request_id: "req-999",
  service: "api-worker",
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  version: "1.0.0",
};

async function written(level: "error" | "info", program: Effect.Effect<void>) {
  const lines: unknown[] = [];
  vi.spyOn(console, level).mockImplementation((line: string) => {
    lines.push(JSON.parse(line));
  });
  await Effect.runPromise(program.pipe(Effect.provide(effectLoggerLayer(context))));
  return lines;
}

const envelope = {
  environment: "test",
  request_id: "req-999",
  service: "api-worker",
  timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  version: "1.0.0",
};

beforeAll(async () => {
  await written("info", Effect.log("warm_up"));
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("effectLoggerLayer", () => {
  it("an Effect.log call", async () => {
    expect(await written("info", Effect.log("user_profile_loaded"))).toEqual([
      {
        ...envelope,
        context: { event: "user_profile_loaded", outcome: "success", retry_class: "none" },
        level: "info",
        message: "user profile loaded",
      },
    ]);
  });

  it("an annotated error call carrying a token", async () => {
    const program = Effect.logError("auth_failure").pipe(
      Effect.annotateLogs({ access_token: "provider-access-secret" }),
    );

    expect(await written("error", program)).toEqual([
      {
        ...envelope,
        context: {
          access_token: "[REDACTED]",
          event: "auth_failure",
          outcome: "failure",
          retry_class: "none",
        },
        level: "error",
        message: "auth failure",
      },
    ]);
  });
});
