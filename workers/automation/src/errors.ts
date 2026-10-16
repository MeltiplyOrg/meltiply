// Shared error-message sanitizer for the Automation Worker (AUD-022).
// Every error message that reaches logs or the database must pass through
// here so URLs and inline credentials are redacted exactly once.

/**
 * Sanitizes and truncates an error message before recording it in database rows or logs.
 * Strips raw URLs and inline credentials (`token=`, `secret=`, `password=`) to prevent
 * secret leaks into telemetry and PostgreSQL error columns (AUD-022).
 *
 * @param cause - Thrown error or unknown rejection value.
 * @param fallback - Default message if cause is not an Error instance (defaults to "unknown job error").
 * @returns Sanitized error message string truncated to at most 1,000 characters.
 *
 * @example
 * safeErrorMessage(new Error("Call failed: https://api.example.com?token=secret123"))
 * // => "Call failed: [REDACTED_URL]"
 */
export function safeErrorMessage(cause: unknown, fallback = "unknown job error"): string {
  return (cause instanceof Error ? cause.message : fallback)
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/(token|secret|password)=\S+/gi, "$1=[REDACTED]")
    .slice(0, 1_000);
}
