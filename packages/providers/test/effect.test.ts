import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vite-plus/test";
import { unavailableCapabilities } from "@meltiply/domain";
import {
  classifyProviderFailure,
  createProviderServiceLive,
  createProviderServiceTest,
  failureDiagnostic,
  ProviderAdapterError,
  ProviderHttpClient,
  ProviderRegistry,
  ProviderService,
  publishEffect,
  listAnalyticsEffect,
  withReadRetry,
} from "../src";
import type { ProviderAdapter, ProviderRequestContext } from "../src";

const context = { operationId: "operation-1", requestId: "request-1" };
const credentials = { accessToken: "access-secret", accountId: "account-1" };
const policy = { baseDelaySeconds: 1, maxAttempts: 3, maxDelaySeconds: 2 };
const input = {
  caption: "Hello",
  hashtags: [],
  idempotencyKey: "random-key-is-not-remote-idempotency",
  media: [],
};

/** Builds a raw adapter boundary fake; operations supplied by each scenario own behavior. */
function adapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    capability: unavailableCapabilities()[0]!,
    transferModes: [],
    ...overrides,
  };
}

/** Creates a bounded real HTTP client with only its network transport replaced. */
function client(fetcher: typeof fetch): ProviderHttpClient {
  return new ProviderHttpClient({
    allowedOrigins: ["https://provider.example"],
    fetch: fetcher,
  });
}

/** Extracts typed failures without converting Effect causes into telemetry. */
function failure<A>(effect: Effect.Effect<A, ProviderAdapterError>) {
  return Effect.runPromise(
    Effect.match(effect, {
      onFailure: (error) => error,
      onSuccess: () => {
        throw new Error("Expected failure");
      },
    }),
  );
}

describe("Effect provider safety", () => {
  it("retries transient reads with virtual time and returns recovered data", async () => {
    let attempts = 0;
    const http = client(async () => {
      attempts += 1;
      return attempts < 3
        ? Response.json({}, { status: 503 })
        : Response.json({ value: "recovered" });
    });
    const read = withReadRetry(
      http.requestEffect<{ value: string }>(context, {
        method: "GET",
        url: "https://provider.example/read",
      }),
      policy,
    );
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(read);
      yield* TestClock.adjust("3 seconds");
      return yield* Fiber.join(fiber);
    });
    const response = await Effect.runPromise(Effect.provide(program, TestClock.layer()));
    expect(response.body).toEqual({ value: "recovered" });
    expect(attempts).toBe(3);
  });

  it("does not retry deterministic reads or rate limits owned by due-work", async () => {
    for (const status of [400, 429]) {
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({}, { status, headers: { "Retry-After": "42" } }),
      );
      const error = await failure(
        withReadRetry(
          client(fetcher).requestEffect(context, {
            method: "GET",
            url: "https://provider.example/read",
          }),
          policy,
        ),
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(error.failure.classification).toBe(status === 429 ? "rate_limit" : "deterministic");
      expect(error.failure.retryAfterSeconds).toBe(status === 429 ? 42 : undefined);
    }
  });

  it("dispatches writes once despite random keys, 5xx, timeout, or malformed responses", async () => {
    const responses: Array<() => Promise<Response>> = [
      async () => Response.json({}, { status: 503 }),
      async () => {
        throw new DOMException("remote may have committed", "TimeoutError");
      },
      async () =>
        new Response("not-json", {
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        throw new Error("network lost after commit");
      },
    ];
    for (const response of responses) {
      const fetcher = vi.fn<typeof fetch>(response);
      const http = client(fetcher);
      const raw = adapter({
        publish: async (ctx) => {
          await http.request(ctx, {
            method: "POST",
            sideEffectPossible: true,
            url: "https://provider.example/publish",
          });
          return { outcome: "confirmed_success", providerPostId: "post-1" };
        },
      });
      const error = await failure(publishEffect(raw, context, credentials, input));
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(["transient", "ambiguous"]).toContain(error.failure.classification);
    }
  });

  it("preserves normalized failure identity and ambiguous reconciliation evidence", async () => {
    const error = new ProviderAdapterError(
      classifyProviderFailure({ timedOut: true, sideEffectPossible: true }),
    );
    const raw = adapter({
      publish: async () => {
        throw error;
      },
    });
    expect(await failure(publishEffect(raw, context, credentials, input))).toBe(error);
    const result = {
      outcome: "unknown" as const,
      failure: { ...error.failure, classification: "ambiguous" as const },
      providerOperationId: "submitted:42",
    };
    expect(
      await Effect.runPromise(
        publishEffect(adapter({ publish: async () => result }), context, credentials, input),
      ),
    ).toEqual(result);
  });

  it("sanitizes unexpected throws to deterministic failures without exposing tokens", async () => {
    const raw = adapter({
      listAnalytics: async () => {
        throw new Error("access-secret refresh-secret authorization-code");
      },
    });
    const error = await failure(listAnalyticsEffect(raw, context, credentials, {}, { limit: 1 }));
    expect(error.failure).toMatchObject({
      code: "provider_unexpected",
      classification: "deterministic",
      retryable: false,
    });
    expect(JSON.stringify(failureDiagnostic(error))).not.toMatch(
      /access-secret|refresh-secret|authorization-code/,
    );
    expect(error.message).not.toMatch(/access-secret|refresh-secret|authorization-code/);
  });

  it("aborts in-flight HTTP when its Effect fiber is interrupted", async () => {
    let notify!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      notify = resolve;
    });
    const fetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
        notify(signal);
      });
    const fiber = Effect.runFork(
      client(fetcher).requestEffect(context, {
        method: "GET",
        url: "https://provider.example/read",
      }),
    );
    const signal = await started;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal.aborted).toBe(true);
  });

  it("preserves caller abort while linking service interruption to adapter I/O", async () => {
    for (const callerAborts of [true, false]) {
      let notify!: (signal: AbortSignal) => void;
      const started = new Promise<AbortSignal>((resolve) => {
        notify = resolve;
      });
      const caller = new AbortController();
      const raw = adapter({
        listAnalytics: (ctx: ProviderRequestContext) =>
          new Promise((_resolve, reject) => {
            ctx.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
            notify(ctx.signal!);
          }),
      });
      const program = Effect.flatMap(ProviderService, (service) =>
        service.listAnalytics(
          "facebook",
          { ...context, signal: caller.signal },
          credentials,
          {},
          { limit: 1 },
        ),
      );
      const fiber = Effect.runFork(
        Effect.provide(Effect.exit(program), createProviderServiceTest({ facebook: raw })),
      );
      const signal = await started;
      if (callerAborts) {
        caller.abort();
        await Effect.runPromise(Fiber.join(fiber));
      } else {
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
      expect(signal.aborted).toBe(true);
      expect(caller.signal.aborted).toBe(callerAborts);
    }
  });

  it("executes through live and test layers with rate-limit metadata retained", async () => {
    const registry = new ProviderRegistry();
    const raw = adapter({
      publish: async (ctx) => {
        ctx.metadata = {
          rateLimitBudget: {
            percentUsed: 90,
            remaining: 1,
            resetsInSeconds: 42,
          },
        };
        return { outcome: "confirmed_success", providerPostId: "post-42" };
      },
    });
    registry.register(raw.capability.platform, raw);
    for (const layer of [
      createProviderServiceLive(registry),
      createProviderServiceTest({ [raw.capability.platform]: raw }),
    ]) {
      const ctx: ProviderRequestContext = { ...context };
      const program = Effect.flatMap(ProviderService, (service) =>
        service.publish(raw.capability.platform, ctx, credentials, input),
      );
      const result = await Effect.runPromise(Effect.provide(program, layer));
      expect(result).toMatchObject({
        outcome: "confirmed_success",
        providerPostId: "post-42",
      });
      expect(ctx.metadata?.rateLimitBudget?.resetsInSeconds).toBe(42);
    }
  });

  it("interrupts every service operation, including token revocation, without replay", async () => {
    const operations = [
      "publish",
      "reply",
      "cancelPublication",
      "lookupPublication",
      "listAnalytics",
      "listComments",
      "getPublicationRequirements",
      "exchangeAuthorizationCode",
      "refreshAccessToken",
      "revoke",
    ] as const;
    for (const operation of operations) {
      let notify!: (signal: AbortSignal) => void;
      const started = new Promise<AbortSignal>((resolve) => {
        notify = resolve;
      });
      let calls = 0;
      // Every raw boundary blocks until aborted; no success values can hide a missed signal.
      const pending = (ctx: ProviderRequestContext): Promise<never> => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          notify(ctx.signal!);
          ctx.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      };
      const raw = adapter({
        publish: pending,
        reply: pending,
        cancelPublication: pending,
        lookupPublication: pending,
        listAnalytics: pending,
        listComments: pending,
        getPublicationRequirements: pending,
        exchangeAuthorizationCode: pending,
        refreshAccessToken: pending,
        revoke: (_token, ctx) => pending(ctx!),
      });
      const program = Effect.flatMap(ProviderService, (service) => {
        switch (operation) {
          case "publish":
            return service.publish("facebook", context, credentials, input);
          case "reply":
            return service.reply("facebook", context, credentials, {
              idempotencyKey: input.idempotencyKey,
              providerCommentId: "comment-1",
              text: "reply",
            });
          case "cancelPublication":
            return service.cancelPublication("facebook", context, credentials, {
              providerPostId: "post-1",
            });
          case "lookupPublication":
            return service.lookupPublication("facebook", context, credentials, {
              providerPostId: "post-1",
            });
          case "listAnalytics":
            return service.listAnalytics("facebook", context, credentials, {}, { limit: 1 });
          case "listComments":
            return service.listComments("facebook", context, credentials, {}, { limit: 1 });
          case "getPublicationRequirements":
            return service.getPublicationRequirements("facebook", context, credentials);
          case "exchangeAuthorizationCode":
            return service.exchangeAuthorizationCode("facebook", context, {
              code: "code-secret",
              codeVerifier: "verifier-secret",
              redirectUri: "https://app.example/callback",
            });
          case "refreshAccessToken":
            return service.refreshAccessToken("facebook", context, "refresh-secret");
          case "revoke":
            return service.revoke("facebook", "access-secret");
        }
      });
      const fiber = Effect.runFork(
        Effect.provide(program, createProviderServiceTest({ facebook: raw })),
      );
      const signal = await started;
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(signal.aborted, operation).toBe(true);
      expect(calls, operation).toBe(1);
    }
  });
});
