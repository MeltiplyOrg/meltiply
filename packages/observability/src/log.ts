const requestIdPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const traceparentPattern = /^00-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i;
const errorNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const fingerprintPattern = /^[0-9a-f]{16}$/;
const messageSeparatorsPattern = /_+/g;

const sensitiveKey = /authorization|cookie|email|password|secret|signed.?url|token|upload.?url/i;
const credentialPair =
  /\b(authorization|access_token|refresh_token|token|password|client_secret|secret|code|state)["']?\s*[=:]\s*(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s&"',}\]]+)/gi;
const bearerToken = /\bBearer\s+(?!\[REDACTED\])[^\s&"',}\]]+/gi;
const httpUrl = /https?:\/\/[^\s"'<>(){}]+/gi;
const maxCauseDepth = 4;
const maxErrorText = 512;
const maxErrorStack = 4_096;
const maxJsonDepth = 6;
const maxJsonEntries = 50;
const maxJsonString = 2_048;
let logSamplingRate = 1;

/** Sets the info/debug sampling rate, clamped to [0, 1]; missing or unparseable input restores 1. */
export function configureLogSampling(rate: string | number | undefined): void {
  const parsed = typeof rate === "string" && rate.trim() !== "" ? Number(rate) : rate;
  logSamplingRate =
    typeof parsed === "number" && Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
}

export interface LogContext {
  environment: string;
  job_id?: string;
  request_id?: string;
  route?: string;
  service: string;
  trace_id: string;
  user_id?: string;
  version: string;
  workflow_id?: string;
}

export type RetryClass =
  | "client_retry"
  | "none"
  | "platform_retry"
  | "provider_backoff"
  | "queue_backoff"
  | "reconciliation"
  | "workflow_backoff";

export interface LogFields extends Record<string, unknown> {
  error_code?: string;
  event: string;
  job?: string;
  latency_ms?: number;
  outcome: number | string;
  provider?: string;
  retry_class: RetryClass;
}

/** The incoming request ID when it is 8-128 safe characters, otherwise a fresh UUID. */
export function createRequestId(incoming?: string | null): string {
  const normalized = incoming?.trim();
  if (normalized && requestIdPattern.test(normalized)) {
    return normalized;
  }
  return crypto.randomUUID();
}

/** The W3C `traceparent` trace ID when valid and non-zero, otherwise `createRequestId(fallback)`. */
export function createTraceId(traceparent?: string | null, fallback?: string): string {
  const match = traceparentPattern.exec(traceparent?.trim() ?? "");
  const traceId = match?.[1];
  const parentId = match?.[2];
  if (
    traceId &&
    traceId !== "00000000000000000000000000000000" &&
    parentId &&
    parentId !== "0000000000000000"
  ) {
    return traceId.toLowerCase();
  }
  return createRequestId(fallback);
}

export function elapsedMilliseconds(startedAt: number, finishedAt = performance.now()): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return 0;
  return Math.round(Math.max(0, finishedAt - startedAt) * 100) / 100;
}

interface SerializedError {
  cause?: unknown;
  fingerprint?: string;
  message: string;
  name: string;
  stack?: string;
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sanitizeErrorText(text: string, max: number): string {
  const scrubbed = text
    .replace(httpUrl, (url) => {
      try {
        const parsed = new URL(url);
        if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) return url;
        return `${parsed.origin}${parsed.pathname}${parsed.search || parsed.hash ? "?[REDACTED]" : ""}`;
      } catch {
        return "[REDACTED URL]";
      }
    })
    .replace(bearerToken, "Bearer [REDACTED]")
    .replace(credentialPair, (_match, key: string) => `${key}=[REDACTED]`);
  return bounded(scrubbed, max);
}

function readSafely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function sanitizeEntries(
  value: object,
  seen: Set<unknown>,
  depth: number,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  let index = 0;
  for (const key of Object.keys(value)) {
    if (index >= maxJsonEntries) {
      output["…"] = "additional keys truncated";
      break;
    }
    index += 1;
    output[key] = sensitiveKey.test(key)
      ? "[REDACTED]"
      : readSafely(() => toJsonSafe(Reflect.get(value, key), seen, depth - 1), "[Unreadable]");
  }
  return output;
}

function toJsonSafe(value: unknown, seen: Set<unknown>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeErrorText(value, maxJsonString);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return bounded(value.toString(), 64);
  if (typeof value === "function") return `[Function ${bounded(value.name || "anonymous", 64)}]`;
  if (typeof value === "symbol") return "[Symbol]";
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : "[Invalid Date]";
  }
  if (value instanceof Error) return serializeError(value, maxJsonDepth - depth, seen);
  if (seen.has(value)) return "[Circular]";
  if (depth <= 0) return "[Truncated]";
  seen.add(value);
  try {
    if (!Array.isArray(value)) return sanitizeEntries(value, seen, depth);
    const items = value.slice(0, maxJsonEntries).map((item) => toJsonSafe(item, seen, depth - 1));
    if (value.length > maxJsonEntries) items.push(`[+${value.length - maxJsonEntries} items]`);
    return items;
  } finally {
    seen.delete(value);
  }
}

/** Bounded, cycle-safe JSON copy with sensitive keys, credentials, and URL queries redacted. */
export function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return sanitizeEntries(record, new Set([record]), maxJsonDepth);
}

function isErrorRecord(value: unknown): value is SerializedError {
  return readSafely(
    () =>
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      typeof value.name === "string" &&
      "message" in value &&
      typeof value.message === "string",
    false,
  );
}

const unreadable = Symbol("unreadable");

function serializeError(cause: unknown, depth: number, seen: Set<unknown>): SerializedError {
  if (!(cause instanceof Error) && !isErrorRecord(cause)) {
    return serializeOpaque(cause, depth);
  }
  if (depth >= maxCauseDepth) {
    return { message: "[cause chain truncated]", name: "TruncatedCause" };
  }
  if (seen.has(cause)) {
    return { message: "[circular cause reference]", name: "CircularCause" };
  }
  seen.add(cause);
  const name = readSafely(
    () => (errorNamePattern.test(cause.name) ? cause.name : "Error"),
    "UnreadableError",
  );
  const rawMessage = readSafely(
    () => (typeof cause.message === "string" ? cause.message : String(cause.message)),
    "[unreadable message]",
  );
  const serialized: SerializedError = {
    message: sanitizeErrorText(rawMessage, maxErrorText),
    name,
  };
  const stack = readSafely(() => cause.stack, undefined);
  if (typeof stack === "string" && stack !== "") {
    serialized.stack = sanitizeErrorText(stack, maxErrorStack);
  }
  const nested = readSafely<unknown>(() => cause.cause, unreadable);
  if (nested === unreadable) {
    serialized.cause = "[unreadable cause]";
  } else if (nested !== undefined) {
    serialized.cause = serializeError(nested, depth + 1, seen);
  }
  if (depth === 0) {
    const carried =
      cause instanceof Error ? undefined : readSafely(() => cause.fingerprint, undefined);
    serialized.fingerprint =
      typeof carried === "string" && fingerprintPattern.test(carried)
        ? carried
        : fingerprintError(name, rawMessage);
  }
  seen.delete(cause);
  return serialized;
}

function serializeOpaque(cause: unknown, depth: number): SerializedError {
  let name = "UnknownError";
  let rawMessage: string;
  if (cause !== null && typeof cause === "object") {
    name = readSafely(() => {
      const tag = "_tag" in cause ? cause._tag : undefined;
      return typeof tag === "string" && errorNamePattern.test(tag) ? tag : "UnknownError";
    }, "UnreadableError");
    rawMessage =
      name === "UnknownError" ? "[non-Error thrown object]" : `[non-Error thrown object ${name}]`;
  } else {
    rawMessage = readSafely(() => String(cause), "[unreadable thrown value]");
  }
  const serialized: SerializedError = {
    message: sanitizeErrorText(rawMessage, maxErrorText),
    name,
  };
  if (depth === 0) serialized.fingerprint = fingerprintError(name, rawMessage);
  return serialized;
}

function fingerprintError(name: string, message: string): string {
  const input = `${name}\0${message}`;
  let first = 2166136261;
  let second = 3335557771;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 2246822519);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Loggable `error` envelope. Reads only name, message, stack, and cause (never arbitrary
 * properties, which can carry provider payloads), scrubs credentials, bounds the cause chain,
 * and adds a stable fingerprint of the unredacted name and message.
 */
export function errorDiagnostic(cause: unknown): { error: SerializedError } {
  return { error: serializeError(cause, 0, new Set()) };
}

function deriveMessage(fields: LogFields): string {
  const explicit = fields.message;
  if (typeof explicit === "string" && explicit !== "") {
    return sanitizeErrorText(explicit, maxJsonString);
  }
  return fields.event.replace(messageSeparatorsPattern, " ").trim() || "log event";
}

type LogLevel = "debug" | "error" | "info" | "warn";

/**
 * Writes one sanitized JSON line to `console[level]` (and to the local Loki receiver when
 * `environment` is `local`). `fields.message` and `fields.error` are hoisted; every other field
 * lands under `context`. Info and debug lines are sampled per trace; warn and error always emit.
 */
export function log(level: LogLevel, context: LogContext, fields: LogFields): void {
  if (!shouldEmitLog(level, context.trace_id)) return;

  const { error, ...contextFields } = fields;
  delete contextFields.message;
  if (context.route !== undefined) contextFields.route = context.route;
  const payload = {
    context: sanitizeRecord(contextFields),
    environment: context.environment,
    error: error === undefined ? undefined : serializeError(error, 0, new Set()),
    job_id: context.job_id,
    level,
    message: deriveMessage(fields),
    request_id: context.request_id,
    service: context.service,
    timestamp: new Date().toISOString(),
    trace_id: context.trace_id,
    user_id: context.user_id,
    version: context.version,
    workflow_id: context.workflow_id,
  };

  const line = JSON.stringify(payload);
  console[level](line);
  if (context.environment === "local") {
    void shipLogToLoki(level, context, line);
  }
}

function shouldEmitLog(level: LogLevel, traceId: string): boolean {
  if (level === "warn" || level === "error") return true;
  if (logSamplingRate <= 0) return false;
  if (logSamplingRate >= 1) return true;

  let hash = 2166136261;
  for (let index = 0; index < traceId.length; index++) {
    hash ^= traceId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296 < logSamplingRate;
}

async function shipLogToLoki(level: LogLevel, context: LogContext, line: string): Promise<void> {
  const stream = {
    environment: context.environment,
    job: "meltiply-worker",
    level,
    service: context.service,
  };
  const timestampNanoseconds = String(BigInt(Date.now()) * 1_000_000n);
  await fetch("http://127.0.0.1:3100/loki/api/v1/push", {
    body: JSON.stringify({ streams: [{ stream, values: [[timestampNanoseconds, line]] }] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).catch(() => undefined);
}
