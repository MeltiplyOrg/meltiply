/**
 * Contract-driven request validation module.
 *
 * Consolidates parameter parsing, body field extraction, and enum membership
 * checks into one module. Each runtime set is explicitly checked against the
 * corresponding contract union because TypeScript types are erased at runtime.
 *
 * Every validator throws CoreApiError on invalid input — this is intentional:
 * validation is an HTTP-layer concern (transforming wire data into domain
 * types) and belongs in the route seam.
 */

import type { components } from "@meltiply/contracts/schema";
import type { TikTokPrivacyLevel } from "@meltiply/providers";
import { PLATFORM_IDS, type Platform } from "@meltiply/domain";
import type { Context } from "hono";

import { CoreApiError } from "./core-types";
import { RFC4122_UUID_PATTERN as uuid } from "./crypto";
import type { ApiWorkerEnvironment } from "./env";

type Schemas = components["schemas"];
type ReplyStatus = Schemas["ReplyStatus"];
type AssetStatus = Schemas["AssetStatus"];
type BrandProfileColor = Schemas["BrandProfileColor"];
type PostStatus = Schemas["PostStatus"];

/**
 * Post lifecycle values accepted by the Post list selector. A Post is `draft`
 * until it has a publication intent and `active` afterwards; neither value
 * describes publication success, which stays per Distribution.
 */
export const POST_STATUS_VALUES: ReadonlySet<PostStatus> = new Set<PostStatus>(["draft", "active"]);

/**
 * Extracts an optional ordered list of UUIDs, such as a Post's attachment set
 * or one Channel's attachment subset.
 *
 * Repeats are rejected rather than silently collapsed: an attachment appearing
 * twice in one composition is ambiguous, and the published ordering must be
 * the order the creator saved rather than a deduplicated echo of it.
 *
 * @param body - Parsed JSON body.
 * @param name - Property name to read.
 * @returns Ordered validated UUIDs, `null` when explicitly null, or `undefined` when omitted.
 * @throws {CoreApiError} 400 if the value is not an array of unique canonical UUIDs.
 */
export function uuidArrayField(
  body: Record<string, unknown>,
  name: string,
): string[] | null | undefined {
  const value = body[name];
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !uuid.test(item))) {
    throw new CoreApiError(400, "validation_error", `${name} must be an array of valid UUIDs.`);
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) {
    throw new CoreApiError(400, "validation_error", `${name} must not repeat an asset.`);
  }
  return ids;
}

/**
 * Extracts an optional bounded Post title from an HTTP request body.
 *
 * The title is an optional label rather than provider copy, so a blank value is
 * allowed and stored as the empty string while control characters and overlong
 * labels are rejected before persistence.
 *
 * @param body - Parsed JSON body.
 * @param name - Property name to read.
 * @returns Normalized title, or `undefined` when omitted.
 * @throws {CoreApiError} 400 if the value is not a string within 200 characters without control characters.
 */
export function postTitleField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 200 || /[\x00-\x1F\x7F]/.test(value)) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${name} must be a string of at most 200 characters.`,
    );
  }
  return value.trim();
}

/**
 * Extracts an optional bounded Post body text from an HTTP request body.
 *
 * Caption length is enforced per Platform later because each provider has its
 * own limit; this boundary only keeps a stored body within the contract's own
 * ceiling so a Draft can never persist unbounded text. Newlines and tabs stay
 * legal because a Post body is multi-line copy.
 *
 * @param body - Parsed JSON body.
 * @param name - Property name to read.
 * @returns Normalized text, or `undefined` when omitted.
 * @throws {CoreApiError} 400 if the value is not a string within 10,000 characters without control characters.
 */
export function postTextField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    [...value].length > 10_000 ||
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)
  ) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${name} must be a string of at most 10000 characters.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Enum sets — derived from contract schema types
// ---------------------------------------------------------------------------

export const REPLY_STATUS_VALUES: ReadonlySet<ReplyStatus> = new Set<ReplyStatus>([
  "not_replied",
  "queued",
  "processing",
  "replied",
  "failed",
  "needs_reconciliation",
]);

export const ASSET_STATUS_VALUES: ReadonlySet<AssetStatus> = new Set<AssetStatus>([
  "pending_upload",
  "uploading",
  "processing",
  "ready",
  "failed",
  "deleting",
  "deleted",
]);

const BRAND_PROFILE_COLOR_VALUES: ReadonlySet<BrandProfileColor> = new Set<BrandProfileColor>([
  "#b91c1c",
  "#991b1b",
  "#7f1d1d",
  "#c2410c",
  "#9a3412",
  "#7c2d12",
  "#b45309",
  "#92400e",
  "#78350f",
  "#a16207",
  "#854d0e",
  "#713f12",
  "#4d7c0f",
  "#3f6212",
  "#365314",
  "#15803d",
  "#166534",
  "#14532d",
  "#0f766e",
  "#115e59",
  "#134e4a",
  "#0e7490",
  "#155e75",
  "#164e63",
  "#0369a1",
  "#075985",
  "#0c4a6e",
  "#1d4ed8",
  "#1e40af",
  "#1e3a8a",
  "#4338ca",
  "#3730a3",
  "#312e81",
  "#6d28d9",
  "#5b21b6",
  "#4c1d95",
  "#7e22ce",
  "#6b21a8",
  "#581c87",
  "#a21caf",
  "#86198f",
  "#701a75",
  "#be185d",
  "#9d174d",
  "#831843",
  "#be123c",
  "#9f1239",
  "#881337",
  "#374151",
  "#1f2937",
  "#111827",
]);

export const TIKTOK_PRIVACY_LEVELS: ReadonlySet<TikTokPrivacyLevel> = new Set<TikTokPrivacyLevel>([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
]);

export const OAUTH_ROUTING_KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const JSON_BODY_MAXIMUM_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Path / query parameter validators
// ---------------------------------------------------------------------------

/**
 * Validates that a string matches a supported social media platform identifier.
 *
 * @param value - Raw platform parameter value from route path or query.
 * @returns Validated `Platform` literal.
 * @throws {CoreApiError} 400 if platform is not in `PLATFORM_IDS`.
 */
export function platformParam(value: string): Platform {
  if (!PLATFORM_IDS.includes(value as Platform)) {
    throw new CoreApiError(400, "invalid_request", "The platform is not supported.");
  }
  return value as Platform;
}

/**
 * Validates that a route parameter or query string conforms to RFC 4122 UUID format.
 *
 * @param value - Raw string value to inspect.
 * @param name - Parameter name to include in error messages (e.g. "asset_id").
 * @returns Validated UUID string.
 * @throws {CoreApiError} 400 if value is not a canonical UUID.
 */
export function uuidParam(value: string, name: string): string {
  if (!uuid.test(value)) {
    throw new CoreApiError(400, "invalid_request", `${name} must be a valid UUID.`);
  }
  return value;
}

/**
 * Parses and bounds an integer query parameter.
 *
 * @param value - Raw query string value or undefined.
 * @param name - Parameter name for error messages.
 * @param fallback - Default value used when parameter is omitted or empty.
 * @param minimum - Inclusive lower bound.
 * @param maximum - Inclusive upper bound.
 * @returns Parsed integer clamped within bounds.
 * @throws {CoreApiError} 400 if not an integer or outside [minimum, maximum].
 */
export function integerParam(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new CoreApiError(400, "invalid_request", `${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new CoreApiError(
      400,
      "invalid_request",
      `${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

/**
 * Parses a boolean query parameter into true, false, or undefined.
 *
 * @param value - Raw query string value or undefined.
 * @param name - Parameter name for error messages.
 * @returns Parsed boolean, or undefined if omitted or empty.
 * @throws {CoreApiError} 400 if value is neither "true" nor "false".
 */
export function booleanParam(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CoreApiError(400, "invalid_request", `${name} must be true or false.`);
}

/**
 * Validates and parses an RFC3339 timestamp string into a Date object.
 *
 * @param value - Raw timestamp string.
 * @param name - Parameter name for error reporting.
 * @returns Valid Date object representing the timestamp.
 * @throws {CoreApiError} 400 `invalid_request` if timestamp is missing, malformed, or NaN.
 */
function dateParam(value: string | undefined, name: string): Date {
  if (!value || !RFC3339_PATTERN.test(value)) {
    throw new CoreApiError(400, "invalid_request", `${name} must be an RFC3339 timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CoreApiError(400, "invalid_request", `${name} must be an RFC3339 timestamp.`);
  }
  return parsed;
}

/**
 * Extracts and validates an RFC3339 timestamp from a JSON request body.
 *
 * Unlike query parameter validation, a malformed body field is a schema
 * violation and so surfaces the `validation_error` code shared by every other
 * body field validator rather than `invalid_request`.
 *
 * @param body - Parsed JSON body.
 * @param name - Property name to read.
 * @returns Valid Date object representing the timestamp.
 * @throws {CoreApiError} 400 `validation_error` if the field is absent, not a string, malformed, or NaN.
 */
export function dateField(body: Record<string, unknown>, name: string): Date {
  const value = body[name];
  if (typeof value !== "string" || !RFC3339_PATTERN.test(value)) {
    throw new CoreApiError(400, "validation_error", `${name} must be an RFC3339 timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CoreApiError(400, "validation_error", `${name} must be an RFC3339 timestamp.`);
  }
  return parsed;
}

/**
 * Parses an optional RFC3339 timestamp parameter.
 *
 * @param value - Raw timestamp string or undefined.
 * @param name - Parameter name for error reporting.
 * @returns Date instance if present, or undefined if omitted.
 */
export function optionalDateParam(value: string | undefined, name: string): Date | undefined {
  return value ? dateParam(value, name) : undefined;
}

/**
 * Validates a start and end RFC3339 date range within a maximum duration.
 *
 * @param startValue - Raw start timestamp string.
 * @param endValue - Raw end timestamp string.
 * @param maximumDays - Maximum allowed span in days.
 * @returns Object with parsed `start` and `end` Date objects.
 * @throws {CoreApiError} 400 if either timestamp is invalid or the range exceeds maximumDays.
 */
export function dateRange(
  startValue: string | undefined,
  endValue: string | undefined,
  maximumDays: number,
): { end: Date; start: Date } {
  const start = dateParam(startValue, "start");
  const end = dateParam(endValue, "end");
  validateDateSpan(start, end, maximumDays);
  return { end, start };
}

/**
 * Asserts that end timestamp is at or after start, and does not exceed maximum days span.
 *
 * @param start - Starting Date object.
 * @param end - Ending Date object.
 * @param maximumDays - Maximum allowable span in calendar days.
 * @throws {CoreApiError} 400 if end is before start or span exceeds maximumDays.
 */
export function validateDateSpan(start: Date, end: Date, maximumDays: number): void {
  if (end.getTime() < start.getTime()) {
    throw new CoreApiError(400, "invalid_range", "end must be at or after start.");
  }
  if (end.getTime() - start.getTime() > maximumDays * 24 * 60 * 60 * 1_000) {
    throw new CoreApiError(
      400,
      "invalid_range",
      `The requested range cannot exceed ${maximumDays} days.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Request header validators
// ---------------------------------------------------------------------------

/**
 * Extracts and validates the mandatory `Idempotency-Key` HTTP request header.
 *
 * Enforces non-empty printable string constraint (1 to 200 characters) on mutating endpoints
 * to guarantee at-most-once operation semantics and safe replay matching.
 *
 * @param c - Hono request context.
 * @returns Trimmed idempotency key string.
 * @throws {CoreApiError} 400 if key header is missing, empty, or exceeds 200 characters.
 */
export function idempotencyKey(c: Context<ApiWorkerEnvironment>): string {
  const key = c.req.header("Idempotency-Key")?.trim() ?? "";
  if (!key || key.length > 200) {
    throw new CoreApiError(
      400,
      "idempotency_key_required",
      "A non-empty Idempotency-Key of at most 200 characters is required.",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Body parsing and field extraction
// ---------------------------------------------------------------------------

/**
 * Reads and verifies the raw text body of a request within declared and maximum byte limits.
 *
 * Inspects `Content-Length` header before reading the stream to fail fast on oversized payloads,
 * followed by exact byte count validation using TextEncoder.
 *
 * @param request - Fetch Request instance.
 * @param code - Error code if payload exceeds limit.
 * @param message - Error message if payload exceeds limit.
 * @param maximumBytes - Maximum allowed byte size (default: 1 MiB).
 * @param status - HTTP status code on limit violation (default: 400).
 * @returns Raw body string.
 * @throws {CoreApiError} if Content-Length or actual body exceeds maximumBytes.
 */
async function rawBody(
  request: Request,
  code: string,
  message: string,
  maximumBytes = 1024 * 1024,
  status = 400,
): Promise<string> {
  const declaredLengthHeader = request.headers.get("Content-Length");
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maximumBytes
    ) {
      throw new CoreApiError(status, code, message);
    }
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBytes) {
    throw new CoreApiError(status, code, message);
  }
  return body;
}

/**
 * Parses a request body as a JSON object within a 512 KiB limit.
 *
 * Verifies that the parsed JSON payload is a non-null, non-array object.
 *
 * @param c - Hono request context.
 * @param optional - If true, an empty or whitespace body returns an empty object `{}`.
 * @returns Parsed JSON record object.
 * @throws {CoreApiError} 413 if body exceeds 512 KiB; 400 if invalid JSON or not an object.
 */
export async function jsonBody(
  c: Context<ApiWorkerEnvironment>,
  optional = false,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await rawBody(
      c.req.raw,
      "payload_too_large",
      "The request body exceeds the 512 KiB limit.",
      JSON_BODY_MAXIMUM_BYTES,
      413,
    );
  } catch (cause) {
    if (cause instanceof CoreApiError) throw cause;
    throw new CoreApiError(400, "invalid_request", "The request body must be valid JSON.");
  }
  try {
    if (optional && !raw.trim()) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("body is not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new CoreApiError(400, "invalid_request", "The request body must be valid JSON.");
  }
}

// ---------------------------------------------------------------------------
// Body field validators
// ---------------------------------------------------------------------------

/**
 * Asserts that a body object contains only approved keys, rejecting unexpected properties.
 *
 * Enforces strict OpenAPI contract matching by preventing client pollution with unknown fields.
 *
 * @param body - Parsed JSON object.
 * @param allowed - Array of permitted field name strings.
 * @throws {CoreApiError} 400 if any key in body is not in the allowed list.
 */
export function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new CoreApiError(400, "validation_error", "The request contains an unknown field.");
  }
}

/**
 * Extracts a mandatory string field from a JSON object.
 *
 * @param body - Parsed JSON body.
 * @param name - Expected property key.
 * @returns Extracted string value.
 * @throws {CoreApiError} 400 if property is missing or not a string.
 */
export function stringField(body: Record<string, unknown>, name: string): string {
  if (typeof body[name] !== "string") {
    throw new CoreApiError(400, "validation_error", `${name} must be a string.`);
  }
  return body[name];
}

/**
 * Extracts and validates a Brand Profile display name at the HTTP boundary.
 *
 * Enforces the OpenAPI name contract before persistence so whitespace-only,
 * control-character, and overlong values produce a deterministic 400 rather
 * than leaking a database constraint failure.
 *
 * @param body - Parsed JSON body.
 * @param name - Expected property key.
 * @returns Valid display name containing 1–100 non-control characters.
 * @throws {CoreApiError} 400 if the field is absent, non-string, or invalid.
 */
export function brandProfileNameField(body: Record<string, unknown>, name: string): string {
  const value = stringField(body, name);
  if (value.length < 1 || value.length > 100 || !/^(?=.*\S)[^\x00-\x1F\x7F]+$/.test(value)) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${name} must contain 1 to 100 non-control characters and cannot be blank.`,
    );
  }
  return value;
}

/**
 * Extracts a nullable Brand Profile description at the HTTP boundary.
 *
 * Descriptions are optional, but supplied strings must contain 1–280 visible
 * non-control characters so the stored profile summary matches its contract.
 *
 * @param body - Parsed JSON body.
 * @param name - Expected property key.
 * @returns Valid description, null to clear it, or undefined when omitted.
 * @throws {CoreApiError} 400 if the supplied value violates the description contract.
 */
export function brandProfileDescriptionField(
  body: Record<string, unknown>,
  name: string,
): string | null | undefined {
  const value = optionalStringField(body, name);
  if (value === undefined || value === null) return value;
  if (value.length < 1 || value.length > 280 || !/^(?=.*\S)[^\x00-\x1F\x7F]+$/.test(value)) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${name} must contain 1 to 280 non-control characters and cannot be blank.`,
    );
  }
  return value;
}

/**
 * Extracts and validates a fixed-palette Brand Profile color at the HTTP boundary.
 *
 * The runtime set mirrors the generated contract union, preserving the fixed
 * accessible palette invariant before the value reaches PostgreSQL.
 *
 * @param body - Parsed JSON body.
 * @param name - Expected property key.
 * @returns A color label admitted by `BRAND_PROFILE_COLOR_VALUES`.
 * @throws {CoreApiError} 400 if the field is absent, non-string, or outside the palette.
 */
export function brandProfileColorField(
  body: Record<string, unknown>,
  name: string,
): BrandProfileColor {
  const value = stringField(body, name);
  if (!BRAND_PROFILE_COLOR_VALUES.has(value as BrandProfileColor)) {
    throw new CoreApiError(400, "validation_error", `${name} is invalid.`);
  }
  return value as BrandProfileColor;
}

/**
 * Extracts an optional string field, permitting string, null, or undefined.
 *
 * @param body - Parsed JSON body.
 * @param name - Expected property key.
 * @returns Extracted string, null, or undefined.
 * @throws {CoreApiError} 400 if value is present and neither a string nor null.
 */
export function optionalStringField(
  body: Record<string, unknown>,
  name: string,
): string | null | undefined {
  const value = body[name];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new CoreApiError(400, "validation_error", `${name} must be a string or null.`);
  }
  return value;
}

/**
 * Extracts an optional array of strings from a JSON object.
 *
 * @param body - Parsed JSON body.
 * @param name - Expected property key.
 * @returns Array of strings, or undefined if omitted.
 * @throws {CoreApiError} 400 if property is present and not an array of strings.
 */
export function stringArrayField(
  body: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CoreApiError(400, "validation_error", `${name} must be an array of strings.`);
  }
  return value;
}

/**
 * Extracts a required positive safe integer field (e.g. file size in bytes).
 *
 * @param body - Parsed JSON body.
 * @param name - Property name.
 * @returns Number value >= 1.
 * @throws {CoreApiError} 400 if value is not a safe integer >= 1.
 */
export function positiveIntegerField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new CoreApiError(400, "validation_error", `${name} must be a positive safe integer.`);
  }
  return Number(value);
}

/**
 * Validates and extracts multipart part numbers array from `body.part_numbers`.
 *
 * Enforces that every part number is an integer between 1 and 10,000.
 *
 * @param body - Request body containing `part_numbers`.
 * @returns Array of integer part numbers.
 * @throws {CoreApiError} 400 if not an array of valid part numbers.
 */
export function partNumbersField(body: Record<string, unknown>): number[] {
  const value = body.part_numbers;
  if (
    !Array.isArray(value) ||
    value.some((item) => !Number.isInteger(item) || Number(item) < 1 || Number(item) > 10_000)
  ) {
    throw new CoreApiError(
      400,
      "validation_error",
      "part_numbers must be an array of integers between 1 and 10000.",
    );
  }
  return value.map(Number);
}

/**
 * Validates and extracts completed multipart parts array (`parts: [{ part_number, etag }]`).
 *
 * Verifies part structure, integer part numbers, string ETags, and disallows unexpected keys.
 *
 * @param body - Request body containing `parts`.
 * @returns Array of valid `CompletedPart` objects, or undefined if omitted.
 * @throws {CoreApiError} 400 if parts array or items are malformed.
 */
export function completedPartsField(
  body: Record<string, unknown>,
): Schemas["CompletedPart"][] | undefined {
  const value = body.parts;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new CoreApiError(400, "validation_error", "parts must be an array.");
  }
  return value.map((part) => {
    if (
      !part ||
      typeof part !== "object" ||
      Array.isArray(part) ||
      !Number.isInteger((part as Record<string, unknown>).part_number) ||
      typeof (part as Record<string, unknown>).etag !== "string"
    ) {
      throw new CoreApiError(
        400,
        "validation_error",
        "Every completed part requires an integer part_number and string etag.",
      );
    }
    onlyKeys(part as Record<string, unknown>, ["part_number", "etag"]);
    return {
      etag: (part as Record<string, unknown>).etag as string,
      part_number: Number((part as Record<string, unknown>).part_number),
    };
  });
}

/**
 * Validates that an optional string parameter belongs to an allowed enumeration set.
 *
 * @param value - Raw query string value or undefined.
 * @param name - Parameter name for error messages.
 * @param allowed - Readonly set of permitted string literals.
 * @returns Typed enum literal if value is provided and valid, or undefined if omitted.
 * @throws {CoreApiError} 400 if value is not contained in the allowed set.
 */
export function enumParam<T extends string>(
  value: string | undefined,
  name: string,
  allowed: ReadonlySet<T>,
): T | undefined {
  if (value === undefined || value === "") return undefined;
  if (!allowed.has(value as T)) {
    throw new CoreApiError(400, "invalid_request", `${name} is invalid.`);
  }
  return value as T;
}

/**
 * Parses and bounds an optional free-text query parameter.
 *
 * Surrounding whitespace is trimmed and an empty result is treated as omitted,
 * so `?q=` behaves like an absent filter. Control characters are rejected
 * before the value reaches a query, log, or error message.
 *
 * @param value - Raw query string value or undefined.
 * @param name - Parameter name for error messages.
 * @param maximumLength - Inclusive character ceiling from the contract.
 * @returns Trimmed value, or undefined when omitted or blank.
 * @throws {CoreApiError} 400 if the value exceeds the ceiling or contains control characters.
 */
export function textParam(
  value: string | undefined,
  name: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > maximumLength || /[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new CoreApiError(
      400,
      "invalid_request",
      `${name} must contain at most ${maximumLength} non-control characters.`,
    );
  }
  return trimmed;
}
