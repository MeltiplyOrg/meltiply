import { isoDateTimeOrNull, PLATFORM_IDS, isPlatform } from "@meltiply/domain";
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

export const REPORTING_EVENTS = {
  diagnostics: "$exception",
  feedback: "meltiply_feedback_discovery_source",
  usage: "meltiply_usage_daily",
} as const;

const maximumFrames = 12;

const allowedNestedKeys: Readonly<Record<string, true>> = Object.freeze({
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
  ...Object.fromEntries(PLATFORM_IDS.map((platform) => [platform, true] as const)),
  as_of: true,
  truncated: true,
  unsupported_metrics: true,
});

const allowedPropertyNames: Readonly<Record<string, true>> = Object.freeze({
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
});

const allowedNestedPropertyNames: Readonly<Record<string, true>> = Object.freeze({
  ...allowedPropertyNames,
  ...allowedNestedKeys,
});

const forbiddenValuePatterns: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s"']*/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\bBearer\s+\S+/i,
  /\b(?:authorization|access_token|refresh_token|token|password|client_secret|secret|api[_-]?key)\b\s*[=:]\s*\S+/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\?\S*=\S*/,
];

export function containsForbiddenValue(value: string): boolean {
  return forbiddenValuePatterns.some((pattern) => pattern.test(value));
}

/** Returns null for missing, negative, or non-finite values so unknown metrics never read as zero. */
export function boundedCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const integer = Math.floor(value);
  return Number.isSafeInteger(integer) ? integer : null;
}

function platformCounts(value: Partial<Record<string, unknown>> | undefined): [Platform, number][] {
  if (!value || typeof value !== "object") return [];
  const entries: [Platform, number][] = [];
  for (const platform of PLATFORM_IDS) {
    const count = boundedCount(value[platform]);
    if (count !== null) entries.push([platform, count]);
  }
  return entries;
}

function channelsProperty(input: UsageReportInput): Record<string, number> | undefined {
  const entries = platformCounts(input.channels);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function publicationsProperty(input: UsageReportInput): Record<string, unknown> | undefined {
  const posts = boundedCount(input.publications?.posts);
  const distributions = platformCounts(input.publications?.distributions);
  if (posts === null && distributions.length === 0) return undefined;
  const property: Record<string, unknown> = {};
  if (posts !== null) property.posts = posts;
  if (distributions.length > 0) property.distributions = Object.fromEntries(distributions);
  return property;
}

function engagementProperty(input: UsageReportInput): Record<string, unknown> | undefined {
  if (!input.engagement || typeof input.engagement !== "object") return undefined;
  const property: Record<string, unknown> = {};
  for (const platform of PLATFORM_IDS) {
    const gauge: UsageEngagement | undefined = input.engagement[platform];
    if (!gauge || typeof gauge !== "object") continue;
    const measured: Record<string, unknown> = {};
    for (const metric of USAGE_ENGAGEMENT_METRICS) {
      const count = boundedCount(gauge[metric]);
      if (count !== null) measured[metric] = count;
    }
    const distributions = boundedCount(gauge.distributions);
    if (distributions !== null) measured.distributions = distributions;
    const asOf = isoDateTimeOrNull(gauge.asOf);
    if (asOf) measured.as_of = asOf;
    if (Object.keys(measured).length > 0) property[platform] = measured;
  }
  return Object.keys(property).length === 0 ? undefined : property;
}

function validReportDate(value: string): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

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
  const interval = isoDateTimeOrNull(input.expectedIntervalStartedAt);
  if (interval) properties.consent_interval_started_at = interval;
  const channels = channelsProperty(input);
  if (channels) properties.channels = channels;
  const publications = publicationsProperty(input);
  if (publications) properties.publications = publications;
  const engagement = engagementProperty(input);
  if (engagement) properties.engagement = engagement;
  const asOf = isoDateTimeOrNull(input.engagementAsOf);
  if (asOf) properties.engagement_as_of = asOf;
  const coverage = input.engagementCoverage;
  if (coverage) {
    const measured = boundedCount(coverage.measured);
    const missing = boundedCount(coverage.missing);
    const unsupported = unsupportedMetricNames(coverage.unsupportedMetrics);
    const property: Record<string, unknown> = {
      ...(measured === null ? {} : { measured }),
      ...(missing === null ? {} : { missing }),
      ...(coverage.truncated === true ? { truncated: true } : {}),
      ...(unsupported.length > 0 ? { unsupported_metrics: unsupported } : {}),
    };
    if (Object.keys(property).length > 0) properties.engagement_coverage = property;
  }
  return properties;
}

function unsupportedMetricNames(value: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return USAGE_ENGAGEMENT_METRICS.filter((metric) => value.includes(metric));
}

interface SanitizedFrame {
  readonly filename?: string;
  readonly function: string;
  readonly in_app: true;
  readonly lang: "javascript";
  readonly lineno?: number;
  readonly platform: "custom";
}

const approvedExceptionTypes: Record<string, true> = {
  AggregateError: true,
  AssetPolicyError: true,
  DOMException: true,
  DatabaseError: true,
  Error: true,
  EvalError: true,
  ForbiddenError: true,
  InvalidRequestError: true,
  MailSubmissionError: true,
  NotFoundError: true,
  ProviderAdapterError: true,
  RangeError: true,
  ReferenceError: true,
  StorageUnavailableError: true,
  SyntaxError: true,
  TokenCipherUnavailableError: true,
  TokenCiphertextError: true,
  TypeError: true,
  URIError: true,
};

const releaseBundleNames: Record<string, true> = {
  "index.js": true,
  "index.mjs": true,
  "worker.js": true,
};

const hashedAssetPath = /(?:^|\/)assets\/[A-Za-z0-9_-]*-([A-Za-z0-9_-]{8,64})\.(?:js|mjs)$/;

const sourceModuleAreas: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  "frontend/": { app: true, public: true, shared: true },
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
  "workers/": { api: true, automation: true, state: true },
};

const sourceToken = "source";

const normalizedAssetPath = /^assets\/[A-Za-z0-9_-]{8,64}\.js$/;

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

const sourceRemainder = /^\/[A-Za-z0-9_./-]{1,200}\.(?:ts|tsx|js|mjs|cjs)$/;

function releaseFramePath(location: string): string | undefined {
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
    const remainder = withoutSuffix.slice(prefix.length + area.length);
    if (!sourceRemainder.test(remainder)) return undefined;
    return `${prefix}${area}/${sourceToken}`;
  }
  return undefined;
}

function isDigitAt(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 48 && code <= 57;
}

function digitRunStart(value: string, endExclusive: number): number {
  let index = endExclusive - 1;
  while (index >= 0 && isDigitAt(value, index)) index -= 1;
  return index + 1;
}

function splitFrameSuffix(value: string): { line: string; location: string } | undefined {
  const columnStart = digitRunStart(value, value.length);
  if (columnStart === value.length) return undefined;
  if (value.charCodeAt(columnStart - 1) !== 58) return undefined;
  const lineEnd = columnStart - 1;
  const lineStart = digitRunStart(value, lineEnd);
  if (lineStart === lineEnd) return undefined;
  if (value.charCodeAt(lineStart - 1) !== 58) return undefined;
  const line = value.slice(lineStart, lineEnd);
  return { line, location: value.slice(0, lineStart - 1) };
}

function frameLocationText(body: string): string | undefined {
  let location = body;
  if (body.endsWith(")")) {
    const open = body.lastIndexOf("(");
    if (open < 0) return undefined;
    location = body.slice(open + 1, -1);
  }
  return /[()\s]/.test(location) ? undefined : location;
}

function sanitizeFrame(line: string): SanitizedFrame | undefined {
  if (!line.startsWith("at ")) return undefined;
  const location = frameLocationText(line.slice(3));
  if (location === undefined) return undefined;
  const suffix = splitFrameSuffix(location);
  if (suffix === undefined) return undefined;
  const filename = releaseFramePath(suffix.location);
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
    function: "<anonymous>",
    in_app: true,
    lang: "javascript",
    platform: "custom",
  };
  const lineno = boundedCount(Number(suffix.line));
  if (lineno !== null) frame.lineno = lineno;
  return frame;
}

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

function sanitizeErrorType(name: unknown): string {
  if (typeof name !== "string") return "Error";
  const trimmed = name.trim();
  return approvedExceptionTypes[trimmed] === true ? trimmed : "Error";
}

function sanitizeDiagnosticCategory(value: unknown): DiagnosticCategory {
  return isDiagnosticCategory(value) ? value : "unhandled_exception";
}

function sanitizeOperationCategory(value: unknown): OperationCategory {
  return isOperationCategory(value) ? value : "other";
}

/** Matches PostHog Error Tracking's `$exception_list` schema; `value` is the fixed category, never the raw message. */
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
    properties.diagnostic_category === "provider_failure" &&
    isProviderFailureClass(input.failureClass)
  ) {
    properties.provider_failure_class = input.failureClass;
  }
  if (isPlatform(input.platform)) {
    properties.platform = input.platform;
  }
  return properties;
}

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
  const allowed = depth === 0 ? allowedPropertyNames : allowedNestedPropertyNames;
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
      if (frameRecord.function !== undefined && frameRecord.function !== "<anonymous>") {
        return "unapproved_frame_symbol";
      }
    }
  }
  return undefined;
}

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
