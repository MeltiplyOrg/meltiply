import { describe, expect, it } from "vite-plus/test";
import { Effect, Fiber } from "effect";

import {
  ActiveOrganizationRequiredError,
  AuthenticationRequiredError,
  DatabaseError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  RequestContext,
  StorageUnavailableError,
} from "../src";

describe("Effect v4 Domain Tagged Errors", () => {
  it.each([
    [new InvalidRequestError({ message: "m" }), 400, "invalid_request"],
    [new AuthenticationRequiredError({ message: "m" }), 401, "authentication_required"],
    [new ActiveOrganizationRequiredError({ message: "m" }), 403, "active_organization_required"],
    [new ForbiddenError({ message: "m" }), 403, "forbidden"],
    [new NotFoundError({ message: "m" }), 404, "not_found"],
    [new StorageUnavailableError({ message: "m" }), 503, "service_unavailable"],
    [new DatabaseError({ message: "m" }), 500, "internal_error"],
  ])("maps %o to its HTTP contract", (error, status, code) => {
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).toBe("m");
  });

  it("yields and catches tagged errors in Effect.gen", async () => {
    const program = Effect.gen(function* () {
      yield* new NotFoundError({ message: "User not found" });
      return "unreachable";
    }).pipe(Effect.catchTag("NotFoundError", (err) => Effect.succeed(`recovered: ${err.message}`)));

    expect(await Effect.runPromise(program)).toBe("recovered: User not found");
  });
});

describe("RequestContext Scope & Isolation", () => {
  it("proves request context does not leak between concurrent requests", async () => {
    const request = (requestId: string, delay: number) =>
      Effect.gen(function* () {
        const ctx = yield* RequestContext;
        yield* Effect.sleep(delay);
        const ctxAfter = yield* RequestContext;
        expect(ctxAfter.requestId).toBe(requestId);
        expect(ctxAfter.traceId).toBe(`trace-${requestId}`);
        return ctx.requestId;
      }).pipe(
        Effect.provideService(RequestContext, {
          requestId,
          session: null,
          traceId: `trace-${requestId}`,
          tenantId: `org-${requestId}`,
        }),
      );

    const program = Effect.gen(function* () {
      const fiberA = yield* Effect.forkChild(request("req-A", 10));
      const fiberB = yield* Effect.forkChild(request("req-B", 5));
      return [yield* Fiber.join(fiberA), yield* Fiber.join(fiberB)];
    });

    expect(await Effect.runPromise(program)).toEqual(["req-A", "req-B"]);
  });
});
