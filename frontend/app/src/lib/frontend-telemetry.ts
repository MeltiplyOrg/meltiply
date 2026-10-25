export const frontendTelemetryEvent = "meltiply:frontend-telemetry";

type FrontendTelemetryKind = "api-error" | "frontend-error" | "unknown-contract-value";

export interface FrontendTelemetryDetail {
  code?: string;
  configurationKey?: string;
  configurationSource?: string;
  configurationState?: string;
  diagnosticCode?: string;
  field?: string;
  kind: FrontendTelemetryKind;
  requestId?: string | null;
  retryable?: boolean;
  status?: number;
  valueHash?: string;
  valueType?: string;
}

/**
 * Sanitizes a field or identifier name for safe telemetry transport,
 * replacing non-alphanumeric characters with underscores and capping at 64 chars.
 *
 * @param field Field name string.
 * @returns Sanitized field string.
 */
function safeField(field: string): string {
  return field.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64);
}

/**
 * Validates and limits an uppercase environment or configuration variable key (e.g. `APP_URL`).
 *
 * @param key Candidate configuration key string.
 * @returns Valid uppercase key string, or `undefined` if malformed.
 */
function safeConfigurationKey(key: string): string | undefined {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(key) ? key : undefined;
}

/**
 * Returns a simplified, safe string description of a value's runtime type (null, array, or typeof).
 *
 * @param value Value to inspect.
 * @returns Type descriptor string (e.g. "string", "null", "array", "number").
 */
function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Computes a 32-bit FNV-1a hex hash of an arbitrary input string (truncated to 128 chars).
 * Allows logging diagnostic fingerprints of unknown values or errors without exposing raw PII.
 *
 * @param value String value to hash.
 * @returns 8-character lowercase hex hash string, or `undefined` if input is empty or non-string.
 */
function valueHash(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;

  let hash = 2166136261;
  for (const character of value.slice(0, 128)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Validates that an HTTP status is an integer within the standard 100-599 range.
 *
 * @param status Candidate HTTP status.
 * @returns Bounded status number or `undefined`.
 */
function boundedStatus(status: number | undefined): number | undefined {
  return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/**
 * Validates a hex hash string, verifying length between 8 and 64 hex characters.
 *
 * @param hash Candidate hash string.
 * @returns Lowercase sanitized hash or `undefined`.
 */
function boundedHash(hash: string | undefined): string | undefined {
  return hash && /^[0-9a-f]{8,64}$/i.test(hash) ? hash.slice(0, 64).toLowerCase() : undefined;
}

/**
 * Reports an unhandled client exception or UI error as a telemetry event.
 * Hashes the error message to protect user data while categorizing by error constructor name.
 *
 * @param error Thrown exception or error reason.
 * @param context Context tag identifying where the error occurred (e.g. "window-error", "auth-refresh").
 */
export function reportFrontendError(error: unknown, context: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "UnknownError";

  reportFrontendTelemetry({
    field: context,
    kind: "frontend-error",
    valueHash: valueHash(message),
    valueType: name,
  });
}

let globalLoggingInstalled = false;

/**
 * Attaches global window error and unhandled promise rejection listeners.
 * Ensures uncaught browser runtime errors are captured and dispatched through
 * frontend telemetry exactly once per session.
 */
export function installFrontendErrorLogging(): void {
  if (globalLoggingInstalled || typeof window === "undefined") return;
  globalLoggingInstalled = true;
  window.addEventListener("error", (event) => {
    reportFrontendError(event.error ?? event.message, "window-error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportFrontendError(event.reason, "unhandled-rejection");
  });
}

/**
 * Sanitizes and dispatches a telemetry payload both locally via window CustomEvent
 * and remotely to the Worker endpoint `POST /__frontend-telemetry`.
 * Strips sensitive data, enforces strict field length limits, and uses keepalive fetch.
 *
 * @param detail Telemetry event detail containing bounded fields, codes, or hashes.
 */
export function reportFrontendTelemetry(detail: FrontendTelemetryDetail): void {
  if (typeof window === "undefined") return;

  const redacted: FrontendTelemetryDetail = { kind: detail.kind };
  if (detail.code) redacted.code = safeField(detail.code);
  const configurationKey = detail.configurationKey
    ? safeConfigurationKey(detail.configurationKey)
    : undefined;
  if (configurationKey) redacted.configurationKey = configurationKey;
  if (detail.configurationSource)
    redacted.configurationSource = safeField(detail.configurationSource);
  if (detail.configurationState) redacted.configurationState = safeField(detail.configurationState);
  if (detail.diagnosticCode) redacted.diagnosticCode = safeField(detail.diagnosticCode);
  if (detail.field) redacted.field = safeField(detail.field);
  if (detail.requestId) redacted.requestId = detail.requestId.slice(0, 128);
  if (detail.retryable !== undefined) redacted.retryable = detail.retryable === true;
  const status = boundedStatus(detail.status);
  if (status !== undefined) redacted.status = status;
  const hash = boundedHash(detail.valueHash);
  if (hash) redacted.valueHash = hash;
  if (detail.valueType) redacted.valueType = safeField(detail.valueType);

  window.dispatchEvent(
    new CustomEvent(frontendTelemetryEvent, {
      detail: redacted,
    }),
  );

  const wireDetail = { ...redacted };
  delete wireDetail.requestId;
  try {
    void globalThis
      .fetch("/__frontend-telemetry", {
        body: JSON.stringify(wireDetail),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        method: "POST",
      })
      .catch(() => undefined);
  } catch {
    // Telemetry is best-effort and must never affect the caller.
  }
}

/**
 * Convenience helper to report an HTTP API failure with structured status and request IDs.
 *
 * @param input Object containing error code, request ID, retryability flag, and HTTP status code.
 */
export function reportFrontendApiError(input: {
  code: string;
  requestId: string | null;
  retryable: boolean;
  status: number;
}): void {
  reportFrontendTelemetry({ kind: "api-error", ...input });
}

/**
 * Reports unrecognized enum variants or response fields that diverge from the OpenAPI contract.
 * Hashes the unexpected value and records its type to diagnose schema drift.
 *
 * @param field Name of the contract field containing the unrecognized variant.
 * @param value The actual received value.
 */
export function reportUnknownContractValue(field: string, value: unknown): void {
  reportFrontendTelemetry({
    field,
    kind: "unknown-contract-value",
    valueHash: valueHash(value),
    valueType: valueType(value),
  });
}
