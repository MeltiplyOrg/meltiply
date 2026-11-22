import { errorMessage } from "@meltiply/domain";

import { applyAuthJwt } from "./auth-token";

const unsafeFieldCharactersPattern = /[^a-zA-Z0-9_.-]/g;
const configurationKeyPattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const hashPattern = /^[0-9a-f]{8,64}$/i;

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
  stack?: string;
  status?: number;
  valueHash?: string;
  valueType?: string;
}

const maximumStackCharacters = 1_500;

function frameLines(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const frames = stack.split("\n").filter((line) => /^\s*at\s/.test(line));
  if (frames.length === 0) return undefined;
  return frames.join("\n").slice(0, maximumStackCharacters);
}

function safeField(field: string): string {
  return field.replace(unsafeFieldCharactersPattern, "_").slice(0, 64);
}

function safeConfigurationKey(key: string): string | undefined {
  return configurationKeyPattern.test(key) ? key : undefined;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function valueHash(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;

  let hash = 2166136261;
  for (const character of value.slice(0, 128)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function boundedStatus(status: number | undefined): number | undefined {
  return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function boundedHash(hash: string | undefined): string | undefined {
  return hash && hashPattern.test(hash) ? hash.slice(0, 64).toLowerCase() : undefined;
}

export function reportFrontendError(error: unknown, context: string): void {
  const message = errorMessage(error, String(error));
  const name = error instanceof Error ? error.name : "UnknownError";
  const stack = error instanceof Error ? frameLines(error.stack) : undefined;

  reportFrontendTelemetry({
    field: context,
    kind: "frontend-error",
    ...(stack ? { stack } : {}),
    valueHash: valueHash(message),
    valueType: name,
  });
}

let globalLoggingInstalled = false;

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
  if (detail.stack) redacted.stack = detail.stack.slice(0, maximumStackCharacters);
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
    const headers = new Headers({ "Content-Type": "application/json" });
    applyAuthJwt(headers);
    void globalThis
      .fetch("/__frontend-telemetry", {
        body: JSON.stringify(wireDetail),
        credentials: "same-origin",
        headers,
        keepalive: true,
        method: "POST",
      })
      .catch(() => undefined);
  } catch {
    return;
  }
}

export function reportFrontendApiError(input: {
  code: string;
  requestId: string | null;
  retryable: boolean;
  status: number;
}): void {
  reportFrontendTelemetry({ kind: "api-error", ...input });
}

export function reportUnknownContractValue(field: string, value: unknown): void {
  reportFrontendTelemetry({
    field,
    kind: "unknown-contract-value",
    valueHash: valueHash(value),
    valueType: valueType(value),
  });
}
