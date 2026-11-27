import {
  PROVIDER_FAILURE_CLASSES,
  type EngagementMetric,
  type Platform,
  type ProviderFailureClass,
} from "@meltiply/domain";

export type { ProviderFailureClass };

export type ReportingCategory = "usage" | "diagnostics";

export type PendingReportCategory = ReportingCategory | "feedback";

export type ReportingCategoryReason =
  | "enabled"
  | "not_requested"
  | "destination_unavailable"
  | "operator_disabled"
  | "preference_unavailable";

export const REPORTING_CATEGORIES: readonly ReportingCategory[] = ["usage", "diagnostics"] as const;

export const REPORTING_DISCLOSURE_VERSION = 1;

export const REPORTING_SCHEMA_VERSION = 1;

export const REPORTING_MAX_PENDING_AGE_DAYS = 7;

export const REPORTING_MAX_DELIVERY_BATCH = 10;

/** Wall-clock ceiling leaving headroom inside a Worker's 30 s `waitUntil` budget. */
export const REPORTING_DELIVERY_BUDGET_MILLISECONDS = 20_000;

export const REPORTING_MAX_PENDING_ROWS = 200;

export const REPORTING_MAX_DIAGNOSTICS_PER_HOUR = 25;

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

const DIAGNOSTIC_CATEGORIES = [
  "unhandled_exception",
  "provider_failure",
  "request_failure",
  "scheduled_job_failure",
  "client_exception",
] as const;

export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];

const OPERATION_CATEGORIES = [
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

export type DeploymentCategory = "managed" | "selfhosted" | "unknown";

export function isDiscoverySource(value: unknown): value is DiscoverySource {
  return typeof value === "string" && (DISCOVERY_SOURCES as readonly string[]).includes(value);
}

export function isDiagnosticCategory(value: unknown): value is DiagnosticCategory {
  return typeof value === "string" && (DIAGNOSTIC_CATEGORIES as readonly string[]).includes(value);
}

export function isOperationCategory(value: unknown): value is OperationCategory {
  return typeof value === "string" && (OPERATION_CATEGORIES as readonly string[]).includes(value);
}

export function isProviderFailureClass(value: unknown): value is ProviderFailureClass {
  return (
    typeof value === "string" && (PROVIDER_FAILURE_CLASSES as readonly string[]).includes(value)
  );
}

export type UsageEngagementMetric = EngagementMetric;

export const USAGE_ENGAGEMENT_METRICS: readonly UsageEngagementMetric[] = [
  "views",
  "reactions",
  "comments",
  "shares",
] as const;

/** Per-Platform as-of engagement gauges; `null` means not measured, never zero. */
export interface UsageEngagement {
  readonly comments: number | null;
  readonly distributions: number;
  readonly reactions: number | null;
  readonly shares: number | null;
  readonly views: number | null;
  readonly asOf: string | null;
}

export interface UsageEngagementCoverage {
  readonly measured: number;
  readonly missing: number;
  readonly unsupportedMetrics: readonly UsageEngagementMetric[];
  readonly truncated: boolean;
}

export interface UsageReportInput {
  readonly reportDate: string;
  readonly channels: Partial<Record<Platform, number>>;
  readonly publications: {
    readonly distributions: Partial<Record<Platform, number>>;
    readonly posts: number;
  };
  readonly engagement: Partial<Record<Platform, UsageEngagement>>;
  readonly engagementAsOf: string | null;
  readonly engagementCoverage: UsageEngagementCoverage | null;
  readonly expectedIntervalStartedAt?: string;
}

export interface DiagnosticReportInput {
  readonly category: DiagnosticCategory;
  readonly failureClass?: ProviderFailureClass;
  readonly logicalId?: string;
  readonly occurredAt: string;
  readonly operation: OperationCategory;
  readonly platform?: Platform;
  readonly handled: boolean;
  readonly error: { readonly name: string; readonly stack?: string };
}

export interface DeliverySummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly discarded: number;
  readonly failed: number;
  readonly released: number;
  readonly skipped: number;
}

export interface CaptureEvent {
  readonly distinctId: string;
  readonly event: string;
  readonly properties: Record<string, unknown>;
  readonly eventUuid: string;
  readonly timestamp: string;
}

export type CaptureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: string; readonly retryable: boolean };

export interface CaptureTransport {
  capture(event: CaptureEvent): Promise<CaptureResult>;
}

export interface ReportingCategoryStatus {
  readonly requested: boolean;
  readonly effective: boolean;
  readonly reason: ReportingCategoryReason;
  readonly decidedAt: string | null;
  readonly disclosureVersion: number | null;
  readonly intervalStartedAt: string | null;
}

export interface ReportingPolicySnapshot {
  readonly disclosureVersion: number;
  readonly destinationConfigured: boolean;
  readonly operatorForcedOff: boolean;
  readonly categories: Record<ReportingCategory, ReportingCategoryStatus>;
  readonly installationReportingId: string | null;
}

export type FeedbackDeliveryStatus = "not_shared" | "not_recorded" | "pending" | "delivered";

export interface ReportingFeedbackState {
  readonly shared: boolean;
  readonly discoverySource: DiscoverySource | null;
  readonly submittedAt: string | null;
  readonly deliveryStatus: FeedbackDeliveryStatus;
}
