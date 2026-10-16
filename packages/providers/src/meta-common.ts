import { classifyProviderFailure, ProviderAdapterError } from "./failures";

/**
 * Asserts that a string parameter is non-empty, within maximum length, and free of control characters.
 * Trims leading/trailing whitespace and rejects ASCII control codes (0x00-0x1F, 0x7F).
 * Returns the trimmed string. Throws TypeError if the value is empty, oversized, or contains control codes.
 */
export function required(name: string, value: string, maximum = 4_096): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

/**
 * Normalizes and validates an OAuth redirect URI string.
 * Requires HTTPS or loopback HTTP with no credentials or fragment, bounded to 2,048 characters.
 * Returns the canonical URL string. Throws TypeError if invalid.
 */
export function exactRedirectUri(value: string): string {
  const normalized = required("redirectUri", value, 2_048);
  return assertHttpsOrLoopbackUrl(normalized, "redirectUri").toString();
}

/**
 * Asserts that an attempted OAuth redirect URI matches the adapter's configured URI.
 * Normalizes the attempt through exactRedirectUri and compares the canonical strings,
 * so equivalent spellings match while any real difference throws
 * TypeError("OAuth redirect URI does not match configuration").
 */
export function assertConfiguredRedirectUri(attempted: string, configured: string): void {
  if (exactRedirectUri(attempted) !== configured) {
    throw new TypeError("OAuth redirect URI does not match configuration");
  }
}

/**
 * Validate a public URL as HTTPS or an exact loopback HTTP URL (AUD-026).
 * Rejects embedded userinfo credentials and fragments to enforce URL shape constraints.
 * Does **not** verify the destination host — arbitrary HTTPS URLs including private and
 * internal addresses are accepted. This is a scheme and credential guard, not SSRF protection.
 * Returns parsed canonical URL object. Throws TypeError if scheme or credentials violate constraints.
 */
export function assertHttpsOrLoopbackUrl(value: string, label = "URL"): URL {
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.hash) {
    throw new TypeError(`${label} must be HTTPS or an exact loopback HTTP URL`);
  }
  return url;
}

/**
 * Validates and normalizes an external provider identifier (e.g. page ID, media ID, user ID).
 * Enforces alphanumeric start and allowable characters `[A-Za-z0-9._:-]` up to 255 characters.
 * Returns trimmed identifier string, or undefined if the input does not match the pattern.
 */
export function providerIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(normalized) ? normalized : undefined;
}

/**
 * Trims and bounds an optional string value to a maximum character length.
 * Disallows empty or whitespace-only strings.
 * Returns trimmed string if valid and non-empty, or undefined otherwise.
 */
export function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

/**
 * Validates and bounds a multiline text payload (such as post caption or biography).
 * Preserves inner whitespace and enforces length <= maximum; optionally permits empty string.
 * Returns string if length <= maximum and allowed, or undefined otherwise.
 */
export function boundedText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): string | undefined {
  if (typeof value !== "string" || value.length > maximum) return undefined;
  return value || allowEmpty ? value : undefined;
}

/**
 * Validates an opaque pagination cursor token returned by an external provider API.
 * Bounds length between 1 and 2,048 characters and excludes ASCII control codes.
 * Returns cursor string if valid, or undefined otherwise.
 */
export function boundedCursor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length >= 1 && value.length <= 2_048 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

/**
 * Validates provider list pagination input parameters (limit and optional cursor).
 * Enforces integer limit between 1 and 100 and validates cursor structure against control characters.
 * Throws ProviderAdapterError with HTTP 400 status if inputs are invalid.
 */
export function validatePageInput(
  provider: string,
  input: { cursor?: string; limit: number },
): void {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.cursor !== undefined && !boundedCursor(input.cursor))
  ) {
    throw new ProviderAdapterError(
      classifyProviderFailure({
        code: `${provider}_page_invalid`,
        status: 400,
      }),
    );
  }
}

/**
 * Parses and converts an arbitrary provider timestamp string into canonical ISO 8601 UTC format.
 * Binds input length to 64 characters and verifies valid finite date parsing.
 * Returns ISO timestamp string (e.g. '2026-09-12T07:00:00.000Z'), or undefined if invalid.
 */
export function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

/**
 * Validates and normalizes an external media or profile resource URL.
 * Requires https: protocol without credentials or fragment identifiers.
 * Returns canonical URL string, or undefined if parsing fails or constraints are not met.
 */
export function secureUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Narrowing helper that verifies whether an untrusted value is a non-null, non-array object.
 * Returns typed Record<string, unknown> if valid, or undefined otherwise.
 */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Constructs an Authorization header record with a validated Bearer token.
 * Validates accessToken string against whitespace and control characters.
 * Returns `{ Authorization: 'Bearer <token>' }` header object. Throws TypeError if token is invalid.
 */
export function bearer(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${required("accessToken", accessToken)}` };
}

/**
 * Validates and bounds a numerical analytics metric (impressions, reach, likes, comments).
 * Enforces that value is a non-negative safe integer.
 * Returns non-negative integer number, or undefined if invalid.
 */
export function metricValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Formats a composite Meta media-container operation identifier tracking publication state.
 * Encodes the container lifecycle phase and container ID (e.g. 'created:12345'); 'submitted'
 * records that a publish request was dispatched with an unconfirmed outcome so later
 * reconciliation never issues a second publish for the same container.
 * Returns formatted operation identifier string.
 */
export function containerOperationId(phase: "created" | "submitted", id: string): string {
  return `${phase}:${id}`;
}

/**
 * Parsed Meta media-container operation identity: the lifecycle phase ('created' awaits
 * finalization, 'submitted' means a publish was already dispatched) plus the container ID.
 */
export interface MetaContainerOperation {
  id: string;
  phase: "created" | "submitted";
}

/**
 * Parses a composite Meta media-container operation identifier into its lifecycle phase
 * and container ID. Matches 'created' or 'submitted' phases produced by
 * containerOperationId; both segments must satisfy provider identifier rules.
 * Returns parsed MetaContainerOperation record, or undefined if malformed or unrecognized.
 */
export function parseContainerOperationId(value: unknown): MetaContainerOperation | undefined {
  const normalized = providerIdentifier(value);
  const match = normalized?.match(/^(created|submitted):(.+)$/);
  const id = providerIdentifier(match?.[2]);
  return match && id ? { id, phase: match[1] as "created" | "submitted" } : undefined;
}

/**
 * Ordered keyword patterns mapping Meta container status detail to safe diagnostic
 * categories. Retrieval is matched first because it is the most common actionable
 * cause; format is last so dimension/duration wording wins over generic 'unsupported'.
 */
const containerFailurePatterns: ReadonlyArray<readonly [pattern: RegExp, category: string]> = [
  [/fetch|retrieve(?:d|ing)?|retrieval|download|url|unreach|access/i, "media_retrieval"],
  [/duration|too short|too long|length/i, "media_duration"],
  [/dimension|aspect|resolution|width|height/i, "media_dimensions"],
  [/format|codec|encoding|unsupported|invalid media|corrupt/i, "media_format"],
];

/**
 * Normalizes untrusted Meta container status detail (Instagram `status`, Threads
 * `error_message`) into a bounded, credential-free failure code. Maps recognized
 * diagnostic wording to media_retrieval, media_duration, media_dimensions, or
 * media_format categories; every other or absent detail falls back to
 * 'container_error'. The raw provider text is never embedded in the result.
 * Returns a `<provider>_container_<category>` code safe for persistence and display.
 */
export function metaContainerFailureCode(provider: string, detail: unknown): string {
  const text = boundedString(detail, 1_024);
  const category = text
    ? (containerFailurePatterns.find(([pattern]) => pattern.test(text))?.[1] ?? "error")
    : "error";
  return `${provider}_container_${category}`;
}
