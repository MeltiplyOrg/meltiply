import { translate, type Language } from "@/lib/i18n";

const publicMessages: Record<string, string> = {
  active_organization_required: "Choose an active workspace to continue.",
  asset_in_use: "This asset cannot be deleted while it is in use.",
  conflict: "This changed while you were working. Refresh and try again.",
  quota_exceeded: "Your storage or upload quota has been reached.",
  rate_limited: "Too many requests. Wait a moment and try again.",
};

const genericErrorMessage = "An error has occurred.";
const genericErrorCodes: Record<string, true> = {
  dependency_unavailable: true,
  provider_unavailable: true,
};

/**
 * Casts an unknown value to a dictionary object if it is a non-null, non-array object.
 *
 * @param value Arbitrary error or payload to test.
 * @returns Key-value record or `undefined` if not an object.
 */
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extracts a string error code from an error payload or ApiError instance.
 *
 * @param error Arbitrary error value.
 * @returns Error code string or `undefined` if not present.
 */
function errorCode(error: unknown): string | undefined {
  const code = record(error)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Extracts an HTTP status code number from an error payload or ApiError instance.
 *
 * @param error Arbitrary error value.
 * @returns Integer HTTP status code or `undefined`.
 */
function errorStatus(error: unknown): number | undefined {
  const status = record(error)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Extracts a string error code from an error payload or ApiError instance.
 *
 * Exported so a specific surface can react to a known code without depending on
 * the generic user-facing copy, which deliberately masks infrastructure codes.
 *
 * @param error Arbitrary error or payload to test.
 * @returns Error code string or `undefined` if not present.
 */
export function apiErrorCode(error: unknown): string | undefined {
  return errorCode(error);
}

/**
 * Resolves an arbitrary error or API rejection to a localized, safe user-facing message.
 * Masks 5xx server errors and internal infrastructure codes with a generic error message,
 * while mapping known business codes (conflict, quota_exceeded, rate_limited) and auth
 * statuses (401/403, 404) to specific localized guidance.
 *
 *
 * @param error The thrown error or API response error.
 * @param language User interface language for translation; defaults to "en".
 * @returns Translated user-facing error message.
 */
export function userFacingErrorMessage(error: unknown, language: Language = "en"): string {
  const status = errorStatus(error);
  if (status !== undefined && status >= 500) {
    return translate(language, genericErrorMessage);
  }

  const code = errorCode(error);
  if (code && genericErrorCodes[code]) {
    return translate(language, genericErrorMessage);
  }
  if (code && publicMessages[code]) return translate(language, publicMessages[code]);

  if (status === 401 || status === 403) {
    return translate(language, "Your session no longer has access to this workspace.");
  }
  if (status === 404) return translate(language, "That item is no longer available.");
  return translate(language, genericErrorMessage);
}
