import { translate, type Language } from "@/lib/i18n";

const publicMessages: Record<string, string> = {
  active_organization_required: "Choose an active workspace to continue.",
  asset_in_use: "This asset cannot be deleted while it is in use.",
  conflict: "This changed while you were working. Refresh and try again.",
  quota_exceeded: "Your storage or upload quota has been reached.",
  rate_limited: "Too many requests. Wait a moment and try again.",
};

const genericErrorMessage = "An error has occurred.";
const genericErrorCodes = new Set(["dependency_unavailable", "provider_unavailable"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorStatus(error: unknown): number | undefined {
  const status = record(error)?.status;
  return typeof status === "number" ? status : undefined;
}

export function apiErrorCode(error: unknown): string | undefined {
  const code = record(error)?.code;
  return typeof code === "string" ? code : undefined;
}

export function userFacingErrorMessage(error: unknown, language: Language = "en"): string {
  const status = errorStatus(error);
  if (status !== undefined && status >= 500) {
    return translate(language, genericErrorMessage);
  }

  const code = apiErrorCode(error);
  if (code && genericErrorCodes.has(code)) {
    return translate(language, genericErrorMessage);
  }
  if (code && Object.hasOwn(publicMessages, code)) {
    return translate(language, publicMessages[code]);
  }

  if (status === 401 || status === 403) {
    return translate(language, "Your session no longer has access to this workspace.");
  }
  if (status === 404) return translate(language, "That item is no longer available.");
  return translate(language, genericErrorMessage);
}
