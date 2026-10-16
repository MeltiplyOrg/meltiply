import { Context } from "effect";

/**
 * Encapsulates immutable request-scoped execution metadata.
 * Holds identifiers for request correlation, distributed tracing, and tenant authorization.
 */
export interface RequestContextData {
  readonly requestId: string;
  readonly session?: Readonly<Record<string, unknown>> | null;
  readonly tenantId?: string;
  readonly traceId: string;
}

/**
 * Request-scoped dependency tag for HTTP request metadata.
 *
 * Provides fiber-isolated access to request ID, trace ID, and session state without
 * allowing cross-request state leakage or mutating global singleton instances.
 */
export class RequestContext extends Context.Service<RequestContext, RequestContextData>()(
  "RequestContext",
) {}

/**
 * Creates a validated RequestContextData record for dependency injection.
 *
 * Ensures request and trace correlation identifiers are present and non-empty,
 * defaulting to fallback identifiers when not provided.
 *
 * @param data - Input metadata including optional request ID and trace ID.
 * @returns Fully populated, immutable RequestContextData instance.
 */
export function makeRequestContext(data: {
  readonly requestId: string;
  readonly session?: Readonly<Record<string, unknown>> | null;
  readonly tenantId?: string;
  readonly traceId: string;
}): RequestContextData {
  return {
    requestId: data.requestId,
    session: data.session ?? null,
    tenantId: data.tenantId,
    traceId: data.traceId,
  };
}
