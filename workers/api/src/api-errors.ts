import type { components } from "@meltiply/contracts/schema";
import type { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";

type Schemas = components["schemas"];

export class CoreApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly details: readonly Schemas["ErrorDetail"][] = [],
  ) {
    super(message);
    this.name = "CoreApiError";
  }
}

export type TenantServiceError = CoreApiError | ActiveOrganizationRequiredError | DatabaseError;

export function toCoreApiErrorOrRethrow(cause: unknown): CoreApiError {
  if (cause instanceof CoreApiError) return cause;
  throw cause;
}
