const sensitiveKey = /authorization|cookie|email|password|secret|signed.?url|token|upload.?url/i;
const signedUrl = /^https?:\/\/[^?\s]+\?(?:[^#\s]*&)?(?:X-Amz-|X-Goog-|sig=)/i;
// Credential-looking `key=value`/`key: "value"` pairs (bare or JSON-quoted key)
// scrubbed from error text; `code`/`state` are OAuth secrets in this codebase.
const secretPair =
  /\b(authorization|access_token|refresh_token|token|password|client_secret|secret|code|state)["']?\s*[=:]\s*(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s&"',}\]]+)/gi;
const bearerToken = /\bBearer\s+(?!\[REDACTED\])[^\s&"',}\]]+/gi;
const httpUrl = /https?:\/\/[^\s"'<>(){}]+/gi;
// Serializer bounds keep one JSON log line small and resistant to hostile throws.
const maxCauseDepth = 4;
const maxErrorText = 512;
const maxErrorStack = 4_096;
const maxJsonDepth = 6;
const maxJsonEntries = 50;
const maxJsonString = 2_048;
let logSamplingRate = 1;

/**
 * Configures the global log sampling rate (between 0.0 and 1.0) for debug and info messages.
 * Warn and error levels bypass sampling completely and are always logged.
 *
 * @param rate - Sampling rate number or string (e.g. 0.5, "1.0"); defaults to 1 if invalid or undefined.
 */
export function configureLogSampling(rate: string | number | undefined): void {
  if (rate === undefined) {
    logSamplingRate = 1;
    return;
  }

  const parsed = typeof rate === "string" && rate.trim() !== "" ? Number(rate) : rate;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    logSamplingRate = 1;
    return;
  }
  logSamplingRate = Math.min(1, Math.max(0, parsed));
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

/**
 * Resolves or generates a bounded, safe request ID string.
 * Validates incoming ID against `^[A-Za-z0-9._:-]{8,128}$`, generating a UUIDv4 fallback if invalid or absent.
 *
 * @param incoming - Optional incoming request ID header value.
 * @returns Validated request ID string or newly generated random UUID.
 */
export function createRequestId(incoming?: string | null): string {
  const normalized = incoming?.trim();
  if (normalized && /^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) {
    return normalized;
  }
  return crypto.randomUUID();
}

/**
 * Extracts a W3C traceparent trace ID or falls back to creating a request ID.
 * Parses standard `00-<32-hex-trace-id>-<16-hex-parent-id>-<flags>` format, rejecting all-zero values.
 *
 * @param traceparent - Optional W3C traceparent header string.
 * @param fallback - Optional fallback identifier if traceparent is invalid.
 * @returns 32-character lowercase hex trace ID, or a fallback request ID.
 */
export function createTraceId(traceparent?: string | null, fallback?: string): string {
  const match = /^00-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i.exec(traceparent?.trim() ?? "");
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

/**
 * Calculates duration in milliseconds between a start time and finish time, rounded to two decimal places.
 * Used for high-precision latency instrumentation without emitting negative numbers or NaN.
 *
 * @param startedAt - High-resolution timestamp from `performance.now()`.
 * @param finishedAt - End timestamp, defaulting to current `performance.now()`.
 * @returns Elapsed duration in milliseconds (clamped to >= 0).
 */
export function elapsedMilliseconds(startedAt: number, finishedAt = performance.now()): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return 0;
  return Math.round(Math.max(0, finishedAt - startedAt) * 100) / 100;
}

/**
 * Loggable projection of one thrown value in an `error` envelope.
 * `fingerprint` is present only on the outermost error computed by
 * `errorDiagnostic`; nested entries omit it. Non-Error throws retain a safe
 * type/tag only, never an opaque provider payload.
 */
export interface SerializedError {
  cause?: unknown;
  fingerprint?: string;
  message: string;
  name: string;
  stack?: string;
}

/** Shape returned by `errorDiagnostic`: the `error` envelope callers spread into `LogFields`. */
export interface ErrorDiagnostic {
  error: SerializedError;
}

/**
 * Truncates a string to `max` characters with a single ellipsis marker so log
 * payloads stay bounded regardless of input size.
 */
function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Scrubs credential-looking text from free-form error messages and stacks.
 * HTTP(S) URL credentials, queries, and fragments are removed; bearer strings
 * and known secret key/value pairs are masked. Already-redacted markers remain
 * unchanged when an upstream diagnostic passes through the logger again.
 *
 * @param text - Raw error message or stack text.
 * @param max - Maximum retained length.
 * @returns Sanitized, length-bounded text safe to persist in logs.
 */
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
    .replace(secretPair, (_match, key: string) => `${key}=[REDACTED]`);
  return bounded(scrubbed, max);
}

/**
 * Builds a JSON-safe, credential-scrubbed copy of event context. Cycles and
 * excessive depth/entries are bounded; unsupported values and unreadable
 * getters become markers so logging cannot fail on ordinary thrown payloads.
 *
 * @param value - Arbitrary untrusted value.
 * @param seen - Ancestor objects for cycle detection.
 * @param depth - Remaining object/array recursion budget.
 * @returns Plain JSON-serializable value.
 */
function toJsonSafe(value: unknown, seen: Set<unknown>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return sanitizeErrorText(value, maxJsonString);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return bounded(value.toString(), 64);
  if (typeof value === "function") {
    return `[Function ${bounded(String(value.name ?? "anonymous"), 64)}]`;
  }
  if (typeof value === "symbol") return "[Symbol]";
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : "[Invalid Date]";
  }
  if (value instanceof Error) {
    // Errors nested inside arbitrary payloads serialize through the same
    // bounded envelope path rather than being flattened to "{}".
    return serializeError(value, maxJsonDepth - depth, seen);
  }
  if (seen.has(value)) return "[Circular]";
  if (depth <= 0) return "[Truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, maxJsonEntries).map((item) => toJsonSafe(item, seen, depth - 1));
      if (value.length > maxJsonEntries) {
        items.push(`[+${value.length - maxJsonEntries} items]`);
      }
      return items;
    }
    const output: Record<string, unknown> = {};
    let index = 0;
    for (const key of Object.keys(value)) {
      if (index >= maxJsonEntries) {
        output["…"] = "additional keys truncated";
        break;
      }
      index += 1;
      if (sensitiveKey.test(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      try {
        output[key] = toJsonSafe(Reflect.get(value, key), seen, depth - 1);
      } catch {
        output[key] = "[Unreadable]";
      }
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

/**
 * Recognizes already-serialized errors without trusting additional properties.
 * Getter failures leave the value opaque; only error channels are logged.
 */
function isErrorRecord(value: unknown): value is SerializedError {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      "name" in value &&
      typeof value.name === "string" &&
      "message" in value &&
      typeof value.message === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Serializes one thrown value into a bounded, credential-scrubbed
 * `SerializedError`. Only the `name`/`message`/`stack`/`cause` channels are
 * read — arbitrary own properties of opaque exceptions are never copied, so
 * provider payloads carrying tokens cannot leak through the envelope. Every
 * property read is guarded (getters may throw), the cause chain is capped at
 * `maxCauseDepth`, and revisiting an ancestor emits a `CircularCause` marker.
 * A 16-hex FNV-1a `fingerprint` over `name\0message` (raw, pre-redaction) is
 * attached at depth 0 for deterministic error grouping.
 *
 * @param cause - Unknown thrown value.
 * @param depth - Consumed nested-cause recursion budget (0 = top level).
 * @param seen - Ancestor errors already on this cause chain.
 * @returns Sanitized `SerializedError` envelope entry.
 */
function serializeError(cause: unknown, depth: number, seen: Set<unknown>): SerializedError {
  if (cause instanceof Error || isErrorRecord(cause)) {
    if (depth >= maxCauseDepth) {
      return { message: "[cause chain truncated]", name: "TruncatedCause" };
    }
    if (seen.has(cause)) {
      return {
        message: "[circular cause reference]",
        name: "CircularCause",
      };
    }
    seen.add(cause);
    // Each channel read is isolated: a throwing getter degrades that channel
    // only, never the whole serialization.
    let name = "Error";
    try {
      if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(cause.name)) {
        name = cause.name;
      }
    } catch {
      name = "UnreadableError";
    }
    let rawMessage = "";
    try {
      rawMessage = typeof cause.message === "string" ? cause.message : String(cause.message);
    } catch {
      rawMessage = "[unreadable message]";
    }
    const serialized: SerializedError = {
      message: sanitizeErrorText(rawMessage, maxErrorText),
      name,
    };
    try {
      if (typeof cause.stack === "string" && cause.stack !== "") {
        serialized.stack = sanitizeErrorText(cause.stack, maxErrorStack);
      }
    } catch {
      // Stack is optional; a throwing getter simply omits it.
    }
    try {
      if (cause.cause !== undefined) {
        serialized.cause = serializeError(cause.cause, depth + 1, seen);
      }
    } catch {
      serialized.cause = "[unreadable cause]";
    }
    if (depth === 0) {
      if (!(cause instanceof Error)) {
        try {
          if (typeof cause.fingerprint === "string" && /^[0-9a-f]{16}$/.test(cause.fingerprint)) {
            serialized.fingerprint = cause.fingerprint;
          }
        } catch {
          // A malformed cached fingerprint cannot hide the current failure.
        }
      }
      serialized.fingerprint ??= fingerprintError(name, rawMessage);
    }
    seen.delete(cause);
    return serialized;
  }

  // Opaque objects retain a safe tag only; their properties can contain raw
  // provider payloads or OAuth codes. Primitive throws retain scrubbed text.
  let name = "UnknownError";
  let rawMessage = "";
  if (cause !== null && typeof cause === "object") {
    try {
      const tag = "_tag" in cause ? cause._tag : undefined;
      if (typeof tag === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(tag)) {
        name = tag;
      }
    } catch {
      name = "UnreadableError";
    }
    rawMessage =
      name === "UnknownError" ? "[non-Error thrown object]" : `[non-Error thrown object ${name}]`;
  } else {
    try {
      rawMessage = String(cause);
    } catch {
      rawMessage = "[unreadable thrown value]";
    }
  }
  const serialized: SerializedError = {
    message: sanitizeErrorText(rawMessage, maxErrorText),
    name,
  };
  if (depth === 0) {
    serialized.fingerprint = fingerprintError(name, rawMessage);
  }
  return serialized;
}

/**
 * Computes the deterministic 64-bit FNV-1a fingerprint (two interleaved 32-bit
 * lanes) over `name\0message` before redaction, so equivalent failures retain
 * a stable grouping key without storing the original credential-bearing text.
 *
 * @param name - Normalized error name.
 * @param message - Raw (unsanitized) error message.
 * @returns 16 lowercase hex characters.
 */
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
 * Computes the `error` envelope for logs: a bounded `SerializedError`
 * (name/message/stack?/cause?) plus a deterministic `fingerprint`. Spread into
 * `LogFields` so `log()` hoists the entry under the top-level `error` key.
 *
 * @param cause - Unknown error or thrown value.
 * @returns `{ error: SerializedError }` ready to merge into log fields.
 */
export function errorDiagnostic(cause: unknown): ErrorDiagnostic {
  return { error: serializeError(cause, 0, new Set()) };
}

/**
 * Derives the human-readable `message` for a log line: an explicit
 * `fields.message` wins, otherwise the snake_case `event` name is rendered
 * with underscores replaced by spaces (e.g. `job_completed` → "job completed").
 */
function deriveMessage(fields: LogFields): string {
  const explicit = fields.message;
  if (typeof explicit === "string" && explicit !== "") {
    return sanitizeErrorText(explicit, maxJsonString);
  }
  const event = typeof fields.event === "string" ? fields.event : "log_event";
  return event.replace(/_+/g, " ").trim() || "log event";
}
/**
 * Recursively redacts sensitive keys and signed URLs from objects, arrays, and primitive values.
 * Masks fields matching password/token/secret patterns with `[REDACTED]` and removes query signatures from URLs.
 *
 * @param value - Arbitrary data payload to sanitize.
 * @param key - Field key name if called recursively on object properties.
 * @returns Sanitized value safe for structured logging or telemetry export.
 */
export function redact(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string" && signedUrl.test(value)) {
    return `${value.split("?")[0]}?[REDACTED]`;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

/**
 * Emits one structured log line: a single JSON string via `console[level]`, and
 * the identical line shipped to Loki in local/test environments. The payload
 * carries `timestamp`, `level`, `service`, `trace_id`, and `environment` plus
 * `version`/`request_id`/`job_id`/`workflow_id`/`user_id` when present, a
 * human-readable `message` (explicit `fields.message` or the event name with
 * underscores rendered as spaces), an optional serialized `error` envelope,
 * and a `context` object holding `route` plus every remaining event field.
 * Event fields and exception text are sanitized before encoding; warn/error
 * always emit while info/debug retain trace-based sampling.
 *
 * @param level - Log severity level ("debug" | "info" | "warn" | "error").
 * @param context - Execution context: environment, service, trace ID, route,
 *   and optional request/job/workflow/user correlation IDs.
 * @param fields - Event-specific fields; `message` and `error` are hoisted to
 *   the top level, everything else lands under `context`.
 */
export function log(
  level: "debug" | "error" | "info" | "warn",
  context: LogContext,
  fields: LogFields,
): void {
  if (!shouldEmitLog(level, context.trace_id)) return;

  const { error, ...contextFields } = fields;
  delete contextFields.message;
  if (context.route !== undefined) contextFields.route = context.route;
  const safeContext = toJsonSafe(contextFields, new Set(), maxJsonDepth) as Record<string, unknown>;

  const payload = {
    context: safeContext,
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
  // Local/test only: ship the same redacted line to Loki so Explore shows
  // real Worker logs correlated by trace_id. Staging/production stay console-only.
  if (context.environment === "local" || context.environment === "test") {
    void shipLogToLoki(level, payload, line);
  }
}

/**
 * Determines whether a log record should be emitted based on severity level and trace ID hash.
 * Warn and error levels always return true; debug and info use deterministic FNV-1a hash of traceId vs sample rate.
 *
 * @param level - Log level being evaluated.
 * @param traceId - Trace ID string used for deterministic hash sampling.
 * @returns True if the log message should be emitted, false if dropped by sampling.
 */
function shouldEmitLog(level: "debug" | "error" | "info" | "warn", traceId: string): boolean {
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

/**
 * Best-effort asynchronous exporter that pushes the exact console JSON line to the local Loki receiver at :3100.
 * Streams retain low-cardinality service/environment labels; trace IDs remain
 * in the JSON line for correlation. Offline Loki never interrupts the caller.
 *
 * @param level - Log severity label.
 * @param payload - Fully redacted log record dictionary (label source).
 * @param line - The identical JSON string emitted to the console.
 */
async function shipLogToLoki(
  level: string,
  payload: Record<string, unknown>,
  line: string,
): Promise<void> {
  try {
    const service = String(payload.service ?? "unknown");
    const environment = String(payload.environment ?? "local");
    const ts = String(BigInt(Date.now()) * 1_000_000n);
    const stream: Record<string, string> = {
      environment,
      job: "meltiply-worker",
      level,
      service,
    };
    await fetch("http://127.0.0.1:3100/loki/api/v1/push", {
      body: JSON.stringify({
        streams: [
          {
            stream,
            values: [[ts, line]],
          },
        ],
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch {
    // Best-effort; never fails the caller if Loki is offline.
  }
}

export interface OtlpSpanInput {
  attributes?: Record<string, unknown>;
  endTimeMs: number;
  name: string;
  parentSpanId?: string;
  service: string;
  spanId?: string;
  startTimeMs: number;
  status: "error" | "ok";
  traceId: string;
}

/**
 * Normalizes a UUID string to a 32-character lowercase hex string suitable for OTLP trace ID encoding.
 * Strips hyphens and falls back to deterministic hash padding if input is not standard 32-hex.
 *
 * @param uuid - Raw UUID string (e.g. standard hyphenated UUID).
 * @returns 32-character lowercase hexadecimal string.
 */
function uuidToHex32(uuid: string): string {
  const clean = uuid.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(clean)) return clean;
  let hash = 0;
  for (let i = 0; i < uuid.length; i++) {
    hash = (hash << 5) - hash + uuid.charCodeAt(i);
    hash |= 0;
  }
  const base = Math.abs(hash).toString(16).padStart(8, "0");
  return (base + clean + "0".repeat(32)).replace(/[^0-9a-f]/g, "0").slice(0, 32);
}

/**
 * Hashes an arbitrary string to a 16-character hex string for OTLP 64-bit span IDs.
 *
 * @param value - String identifier or composite span name.
 * @returns 16-character hexadecimal span ID string.
 */
function stringToHex16(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(16, "0").slice(0, 16);
}

/**
 * Normalizes a span identifier to a 16-character hex string for OpenTelemetry 64-bit span IDs.
 *
 * Preserves already-valid 16-character hex strings (such as Effect native span IDs) in lowercase,
 * and falls back to deterministic hashing for arbitrary non-hex strings.
 *
 * @param value - String identifier, Effect span ID, or composite name.
 * @returns 16-character hexadecimal span ID string.
 */
function toHex16SpanId(value: string): string {
  if (/^[0-9a-f]{16}$/i.test(value)) {
    return value.toLowerCase();
  }
  return stringToHex16(value);
}

/**
 * Best-effort OTLP/HTTP JSON span export for local/test only.
 * Sanitizes span attributes using recursive redaction before serializing to OTLP JSON format
 * and posting to the Compose Tempo receiver at 127.0.0.1:4318.
 * Staging and production are a zero-cost no-op so Workers never depend on the local stack.
 *
 * @param env - Worker environment containing the ENVIRONMENT binding.
 * @param span - Input parameters describing the span timing, status, attributes, and trace IDs.
 */
export async function exportOtlpSpan(
  env: { ENVIRONMENT: string },
  span: OtlpSpanInput,
): Promise<void> {
  if (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test") return;

  const traceIdHex = uuidToHex32(span.traceId);
  const spanIdHex = span.spanId
    ? toHex16SpanId(span.spanId)
    : stringToHex16(`${span.name}-${span.startTimeMs}`);
  const parentSpanIdHex = span.parentSpanId ? toHex16SpanId(span.parentSpanId) : undefined;

  const sanitizedAttributes = (redact(span.attributes ?? {}) as Record<string, unknown>) ?? {};

  const otlpAttributes = Object.entries(sanitizedAttributes).map(([key, val]) => ({
    key,
    value:
      typeof val === "number"
        ? { intValue: val }
        : typeof val === "boolean"
          ? { boolValue: val }
          : {
              stringValue:
                typeof val === "object" && val !== null ? JSON.stringify(val) : String(val ?? ""),
            },
  }));

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: span.service } },
            {
              key: "deployment.environment",
              value: { stringValue: env.ENVIRONMENT },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "meltiply-tracer" },
            spans: [
              {
                attributes: otlpAttributes,
                endTimeUnixNano: String(BigInt(Math.floor(span.endTimeMs)) * 1000000n),
                kind: 1,
                name: span.name,
                parentSpanId: parentSpanIdHex,
                spanId: spanIdHex,
                startTimeUnixNano: String(BigInt(Math.floor(span.startTimeMs)) * 1000000n),
                status: { code: span.status === "ok" ? 1 : 2 },
                traceId: traceIdHex,
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    await fetch("http://127.0.0.1:4318/v1/traces", {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch {
    // Best-effort export; never fails if Tempo is offline.
  }
}

export * from "./effect-logger";
export * from "./effect-tracer";
