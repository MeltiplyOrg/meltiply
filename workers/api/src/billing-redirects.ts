import { CoreApiError } from "./core-types";

/**
 * Validates that a billing redirect URL is well-formed, secure, and belongs to an approved origin.
 *
 * Ensures the target redirect adheres to HTTPS (permitting HTTP only for `localhost`), and that
 * its origin matches one of the comma-separated approved application origins configured in the environment.
 *
 * @param value - Candidate target redirect URL string.
 * @param name - Human-readable parameter name for error messaging (e.g., `"success_url"`).
 * @param allowedOrigins - Comma-separated list of approved application origins.
 * @returns The normalized string representation of the validated URL.
 * @throws {CoreApiError} 422 `validation_error` if the URL is malformed or does not use HTTPS.
 * @throws {CoreApiError} 422 `redirect_not_allowed` if the URL origin is not in the approved origins set.
 */
export function validateBillingRedirect(
  value: string,
  name: string,
  allowedOrigins: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CoreApiError(422, "validation_error", `${name} must be a valid URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new CoreApiError(422, "validation_error", `${name} must use HTTPS.`);
  }
  const allowed = new Set(
    allowedOrigins
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
  if (!allowed.has(url.origin)) {
    throw new CoreApiError(
      422,
      "redirect_not_allowed",
      `${name} must use an approved application origin.`,
    );
  }
  return url.toString();
}
