import { Context, Effect, Layer } from "effect";
import type { DatabaseError } from "@meltiply/domain";

import type { ReportingConfiguration } from "./configuration";
import { reportedAppVersion } from "./configuration";
import {
  isProviderFailureClass,
  REPORTING_CATEGORIES,
  REPORTING_DELIVERY_BUDGET_MILLISECONDS,
  REPORTING_DISCLOSURE_VERSION,
  REPORTING_MAX_DELIVERY_BATCH,
  REPORTING_MAX_DIAGNOSTICS_PER_HOUR,
  REPORTING_SCHEMA_VERSION,
  type CaptureEvent,
  type CaptureTransport,
  type DeliverySummary,
  type DiagnosticReportInput,
  type DiscoverySource,
  type FeedbackDeliveryStatus,
  type ReportingFeedbackState,
  type ReportingPolicySnapshot,
  type UsageReportInput,
} from "./contracts";
import {
  categoryEffective,
  feedbackEffective,
  isoOrNull,
  policySnapshot,
  retryDelaySeconds,
  type PreferencesRow,
} from "./policy";
import {
  createPostgresReportingRepository,
  loadPreferences,
  lockReportingMeasurement,
  type ReportingFeedbackRow,
  type ReportingRepository,
} from "./repository";
import {
  diagnosticProperties,
  feedbackProperties,
  payloadViolation,
  REPORTING_EVENTS,
  usageProperties,
} from "./sanitize";
import { CAPTURE_TIMEOUT_MILLISECONDS } from "./transport";

export { loadPreferences, lockReportingMeasurement };

/** Minimal driver result shape; a `pg` QueryResult satisfies it structurally. */
export interface ReportingQueryResult<Row> {
  readonly rowCount: number | null;
  readonly rows: Row[];
}

/** Minimal Effect-native query client the reporting module needs. */
export interface ReportingClient {
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Effect.Effect<ReportingQueryResult<Row>, DatabaseError>;
}

/**
 * Runs one operation against a system-scoped transaction.
 *
 * The worker supplies its own adapter, so this package never reads environment
 * bindings, never owns a connection pool and never constructs a driver client.
 * Outbound HTTP happens between transactions, never inside one.
 */
export type ReportingTransactionRunner = <A, E>(
  operation: (client: ReportingClient) => Effect.Effect<A, E>,
) => Effect.Effect<A, E | DatabaseError>;

export interface ReportingServiceShape {
  readonly policy: () => Effect.Effect<ReportingPolicySnapshot, DatabaseError>;
  readonly setPreferences: (input: {
    readonly diagnostics: boolean;
    readonly usage: boolean;
  }) => Effect.Effect<
    { readonly changed: boolean; readonly policy: ReportingPolicySnapshot },
    DatabaseError
  >;
  readonly feedbackState: () => Effect.Effect<ReportingFeedbackState, DatabaseError>;
  readonly submitFeedback: (
    source: DiscoverySource,
  ) => Effect.Effect<ReportingFeedbackState, DatabaseError>;
  readonly enqueueUsageReport: (
    input: UsageReportInput,
  ) => Effect.Effect<"queued" | "skipped", DatabaseError>;
  readonly enqueueDiagnostic: (
    input: DiagnosticReportInput,
  ) => Effect.Effect<"queued" | "skipped", DatabaseError>;
  readonly deliverPending: (options?: {
    readonly budgetMilliseconds?: number;
    readonly limit?: number;
  }) => Effect.Effect<DeliverySummary, DatabaseError>;
}

/** Effect service tag for installation improvement reporting. */
export class ReportingService extends Context.Service<ReportingService, ReportingServiceShape>()(
  "ReportingService",
) {}

/** Options for the live layer. */
export interface ReportingServiceOptions {
  readonly configuration: ReportingConfiguration;
  readonly appVersion: string | undefined;
  readonly transport: CaptureTransport | null;
  readonly transaction?: ReportingTransactionRunner;
  readonly repository?: ReportingRepository;
  readonly now?: () => Date;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function feedbackStateFrom(
  row: ReportingFeedbackRow | null,
  deliveryStatus: FeedbackDeliveryStatus,
): ReportingFeedbackState {
  return {
    deliveryStatus: row ? deliveryStatus : "not_shared",
    discoverySource: row ? (row.discovery_source as DiscoverySource) : null,
    shared: row?.shared === true,
    submittedAt: row ? isoOrNull(row.submitted_at) : null,
  };
}

function usageLogicalId(intervalStartedAt: string | null, reportDate: string): string {
  return `${intervalStartedAt ?? "unstarted"}:${reportDate}`;
}

function hourBucket(occurredAt: string, now: () => Date): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return now().toISOString().slice(0, 13);
  return date.toISOString().slice(0, 13);
}

/**
 * Creates the live reporting service.
 *
 * All reads and writes go through the caller's repository or system transaction
 * adapter. The persisted policy is re-read inside the write transaction for
 * preference changes and inside a fresh transaction before each send, which is
 * what makes a withdrawn or operator-disabled category stop transmitting immediately.
 */
export function createReportingServiceLive(
  options: ReportingServiceOptions,
): Layer.Layer<ReportingService, never, never> {
  const { configuration } = options;
  const repository =
    options.repository ??
    (() => {
      if (!options.transaction) {
        throw new TypeError("ReportingServiceOptions requires either repository or transaction.");
      }
      return createPostgresReportingRepository(options.transaction);
    })();
  const now = options.now ?? (() => new Date());
  const transport = options.transport;
  const appVersion = reportedAppVersion(options.appVersion);

  const policyProgram = Effect.flatMap(
    repository.transaction((tx) => tx.loadPreferences(false)),
    (row) => Effect.succeed(policySnapshot(row, configuration)),
  );

  const sendCapture = (
    event: CaptureEvent,
  ): Effect.Effect<{
    readonly ok: boolean;
    readonly errorCode?: string;
    readonly retryable?: boolean;
  }> =>
    Effect.gen(function* () {
      if (!transport) return { ok: false, errorCode: "destination_unavailable", retryable: false };
      const violation = payloadViolation(event.properties);
      if (violation) return { ok: false, errorCode: violation, retryable: false };
      return yield* Effect.promise(() => transport.capture(event));
    });

  const service: ReportingServiceShape = {
    policy: () => policyProgram,

    setPreferences: (input) =>
      repository.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.lockMutations();
          const current = yield* tx.loadPreferences(true);
          const nextUsage = input.usage === true;
          const nextDiagnostics = input.diagnostics === true;
          const wasUsage = current?.usage_requested === true;
          const wasDiagnostics = current?.diagnostics_requested === true;
          const decidedAt = now();
          const installationId =
            current?.installation_reporting_id ??
            (nextUsage || nextDiagnostics ? crypto.randomUUID() : null);
          const usageInterval = nextUsage
            ? wasUsage
              ? current?.usage_interval_started_at
              : decidedAt
            : null;
          const diagnosticsInterval = nextDiagnostics
            ? wasDiagnostics
              ? current?.diagnostics_interval_started_at
              : decidedAt
            : null;
          const usageDecided = current === null || wasUsage !== nextUsage;
          const diagnosticsDecided = current === null || wasDiagnostics !== nextDiagnostics;
          const usageDecidedAt = usageDecided ? decidedAt : (current?.usage_decided_at ?? null);
          const diagnosticsDecidedAt = diagnosticsDecided
            ? decidedAt
            : (current?.diagnostics_decided_at ?? null);
          const usageDisclosureVersion = usageDecided
            ? REPORTING_DISCLOSURE_VERSION
            : (current?.usage_disclosure_version ?? null);
          const diagnosticsDisclosureVersion = diagnosticsDecided
            ? REPORTING_DISCLOSURE_VERSION
            : (current?.diagnostics_disclosure_version ?? null);

          const stored: PreferencesRow = {
            diagnostics_decided_at: diagnosticsDecidedAt,
            diagnostics_disclosure_version: diagnosticsDisclosureVersion,
            diagnostics_interval_started_at: diagnosticsInterval,
            diagnostics_requested: nextDiagnostics,
            installation_reporting_id: installationId,
            schema_version: REPORTING_SCHEMA_VERSION,
            usage_decided_at: usageDecidedAt,
            usage_disclosure_version: usageDisclosureVersion,
            usage_interval_started_at: usageInterval,
            usage_requested: nextUsage,
          };

          yield* tx.savePreferences(stored);

          for (const category of REPORTING_CATEGORIES) {
            const turnedOff =
              (category === "usage" && wasUsage && !nextUsage) ||
              (category === "diagnostics" && wasDiagnostics && !nextDiagnostics);
            if (!turnedOff) continue;
            yield* tx.discardPendingByCategory(category, "withdrawn");
          }

          const changed =
            current === null || wasUsage !== nextUsage || wasDiagnostics !== nextDiagnostics;
          return { changed, policy: policySnapshot(stored, configuration) };
        }),
      ),

    feedbackState: () =>
      repository.transaction((tx) =>
        Effect.gen(function* () {
          const row = yield* tx.loadFeedback(false);
          const deliveryStatus = row
            ? yield* tx.feedbackDeliveryStatus(row.response_id)
            : ("not_recorded" as const);
          return feedbackStateFrom(row, deliveryStatus);
        }),
      ),

    submitFeedback: (source) =>
      repository.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.lockMutations();
          const existing = yield* tx.loadFeedback(true);
          const shareable = source !== "prefer_not_to_say";
          if (existing) {
            const deliveryStatus = yield* tx.feedbackDeliveryStatus(existing.response_id);
            return feedbackStateFrom(existing, deliveryStatus);
          }
          const responseId = crypto.randomUUID();
          const decidedAt = now();
          yield* tx.insertFeedback({
            discovery_source: source,
            response_id: responseId,
            schema_version: REPORTING_SCHEMA_VERSION,
            shared: shareable,
            submitted_at: decidedAt,
          });
          if (!shareable || !feedbackEffective(configuration)) {
            return feedbackStateFrom(
              {
                discovery_source: source,
                response_id: responseId,
                shared: shareable,
                submitted_at: decidedAt,
              },
              "not_recorded",
            );
          }
          yield* tx.enqueueFeedbackPending({
            category: "feedback",
            distinctId: responseId,
            eventName: REPORTING_EVENTS.feedback,
            eventTimestamp: decidedAt,
            intervalStartedAt: decidedAt.toISOString(),
            logicalId: responseId,
            payload: feedbackProperties(source, {
              appVersion,
              deploymentCategory: configuration.deploymentCategory,
            }),
          });
          return feedbackStateFrom(
            {
              discovery_source: source,
              response_id: responseId,
              shared: true,
              submitted_at: decidedAt,
            },
            "pending",
          );
        }),
      ),

    enqueueUsageReport: (input) =>
      repository.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.lockMutations();
          const row = yield* tx.loadPreferences(false);
          const policy = policySnapshot(row, configuration);
          if (!categoryEffective(policy, "usage")) return "skipped" as const;
          const installationId = policy.installationReportingId;
          if (!installationId) return "skipped" as const;
          const intervalStartedAt = policy.categories.usage.intervalStartedAt;
          if (!intervalStartedAt) return "skipped" as const;
          if (
            input.expectedIntervalStartedAt !== undefined &&
            input.expectedIntervalStartedAt !== intervalStartedAt
          ) {
            return "skipped" as const;
          }
          const payload = usageProperties(input, {
            appVersion,
            deploymentCategory: configuration.deploymentCategory,
          });
          if (payloadViolation(payload)) return "skipped" as const;
          const inserted = yield* tx.insertBoundedPending({
            category: "usage",
            distinctId: installationId,
            eventName: REPORTING_EVENTS.usage,
            eventTimestamp: now(),
            intervalStartedAt,
            logicalId: usageLogicalId(intervalStartedAt, input.reportDate),
            payload,
          });
          return inserted ? ("queued" as const) : ("skipped" as const);
        }),
      ),

    enqueueDiagnostic: (input) =>
      repository.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.lockMutations();
          const row = yield* tx.loadPreferences(false);
          const policy = policySnapshot(row, configuration);
          if (!categoryEffective(policy, "diagnostics")) return "skipped" as const;
          const installationId = policy.installationReportingId;
          if (!installationId) return "skipped" as const;
          const intervalStartedAt = policy.categories.diagnostics.intervalStartedAt;
          if (!intervalStartedAt) return "skipped" as const;
          const recent = yield* tx.countRecentDiagnostics();
          if (recent >= REPORTING_MAX_DIAGNOSTICS_PER_HOUR) {
            return "skipped" as const;
          }
          const properties = diagnosticProperties(input, {
            appVersion,
            deploymentCategory: configuration.deploymentCategory,
          });
          if (payloadViolation(properties)) return "skipped" as const;
          const failureClass =
            input.category === "provider_failure" && isProviderFailureClass(input.failureClass)
              ? input.failureClass
              : "";
          const logicalId =
            input.logicalId ??
            `${intervalStartedAt}:${input.category}:${input.operation}:${
              input.platform ?? "none"
            }:${typeof input.error?.name === "string" ? input.error.name.slice(0, 40) : "Error"}${
              failureClass ? `:${failureClass}` : ""
            }:${hourBucket(input.occurredAt, now)}`;
          const occurredAt = new Date(input.occurredAt);
          const inserted = yield* tx.insertBoundedPending({
            category: "diagnostics",
            distinctId: installationId,
            eventName: REPORTING_EVENTS.diagnostics,
            eventTimestamp: Number.isNaN(occurredAt.getTime()) ? now() : occurredAt,
            intervalStartedAt,
            logicalId,
            payload: properties,
          });
          return inserted ? ("queued" as const) : ("skipped" as const);
        }),
      ),

    deliverPending: (deliveryOptions) =>
      Effect.gen(function* () {
        const limit = Math.min(
          Math.max(deliveryOptions?.limit ?? REPORTING_MAX_DELIVERY_BATCH, 1),
          REPORTING_MAX_DELIVERY_BATCH,
        );
        const budgetMilliseconds = Math.min(
          Math.max(
            deliveryOptions?.budgetMilliseconds ?? REPORTING_DELIVERY_BUDGET_MILLISECONDS,
            1_000,
          ),
          REPORTING_DELIVERY_BUDGET_MILLISECONDS,
        );
        const startedAt = now().getTime();
        const elapsed = () => now().getTime() - startedAt;
        const expired = yield* repository.transaction((tx) => tx.expirePendingReports());
        const claimed = yield* repository.transaction((tx) => tx.claimPendingReports(limit));

        let delivered = 0;
        let failed = 0;
        let skipped = 0;
        let discarded = 0;
        let released = 0;
        for (const [index, row] of claimed.entries()) {
          if (elapsed() + CAPTURE_TIMEOUT_MILLISECONDS > budgetMilliseconds) {
            const unprocessed = claimed.slice(index);
            yield* repository.transaction((tx) =>
              Effect.gen(function* () {
                for (const entry of unprocessed) {
                  released += yield* tx.releaseLeasedPending(entry.id, entry.lease_token);
                }
              }),
            );
            break;
          }
          const decision = yield* repository.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.lockMutations();
              const current = yield* tx.loadPendingForUpdate(row.id);
              if (
                !current ||
                current.state !== "leased" ||
                current.lease_token !== row.lease_token
              ) {
                return "lost" as const;
              }
              const preferences = yield* tx.loadPreferences(false);
              const policy = policySnapshot(preferences, configuration);
              if (current.category === "feedback") {
                return feedbackEffective(configuration)
                  ? ("permitted" as const)
                  : ("revoked" as const);
              }
              if (!categoryEffective(policy, current.category)) return "revoked" as const;
              const liveInterval = policy.categories[current.category].intervalStartedAt;
              const rowInterval = isoOrNull(current.interval_started_at);
              if (rowInterval === null || liveInterval !== rowInterval) {
                return "stale_interval" as const;
              }
              return "permitted" as const;
            }),
          );
          if (decision === "lost") {
            skipped += 1;
            continue;
          }
          if (decision !== "permitted") {
            discarded += 1;
            yield* repository.transaction((tx) =>
              tx.markPendingDiscarded(
                row.id,
                row.lease_token,
                decision === "revoked" ? "policy_revoked" : "stale_interval",
              ),
            );
            continue;
          }
          const properties = payloadRecord(row.payload);
          const result = yield* sendCapture({
            distinctId: row.distinct_id,
            event: row.event_name,
            eventUuid: row.event_uuid,
            properties,
            timestamp:
              row.event_timestamp instanceof Date
                ? row.event_timestamp.toISOString()
                : new Date(row.event_timestamp).toISOString(),
          });
          if (result.ok) {
            delivered += 1;
            yield* repository.transaction((tx) => tx.markPendingSent(row.id, row.lease_token));
            continue;
          }
          const expiresAt =
            row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
          const delay =
            result.retryable === true ? retryDelaySeconds(row.attempts, expiresAt, now()) : null;
          if (delay === null) {
            discarded += 1;
            yield* repository.transaction((tx) =>
              tx.markPendingDiscarded(
                row.id,
                row.lease_token,
                result.errorCode ?? "delivery_failed",
              ),
            );
            continue;
          }
          failed += 1;
          yield* repository.transaction((tx) =>
            tx.reschedulePending(
              row.id,
              row.lease_token,
              result.errorCode ?? "delivery_failed",
              delay,
            ),
          );
        }
        yield* repository.transaction((tx) => tx.pruneTerminalReports());
        skipped += claimed.length === 0 ? 1 : 0;
        return {
          claimed: claimed.length,
          delivered,
          discarded: discarded + expired,
          failed,
          released,
          skipped,
        } satisfies DeliverySummary;
      }),
  };

  return Layer.succeed(ReportingService, service);
}

/** Builds a test Layer; unprovided methods die rather than silently accepting work. */
export function createReportingServiceTest(
  impl: Partial<ReportingServiceShape> = {},
): Layer.Layer<ReportingService, never, never> {
  const unstubbed = () => Effect.die(new Error("Unexpected ReportingService call"));
  return Layer.succeed(ReportingService, {
    deliverPending: unstubbed,
    enqueueDiagnostic: unstubbed,
    enqueueUsageReport: unstubbed,
    feedbackState: unstubbed,
    policy: unstubbed,
    setPreferences: unstubbed,
    submitFeedback: unstubbed,
    ...impl,
  });
}
