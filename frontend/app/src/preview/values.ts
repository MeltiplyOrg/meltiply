import sampleUrl from "./sample.svg?url";
import type { PreviewObject, PreviewValue } from "./contract-types";
import type { PreviewOptions } from "./scenarios";

/** Copies validated canonical examples into a fresh browser scenario, shifts sample dates near today, and removes external resource URLs. Feature outcomes alter data, never application code. */
export function scenarioValue(
  value: PreviewValue,
  options: PreviewOptions,
  now: number,
  key = "",
): PreviewValue {
  if (Array.isArray(value)) return value.map((item) => scenarioValue(item, options, now, key));
  if (value !== null && typeof value === "object") {
    const result: PreviewObject = Object.fromEntries(
      Object.entries(value).map(([field, child]) => [
        field,
        scenarioValue(child, options, now, field),
      ]),
    );
    if ("asset_type" in result) {
      result.thumbnail_url = sampleUrl;
      result.download_url = sampleUrl;
    }
    if (options.scenario === "channel-expired" && "connection_status" in result)
      result.connection_status = "reconnect_required";
    if (options.scenario === "publication-failed") {
      if ("default_text" in result) result.status = "active";
      if ("post_id" in result && "platform_account_id" in result && "status" in result) {
        result.status = "failed";
        if ("failure" in result)
          result.failure = {
            code: "preview_publication_failed",
            message: "Synthetic publication failure for frontend review.",
            retryable: true,
            last_occurred_at: new Date(now).toISOString(),
          };
      }
    }
    if ((options.scenario === "viewer" || options.scenario === "editor") && "role" in result)
      result.role = options.scenario;
    if (
      (options.scenario === "viewer" || options.scenario === "editor") &&
      "is_installation_owner" in result
    )
      result.is_installation_owner = false;
    return result;
  }
  if (typeof value !== "string") return value;
  if (/^\d{4}-\d\d-\d\d(?:T|$)/.test(value) && Number.isFinite(Date.parse(value))) {
    const shifted = new Date(
      now + Date.parse(value) - Date.parse("2026-01-01T00:00:00Z"),
    ).toISOString();
    return value.length === 10 ? shifted.slice(0, 10) : shifted;
  }
  if (key === "totpURI")
    return "otpauth://totp/UI%20preview?secret=JBSWY3DPEHPK3PXP&issuer=UI%20preview";
  if (/^https?:\/\//.test(value)) {
    if (/avatar|image|thumbnail|download|picture|^url$/.test(key)) return sampleUrl;
    return null;
  }
  return value;
}

/** Empties data arrays and aggregate counters while retaining the envelope and pagination configuration. */
export function emptyValue(value: PreviewValue): PreviewValue {
  if (Array.isArray(value)) return [];
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "has_more"
        ? false
        : key === "next_cursor"
          ? null
          : typeof child === "number" && !["limit", "offset"].includes(key)
            ? 0
            : emptyValue(child),
    ]),
  );
}

/** Applies form fields to a validated response shape; array rows retain example defaults so response-only fields survive frontend saves. */
export function mergeExample(example: PreviewValue, input: PreviewValue): PreviewValue {
  if (Array.isArray(input)) {
    const template = Array.isArray(example) ? example[0] : undefined;
    return input.map((item) => (template !== undefined ? mergeExample(template, item) : item));
  }
  if (
    example === null ||
    typeof example !== "object" ||
    Array.isArray(example) ||
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    return input;
  return Object.fromEntries(
    Object.entries(example).map(([key, value]) => [
      key,
      Object.hasOwn(input, key) ? mergeExample(value, input[key] ?? null) : value,
    ]),
  );
}
