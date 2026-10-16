import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";

import {
  ActiveOrganizationRequiredError,
  AuthenticationRequiredError,
  ConflictError,
  DatabaseError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTransientError,
  QuotaExceededError,
  RateLimitExceededError,
  RequestContext,
  StorageUnavailableError,
  ValidationError,
  makeRequestContext,
} from "../src";

describe("Effect v4 Domain Tagged Errors", () => {
  it("constructs recoverable tagged errors with correct _tag, status, and code", () => {
    const notFound = new NotFoundError({
      message: "Distribution not found",
      entityId: "dist_123",
    });
    expect(notFound._tag).toBe("NotFoundError");
    expect(notFound.status).toBe(404);
    expect(notFound.code).toBe("not_found");
    expect(notFound.message).toBe("Distribution not found");
    expect(notFound.entityId).toBe("dist_123");

    const authReq = new AuthenticationRequiredError({
      message: "Missing bearer token",
    });
    expect(authReq._tag).toBe("AuthenticationRequiredError");
    expect(authReq.status).toBe(401);
    expect(authReq.code).toBe("authentication_required");

    const activeOrg = new ActiveOrganizationRequiredError({
      message: "The authenticated identity is not an active organization member.",
    });
    expect(activeOrg._tag).toBe("ActiveOrganizationRequiredError");
    expect(activeOrg.status).toBe(403);
    expect(activeOrg.code).toBe("active_organization_required");

    const forbidden = new ForbiddenError({
      message: "Insufficient permissions",
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.code).toBe("forbidden");

    const invalidReq = new InvalidRequestError({
      message: "Invalid limit parameter",
    });
    expect(invalidReq.status).toBe(400);
    expect(invalidReq.code).toBe("invalid_request");

    const validation = new ValidationError({
      message: "Payload validation failed",
      issues: [{ field: "name", message: "Required" }],
    });
    expect(validation.status).toBe(422);
    expect(validation.code).toBe("validation_error");
    expect(validation.issues).toEqual([{ field: "name", message: "Required" }]);

    const conflict = new ConflictError({
      message: "Resource modified concurrently",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("conflict");

    const invalidState = new ConflictError({
      code: "invalid_state",
      message: "Distribution was already sent",
    });
    expect(invalidState.status).toBe(409);
    expect(invalidState.code).toBe("invalid_state");

    const quota = new QuotaExceededError({
      message: "Monthly distribution limit reached",
    });
    expect(quota.status).toBe(403);
    expect(quota.code).toBe("quota_exceeded");

    const rateLimit = new RateLimitExceededError({
      message: "Too many requests",
      retryAfterSeconds: 30,
    });
    expect(rateLimit.status).toBe(429);
    expect(rateLimit.code).toBe("rate_limited");
    expect(rateLimit.retryAfterSeconds).toBe(30);

    const providerRateLimit = new ProviderRateLimitError({
      message: "Instagram rate limit reached",
      provider: "instagram",
      retryAfterSeconds: 60,
    });
    expect(providerRateLimit.status).toBe(429);
    expect(providerRateLimit.code).toBe("provider_rate_limited");
    expect(providerRateLimit.provider).toBe("instagram");

    const providerErr = new ProviderError({
      message: "OAuth token revoked",
      provider: "tiktok",
    });
    expect(providerErr.status).toBe(502);
    expect(providerErr.code).toBe("provider_error");

    const providerTransient = new ProviderTransientError({
      message: "Upstream timeout",
      provider: "youtube",
    });
    expect(providerTransient.status).toBe(502);
    expect(providerTransient.code).toBe("provider_unavailable");

    const storage = new StorageUnavailableError({
      message: "R2 bucket unavailable",
    });
    expect(storage.status).toBe(503);
    expect(storage.code).toBe("service_unavailable");

    const db = new DatabaseError({
      message: "Connection pool exhausted",
    });
    expect(db.status).toBe(500);
    expect(db.code).toBe("internal_error");
  });

  it("yields and catches tagged errors cleanly in Effect.gen", async () => {
    const program = Effect.gen(function* () {
      yield* new NotFoundError({
        message: "User not found",
        entityId: "u_1",
      });
      return "unreachable";
    }).pipe(
      Effect.catchTag("NotFoundError", (err) => Effect.succeed(`recovered: ${err.entityId}`)),
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe("recovered: u_1");
  });
});

describe("RequestContext Scope & Isolation", () => {
  it("proves request context does not leak between concurrent requests", async () => {
    const taskA = Effect.gen(function* () {
      const ctx = yield* RequestContext;
      // Simulate asynchronous execution time
      yield* Effect.sleep("10 millis");
      const ctxAfter = yield* RequestContext;
      expect(ctxAfter.requestId).toBe("req-A");
      expect(ctxAfter.traceId).toBe("trace-A");
      return ctx.requestId;
    }).pipe(
      Effect.provideService(RequestContext, {
        requestId: "req-A",
        traceId: "trace-A",
        tenantId: "org-A",
      }),
    );

    const taskB = Effect.gen(function* () {
      const ctx = yield* RequestContext;
      yield* Effect.sleep("5 millis");
      const ctxAfter = yield* RequestContext;
      expect(ctxAfter.requestId).toBe("req-B");
      expect(ctxAfter.traceId).toBe("trace-B");
      return ctx.requestId;
    }).pipe(
      Effect.provideService(RequestContext, {
        requestId: "req-B",
        traceId: "trace-B",
        tenantId: "org-B",
      }),
    );

    const [fiberA, fiberB] = await Promise.all([
      Effect.runPromise(taskA),
      Effect.runPromise(taskB),
    ]);

    expect(fiberA).toBe("req-A");
    expect(fiberB).toBe("req-B");
  });

  it("makeRequestContext populates immutable request context data", () => {
    const data = makeRequestContext({
      requestId: "req-123",
      traceId: "trace-456",
      tenantId: "org-789",
      session: { role: "admin" },
    });
    expect(data.requestId).toBe("req-123");
    expect(data.traceId).toBe("trace-456");
    expect(data.tenantId).toBe("org-789");
    expect(data.session).toEqual({ role: "admin" });
  });
});
