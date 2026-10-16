import { Data } from "effect";

/**
 * Validation issue descriptor representing a single field constraint violation.
 */
export interface ValidationIssue {
  readonly actual?: unknown;
  readonly constraint?: string;
  readonly field?: string;
  readonly limit?: number | string;
  readonly message: string;
}

/**
 * Tagged error for malformed client requests (syntax, parameter parsing, header size).
 * Maps to HTTP 400 with canonical OpenAPI error code `invalid_request`.
 */
export class InvalidRequestError extends Data.TaggedError("InvalidRequestError")<{
  readonly code?: "invalid_request";
  readonly message: string;
  readonly status?: 400;
}> {
  readonly code = "invalid_request";
  readonly status = 400;
}

/**
 * Tagged error for schema validation failures on request payloads.
 * Maps to HTTP 422 with canonical OpenAPI error code `validation_error`.
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly code?: "validation_error";
  readonly details?: readonly ValidationIssue[];
  readonly issues?: readonly ValidationIssue[];
  readonly message: string;
  readonly status?: 422;
}> {
  readonly code = "validation_error";
  readonly status = 422;
}

/**
 * Tagged error when a request lacks valid authentication credentials.
 * Maps to HTTP 401 with canonical OpenAPI error code `authentication_required`.
 */
export class AuthenticationRequiredError extends Data.TaggedError("AuthenticationRequiredError")<{
  readonly code?: "authentication_required";
  readonly message: string;
  readonly status?: 401;
}> {
  readonly code = "authentication_required";
  readonly status = 401;
}

/**
 * Tagged error when an authenticated identity is not an active organization member.
 * Maps to HTTP 403 with canonical OpenAPI error code `active_organization_required`.
 */
export class ActiveOrganizationRequiredError extends Data.TaggedError(
  "ActiveOrganizationRequiredError",
)<{
  readonly code?: "active_organization_required";
  readonly message: string;
  readonly status?: 403;
}> {
  readonly code = "active_organization_required";
  readonly status = 403;
}

/**
 * Tagged error when an authenticated caller lacks required permission for an operation.
 * Maps to HTTP 403 with canonical OpenAPI error code `forbidden`.
 */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly code?: "forbidden";
  readonly message: string;
  readonly status?: 403;
}> {
  readonly code = "forbidden";
  readonly status = 403;
}

/**
 * Tagged error when a requested resource does not exist or is invisible to the tenant.
 * Maps to HTTP 404 with canonical OpenAPI error code `not_found`.
 */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly code?: "not_found";
  readonly entityId?: string;
  readonly entityType?: string;
  readonly message: string;
  readonly status?: 404;
}> {
  readonly code = "not_found";
  readonly status = 404;
}

/**
 * Tagged error for optimistic locking conflicts or invalid state transitions.
 * Maps to HTTP 409, preserving `invalid_state` where callers distinguish a stale
 * write from an illegal lifecycle transition.
 */
export class ConflictError extends Data.TaggedError("ConflictError")<{
  readonly code?: "conflict" | "invalid_state";
  readonly message: string;
  readonly status?: 409;
}> {
  readonly code: "conflict" | "invalid_state";
  readonly status = 409;

  /**
   * Keeps an explicitly classified state-transition conflict on its typed error.
   *
   * `new ConflictError({ code: "invalid_state", message: "Already sent" })`
   * stays `invalid_state`; omitted codes retain the canonical `conflict` default.
   */
  constructor(args: {
    readonly code?: "conflict" | "invalid_state";
    readonly message: string;
    readonly status?: 409;
  }) {
    super(args);
    this.code = args.code ?? "conflict";
  }
}

/**
 * Tagged error when workspace quota limits (monthly posts, storage) are exceeded.
 * Maps to HTTP 403 with canonical OpenAPI error code `quota_exceeded`.
 */
export class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
  readonly code?: "quota_exceeded";
  readonly limitType?: string;
  readonly message: string;
  readonly status?: 403;
}> {
  readonly code = "quota_exceeded";
  readonly status = 403;
}

/**
 * Tagged error when local API rate limit budgets are exhausted.
 * Maps to HTTP 429 with canonical OpenAPI error code `rate_limited`.
 */
export class RateLimitExceededError extends Data.TaggedError("RateLimitExceededError")<{
  readonly code?: "rate_limited";
  readonly message: string;
  readonly retryAfterSeconds?: number;
  readonly status?: 429;
}> {
  readonly code = "rate_limited";
  readonly status = 429;
}

/**
 * Tagged error when an upstream social provider rate limit is encountered.
 * Maps to HTTP 429 with canonical OpenAPI error code `provider_rate_limited`.
 */
export class ProviderRateLimitError extends Data.TaggedError("ProviderRateLimitError")<{
  readonly code?: "provider_rate_limited";
  readonly message: string;
  readonly provider: string;
  readonly retryAfterSeconds?: number;
  readonly status?: 429;
}> {
  readonly code = "provider_rate_limited";
  readonly status = 429;
}

/**
 * Tagged error when an upstream provider rejects an operation deterministically.
 * Maps to HTTP 502 with canonical OpenAPI error code `provider_error`.
 */
export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly code?: "provider_error";
  readonly message: string;
  readonly provider: string;
  readonly status?: 502;
}> {
  readonly code = "provider_error";
  readonly status = 502;
}

/**
 * Tagged error when an upstream provider experiences a transient 5xx or timeout.
 * Maps to HTTP 502 with canonical OpenAPI error code `provider_unavailable`.
 */
export class ProviderTransientError extends Data.TaggedError("ProviderTransientError")<{
  readonly code?: "provider_unavailable";
  readonly message: string;
  readonly provider: string;
  readonly status?: 502;
}> {
  readonly code = "provider_unavailable";
  readonly status = 502;
}

/**
 * Tagged error when cloud storage (R2) encounters transient or permanent failures.
 * Maps to HTTP 503 with canonical OpenAPI error code `service_unavailable`.
 */
export class StorageUnavailableError extends Data.TaggedError("StorageUnavailableError")<{
  readonly code?: "service_unavailable";
  readonly message: string;
  readonly status?: 503;
}> {
  readonly code = "service_unavailable";
  readonly status = 503;
}
/**
 * Failure classification for outbound mail submission. `unavailable` means the
 * binding or sender configuration was absent so nothing was dispatched;
 * `rejected` means the provider deterministically refused the message;
 * `rate_limit`/`quota` distinguish throttling from daily-quota exhaustion;
 * `infrastructure` means a known internal provider failure; `ambiguous` means
 * the outcome is unknown after dispatch (unrecognized code, malformed receipt,
 * or transport error) and the submission must never be blindly resubmitted.
 */
export type MailSubmissionClassification =
  | "unavailable"
  | "rejected"
  | "rate_limit"
  | "quota"
  | "infrastructure"
  | "ambiguous";

/**
 * Tagged error for outbound mail submission failures. Owns the sanitized
 * failure contract: `message` never carries message bodies, action links,
 * recipient details beyond the classification, or raw vendor errors, and no
 * `cause` is retained. `classification` is the actionable distinction callers
 * need — only `ambiguous` leaves the remote write uncertain.
 */
export class MailSubmissionError extends Data.TaggedError("MailSubmissionError")<{
  readonly classification: MailSubmissionClassification;
  readonly message: string;
}> {}

/**
 * Tagged error for unexpected internal errors or connection pool timeouts.
 * Maps to HTTP 500 with canonical OpenAPI error code `internal_error`.
 */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause?: unknown;
  readonly code?: "internal_error";
  readonly message: string;
  readonly status?: 500;
}> {
  readonly code = "internal_error";
  readonly status = 500;
}

/**
 * Union type representing all canonical recoverable domain errors in Meltiply.
 */
export type MeltiplyDomainError =
  | InvalidRequestError
  | ValidationError
  | AuthenticationRequiredError
  | ActiveOrganizationRequiredError
  | ForbiddenError
  | NotFoundError
  | ConflictError
  | QuotaExceededError
  | RateLimitExceededError
  | ProviderRateLimitError
  | ProviderError
  | ProviderTransientError
  | StorageUnavailableError
  | MailSubmissionError
  | DatabaseError;
