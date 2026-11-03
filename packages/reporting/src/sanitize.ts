import { PLATFORM_IDS } from "@meltiply/domain";
import type { Platform } from "@meltiply/domain";

import {
  isDiagnosticCategory,
  isOperationCategory,
  isProviderFailureClass,
  REPORTING_SCHEMA_VERSION,
  USAGE_ENGAGEMENT_METRICS,
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
  // Per-gauge freshness and the coverage section's bounded shape.
  as_of: true,
  truncated: true,
  unsupported_metrics: true,
};

/** Property names permitted on any outbound payload. */
const allowedPropertyNames: Record<string, true> = {
  $exception_level: true,
  $exception_list: true,
  $geoip_disable: true,
  $process_person_profile: true,
  app_version: true,
  channels: true,
  consent_interval_started_at: true,
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
  provider_failure_class: true,
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
    const measured: Record<string, unknown> = {};
    for (const metric of ["views", "reactions", "comments", "shares"] as const) {
      const count = boundedCount(gauge[metric]);
      if (count !== null) measured[metric] = count;
    }
    const distributions = boundedCount(gauge.distributions);
    if (distributions !== null) measured.distributions = distributions;
    // Freshness travels with the gauge it describes: one Platform's snapshots
    // can be hours newer than another's, so a single report-level timestamp
    // would overstate the older gauge.
    const asOf = validTimestamp(gauge.asOf ?? null);
    if (asOf) measured.as_of = asOf;
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
  // The consent interval is what makes two same-day reports distinct measurements
  // rather than duplicate deliveries, so it travels with the counters it bounds.
  const interval = validTimestamp(input.expectedIntervalStartedAt);
  if (interval) properties.consent_interval_started_at = interval;
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
    const unsupported = unsupportedMetricNames(coverage.unsupportedMetrics);
    const property: Record<string, unknown> = {
      ...(measured === null ? {} : { measured }),
      ...(missing === null ? {} : { missing }),
      // Truncation is a producer-stated bound, never inferred from the counts:
      // a dashboard must see that the cohort stopped early rather than assume
      // the gauges cover every eligible Distribution.
      ...(coverage.truncated === true ? { truncated: true } : {}),
      ...(unsupported.length > 0 ? { unsupported_metrics: unsupported } : {}),
    };
    if (Object.keys(property).length > 0) properties.engagement_coverage = property;
  }
  return properties;
}

/** Keeps only in-vocabulary metric names, in canonical order, from untrusted input. */
function unsupportedMetricNames(value: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return USAGE_ENGAGEMENT_METRICS.filter((metric) => value.includes(metric));
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
 * Exception types that may reach the destination as a group name.
 *
 * The authenticated diagnostic endpoint forwards an error class name it observed,
 * so an unrecognized name is untrusted text: `SensitiveCustomerName` is exactly
 * as valid an identifier as `TypeError`, and forwarding it would publish a
 * caller-chosen value. Only these reviewed classes travel; the rest group as
 * `Error`, which is still useful because grouping also keys on release location.
 */
const approvedExceptionTypes: Record<string, true> = {
  AggregateError: true,
  DOMException: true,
  DatabaseError: true,
  Error: true,
  EvalError: true,
  MailSubmissionError: true,
  ProviderAdapterError: true,
  ProviderError: true,
  RangeError: true,
  ReferenceError: true,
  ReportingInputError: true,
  StorageUnavailableError: true,
  SyntaxError: true,
  TypeError: true,
  URIError: true,
  ValidationError: true,
};

/**
 * Fixed release bundle names that identify this application's own build.
 *
 * A Worker's deployed stack refers to the bundle, not to a source file, and the
 * name is produced by the build rather than by any caller. Only these fixed
 * basenames are accepted from a bare path, so a forwarded stack cannot introduce
 * a free-form file name.
 */
const releaseBundleNames: Record<string, true> = {
  "index.js": true,
  "index.mjs": true,
  "worker.js": true,
};

/**
 * Content-hashed frontend asset path, e.g. `/assets/index-DiwrgTda.js`.
 *
 * Vite emits `assets/<chunk>-<content hash>.js`. Only the hash is retained: the
 * chunk name is build output too, but keeping it would mean forwarding a name a
 * caller could have chosen, so the emitted location is the hash alone.
 */
const hashedAssetPath = /(?:^|\/)assets\/[A-Za-z0-9_-]*-([A-Za-z0-9_-]{8,64})\.(?:js|mjs)$/;

/**
 * Reviewed module areas, keyed by source-tree prefix.
 *
 * A repository-relative frame names a file inside a module, and the module's file
 * name is not reviewed data. Only the area is emitted, so a stack line carrying
 * `packages/SensitiveCustomerName.ts` cannot publish that identifier: the frame
 * becomes `<prefix><area>/source` from this closed roster instead.
 */
const sourceModuleAreas: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  "packages/": {
    auth: true,
    contracts: true,
    database: true,
    domain: true,
    observability: true,
    providers: true,
    reporting: true,
    secrets: true,
    storage: true,
    ui: true,
  },
  "src/": {
    app: true,
    components: true,
    hooks: true,
    lib: true,
    locales: true,
    types: true,
    worker: true,
  },
  "workers/": { api: true, automation: true },
};

/** Fixed token replacing every untrusted file name. */
const sourceToken = "source";

/** The emitted location families, matched against an already-normalized path. */
const normalizedAssetPath = /^assets\/[A-Za-z0-9_-]{8,64}\.js$/;

/**
 * Reports whether a stored frame location is one this module could have emitted.
 *
 * The emitted location is a normalized form — an asset hash, a fixed bundle name,
 * or `<prefix><area>/source` from the reviewed roster — so validity is a regex
 * over the output vocabulary rather than a re-normalization of an arbitrary input.
 * A row written by an older build or edited at rest cannot smuggle a file name
 * through this check.
 *
 * @param filename - Stored frame location.
 * @returns True when the location is in the emitted vocabulary.
 */
function isNormalizedFramePath(filename: string): boolean {
  if (normalizedAssetPath.test(filename)) return true;
  if (releaseBundleNames[filename] === true) return true;
  for (const [prefix, areas] of Object.entries(sourceModuleAreas)) {
    for (const area of Object.keys(areas)) {
      if (filename === `${prefix}${area}/${sourceToken}`) return true;
    }
  }
  return false;
}

/** Source file remainder: a path under a reviewed area ending in a source extension. */
const sourceRemainder = /^\/[A-Za-z0-9_.\/-]{1,200}\.(?:ts|tsx|js|mjs|cjs)$/;

/**
 * Reduces a stack location to provable application release metadata.
 *
 * Three location families identify this application's own code, and nothing else
 * survives:
 *
 * - a deployed frontend asset, reduced to `assets/<content hash>.js`, so the
 *   origin, chunk name, credentials and query string are all removed;
 * - one of the fixed release bundle names a Worker deploys as;
 * - a repository-relative path under a fixed prefix and a reviewed module area,
 *   reduced to `<prefix><area>/source`, which is what a source-map-backed stack
 *   reports.
 *
 * Every retained character is therefore either build output or a member of a
 * closed roster. Dependency paths, `node_modules`, `eval` frames, absolute paths
 * and arbitrary file names are dropped rather than sanitized: a location is only
 * useful when it can be shown to name this application's own code.
 *
 * @param location - Raw location text from one stack line.
 * @returns The constrained application path, or undefined when nothing safe remains.
 */
function releaseFramePath(location: string): string | undefined {
  // Fragment and query first: a frame can carry a cache-busting suffix or a
  // credential-bearing query, and neither may reach the payload.
  const withoutSuffix = (location.split(/[?#]/, 1)[0] ?? "").trim();
  if (withoutSuffix.length === 0 || withoutSuffix.length > 400) return undefined;
  const asset = hashedAssetPath.exec(withoutSuffix);
  if (asset?.[1]) return `assets/${asset[1]}.js`;
  const basename = withoutSuffix.slice(withoutSuffix.lastIndexOf("/") + 1);
  if (releaseBundleNames[basename] === true) return basename;
  for (const [prefix, areas] of Object.entries(sourceModuleAreas)) {
    if (!withoutSuffix.startsWith(prefix)) continue;
    const area = withoutSuffix.slice(prefix.length).split("/", 1)[0] ?? "";
    if (areas[area] !== true) return undefined;
    // The remainder proves this is a source file, but its name is never copied.
    const remainder = withoutSuffix.slice(prefix.length + area.length);
    if (!sourceRemainder.test(remainder)) return undefined;
    return `${prefix}${area}/${sourceToken}`;
  }
  return undefined;
}

/**
 * Sanitizes one stack line into an allowlisted frame.
 *
 * The retained facts are the release location and line number — both build
 * output — plus the constants PostHog requires. The runtime function name is
 * deliberately not forwarded: it is free-form text taken from the stack, so it is
 * indistinguishable from a caller-supplied identifier and could carry a customer
 * or Channel name. Grouping keys on the exception type and the release location,
 * which is what identifies a defect, and every frame reports `<anonymous>` so the
 * gap is explicit rather than a wrong symbol.
 *
 * @param line - One trimmed stack line.
 * @returns The sanitized frame, or undefined when the frame is unsafe.
 */
function sanitizeFrame(line: string): SanitizedFrame | undefined {
  const match = /^at\s+(?:(.+?)\s+\()?([^()\s]+):(\d+):(\d+)\)?$/.exec(line);
  if (!match) return undefined;
  const [, , rawLocation, rawLine] = match;
  const filename = releaseFramePath(rawLocation ?? "");
  if (filename === undefined) return undefined;
  const frame: {
    filename: string;
    function: string;
    in_app: true;
    lang: "javascript";
    lineno?: number;
    platform: "custom";
  } = {
    filename,
    // PostHog requires a function name on custom frames; see the note above for
    // why the stack's own symbol is not forwarded.
    function: "<anonymous>",
    in_app: true,
    lang: "javascript",
    platform: "custom",
  };
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

/**
 * Sanitizes an error type name to a reviewed exception class.
 *
 * The name arrives from an authenticated caller's stack, so it is untrusted text:
 * an identifier-shaped string is not evidence that it names an exception class.
 * Anything outside the reviewed set becomes `Error`. Grouping stays useful because
 * it also keys on the release location, and the constant `Error` is a truthful
 * statement rather than a value the caller chose.
 *
 * @param name - Raw error name or constructor name from the boundary.
 * @returns An approved class name.
 */
function sanitizeErrorType(name: unknown): string {
  if (typeof name !== "string") return "Error";
  const trimmed = name.trim();
  return approvedExceptionTypes[trimmed] === true ? trimmed : "Error";
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
  // The canonical class is the countable fact behind an expected Provider
  // condition: "auth expired" versus "rate limited" without any Provider message,
  // status text or response body. An out-of-vocabulary value is dropped rather
  // than forwarded, and it is meaningless outside the Provider category.
  if (
    properties.diagnostic_category === "provider_failure" &&
    isProviderFailureClass(input.failureClass)
  ) {
    properties.provider_failure_class = input.failureClass;
  }
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
 * Validates the exception list's value-bearing fields against their allowlist.
 *
 * The key allowlist stops an extra property, but a stored row could still carry a
 * free-form `type` or an arbitrary `filename`, and the authenticated ingestion
 * endpoint accepts both from callers. Re-deriving the constraint at send time is
 * what makes the promise hold for rows written by an older build or edited at
 * rest: an unapproved exception type or a location that is not provably this
 * application's release output fails the send instead of leaving the
 * installation.
 *
 * @param exceptions - Value under `$exception_list`.
 * @returns The first violation, or undefined when every entry is safe.
 */
function exceptionViolation(exceptions: unknown): string | undefined {
  if (!Array.isArray(exceptions)) return "exception_list_not_list";
  for (const entry of exceptions) {
    if (entry === null || typeof entry !== "object") return "exception_entry_invalid";
    const record = entry as Record<string, unknown>;
    if (typeof record.type === "string" && approvedExceptionTypes[record.type] !== true) {
      return "unapproved_exception_type";
    }
    const stacktrace = record.stacktrace;
    if (stacktrace === null || typeof stacktrace !== "object") continue;
    const frames = (stacktrace as Record<string, unknown>).frames;
    if (frames === undefined) continue;
    if (!Array.isArray(frames)) return "frames_not_list";
    for (const frame of frames) {
      if (frame === null || typeof frame !== "object") return "frame_invalid";
      const frameRecord = frame as Record<string, unknown>;
      const filename = frameRecord.filename;
      if (typeof filename === "string" && !isNormalizedFramePath(filename)) {
        return "unapproved_frame_location";
      }
      // The sanitizer never retains a stack symbol; a row carrying one came from
      // somewhere other than this module and cannot be shown to be safe.
      if (frameRecord.function !== undefined && frameRecord.function !== "<anonymous>") {
        return "unapproved_frame_symbol";
      }
    }
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
  if ("$exception_list" in properties) {
    const exception = exceptionViolation(properties.$exception_list);
    if (exception) return exception;
  }
  return undefined;
}
