import { codePointLength, isLoopbackHostname } from "@meltiply/domain";

export { codePointLength };

export const STANDARD_VIDEO_MIME_TYPES: readonly string[] = ["video/mp4", "video/quicktime"];

const controlCharactersPattern = /[\u0000-\u001f\u007f]/;
const providerIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const lineBreakPattern = /\r?\n/;
const maxCursorChars = 2_048;
const idempotencyKeyMaxChars = 255;

export function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(lineBreakPattern)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function normalizeContentType(contentType: string): string {
  const semi = contentType.indexOf(";");
  return (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

export function mediaKind(contentType: string): "image" | "video" | null {
  const normalized = normalizeContentType(contentType);
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  return null;
}

export function validFileSize(fileSize: number, maximum: number): boolean {
  return Number.isSafeInteger(fileSize) && fileSize >= 1 && fileSize <= maximum;
}

export function required(name: string, value: string, maximum = 4_096): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || controlCharactersPattern.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

export function assertHttpsOrLoopbackUrl(value: string, label = "URL"): URL {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.hash) {
    throw new TypeError(`${label} must be HTTPS or an exact loopback HTTP URL`);
  }
  return url;
}

export function exactRedirectUri(value: string): string {
  return assertHttpsOrLoopbackUrl(required("redirectUri", value, 2_048), "redirectUri").toString();
}

export function providerIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return providerIdentifierPattern.test(normalized) ? normalized : undefined;
}

export function numericOrStringIdentifier(value: unknown): string | undefined {
  return providerIdentifier(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : value,
  );
}

export function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

export function boundedText(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): string | undefined {
  if (typeof value !== "string" || value.length > maximum) return undefined;
  return value || allowEmpty ? value : undefined;
}

export function boundedCursor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length >= 1 &&
    value.length <= maxCursorChars &&
    !controlCharactersPattern.test(value)
    ? value
    : undefined;
}

export function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

/** Validated locally only; no provider accepts a remote idempotency key. */
export function requireIdempotencyKey(value: string): void {
  required("idempotencyKey", value, idempotencyKeyMaxChars);
}

export function secureUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

export function rtmpsUrl(value: unknown, maximum: number): string | undefined {
  const raw = boundedString(value, maximum);
  if (!raw || !URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  return url.protocol === "rtmps:" && !url.username && !url.password && !url.hash ? raw : undefined;
}

export function optionalSecureUrl(value: unknown): { valid: boolean; href?: string } {
  if (value === undefined) return { valid: true };
  const href = secureUrl(value)?.href;
  return href ? { valid: true, href } : { valid: false };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${required("accessToken", accessToken)}` };
}

export function jsonHeaders(accessToken: string): Record<string, string> {
  return { ...bearer(accessToken), "Content-Type": "application/json" };
}

export const formHeaders = { "Content-Type": "application/x-www-form-urlencoded" } as const;

export function metricValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function nonNegativeIntegerStringOrNumber(value: unknown): number | undefined {
  if (typeof value === "number") return metricValue(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
