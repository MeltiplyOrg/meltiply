import { describe, expect, it } from "vite-plus/test";
import { Deferred, Effect, Fiber } from "effect";

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
    ["an invalid request", InvalidRequestError, "InvalidRequestError", 400, "invalid_request"],
    [
      "missing authentication",
      AuthenticationRequiredError,
      "AuthenticationRequiredError",
      401,
      "authentication_required",
    ],
    [
      "no active organization",
      ActiveOrganizationRequiredError,
      "ActiveOrganizationRequiredError",
      403,
      "active_organization_required",
    ],
    ["a forbidden operation", ForbiddenError, "ForbiddenError", 403, "forbidden"],
    ["a missing resource", NotFoundError, "NotFoundError", 404, "not_found"],
    [
      "unavailable storage",
      StorageUnavailableError,
      "StorageUnavailableError",
      503,
      "service_unavailable",
    ],
    ["a database failure", DatabaseError, "DatabaseError", 500, "internal_error"],
  ])("%s", (_example, ErrorClass, tag, status, code) => {
    const error = new ErrorClass({ message: "m" });

    expect({
      tag: error._tag,
      status: error.status,
      code: error.code,
      message: error.message,
    }).toEqual({ tag, status, code, message: "m" });
  });
});

describe("RequestContext", () => {
  it("two interleaved requests", async () => {
    const program = Effect.gen(function* () {
      const secondHasRead = yield* Deferred.make<void>();
      const request = (requestId: string, pause: Effect.Effect<unknown>) =>
        Effect.gen(function* () {
          const before = yield* RequestContext;
          yield* pause;
          const after = yield* RequestContext;
          return [before.requestId, after.requestId, after.traceId];
        }).pipe(
          Effect.provideService(RequestContext, {
            requestId,
            session: null,
            traceId: `trace-${requestId}`,
            tenantId: `org-${requestId}`,
          }),
        );

      const first = yield* Effect.forkChild(request("req-A", Deferred.await(secondHasRead)));
      const second = yield* Effect.forkChild(
        request("req-B", Deferred.succeed(secondHasRead, undefined)),
      );
      return [yield* Fiber.join(first), yield* Fiber.join(second)];
    });

    expect(await Effect.runPromise(program)).toEqual([
      ["req-A", "req-A", "trace-req-A"],
      ["req-B", "req-B", "trace-req-B"],
    ]);
  });
});
