import { Effect } from "effect";
import { ActiveOrganizationRequiredError, type RequestContext } from "@meltiply/domain";
import { ProviderAdapterError } from "@meltiply/providers";

import { CoreApiError } from "../core-types";

function classifyRouteError(
  cause: unknown,
): CoreApiError | ActiveOrganizationRequiredError | ProviderAdapterError {
  if (
    cause instanceof CoreApiError ||
    cause instanceof ActiveOrganizationRequiredError ||
    cause instanceof ProviderAdapterError
  ) {
    return cause;
  }
  throw cause;
}

export function fromPromise<A>(
  operation: () => Promise<A> | A,
): Effect.Effect<
  A,
  CoreApiError | ActiveOrganizationRequiredError | ProviderAdapterError,
  RequestContext
> {
  return Effect.suspend(() => {
    let result: Promise<A> | A;
    try {
      result = operation();
    } catch (cause) {
      return Effect.fail(classifyRouteError(cause));
    }
    if (result instanceof Promise) {
      return Effect.tryPromise({
        catch: classifyRouteError,
        try: () => result,
      });
    }
    return Effect.succeed(result);
  });
}
