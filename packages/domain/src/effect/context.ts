import { Context } from "effect";

/**
 * Encapsulates immutable request-scoped execution metadata.
 * Holds identifiers for request correlation, distributed tracing, and tenant authorization.
 */
export interface RequestContextData {
  readonly requestId: string;
  readonly session?: object | null;
  readonly tenantId?: string;
  readonly traceId: string;
}

/**
 * Request-scoped dependency tag for HTTP request metadata.
 */
export class RequestContext extends Context.Service<RequestContext, RequestContextData>()(
  "RequestContext",
) {}

/**
 * Builds an immutable RequestContextData record from caller-supplied correlation and session metadata.
 *
 * @param data - Request correlation IDs, optional tenant ID, and optional verified session claims.
 * @returns Immutable RequestContextData with `session` normalized to `null` when omitted.
 */
export function makeRequestContext(data: {
  readonly requestId: string;
  readonly session?: object | null;
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
