import { Data } from "effect";
import { PLATFORM_IDS, type Platform } from "@meltiply/domain";

/**
 * Improvement-reporting contract shared by the API Worker, the Automation
 * Worker and the versioned event catalog in the deployment documentation.
 *
 * Everything here is deliberately closed: categories, platforms, diagnostic
 * classifications and event property names are fixed enumerations. A caller
 * supplies an approved measurement or diagnostic classification; it never
 * supplies arbitrary properties, serialized domain objects or free-form text.
 */

/** The two independent reporting choices an Installation Owner makes. */
export type ReportingCategory = "usage" | "diagnostics";

/**
 * Categories that can occupy the bounded pending queue.
 *
 * Feedback is a third queue category but not a consent-controlled reporting
 * choice: it has its own one-time disclosure, its own random response identity,
 * and is unaffected by either reporting toggle.
 */
export type PendingReportCategory = ReportingCategory | "feedback";

/** Why a category is or is not effective for outbound transmission. */
export type ReportingCategoryReason =
  | "enabled"
  | "not_requested"
  | "destination_unavailable"
  | "operator_disabled"
  | "preference_unavailable";

export const REPORTING_CATEGORIES: readonly ReportingCategory[] = ["usage", "diagnostics"] as const;

/** Disclosure text version the stored consent was granted against. */
export const REPORTING_DISCLOSURE_VERSION = 1;

/** Event/payload schema version for every outbound report. */
export const REPORTING_SCHEMA_VERSION = 1;

/** Optional reporting data is never delivered later than this. */
export const REPORTING_MAX_PENDING_AGE_DAYS = 7;

/** Upper bound on pending rows drained by one delivery pass. */
export const REPORTING_MAX_DELIVERY_BATCH = 10;

/**
 * Wall-clock ceiling for one delivery pass.
 *
 * A Worker invocation's post-response continuation shares a 30-second window, so
 * the pass must stop early enough that its last transport attempt, the lease
 * bookkeeping around it and the terminal-payload prune all finish inside it. The
 * pass therefore spends nothing on a send it cannot complete, and rows it has not
 * dispatched are released back to `pending` rather than left leased.
 */
export const REPORTING_DELIVERY_BUDGET_MILLISECONDS = 20_000;

/** Upper bound on stored pending rows, so a noisy producer cannot grow storage. */
export const REPORTING_MAX_PENDING_ROWS = 200;

/** Diagnostic rows accepted within one hour, bounding a repeated browser failure. */
export const REPORTING_MAX_DIAGNOSTICS_PER_HOUR = 25;

/** Fixed discovery-source enumeration; there is no free-text answer. */
export const DISCOVERY_SOURCES = [
  "github",
  "search_engine",
  "social_media",
  "video",
  "article_newsletter",
  "friend_word_of_mouth",
  "ai_assistant",
  "other",
  "prefer_not_to_say",
] as const;

export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

/**
 * Diagnostic classes an allowed producer may report.
 *
 * `provider_failure` is the one expected-condition class: a classified
 * `ProviderAdapterError` (auth, quota, rate limit, timeout, transient,
 * deterministic, ambiguous) is normal recoverable Provider behavior and must not
 * be stacked as an unexpected exception, or it hides application defects in Error
 * Tracking. Every other member is an unexpected failure, and the producer marks
 * which one it saw through `handled` as well.
 */
export const DIAGNOSTIC_CATEGORIES = [
  "unhandled_exception",
  "provider_failure",
  "request_failure",
  "scheduled_job_failure",
  "client_exception",
] as const;

export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];

/** Production operation grouping used to prioritize repairs. */
export const OPERATION_CATEGORIES = [
  "publish",
  "analytics",
  "inbox",
  "auth",
  "assets",
  "queues",
  "installation",
  "reporting",
  "other",
] as const;

export type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

/**
 * Expected Provider conditions, as the canonical adapter classification names
 * them. Reporting restates the roster rather than importing `@meltiply/providers`
 * so the shared module keeps its single small dependency surface; producers map
 * an adapter failure to one member and the module rejects anything else.
 */
export const PROVIDER_FAILURE_CLASSES = [
  "ambiguous",
  "auth",
  "deterministic",
  "quota",
  "rate_limit",
  "timeout",
  "transient",
] as const;

export type ProviderFailureClass = (typeof PROVIDER_FAILURE_CLASSES)[number];

/** How the installation is deployed; reported coarsely, never as a hostname. */
export type DeploymentCategory = "managed" | "selfhosted" | "unknown";

/**
 * Failure raised when a producer hands the module a value outside the approved
 * measurement shape. Internal callers treat this as a programming error; it is
 * never produced from untrusted HTTP input, which is validated by the route.
 */
export class ReportingInputError extends Data.TaggedError("ReportingInputError")<{
  readonly field: string;
  readonly message: string;
}> {}

/** Narrows untrusted input to one of the fixed discovery-source answers. */
export function isDiscoverySource(value: unknown): value is DiscoverySource {
  return typeof value === "string" && (DISCOVERY_SOURCES as readonly string[]).includes(value);
}

/** Narrows untrusted input to one of the fixed diagnostic classes. */
export function isDiagnosticCategory(value: unknown): value is DiagnosticCategory {
  return typeof value === "string" && (DIAGNOSTIC_CATEGORIES as readonly string[]).includes(value);
}

/** Narrows untrusted input to one of the fixed operation groupings. */
export function isOperationCategory(value: unknown): value is OperationCategory {
  return typeof value === "string" && (OPERATION_CATEGORIES as readonly string[]).includes(value);
}

/** Narrows untrusted input to one of the canonical Provider failure classes. */
export function isProviderFailureClass(value: unknown): value is ProviderFailureClass {
  return typeof value === "string" && (PROVIDER_FAILURE_CLASSES as readonly string[]).includes(value);
}

/** Narrows untrusted input to a supported Platform identifier. */
export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORM_IDS as readonly string[]).includes(value);
}

/** One audience counter reported from stored Provider analytics. */
export type UsageEngagementMetric = "comments" | "reactions" | "shares" | "views";

/** Every engagement metric name, so coverage can name an omitted one. */
export const USAGE_ENGAGEMENT_METRICS: readonly UsageEngagementMetric[] = [
  "views",
  "reactions",
  "comments",
  "shares",
] as const;

/**
 * Per-Platform as-of engagement gauges; `null` means not measured, never zero.
 *
 * The figures are the latest eligible stored snapshot of each contributing
 * Distribution, so they are gauges, not daily deltas: repeating a lifetime
 * count across days is the same views, not new views.
 */
export interface UsageEngagement {
  readonly comments: number | null;
  /** Distributions whose stored snapshot contributed to these gauges. */
  readonly distributions: number;
  readonly reactions: number | null;
  readonly shares: number | null;
  readonly views: number | null;
  /** Newest contributing snapshot capture time, so freshness travels with the gauge. */
  readonly asOf: string | null;
}

/**
 * How much of the eligible cohort the engagement gauges actually cover.
 *
 * `measured` and `missing` are Distribution counts, and `truncated` says the
 * bounded cohort stopped before covering every eligible Distribution, so a
 * dashboard never implies completeness the producer could not establish.
 */
export interface UsageEngagementCoverage {
  readonly measured: number;
  readonly missing: number;
  /** Metrics omitted because that Platform could not be shown to expose them. */
  readonly unsupportedMetrics: readonly UsageEngagementMetric[];
  readonly truncated: boolean;
}

/**
 * One daily aggregate usage summary. Counters are install-local aggregates;
 * nothing here identifies a Post, Distribution, Channel, Workspace or member.
 */
export interface UsageReportInput {
  /** UTC calendar day the counters cover, `YYYY-MM-DD`. */
  readonly reportDate: string;
  /** Connected Channels per Platform, an occupancy gauge from the canonical state. */
  readonly channels: Partial<Record<Platform, number>>;
  /** Confirmed publication counters for the reporting interval. */
  readonly publications: {
    readonly distributions: Partial<Record<Platform, number>>;
    readonly posts: number;
  };
  /** Latest eligible stored analytics snapshot per Distribution, per Platform. */
  readonly engagement: Partial<Record<Platform, UsageEngagement>>;
  /** Newest snapshot capture time across every gauge, or null when nothing was measured. */
  readonly engagementAsOf: string | null;
  /** Cohort coverage and truncation for the gauges above; null when there is no cohort. */
  readonly engagementCoverage: UsageEngagementCoverage | null;
  /**
   * Consent interval these measurements were computed under.
   *
   * The producer reads policy and aggregates in one snapshot, then enqueues in a
   * later transaction. Without this, a withdrawal plus re-enable in between would
   * tag the old interval's counters with the new interval's identity and report
   * activity the Owner had declined. A mismatch queues nothing.
   */
  readonly expectedIntervalStartedAt?: string;
}

/** One allowlisted diagnostic report; the module sanitizes `error` before transport. */
export interface DiagnosticReportInput {
  readonly category: DiagnosticCategory;
  /**
   * Canonical adapter class of the Provider condition this report describes.
   *
   * Only meaningful with `category: "provider_failure"`, where it is what makes
   * "expired authorization" or "rate limited" countable without any Provider
   * message, status text or response body leaving the installation.
   */
  readonly failureClass?: ProviderFailureClass;
  /** Fixed logical identity; a repeated report reuses the same pending row. */
  readonly logicalId?: string;
  readonly occurredAt: string;
  readonly operation: OperationCategory;
  readonly platform?: Platform;
  /** Handled provider conditions are categorized, not stacked as exceptions. */
  readonly handled: boolean;
  /** Raw error name and stack; only allowlisted frames survive sanitization. */
  readonly error: { readonly name: string; readonly stack?: string };
}

/**
 * Bounded delivery outcome surfaced by the scheduled unit's log line.
 *
 * `released` counts rows this pass claimed but deliberately handed back to
 * `pending` because the invocation budget could not fit another send. They are
 * neither sent nor discarded and are expected on a later pass.
 */
export interface DeliverySummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly discarded: number;
  readonly failed: number;
  readonly released: number;
  readonly skipped: number;
}

/** PostHog-compatible capture request the transport submits. */
export interface CaptureEvent {
  readonly distinctId: string;
  readonly event: string;
  readonly properties: Record<string, unknown>;
  /** Frozen "$insert_id" UUID shared by every delivery attempt of this report. */
  readonly eventUuid: string;
  /**
   * Frozen instant of the measurement or diagnostic. PostHog de-duplicates on
   * `uuid` + `event` + `timestamp` + `distinct_id`, so a retry must repeat this
   * value rather than re-stamping the send time.
   */
  readonly timestamp: string;
}

/** Transport outcome; transport failures never escape as exceptions. */
export type CaptureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: string; readonly retryable: boolean };

/** Delivers exactly one capture request within the module's bounded budget. */
export interface CaptureTransport {
  capture(event: CaptureEvent): Promise<CaptureResult>;
}

/** Requested versus effective status for one reporting category. */
export interface ReportingCategoryStatus {
  /** What the Installation Owner asked for, as persisted. */
  readonly requested: boolean;
  /** Whether an outbound report may actually be sent right now. */
  readonly effective: boolean;
  readonly reason: ReportingCategoryReason;
  /** When the stored choice was last changed, or null if never decided. */
  readonly decidedAt: string | null;
  /**
   * Disclosure version the stored decision was recorded against, or null when
   * that category was never decided. Reporting fails closed unless it matches
   * `REPORTING_DISCLOSURE_VERSION`, so this is the truthful record of what the
   * Owner actually agreed to rather than the version in force today.
   */
  readonly disclosureVersion: number | null;
  /** Start of the interval this category counts activity over. */
  readonly intervalStartedAt: string | null;
}

/**
 * Installation reporting policy.
 *
 * `requested` and `effective` are distinct on purpose: an Owner can ask for a
 * category that the operator override or a missing destination disables, and the
 * surface must say so instead of claiming reporting is on.
 */
export interface ReportingPolicySnapshot {
  readonly disclosureVersion: number;
  readonly destinationConfigured: boolean;
  readonly operatorForcedOff: boolean;
  readonly categories: Record<ReportingCategory, ReportingCategoryStatus>;
  /** Pseudonymous identifier; present only after the first opt-in. */
  readonly installationReportingId: string | null;
}

/** Honest delivery state of the one-time attribution answer. */
export type FeedbackDeliveryStatus = "not_shared" | "not_recorded" | "pending" | "delivered";

/** One-time discovery-source answer, if the Owner ever submitted one. */
export interface ReportingFeedbackState {
  readonly shared: boolean;
  readonly discoverySource: DiscoverySource | null;
  readonly submittedAt: string | null;
  readonly deliveryStatus: FeedbackDeliveryStatus;
}
