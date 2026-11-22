import type { components } from "@meltiply/contracts/schema";
import type { TikTokPrivacyLevel } from "@meltiply/providers";
import { codePointLength, PLATFORM_IDS, type Platform } from "@meltiply/domain";
import type { Context } from "hono";
import { z } from "zod";

import { CoreApiError } from "./core-types";
import { RFC4122_UUID_PATTERN as uuid } from "./crypto";
import type { ApiWorkerEnvironment } from "./env";

const timezoneOffsetPattern = /^[+-]/;
const controlCharactersPattern = /[\x00-\x1F\x7F]/;
const unsafePostTextPattern = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const integerPattern = /^\d+$/;
const nonBlankTextPattern = /^(?=.*\S)[^\x00-\x1F\x7F]+$/;

type Schemas = components["schemas"];
type ReplyStatus = Schemas["ReplyStatus"];
type AssetStatus = Schemas["AssetStatus"];
type BrandProfileColor = Schemas["BrandProfileColor"];
type PostStatus = Schemas["PostStatus"];
type AnalyticsMetric = Schemas["AnalyticsMetric"];

export const queueConfigurationSchema = z.strictObject({
  brand_profile_id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  timezone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return !timezoneOffsetPattern.test(value);
      } catch {
        return false;
      }
    }, "Use a supported IANA timezone"),
  slots: z
    .array(
      z.strictObject({
        weekday: z.number().int().min(0).max(6),
        time: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
      }),
    )
    .min(1)
    .max(168)
    .refine(
      (slots) => new Set(slots.map((slot) => `${slot.weekday}/${slot.time}`)).size === slots.length,
      "Slots must be unique",
    ),
});
export const queuePatchSchema = queueConfigurationSchema.partial({
  name: true,
  timezone: true,
  slots: true,
});
export const queueScopeSchema = z.strictObject({ brand_profile_id: z.uuid() });
export type QueueConfiguration = z.infer<typeof queueConfigurationSchema>;

export const POST_STATUS_VALUES: ReadonlySet<PostStatus> = new Set<PostStatus>(["draft", "active"]);

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

export function postTitleField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 200 || controlCharactersPattern.test(value)) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${name} must be a string of at most 200 characters.`,
    );
  }
  return value.trim();
}

export function postTextField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    codePointLength(value) > 10_000 ||
    unsafePostTextPattern.test(value)
  ) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${name} must be a string of at most 10000 characters.`,
    );
  }
  return value;
}

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

const ANALYTICS_FORMATS: Record<Schemas["AnalyticsFormat"], true> = {
  carousel: true,
  image: true,
  text: true,
  video: true,
};

const ANALYTICS_METRICS: Record<AnalyticsMetric, true> = {
  comments: true,
  likes: true,
  shares: true,
  views: true,
};

export function analyticsMetricParam(value: string | undefined): AnalyticsMetric {
  if (value === undefined || value === "") return "views";
  if (!Object.hasOwn(ANALYTICS_METRICS, value)) {
    throw new CoreApiError(400, "invalid_request", "metric is invalid.");
  }
  return value as AnalyticsMetric;
}

export function analyticsFormatParam(
  value: string | undefined,
): Schemas["AnalyticsFormat"] | undefined {
  if (value === undefined || value === "") return undefined;
  if (!Object.hasOwn(ANALYTICS_FORMATS, value)) {
    throw new CoreApiError(400, "invalid_request", "format is invalid.");
  }
  return value as Schemas["AnalyticsFormat"];
}

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

export function platformParam(value: string): Platform {
  if (!PLATFORM_IDS.includes(value as Platform)) {
    throw new CoreApiError(400, "invalid_request", "The platform is not supported.");
  }
  return value as Platform;
}

export function uuidParam(value: string, name: string): string {
  if (!uuid.test(value)) {
    throw new CoreApiError(400, "invalid_request", `${name} must be a valid UUID.`);
  }
  return value;
}

export function integerParam(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!integerPattern.test(value)) {
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

export function booleanParam(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new CoreApiError(400, "invalid_request", `${name} must be true or false.`);
}

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

export function optionalDateParam(value: string | undefined, name: string): Date | undefined {
  return value ? dateParam(value, name) : undefined;
}

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

export function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new CoreApiError(400, "validation_error", "The request contains an unknown field.");
  }
}

export function stringField(body: Record<string, unknown>, name: string): string {
  if (typeof body[name] !== "string") {
    throw new CoreApiError(400, "validation_error", `${name} must be a string.`);
  }
  return body[name];
}

export function brandProfileNameField(body: Record<string, unknown>, name: string): string {
  const value = stringField(body, name);
  if (value.length < 1 || value.length > 100 || !nonBlankTextPattern.test(value)) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${name} must contain 1 to 100 non-control characters and cannot be blank.`,
    );
  }
  return value;
}

export function brandProfileDescriptionField(
  body: Record<string, unknown>,
  name: string,
): string | null | undefined {
  const value = optionalStringField(body, name);
  if (value === undefined || value === null) return value;
  if (value.length < 1 || value.length > 280 || !nonBlankTextPattern.test(value)) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${name} must contain 1 to 280 non-control characters and cannot be blank.`,
    );
  }
  return value;
}

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

export function workspaceNameValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new CoreApiError(400, "validation_error", `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200 || /[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${field} must contain 1 to 200 characters without control characters.`,
    );
  }
  return trimmed;
}

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

export function positiveIntegerField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new CoreApiError(400, "validation_error", `${name} must be a positive safe integer.`);
  }
  return Number(value);
}

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

export function textParam(
  value: string | undefined,
  name: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > maximumLength || controlCharactersPattern.test(trimmed)) {
    throw new CoreApiError(
      400,
      "invalid_request",
      `${name} must contain at most ${maximumLength} non-control characters.`,
    );
  }
  return trimmed;
}
