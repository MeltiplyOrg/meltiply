import sampleUrl from "./sample.svg?url";
import type { PreviewObject, PreviewValue } from "./contract-types";
import type { PreviewOptions } from "./scenarios";

/** Copies validated data into a fresh browser scenario and removes external resource URLs. Catalog dates shift near today by default; a zero dateOffset preserves real seed timestamps and timezone-aware Queue assignments. */
export function scenarioValue(
  value: PreviewValue,
  options: PreviewOptions,
  now: number,
  key = "",
  dateOffset = now - Date.parse("2026-01-01T00:00:00Z"),
): PreviewValue {
  if (Array.isArray(value))
    return value.map((item) => scenarioValue(item, options, now, key, dateOffset));
  if (value !== null && typeof value === "object") {
    const result: PreviewObject = Object.fromEntries(
      Object.entries(value).map(([field, child]) => [
        field,
        scenarioValue(child, options, now, field, dateOffset),
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
    const shifted = new Date(Date.parse(value) + dateOffset).toISOString();
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

/**
 * Applies form fields to a validated response shape. Identity-matched array
 * defaults retain response-only fields without borrowing another Channel's
 * settings. Provider option maps are authoritative replacements: a method
 * change must remove old nested choices and retain newly introduced fields.
 */
export function mergeExample(example: PreviewValue, input: PreviewValue): PreviewValue {
  if (Array.isArray(input)) {
    const rows = Array.isArray(example) ? example : [];
    return input.map((item) => {
      let template = rows[0];
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const key = ["id", "platform_account_id", "user_id", "asset_id"].find(
          (key) => typeof item[key] === "string",
        );
        if (key)
          template =
            rows.find(
              (row) =>
                row !== null &&
                typeof row === "object" &&
                !Array.isArray(row) &&
                row[key] === item[key],
            ) ?? template;
      }
      return template !== undefined ? mergeExample(template, item) : item;
    });
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
      Object.hasOwn(input, key)
        ? key === "provider_options"
          ? (input[key] ?? null)
          : mergeExample(value, input[key] ?? null)
        : value,
    ]),
  );
}
