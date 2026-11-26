import { unavailableCapabilities } from "@meltiply/domain";
import { Effect, Fiber, type Duration } from "effect";
import { TestClock } from "effect/testing";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  cancelPublicationEffect,
  createProviderServiceLive,
  createProviderServiceTest,
  exchangeAuthorizationCodeEffect,
  getAccountAnalyticsEffect,
  getPublicationRequirementsEffect,
  isRetryableFailure,
  listAnalyticsEffect,
  listCommentsEffect,
  lookupPublicationEffect,
  providerCallEffect,
  ProviderService,
  publishEffect,
  refreshAccessTokenEffect,
  replyEffect,
  revokeEffect,
  withReadRetry,
  type ProviderServiceShape,
} from "../src/effect";
import { classifyProviderFailure, failureDiagnostic, ProviderAdapterError } from "../src/failures";
import { unknownResult } from "../src/results";
import type { ProviderAdapter, ProviderRequestContext } from "../src/types";
import { failureOf, refused } from "./support";

const newContext = (patch: Partial<ProviderRequestContext> = {}): ProviderRequestContext => ({
  operationId: "operation-1",
  requestId: "request-1",
  ...patch,
});
const credentials = { accessToken: "access-secret", accountId: "account-1" };
const policy = { baseDelaySeconds: 1, maxAttempts: 4, maxDelaySeconds: 2 };
const input = { caption: "Hello", hashtags: [], idempotencyKey: "key", media: [] };
const lookup = { providerPostId: "post-1" };
const page = { limit: 1 };
const reply = { idempotencyKey: "key", providerCommentId: "c1", providerPostId: "p1", text: "hi" };
const exchange = { code: "code", codeVerifier: "v", redirectUri: "https://app.example/callback" };
const rateLimitBudget = { percentUsed: 90, remaining: 1, resetsInSeconds: 42 };

const adapter = (methods: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
  capability: unavailableCapabilities()[0]!,
  transferModes: [],
  ...methods,
});

const fail = (status: number, retryAfterSeconds?: number) =>
  new ProviderAdapterError(classifyProviderFailure({ retryAfterSeconds, status }));

const errorOf = <A>(effect: Effect.Effect<A, ProviderAdapterError>) =>
  Effect.runPromise(Effect.flip(effect));

const failedWith = <A>(effect: Effect.Effect<A, ProviderAdapterError>) =>
  failureOf(Effect.runPromise(effect));

function untilAborted(signal: AbortSignal | undefined, started: () => void): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
    started();
  });
}

function recording() {
  const calls: unknown[][] = [];
  const method =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([
        name,
        ...args.filter((arg) => !(typeof arg === "object" && arg && "requestId" in arg)),
      ]);
      return Promise.resolve({ name } as never);
    };
  const full = adapter({
    cancelPublication: method("cancelPublication"),
    endBroadcast: method("endBroadcast"),
    exchangeAuthorizationCode: method("exchangeAuthorizationCode"),
    getAccountAnalytics: method("getAccountAnalytics"),
    getBroadcastInfo: method("getBroadcastInfo"),
    getPublicationRequirements: method("getPublicationRequirements"),
    listAnalytics: method("listAnalytics"),
    listComments: method("listComments"),
    lookupPublication: method("lookupPublication"),
    publish: method("publish"),
    refreshAccessToken: method("refreshAccessToken"),
    reply: method("reply"),
    revoke: method("revoke"),
  });
  return { full, calls };
}

type Operation = {
  name: string;
  label: string;
  args: unknown[];
  run: (
    service: ProviderServiceShape,
    context: ProviderRequestContext,
  ) => Effect.Effect<unknown, ProviderAdapterError>;
};

const operations: Operation[] = [
  {
    name: "getBroadcastInfo",
    label: "broadcast_info",
    args: [credentials, lookup],
    run: (s, c) => s.getBroadcastInfo("facebook", c, credentials, lookup),
  },
  {
    name: "endBroadcast",
    label: "end_broadcast",
    args: [credentials, lookup],
    run: (s, c) => s.endBroadcast("facebook", c, credentials, lookup),
  },
  {
    name: "cancelPublication",
    label: "cancel_publication",
    args: [credentials, lookup],
    run: (s, c) => s.cancelPublication("facebook", c, credentials, lookup),
  },
  {
    name: "exchangeAuthorizationCode",
    label: "exchange_authorization_code",
    args: [exchange],
    run: (s, c) => s.exchangeAuthorizationCode("facebook", c, exchange),
  },
  {
    name: "getAccountAnalytics",
    label: "account_analytics",
    args: [credentials],
    run: (s, c) => s.getAccountAnalytics("facebook", c, credentials),
  },
  {
    name: "getPublicationRequirements",
    label: "publication_requirements",
    args: [credentials],
    run: (s, c) => s.getPublicationRequirements("facebook", c, credentials),
  },
  {
    name: "listAnalytics",
    label: "list_analytics",
    args: [credentials, lookup, page],
    run: (s, c) => s.listAnalytics("facebook", c, credentials, lookup, page),
  },
  {
    name: "listComments",
    label: "list_comments",
    args: [credentials, lookup, page],
    run: (s, c) => s.listComments("facebook", c, credentials, lookup, page),
  },
  {
    name: "lookupPublication",
    label: "lookup_publication",
    args: [credentials, lookup],
    run: (s, c) => s.lookupPublication("facebook", c, credentials, lookup),
  },
  {
    name: "publish",
    label: "publish",
    args: [credentials, input],
    run: (s, c) => s.publish("facebook", c, credentials, input),
  },
  {
    name: "refreshAccessToken",
    label: "refresh_access_token",
    args: ["refresh"],
    run: (s, c) => s.refreshAccessToken("facebook", c, "refresh"),
  },
  {
    name: "reply",
    label: "reply",
    args: [credentials, reply],
    run: (s, c) => s.reply("facebook", c, credentials, reply),
  },
  { name: "revoke", label: "revoke", args: ["access"], run: (s) => s.revoke("facebook", "access") },
];

const onService = (
  operation: Operation,
  source: ProviderAdapter | undefined,
  context = newContext(),
) =>
  Effect.flatMap(ProviderService, (service) => operation.run(service, context)).pipe(
    Effect.provide(createProviderServiceTest(source ? { facebook: source } : {})),
  );

beforeAll(async () => {
  await Effect.runPromise(onService(operations[9]!, recording().full));
});

describe("providerCallEffect", () => {
  it("a successful call keeps its metadata", async () => {
    const context = newContext();

    const result = await Effect.runPromise(
      providerCallEffect(context, async (child) => {
        child.metadata = { rateLimitBudget };
        return "done";
      }),
    );

    expect(result).toEqual("done");
    expect(context.metadata).toEqual({ rateLimitBudget });
  });

  it("a provider error keeps its identity and metadata", async () => {
    const context = newContext();
    const error = fail(429, 42);

    const caught = await errorOf(
      providerCallEffect(context, (child) => {
        child.metadata = { rateLimitBudget };
        return Promise.reject(error);
      }),
    );

    expect(caught).toBe(error);
    expect(context.metadata).toEqual({ rateLimitBudget });
  });

  it("an unexpected throw is sanitized", async () => {
    const error = await errorOf(
      providerCallEffect(newContext(), () => Promise.reject(new Error("access-secret"))),
    );

    expect(failureDiagnostic(error)).toEqual({
      classification: "deterministic",
      code: "provider_unexpected",
      retryable: false,
    });
    expect(error.message).toEqual("The provider rejected this request.");
  });

  it("a caller abort reaches the call", async () => {
    const caller = new AbortController();
    const seen: AbortSignal[] = [];

    await errorOf(
      providerCallEffect(newContext({ signal: caller.signal }), (child) => {
        seen.push(child.signal!);
        return untilAborted(child.signal, () => caller.abort());
      }),
    );

    expect(seen.map((signal) => signal.aborted)).toEqual([true]);
  });
});

describe("provider operation effects", () => {
  const direct: [string, (a: ProviderAdapter) => Effect.Effect<unknown, ProviderAdapterError>][] = [
    ["publish", (a) => publishEffect(a, newContext(), credentials, input)],
    ["lookupPublication", (a) => lookupPublicationEffect(a, newContext(), credentials, lookup)],
    ["cancelPublication", (a) => cancelPublicationEffect(a, newContext(), credentials, lookup)],
    ["reply", (a) => replyEffect(a, newContext(), credentials, reply)],
    ["getAccountAnalytics", (a) => getAccountAnalyticsEffect(a, newContext(), credentials)],
    ["listAnalytics", (a) => listAnalyticsEffect(a, newContext(), credentials, lookup, page)],
    ["listComments", (a) => listCommentsEffect(a, newContext(), credentials, lookup, page)],
    [
      "getPublicationRequirements",
      (a) => getPublicationRequirementsEffect(a, newContext(), credentials),
    ],
    [
      "exchangeAuthorizationCode",
      (a) => exchangeAuthorizationCodeEffect(a, newContext(), exchange),
    ],
    ["refreshAccessToken", (a) => refreshAccessTokenEffect(a, newContext(), "refresh")],
    ["revoke", (a) => revokeEffect(a, "access")],
  ];

  it.each(direct)("%s calls the adapter once", async (name, run) => {
    const { full, calls } = recording();
    const { args } = operations.find((candidate) => candidate.name === name)!;

    await Effect.runPromise(run(full));

    expect(calls).toEqual([[name, ...args]]);
  });

  it.each(direct)("%s without an adapter method", async (name, run) => {
    const operation = operations.find((candidate) => candidate.name === name)!;

    expect(await failedWith(run(adapter()))).toEqual(
      refused(`provider_unsupported_${operation.label}`),
    );
  });

  it("an unknown publish outcome stays on the success channel", async () => {
    const unknown = unknownResult("publish_unknown", "submitted:42");
    const raw = adapter({ publish: () => Promise.resolve(unknown) });

    const result = await Effect.runPromise(publishEffect(raw, newContext(), credentials, input));

    expect(result).toEqual(unknown);
  });

  it("a failed write is not replayed", async () => {
    let attempts = 0;
    const raw = adapter({
      publish: () => {
        attempts += 1;
        return Promise.reject(fail(503));
      },
    });

    await errorOf(publishEffect(raw, newContext(), credentials, input));

    expect(attempts).toEqual(1);
  });
});

describe("ProviderService", () => {
  it.each(operations)("$name reaches the configured adapter", async (operation) => {
    const { full, calls } = recording();

    await Effect.runPromise(onService(operation, full));

    expect(calls).toEqual([[operation.name, ...operation.args]]);
  });

  it.each(operations)("$name without an adapter method", async (operation) => {
    expect(await failedWith(onService(operation, adapter()))).toEqual(
      refused(`provider_unsupported_${operation.label}`),
    );
  });

  it("an unconfigured platform", async () => {
    expect(await failedWith(onService(operations[9]!, undefined))).toEqual(
      refused("provider_not_configured"),
    );
  });

  it.each(operations)("$name interrupted aborts its only call", async (operation) => {
    const signals: (AbortSignal | undefined)[] = [];
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = (...args: unknown[]) => {
      const context = args.find(
        (arg): arg is ProviderRequestContext =>
          typeof arg === "object" && arg !== null && "requestId" in arg,
      );
      signals.push(context?.signal);
      return untilAborted(context?.signal, started);
    };
    const raw = adapter({ [operation.name]: pending });

    const fiber = Effect.runFork(onService(operation, raw));
    await running;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(signals.map((signal) => signal?.aborted)).toEqual([true]);
  });

  it("the live layer reads from its adapter source", async () => {
    const { full, calls } = recording();
    const program = Effect.flatMap(ProviderService, (service) =>
      service.publish("facebook", newContext(), credentials, input),
    );

    await Effect.runPromise(
      Effect.provide(program, createProviderServiceLive({ get: () => full })),
    );

    expect(calls).toEqual([["publish", credentials, input]]);
  });
});

describe("isRetryableFailure", () => {
  it.each([
    ["a transient failure", fail(503), true],
    ["a timeout", fail(408), true],
    ["a rate limit", fail(429), false],
    ["a deterministic failure", fail(400), false],
    ["an auth failure", fail(401), false],
    ["a plain error", new Error("x"), false],
  ])("%s", (_example, error, retryable) => {
    expect(isRetryableFailure(error)).toEqual(retryable);
  });
});

describe("withReadRetry", () => {
  async function attempts(failures: ProviderAdapterError[], elapsed: Duration.Input) {
    let calls = 0;
    const read = Effect.suspend(() => {
      const error = failures[calls];
      calls += 1;
      return error ? Effect.fail(error) : Effect.succeed("recovered");
    });
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(withReadRetry(read, policy)));
      yield* TestClock.adjust(elapsed);
      const seen = calls;
      yield* Fiber.interrupt(fiber);
      return seen;
    });
    return Effect.runPromise(Effect.provide(program, TestClock.layer()));
  }
  const always = Array.from({ length: 10 }, () => fail(503));

  it.each([
    ["before the first delay", "999 millis", 1],
    ["after the first delay", "1 second", 2],
    ["after the doubled delay", "3 seconds", 3],
    ["after a delay capped at the maximum", "5 seconds", 4],
    ["long after the last attempt", "1 hour", 4],
  ] as const)("a read %s", async (_example, elapsed, calls) => {
    expect(await attempts(always, elapsed)).toEqual(calls);
  });

  it.each([
    ["a deterministic failure", fail(400)],
    ["a rate limit left to the due-work scheduler", fail(429, 42)],
  ])("%s is not retried", async (_example, error) => {
    expect(await attempts([error, error], "1 hour")).toEqual(1);
  });

  it("a recovered read", async () => {
    const read = Effect.succeed("data");

    expect(await Effect.runPromise(withReadRetry(read, policy))).toEqual("data");
  });
});
