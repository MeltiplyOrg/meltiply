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
  REPORTING_MAX_PENDING_AGE_DAYS,
  REPORTING_MAX_PENDING_ROWS,
  REPORTING_SCHEMA_VERSION,
  type CaptureEvent,
  type CaptureTransport,
  type DeliverySummary,
  type DiagnosticReportInput,
  type DiscoverySource,
  type FeedbackDeliveryStatus,
  type PendingReportCategory,
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
  diagnosticProperties,
  feedbackProperties,
  payloadViolation,
  REPORTING_EVENTS,
  usageProperties,
} from "./sanitize";
import { CAPTURE_TIMEOUT_MILLISECONDS } from "./transport";

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

interface PendingRow extends Record<string, unknown> {
  attempts: number;
  category: PendingReportCategory;
  distinct_id: string;
  event_name: string;
  event_timestamp: Date | string;
  event_uuid: string;
  expires_at: Date | string;
  id: string;
  interval_started_at: Date | string | null;
  lease_token: string | null;
  logical_id: string;
  payload: Record<string, unknown>;
}

interface FeedbackRow extends Record<string, unknown> {
  discovery_source: string;
  response_id: string;
  shared: boolean;
  submitted_at: Date | string;
}

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
  readonly transaction: ReportingTransactionRunner;
  readonly now?: () => Date;
}

const reportingMutationLockKey = 810_000_101;

function lockReportingMutations(client: ReportingClient): Effect.Effect<void, DatabaseError> {
  return Effect.asVoid(
    client.query("SELECT pg_advisory_xact_lock($1)", [reportingMutationLockKey]),
  );
}

const reportingMeasurementLockKey = 810_000_102;

/**
 * Takes the publication-measurement lock for the rest of the transaction.
 *
 * Exported because the in-transaction measurement and the scheduled producer must
 * share one lock identity; a second constant would silently stop ordering them.
 */
export function lockReportingMeasurement(
  client: ReportingClient,
): Effect.Effect<void, DatabaseError> {
  return Effect.asVoid(
    client.query("SELECT pg_advisory_xact_lock($1)", [reportingMeasurementLockKey]),
  );
}

function pruneTerminalReports(client: ReportingClient): Effect.Effect<number, DatabaseError> {
  return Effect.map(
    client.query(
      `WITH pruned AS (
         DELETE FROM reporting_pending_reports
         WHERE id IN (
           SELECT id FROM reporting_pending_reports
           WHERE state IN ('sent', 'discarded')
             AND updated_at <= now() - INTERVAL '1 hour'
           ORDER BY updated_at
           LIMIT 500
         )
         RETURNING category, logical_id, event_uuid, event_timestamp, state
       ), receipted AS (
         INSERT INTO reporting_delivery_receipts (
           category, logical_id, event_uuid, event_timestamp, state
         )
         SELECT category, logical_id, event_uuid, event_timestamp, state FROM pruned
         ON CONFLICT (category, logical_id) DO NOTHING
         RETURNING logical_id
       )
       SELECT (SELECT count(*) FROM pruned)::text AS pruned`,
    ),
    (result) => Number(result.rows[0]?.pruned ?? "0"),
  );
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

const LOAD_PREFERENCES_SQL = `SELECT diagnostics_decided_at, diagnostics_disclosure_version,
              diagnostics_interval_started_at, diagnostics_requested,
              installation_reporting_id, schema_version, usage_decided_at,
              usage_disclosure_version, usage_interval_started_at, usage_requested
       FROM reporting_preferences
       WHERE id`;

const LOAD_PREFERENCES_FOR_UPDATE_SQL = `${LOAD_PREFERENCES_SQL}
       FOR UPDATE`;

const LOAD_FEEDBACK_SQL = `SELECT discovery_source, response_id, shared, submitted_at
       FROM reporting_attribution_responses
       WHERE id`;

const LOAD_FEEDBACK_FOR_UPDATE_SQL = `${LOAD_FEEDBACK_SQL}
       FOR UPDATE`;

export function loadPreferences(
  client: ReportingClient,
  lock: boolean,
): Effect.Effect<PreferencesRow | null, DatabaseError> {
  return Effect.map(
    client.query<PreferencesRow>(lock ? LOAD_PREFERENCES_FOR_UPDATE_SQL : LOAD_PREFERENCES_SQL),
    (result) => result.rows[0] ?? null,
  );
}

function loadFeedback(
  client: ReportingClient,
  lock: boolean,
): Effect.Effect<FeedbackRow | null, DatabaseError> {
  return Effect.map(
    client.query<FeedbackRow>(lock ? LOAD_FEEDBACK_FOR_UPDATE_SQL : LOAD_FEEDBACK_SQL),
    (result) => result.rows[0] ?? null,
  );
}

function feedbackDeliveryStatus(
  client: ReportingClient,
  responseId: string | null,
): Effect.Effect<FeedbackDeliveryStatus, DatabaseError> {
  if (!responseId) return Effect.succeed("not_recorded");
  return Effect.map(
    client.query<{ state: string }>(
      `SELECT state FROM (
         SELECT state FROM reporting_pending_reports
         WHERE category = 'feedback' AND logical_id = $1
         UNION ALL
         SELECT state FROM reporting_delivery_receipts
         WHERE category = 'feedback' AND logical_id = $1
       ) AS states
       ORDER BY CASE state WHEN 'sent' THEN 0 ELSE 1 END
       LIMIT 1`,
      [responseId],
    ),
    (result) => {
      const state = result.rows[0]?.state;
      if (state === "sent") return "delivered";
      if (state === "pending" || state === "leased") return "pending";
      return "not_recorded";
    },
  );
}

function feedbackStateFrom(
  row: FeedbackRow | null,
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

function hourBucket(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 13);
  return date.toISOString().slice(0, 13);
}

/**
 * Creates the live reporting service.
 *
 * All reads and writes go through the caller's system transaction adapter. The
 * persisted policy is re-read inside the write transaction for preference
 * changes and inside a fresh transaction before each send, which is what makes a
 * withdrawn or operator-disabled category stop transmitting immediately.
 */
export function createReportingServiceLive(
  options: ReportingServiceOptions,
): Layer.Layer<ReportingService, never, never> {
  const { configuration, transaction } = options;
  const now = options.now ?? (() => new Date());
  const transport = options.transport;
  const appVersion = reportedAppVersion(options.appVersion);

  const policyProgram = Effect.flatMap(
    transaction((client) => loadPreferences(client, false)),
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
      transaction((client) =>
        Effect.gen(function* () {
          yield* lockReportingMutations(client);
          const current = yield* loadPreferences(client, true);
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

          yield* client.query(
            `INSERT INTO reporting_preferences (
               id, schema_version,
               usage_requested, usage_disclosure_version, usage_decided_at, usage_interval_started_at,
               diagnostics_requested, diagnostics_disclosure_version, diagnostics_decided_at,
               diagnostics_interval_started_at, installation_reporting_id, updated_at
             )
             VALUES (TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
             ON CONFLICT (id) DO UPDATE SET
               schema_version = EXCLUDED.schema_version,
               usage_requested = EXCLUDED.usage_requested,
               usage_disclosure_version = EXCLUDED.usage_disclosure_version,
               usage_decided_at = EXCLUDED.usage_decided_at,
               usage_interval_started_at = EXCLUDED.usage_interval_started_at,
               diagnostics_requested = EXCLUDED.diagnostics_requested,
               diagnostics_disclosure_version = EXCLUDED.diagnostics_disclosure_version,
               diagnostics_decided_at = EXCLUDED.diagnostics_decided_at,
               diagnostics_interval_started_at = EXCLUDED.diagnostics_interval_started_at,
               installation_reporting_id = EXCLUDED.installation_reporting_id,
               updated_at = now()`,
            [
              REPORTING_SCHEMA_VERSION,
              nextUsage,
              usageDisclosureVersion,
              usageDecidedAt,
              usageInterval,
              nextDiagnostics,
              diagnosticsDisclosureVersion,
              diagnosticsDecidedAt,
              diagnosticsInterval,
              installationId,
            ],
          );

          for (const category of REPORTING_CATEGORIES) {
            const turnedOff =
              (category === "usage" && wasUsage && !nextUsage) ||
              (category === "diagnostics" && wasDiagnostics && !nextDiagnostics);
            if (!turnedOff) continue;
            yield* client.query(
              `UPDATE reporting_pending_reports
               SET state = 'discarded', updated_at = now(), last_error_code = 'withdrawn'
               WHERE category = $1 AND state IN ('pending', 'leased')`,
              [category],
            );
          }

          const changed =
            current === null || wasUsage !== nextUsage || wasDiagnostics !== nextDiagnostics;
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
          return { changed, policy: policySnapshot(stored, configuration) };
        }),
      ),

    feedbackState: () =>
      transaction((client) =>
        Effect.gen(function* () {
          const row = yield* loadFeedback(client, false);
          const deliveryStatus = yield* feedbackDeliveryStatus(client, row?.response_id ?? null);
          return feedbackStateFrom(row, deliveryStatus);
        }),
      ),

    submitFeedback: (source) =>
      transaction((client) =>
        Effect.gen(function* () {
          yield* lockReportingMutations(client);
          const existing = yield* loadFeedback(client, true);
          const shareable = source !== "prefer_not_to_say";
          if (existing) {
            const deliveryStatus = yield* feedbackDeliveryStatus(client, existing.response_id);
            return feedbackStateFrom(existing, deliveryStatus);
          }
          const responseId = crypto.randomUUID();
          const decidedAt = now();
          yield* client.query(
            `INSERT INTO reporting_attribution_responses (
               id, response_id, discovery_source, shared, schema_version, submitted_at
             ) VALUES (TRUE, $1, $2, $3, $4, $5)`,
            [responseId, source, shareable, REPORTING_SCHEMA_VERSION, decidedAt],
          );
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
          yield* enqueuePending(client, {
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
      transaction((client) =>
        Effect.gen(function* () {
          yield* lockReportingMutations(client);
          const row = yield* loadPreferences(client, false);
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
          const inserted = yield* insertPending(client, {
            category: "usage",
            distinctId: installationId,
            eventName: REPORTING_EVENTS.usage,
            eventTimestamp: now(),
            intervalStartedAt,
            logicalId: usageLogicalId(intervalStartedAt, input.reportDate),
            payload: usageProperties(input, {
              appVersion,
              deploymentCategory: configuration.deploymentCategory,
            }),
          });
          return inserted ? ("queued" as const) : ("skipped" as const);
        }),
      ),

    enqueueDiagnostic: (input) =>
      transaction((client) =>
        Effect.gen(function* () {
          yield* lockReportingMutations(client);
          const row = yield* loadPreferences(client, false);
          const policy = policySnapshot(row, configuration);
          if (!categoryEffective(policy, "diagnostics")) return "skipped" as const;
          const installationId = policy.installationReportingId;
          if (!installationId) return "skipped" as const;
          const intervalStartedAt = policy.categories.diagnostics.intervalStartedAt;
          if (!intervalStartedAt) return "skipped" as const;
          const recent = yield* client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM reporting_pending_reports
             WHERE category = 'diagnostics' AND created_at > now() - INTERVAL '1 hour'`,
          );
          if (Number(recent.rows[0]?.count ?? "0") >= REPORTING_MAX_DIAGNOSTICS_PER_HOUR) {
            return "skipped" as const;
          }
          const properties = diagnosticProperties(input, {
            appVersion,
            deploymentCategory: configuration.deploymentCategory,
          });
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
            }:${hourBucket(input.occurredAt)}`;
          const occurredAt = new Date(input.occurredAt);
          const inserted = yield* insertPending(client, {
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
        const expired = yield* transaction((client) =>
          Effect.map(
            client.query(
              `UPDATE reporting_pending_reports
               SET state = 'discarded', updated_at = now(), last_error_code = 'expired'
               WHERE state IN ('pending', 'leased')
                 AND expires_at <= now()
               RETURNING id`,
            ),
            (result) => result.rowCount ?? result.rows.length,
          ),
        );
        const claimed = yield* transaction((client) =>
          client
            .query<PendingRow>(
              `WITH candidates AS (
                 SELECT id FROM reporting_pending_reports
                 WHERE (
                         (state = 'pending' AND available_at <= now())
                         OR (state = 'leased' AND lease_expires_at <= now())
                       )
                   AND expires_at > now()
                 ORDER BY available_at, created_at, id
                 LIMIT $1
                 FOR UPDATE SKIP LOCKED
               )
               UPDATE reporting_pending_reports AS report
               SET state = 'leased',
                   attempts = report.attempts + 1,
                   lease_token = gen_random_uuid(),
                   lease_expires_at = now() + INTERVAL '120 seconds',
                   updated_at = now()
               FROM candidates
               WHERE report.id = candidates.id
               RETURNING report.id, report.category, report.logical_id, report.event_name,
                         report.event_uuid, report.event_timestamp, report.distinct_id,
                         report.payload, report.attempts, report.expires_at,
                         report.interval_started_at, report.lease_token`,
              [limit],
            )
            .pipe(Effect.map((result) => result.rows)),
        );

        let delivered = 0;
        let failed = 0;
        let skipped = 0;
        let discarded = 0;
        let released = 0;
        for (const [index, row] of claimed.entries()) {
          if (elapsed() + CAPTURE_TIMEOUT_MILLISECONDS > budgetMilliseconds) {
            const unprocessed = claimed.slice(index);
            yield* transaction((client) =>
              Effect.gen(function* () {
                for (const entry of unprocessed) {
                  const result = yield* client.query(
                    `UPDATE reporting_pending_reports
                     SET state = 'pending', lease_token = NULL, lease_expires_at = NULL,
                         attempts = GREATEST(attempts - 1, 0), updated_at = now()
                     WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
                    [entry.id, entry.lease_token],
                  );
                  released += result.rowCount ?? result.rows.length;
                }
              }),
            );
            break;
          }
          const decision = yield* transaction((client) =>
            Effect.gen(function* () {
              yield* lockReportingMutations(client);
              const live = yield* client.query<{
                category: PendingReportCategory;
                interval_started_at: Date | string | null;
                lease_token: string | null;
                state: string;
              }>(
                `SELECT category, interval_started_at, lease_token, state
                 FROM reporting_pending_reports WHERE id = $1 FOR UPDATE`,
                [row.id],
              );
              const current = live.rows[0];
              if (
                !current ||
                current.state !== "leased" ||
                current.lease_token !== row.lease_token
              ) {
                return "lost" as const;
              }
              const preferences = yield* loadPreferences(client, false);
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
            yield* transaction((client) =>
              client.query(
                `UPDATE reporting_pending_reports
                 SET state = 'discarded', updated_at = now(), last_error_code = $3,
                     lease_token = NULL, lease_expires_at = NULL
                 WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
                [
                  row.id,
                  row.lease_token,
                  decision === "revoked" ? "policy_revoked" : "stale_interval",
                ],
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
            yield* transaction((client) =>
              client.query(
                `UPDATE reporting_pending_reports
                 SET state = 'sent', updated_at = now(), last_error_code = NULL,
                     lease_token = NULL, lease_expires_at = NULL
                 WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
                [row.id, row.lease_token],
              ),
            );
            continue;
          }
          const expiresAt =
            row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
          const delay =
            result.retryable === true ? retryDelaySeconds(row.attempts, expiresAt, now()) : null;
          if (delay === null) {
            discarded += 1;
            yield* transaction((client) =>
              client.query(
                `UPDATE reporting_pending_reports
                 SET state = 'discarded', updated_at = now(), last_error_code = $3,
                     lease_token = NULL, lease_expires_at = NULL
                 WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
                [row.id, row.lease_token, result.errorCode ?? "delivery_failed"],
              ),
            );
            continue;
          }
          failed += 1;
          yield* transaction((client) =>
            client.query(
              `UPDATE reporting_pending_reports
               SET state = 'pending', updated_at = now(), last_error_code = $3,
                   available_at = now() + ($4 * INTERVAL '1 second'),
                   lease_token = NULL, lease_expires_at = NULL
               WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
              [row.id, row.lease_token, result.errorCode ?? "delivery_failed", delay],
            ),
          );
        }
        yield* transaction((client) => pruneTerminalReports(client));
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

interface PendingInsert {
  category: PendingReportCategory;
  distinctId: string;
  eventName: string;
  eventTimestamp: Date;
  intervalStartedAt: string;
  logicalId: string;
  payload: Record<string, unknown>;
}

function insertPending(
  client: ReportingClient,
  input: PendingInsert,
): Effect.Effect<boolean, DatabaseError> {
  if (payloadViolation(input.payload)) return Effect.succeed(false);
  return Effect.map(
    client.query(
      `INSERT INTO reporting_pending_reports (
         category, logical_id, event_name, schema_version, event_uuid, event_timestamp,
         distinct_id, payload, interval_started_at, expires_at
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
              now() + ($10 * INTERVAL '1 day')
       WHERE NOT EXISTS (
         SELECT 1 FROM reporting_delivery_receipts WHERE category = $1 AND logical_id = $2
       )
         AND (
           SELECT count(*) FROM reporting_pending_reports WHERE state IN ('pending', 'leased')
         ) < $11
       ON CONFLICT (category, logical_id) DO NOTHING
       RETURNING id`,
      [
        input.category,
        input.logicalId,
        input.eventName,
        REPORTING_SCHEMA_VERSION,
        crypto.randomUUID(),
        input.eventTimestamp,
        input.distinctId,
        JSON.stringify(input.payload),
        input.intervalStartedAt,
        REPORTING_MAX_PENDING_AGE_DAYS,
        REPORTING_MAX_PENDING_ROWS,
      ],
    ),
    (result) => (result.rowCount ?? result.rows.length) > 0,
  );
}

function enqueuePending(
  client: ReportingClient,
  input: PendingInsert,
): Effect.Effect<boolean, DatabaseError> {
  return Effect.map(
    client.query(
      `INSERT INTO reporting_pending_reports (
         category, logical_id, event_name, schema_version, event_uuid, event_timestamp,
         distinct_id, payload, interval_started_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
                 now() + ($10 * INTERVAL '1 day'))
       ON CONFLICT (category, logical_id) DO NOTHING
       RETURNING id`,
      [
        input.category,
        input.logicalId,
        input.eventName,
        REPORTING_SCHEMA_VERSION,
        crypto.randomUUID(),
        input.eventTimestamp,
        input.distinctId,
        JSON.stringify(input.payload),
        input.intervalStartedAt,
        REPORTING_MAX_PENDING_AGE_DAYS,
      ],
    ),
    (result) => (result.rowCount ?? result.rows.length) > 0,
  );
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
