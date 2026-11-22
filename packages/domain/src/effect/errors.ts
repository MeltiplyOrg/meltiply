import { Data } from "effect";

/** Malformed request syntax or parameters; HTTP 400 `invalid_request`. */
export class InvalidRequestError extends Data.TaggedError("InvalidRequestError")<{
  readonly message: string;
}> {
  readonly code = "invalid_request";
  readonly status = 400;
}

/** Missing or invalid credentials; HTTP 401 `authentication_required`. */
export class AuthenticationRequiredError extends Data.TaggedError("AuthenticationRequiredError")<{
  readonly message: string;
}> {
  readonly code = "authentication_required";
  readonly status = 401;
}

/** Authenticated identity without an active Workspace membership; HTTP 403 `active_organization_required`. */
export class ActiveOrganizationRequiredError extends Data.TaggedError(
  "ActiveOrganizationRequiredError",
)<{
  readonly message: string;
}> {
  readonly code = "active_organization_required";
  readonly status = 403;
}

/** Caller lacks the capability for the operation; HTTP 403 `forbidden`. */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  readonly message: string;
}> {
  readonly code = "forbidden";
  readonly status = 403;
}

/** Resource missing or invisible to the tenant; HTTP 404 `not_found`. */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
}> {
  readonly code = "not_found";
  readonly status = 404;
}

/** Object storage failure; HTTP 503 `service_unavailable` with a sanitized message. */
export class StorageUnavailableError extends Data.TaggedError("StorageUnavailableError")<{
  readonly message: string;
}> {
  readonly code = "service_unavailable";
  readonly status = 503;
}

/**
 * Outbound mail failure class. `unavailable` dispatched nothing; `ambiguous`
 * means the outcome is unknown after dispatch and must never be blindly resubmitted.
 */
export type MailSubmissionClassification =
  | "unavailable"
  | "rejected"
  | "rate_limit"
  | "quota"
  | "infrastructure"
  | "ambiguous";

/** Sanitized mail failure: `message` never carries bodies, links, recipients, or vendor errors. */
export class MailSubmissionError extends Data.TaggedError("MailSubmissionError")<{
  readonly classification: MailSubmissionClassification;
  readonly message: string;
}> {}

/** Database or other internal failure; HTTP 500 `internal_error` with a sanitized message. */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {
  readonly code = "internal_error";
  readonly status = 500;
}
