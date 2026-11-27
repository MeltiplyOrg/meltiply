const errorNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const fingerprintPattern = /^[0-9a-f]{16}$/;

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

export function sanitizeErrorText(text: string, max: number): string {
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

export function serializeError(cause: unknown, depth: number, seen: Set<unknown>): SerializedError {
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
