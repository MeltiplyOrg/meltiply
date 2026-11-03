import { PLATFORM_IDS } from "@meltiply/domain";
import type { Platform } from "@meltiply/domain";

import {
  isDiagnosticCategory,
  isOperationCategory,
  REPORTING_SCHEMA_VERSION,
  type DeploymentCategory,
  type DiagnosticCategory,
  type DiagnosticReportInput,
  type OperationCategory,
  type UsageEngagement,
  type UsageReportInput,
} from "./contracts";

/**
 * Outbound payload construction and sanitization.
 *
 * Two independent guarantees hold for every payload leaving the installation:
 *
 * 1. Properties are assembled from a fixed allowlist. A caller can only supply a
 *    number, a known enumeration member, or a timestamp; there is no code path
 *    that copies a caller-provided object into the payload.
 * 2. The assembled payload is validated against that allowlist before transport,
 *    so a future edit that adds a property without updating the allowlist fails
 *    the send instead of leaking a name, identifier, URL or free-form message.
 */

/** Event names published in the versioned catalog. */
export const REPORTING_EVENTS = {
  diagnostics: "$exception",
  feedback: "meltiply_feedback_discovery_source",
  usage: "meltiply_usage_daily",
} as const;

/** Stack frames retained on one sanitized exception, outermost last. */
const maximumFrames = 12;

/**
 * Property names permitted on any outbound payload, including the nested
 * structures PostHog requires. The exception schema follows
 * https://posthog.com/docs/error-tracking/installation/manual: each exception
 * carries `type`, `value`, `mechanism` and a `stacktrace` whose frames carry
 * `platform`, `lang`, `function` and optional location fields.
 */
const allowedNestedKeys: Record<string, true> = {
  chunk_id: true,
  colno: true,
  exception_id: true,
  parent_id: true,
  filename: true,
  frames: true,
  function: true,
  handled: true,
  in_app: true,
  lang: true,
  lineno: true,
  mechanism: true,
  module: true,
  platform: true,
  resolved: true,
  stacktrace: true,
  synthetic: true,
  type: true,
  value: true,
  // Per-Platform counter maps are keyed by the fixed Platform roster.
  tiktok: true,
  youtube: true,
  instagram: true,
  facebook: true,
  threads: true,
};

/** Property names permitted on any outbound payload. */
const allowedPropertyNames: Record<string, true> = {
  $exception_level: true,
  $exception_list: true,
  $geoip_disable: true,
  $process_person_profile: true,
  app_version: true,
  channels: true,
  comments: true,
  deployment_category: true,
  diagnostic_category: true,
  diagnostic_handled: true,
  disclosure_version: true,
  distributions: true,
  discovery_source: true,
  engagement: true,
  engagement_as_of: true,
  engagement_coverage: true,
  measured: true,
  missing: true,
  operation_category: true,
  platform: true,
  posts: true,
  publications: true,
  reactions: true,
  report_date: true,
  schema_version: true,
  shares: true,
  views: true,
};

/**
 * Identity- and secret-bearing keys that must never appear anywhere in a
 * payload, including inside a sanitized exception list. The property allowlist
 * already excludes them; this second check catches a value smuggled through a
 * permitted key, e.g. a function name containing a URL or an email address.
 */
const forbiddenValuePatterns: readonly RegExp[] = [
  // Absolute URLs, including signed media and OAuth callback URLs.
  /[a-z][a-z0-9+.-]*:\/\/[^\s"']*/i,
  // Email addresses.
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  // Bearer credentials and credential-shaped key=value pairs.
  /\bBearer\s+\S+/i,
  /\b(?:authorization|access_token|refresh_token|token|password|client_secret|secret|api[_-]?key)\b\s*[=:]\s*\S+/i,
  // UUIDs (Post, Distribution, Channel, Workspace, member and installation ids).
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  // URLs with query strings even without a scheme.
  /\?\S*=\S*/,
];

/** Leaked-value detector applied to every string that reaches a payload. */
export function containsForbiddenValue(value: string): boolean {
  return forbiddenValuePatterns.some((pattern) => pattern.test(value));
}

/**
 * Bounds a counter to a non-negative safe integer.
 *
 * A measurement that is missing, negative, fractional or non-finite is `null`
 * (unknown) rather than `0`, so an unsupported metric is never reported as an
 * observed zero.
 *
 * @param value - Candidate measurement.
 * @returns The integer, or null when the value is not a usable count.
 */
export function boundedCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const integer = Math.floor(value);
  return Number.isSafeInteger(integer) ? integer : null;
}

/**
 * Compacts a per-Platform counter map to supported Platforms with usable counts.
 *
 * @param value - Candidate per-Platform measurements.
 * @returns Ordered entries only for Platforms with a non-null count.
 */
function platformCounts(value: Partial<Record<string, unknown>> | undefined): [Platform, number][] {
  if (!value || typeof value !== "object") return [];
  const entries: [Platform, number][] = [];
  for (const platform of PLATFORM_IDS) {
    const count = boundedCount(value[platform]);
    if (count !== null) entries.push([platform, count]);
  }
  return entries;
}

/** Builds the per-Platform Channel occupancy gauge. */
function channelsProperty(input: UsageReportInput): Record<string, number> | undefined {
  const entries = platformCounts(input.channels);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** Builds the confirmed-publication counters, omitting unknown sections. */
function publicationsProperty(input: UsageReportInput): Record<string, unknown> | undefined {
  const posts = boundedCount(input.publications?.posts);
  const distributions = platformCounts(input.publications?.distributions);
  if (posts === null && distributions.length === 0) return undefined;
  const property: Record<string, unknown> = {};
  if (posts !== null) property.posts = posts;
  if (distributions.length > 0) property.distributions = Object.fromEntries(distributions);
  return property;
}

/**
 * Builds the as-of engagement gauges per Platform.
 *
 * Every metric is an as-of snapshot from the latest eligible stored analytics
 * record per Distribution, so the figures are gauges, not daily deltas. A metric
 * the Provider does not expose stays absent instead of becoming zero.
 */
function engagementProperty(input: UsageReportInput): Record<string, unknown> | undefined {
  if (!input.engagement || typeof input.engagement !== "object") return undefined;
  const property: Record<string, unknown> = {};
  for (const platform of PLATFORM_IDS) {
    const gauge: UsageEngagement | undefined = input.engagement[platform];
    if (!gauge || typeof gauge !== "object") continue;
    const measured: Record<string, number> = {};
    for (const metric of ["views", "reactions", "comments", "shares"] as const) {
      const count = boundedCount(gauge[metric]);
      if (count !== null) measured[metric] = count;
    }
    const distributions = boundedCount(gauge.distributions);
    if (distributions !== null) measured.distributions = distributions;
    if (Object.keys(measured).length > 0) property[platform] = measured;
  }
  return Object.keys(property).length === 0 ? undefined : property;
}

/** Validates the UTC reporting period; a malformed date never becomes a payload. */
function validReportDate(value: string): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

/** Normalizes an ISO timestamp; a malformed value is dropped rather than forwarded. */
function validTimestamp(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** Builds the allowlisted `meltiply_usage_daily` properties. */
export function usageProperties(
  input: UsageReportInput,
  context: { appVersion: string; deploymentCategory: DeploymentCategory },
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    app_version: context.appVersion,
    deployment_category: context.deploymentCategory,
    schema_version: REPORTING_SCHEMA_VERSION,
  };
  const reportDate = validReportDate(input.reportDate);
  if (reportDate) properties.report_date = reportDate;
  const channels = channelsProperty(input);
  if (channels) properties.channels = channels;
  const publications = publicationsProperty(input);
  if (publications) properties.publications = publications;
  const engagement = engagementProperty(input);
  if (engagement) properties.engagement = engagement;
  const asOf = validTimestamp(input.engagementAsOf);
  if (asOf) properties.engagement_as_of = asOf;
  const coverage = input.engagementCoverage;
  if (coverage) {
    const measured = boundedCount(coverage.measured);
    const missing = boundedCount(coverage.missing);
    if (measured !== null || missing !== null) {
      properties.engagement_coverage = {
        ...(measured === null ? {} : { measured }),
        ...(missing === null ? {} : { missing }),
      };
    }
  }
  return properties;
}

/** One sanitized stack frame in PostHog's documented frame schema. */
interface SanitizedFrame {
  readonly filename?: string;
  readonly function: string;
  readonly in_app: true;
  readonly lang: "javascript";
  readonly lineno?: number;
  readonly platform: "custom";
}

/**
 * Sanitizes one stack line into an allowlisted frame.
 *
 * A frame survives only when its function name is a plain identifier and its
 * location is a repository-relative application path. Node-internal frames,
 * `eval` frames, bundled third-party paths, URLs and anything carrying a query
 * string are dropped; the raw stack never leaves this function.
 *
 * @param line - One trimmed stack line.
 * @returns The sanitized frame, or undefined when the frame is unsafe.
 */
function sanitizeFrame(line: string): SanitizedFrame | undefined {
  const match = /^at\s+(?:(.+?)\s+\()?([^()\s]+):(\d+):(\d+)\)?$/.exec(line);
  if (!match) return undefined;
  const [, rawFunction, rawLocation, rawLine] = match;
  const location = rawLocation ?? "";
  if (
    !location.startsWith("src/") &&
    !location.startsWith("workers/") &&
    !location.startsWith("packages/")
  ) {
    return undefined;
  }
  if (containsForbiddenValue(location)) return undefined;
  const frame: {
    filename: string;
    function: string;
    in_app: true;
    lang: "javascript";
    lineno?: number;
    platform: "custom";
  } = {
    filename: location,
    // PostHog requires a function name on custom frames. `<anonymous>` keeps
    // anonymous frames grouped instead of forcing a wrong symbol.
    function: "<anonymous>",
    in_app: true,
    lang: "javascript",
    platform: "custom",
  };
  const name = rawFunction?.replace(/^async\s+/, "").trim();
  // `<anonymous>`, `new Foo`, `Object.<anonymous>` and generator markers still
  // group usefully, but only when they stay plain identifiers.
  if (name && /^[A-Za-z_$][\w$.<> ]{0,120}$/.test(name)) frame.function = name;
  const lineno = boundedCount(Number(rawLine));
  if (lineno !== null) frame.lineno = lineno;
  return frame;
}

/** Sanitizes a raw stack into at most `maximumFrames` allowlisted frames. */
export function sanitizedFrames(stack: string | undefined): SanitizedFrame[] {
  if (typeof stack !== "string" || stack.length === 0) return [];
  const frames: SanitizedFrame[] = [];
  for (const line of stack.split("\n")) {
    const frame = sanitizeFrame(line.trim());
    if (!frame) continue;
    frames.push(frame);
    if (frames.length === maximumFrames) break;
  }
  return frames;
}

/** Sanitizes an error type name to a plain identifier, falling back to `Error`. */
function sanitizeErrorType(name: unknown): string {
  if (typeof name !== "string") return "Error";
  const trimmed = name.trim();
  if (!/^[A-Za-z_$][\w$.]{0,79}$/.test(trimmed) || containsForbiddenValue(trimmed)) return "Error";
  return trimmed;
}

/** Rejects an out-of-vocabulary class rather than forwarding a raw category. */
function sanitizeDiagnosticCategory(value: unknown): DiagnosticCategory {
  return isDiagnosticCategory(value) ? value : "unhandled_exception";
}

/** Rejects an out-of-vocabulary grouping rather than forwarding a raw operation. */
function sanitizeOperationCategory(value: unknown): OperationCategory {
  return isOperationCategory(value) ? value : "other";
}

/**
 * Builds the allowlisted `$exception` properties for PostHog Error Tracking.
 *
 * The shape mirrors what the maintained SDKs emit (see
 * posthog-js `ErrorPropertiesBuilder`): a `$exception_list` whose single entry
 * carries `type`, `value`, a `mechanism` with `type`/`handled`/`synthetic`/
 * `exception_id`, and a `stacktrace` of `raw` frames, plus
 * `$exception_level: "error"`.
 *
 * The exception `value` is the fixed category label rather than the runtime
 * message. Exception grouping therefore keys on the sanitized type and frame
 * locations — which are what identify a defect — while a Post title, email, URL
 * or SQL parameter cannot ride along in a group name.
 */
export function diagnosticProperties(
  input: DiagnosticReportInput,
  context: { appVersion: string; deploymentCategory: DeploymentCategory },
): Record<string, unknown> {
  const exception: Record<string, unknown> = {
    mechanism: {
      exception_id: 0,
      handled: input.handled === true,
      synthetic: false,
      type: "generic",
    },
    type: sanitizeErrorType(input.error?.name),
    // Never the runtime message: see the note above.
    value: sanitizeDiagnosticCategory(input.category),
  };
  const frames = sanitizedFrames(input.error?.stack);
  if (frames.length > 0) exception.stacktrace = { frames, type: "raw" };
  const properties: Record<string, unknown> = {
    $exception_level: "error",
    $exception_list: [exception],
    app_version: context.appVersion,
    deployment_category: context.deploymentCategory,
    diagnostic_category: sanitizeDiagnosticCategory(input.category),
    diagnostic_handled: input.handled === true,
    operation_category: sanitizeOperationCategory(input.operation),
    schema_version: REPORTING_SCHEMA_VERSION,
  };
  if (
    typeof input.platform === "string" &&
    (PLATFORM_IDS as readonly string[]).includes(input.platform)
  ) {
    properties.platform = input.platform;
  }
  return properties;
}

/** Builds the one-time discovery-source attribution properties. */
export function feedbackProperties(
  source: string,
  context: { appVersion: string; deploymentCategory: DeploymentCategory },
): Record<string, unknown> {
  return {
    app_version: context.appVersion,
    deployment_category: context.deploymentCategory,
    discovery_source: source,
    schema_version: REPORTING_SCHEMA_VERSION,
  };
}

/**
 * Recursively validates payload structure and collects every reachable string.
 *
 * Top-level properties must appear in the property allowlist and every nested key
 * in the nested allowlist, so an exception object cannot smuggle an extra field
 * such as a request body or a raw provider error.
 *
 * @param value - Candidate payload or nested value.
 * @param collected - Accumulator receiving every string for the leak scan.
 * @param depth - Current nesting depth; 0 is the property level.
 * @returns The first violation, or undefined when the subtree is clean.
 */
function collectPayloadStrings(
  value: unknown,
  collected: string[],
  depth: number,
): string | undefined {
  if (depth > 6) return "payload_too_deep";
  if (typeof value === "string") {
    collected.push(value);
    return undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) return "payload_too_wide";
    for (const item of value) {
      const violation = collectPayloadStrings(item, collected, depth + 1);
      if (violation) return violation;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  // Below the property level both fixed key sets apply: aggregate sections reuse
  // documented property names (`posts`, `views`, `measured`) and the exception
  // list adds the documented frame and mechanism keys.
  const allowed =
    depth === 0 ? allowedPropertyNames : { ...allowedPropertyNames, ...allowedNestedKeys };
  for (const [key, item] of Object.entries(value)) {
    if (!(key in allowed)) {
      return depth === 0 ? `unexpected_property:${key}` : `unexpected_nested_key:${key}`;
    }
    collected.push(key);
    const violation = collectPayloadStrings(item, collected, depth + 1);
    if (violation) return violation;
  }
  return undefined;
}

/**
 * Validates an assembled payload against the property and value allowlist.
 *
 * Runs immediately before transport, so the transport can only ever submit a
 * payload this module assembled. Any violation means a bug in payload
 * construction; the caller discards the row rather than sending it.
 *
 * @param properties - Fully assembled event properties.
 * @returns A human-readable violation, or undefined when the payload is clean.
 */
export function payloadViolation(properties: Record<string, unknown>): string | undefined {
  const collected: string[] = [];
  const nested = collectPayloadStrings(properties, collected, 0);
  if (nested) return nested;
  for (const text of collected) {
    if (text.length > 200) return "oversized_value";
    if (containsForbiddenValue(text)) return "forbidden_value";
  }
  return undefined;
}
