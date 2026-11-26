import { Context } from "effect";

/** Request correlation and tenant metadata provided to every API request program. */
export interface RequestContextData {
  readonly requestId: string;
  readonly session: object | null;
  readonly tenantId?: string;
  readonly traceId: string;
}

export class RequestContext extends Context.Service<RequestContext, RequestContextData>()(
  "RequestContext",
) {}
