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

/** Pending row as the delivery pass reads it. */
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

/** Feedback row as the feedback surface reads it. */
interface FeedbackRow extends Record<string, unknown> {
  discovery_source: string;
  response_id: string;
  shared: boolean;
  submitted_at: Date | string;
}

export interface ReportingServiceShape {
  /** Current policy for any authenticated member. */
  readonly policy: () => Effect.Effect<ReportingPolicySnapshot, DatabaseError>;
  /** Applies the Owner's requested choices and returns the effective policy. */
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
  /** Deployment configuration resolved from the invocation's bindings. */
  readonly configuration: ReportingConfiguration;
  /** Application version reported with each event. */
  readonly appVersion: string | undefined;
  /** Capture transport; absent means no destination or no transport available. */
  readonly transport: CaptureTransport | null;
  /** Worker-supplied system transaction adapter. */
  readonly transaction: ReportingTransactionRunner;
  /** Injectable clock so tests can freeze intervals, expiry and retry windows. */
  readonly now?: () => Date;
}

const emptySummary: DeliverySummary = {
  claimed: 0,
  delivered: 0,
  discarded: 0,
  failed: 0,
  released: 0,
  skipped: 0,
};

/**
 * Transaction-scoped advisory lock serializing every reporting mutation.
 *
 * The preference row, the attribution singleton and the pending queue are
 * installation-wide single rows/tables, so `SELECT ... FOR UPDATE` on an absent
 * row locks nothing. One constant key therefore serializes the read-then-write
 * sequences that must not interleave: two concurrent first decisions, two
 * concurrent first attribution submissions, an enqueue racing a withdrawal's
 * discard, and the pending-cap check against concurrent inserts.
 */
const reportingMutationLockKey = 810_000_101;

/** Takes the reporting mutation lock for the rest of the transaction. */
function lockReportingMutations(
  client: ReportingClient,
): Effect.Effect<void, DatabaseError> {
  return Effect.asVoid(client.query("SELECT pg_advisory_xact_lock($1)", [reportingMutationLockKey]));
}

/**
 * Deletes terminal rows' payloads and rows themselves once they are old enough
 * to be off any retry path, keeping only the minimal delivery receipt.
 *
 * Payload retention is what the seven-day optional-data rule is really about: a
 * sent or discarded row that kept its payload forever would hold data beyond its
 * window and let the pending cap be circumvented one row at a time. Receipts keep
 * the frozen identity so the same logical report is never re-created and re-sent
 * after pruning.
 */
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

/** Converts a database payload column into a plain property record. */
function payloadRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Reads the singleton preference row through a caller-supplied client.
 *
 * Exported because every producer that gates on consent — the service itself, the
 * in-transaction publication measurement, and the daily usage producer — must read
 * exactly these columns. A second projection is how the per-category disclosure
 * versions went missing once already, and the resulting gate would authorize a
 * send the service refuses.
 *
 * @param client - Active client, either a transaction or the caller's own.
 * @param lock - Whether to take the row lock (mutations only).
 * @returns Effect resolving the row, or null when no choice was ever saved.
 */
export function loadPreferences(
  client: ReportingClient,
  lock: boolean,
): Effect.Effect<PreferencesRow | null, DatabaseError> {
  return Effect.map(
    client.query<PreferencesRow>(
      `SELECT diagnostics_decided_at, diagnostics_disclosure_version,
              diagnostics_interval_started_at, diagnostics_requested,
              installation_reporting_id, schema_version, usage_decided_at,
              usage_disclosure_version, usage_interval_started_at, usage_requested
       FROM reporting_preferences
       WHERE id
       ${lock ? "FOR UPDATE" : ""}`,
    ),
    (result) => result.rows[0] ?? null,
  );
}

/** Reads the one-time attribution row, locking it for a submission. */
function loadFeedback(
  client: ReportingClient,
  lock: boolean,
): Effect.Effect<FeedbackRow | null, DatabaseError> {
  return Effect.map(
    client.query<FeedbackRow>(
      `SELECT discovery_source, response_id, shared, submitted_at
       FROM reporting_attribution_responses
       WHERE id
       ${lock ? "FOR UPDATE" : ""}`,
    ),
    (result) => result.rows[0] ?? null,
  );
}

/**
 * Reads the delivery state of the feedback pending row, if one exists.
 *
 * Terminal rows are pruned once their payload has outlived its window, so the
 * minimal receipt is the second source of truth: a pruned `sent` row still means
 * the destination accepted the answer, and a pruned `discarded` row still means
 * it was not delivered.
 *
 * @param client - Active system transaction client.
 * @param responseId - Recorded attribution response identity, if any.
 * @returns Honest delivery state for the surface.
 */
function feedbackDeliveryStatus(
  client: ReportingClient,
  responseId: string | null,
): Effect.Effect<FeedbackDeliveryStatus, DatabaseError> {
  if (!responseId) return Effect.succeed("not_recorded");
  return Effect.map(
    client.query<{ state: string }>(
      `SELECT state FROM reporting_pending_reports
       WHERE category = 'feedback' AND logical_id = $1
       UNION ALL
       SELECT state FROM reporting_delivery_receipts
       WHERE category = 'feedback' AND logical_id = $1
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

/** Projects the attribution row plus delivery state into the API shape. */
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

/** Builds the frozen logical identity of one daily usage summary. */
function usageLogicalId(intervalStartedAt: string | null, reportDate: string): string {
  return `${intervalStartedAt ?? "unstarted"}:${reportDate}`;
}

/** Buckets a diagnostic timestamp to the hour so a repeated failure is one report. */
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
 *
 * @param options - Configuration, transport, transaction adapter and clock.
 * @returns Layer providing `ReportingService` with `R = never`.
 */
export function createReportingServiceLive(
  options: ReportingServiceOptions,
): Layer.Layer<ReportingService, never, never> {
  const { configuration, transaction } = options;
  const now = options.now ?? (() => new Date());
  const transport = options.transport;
  const appVersion = reportedAppVersion(options.appVersion);

  /** Re-reads persisted policy inside a transaction and returns it. */
  const policyProgram = Effect.flatMap(
    transaction((client) => loadPreferences(client, false)),
    (row) => Effect.succeed(policySnapshot(row, configuration)),
  );

  /** Emits one capture attempt, sanitizing and validating first. */
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
          // Serialized with enqueue and delivery so a withdrawal's discard cannot
          // interleave with a producer that already read the old consent.
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
          // Re-enabling starts a new interval; staying enabled keeps the running
          // one so an unchanged decision never replays or re-windows activity.
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
          // A decision is recorded with time and disclosure version only when it
          // is actually made. Re-saving an unchanged choice must not silently
          // upgrade the stored consent to a disclosure the Owner never saw, nor
          // restate when the choice was made.
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

          // Withdrawal stops future reports and discards the unsent backlog for
          // that category, so a new choice takes effect instead of leaving a
          // hidden queue that would transmit hours later.
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
            current === null ||
            wasUsage !== nextUsage ||
            wasDiagnostics !== nextDiagnostics;
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
          // The attribution row is an installation-wide singleton, so a
          // non-existent row cannot be locked with FOR UPDATE. The advisory lock
          // makes two concurrent first submissions (with different idempotency
          // keys) converge on one recorded answer instead of racing the primary
          // key insert.
          yield* lockReportingMutations(client);
          const existing = yield* loadFeedback(client, true);
          // Shareable answers only. `prefer_not_to_say` records a local decision
          // and never produces an attribution event.
          const shareable = source !== "prefer_not_to_say";
          if (existing) {
            // A refresh or retry reuses the recorded logical identity instead of
            // creating a second response.
            const deliveryStatus = yield* feedbackDeliveryStatus(client, existing.response_id);
            return feedbackStateFrom(existing, deliveryStatus);
          }
          const responseId = crypto.randomUUID();
          const decidedAt = now();
          // The lock above guarantees the row is still absent here, so a plain
          // insert records exactly the answer this call returns. A conflict would
          // mean this response described an identity it never stored.
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
          // Serialized with preference changes: a withdrawal's discard and this
          // enqueue cannot interleave, so a row can never be written after the
          // consent it assumed was withdrawn.
          yield* lockReportingMutations(client);
          const row = yield* loadPreferences(client, false);
          const policy = policySnapshot(row, configuration);
          if (!categoryEffective(policy, "usage")) return "skipped" as const;
          const installationId = policy.installationReportingId;
          if (!installationId) return "skipped" as const;
          const intervalStartedAt = policy.categories.usage.intervalStartedAt;
          if (!intervalStartedAt) return "skipped" as const;
          // The producer computed these counters under one interval. If the Owner
          // withdrew or re-enabled since, the live interval differs and the
          // counters describe activity that consent no longer covers.
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
          // The logical identity is what collapses a repeating failure into one
          // pending row per hour. The Provider class joins it because two
          // expected conditions in the same hour — expired authorization and a
          // rate limit, say — are different facts, not a repeat of one. The
          // consent interval joins it too: after a withdrawal and re-enable in
          // the same hour, the previous interval's discarded row must not absorb
          // the newly consented failure.
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
            // The diagnostic keeps the instant it occurred, and the hour bucket
            // in the logical id makes a repeating failure one pending row.
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
        // Expiry is checked first: a row that outlived the seven-day window is
        // discarded, never sent late, and never blocks the queue.
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
        // A claim leases a row for longer than one invocation can hold it. Any
        // lease left behind by an interrupted invocation, a crash after the claim
        // committed, or a database failure is already expired by the time a later
        // pass runs, and must be reclaimed through the same frozen row rather than
        // waiting for the seven-day discard: the UUID and timestamp on the row are
        // what make the retry the same measurement instead of a second one.
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
        // One row at a time: the module's bounded delivery is a sequential pass so
        // two reports can never be in flight together and the invocation's shared
        // post-response budget is spent predictably.
        for (const [index, row] of claimed.entries()) {
          // A send costs up to the transport timeout. Claiming a row we then
          // cannot finish would strand it leased, so the pass stops before that
          // and releases everything it has not dispatched back to `pending`.
          if (elapsed() + CAPTURE_TIMEOUT_MILLISECONDS > budgetMilliseconds) {
            const unprocessed = claimed.slice(index);
            yield* transaction((client) =>
              Effect.gen(function* () {
                // Each release names the lease token it is giving back. A blanket
                // `id = ANY(...) AND state = 'leased'` would also match a row a
                // different pass had already reclaimed, handing that pass's
                // ownership to this one and letting two invocations decide the
                // same row. Rows whose token no longer matches are skipped, and
                // only the releases that actually happened are reported.
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
          // Every decision below is made from the row as it exists now, holding
          // its lease: a withdrawal that discarded this row, or a re-enable that
          // started a different interval, must win over the batch claimed before
          // it happened. The policy read and this fenced re-read share one
          // transaction so no preference change can slip between them.
          const decision = yield* transaction((client) =>
            Effect.gen(function* () {
              // The decision itself is serialized with preference changes: a
              // withdrawal either commits before this read (so the row and its
              // interval are already discarded/stale here) or after it. The
              // completion update below is fenced on the lease, so a withdrawal
              // that wins later is never overwritten by this pass.
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
              if (!current || current.state !== "leased" || current.lease_token !== row.lease_token) {
                return "lost" as const;
              }
              const preferences = yield* loadPreferences(client, false);
              const policy = policySnapshot(preferences, configuration);
              if (current.category === "feedback") {
                // Feedback has its own one-time disclosure and its own random
                // response identity; it is not governed by either reporting
                // category's interval, so only its own consent applies.
                return feedbackEffective(configuration)
                  ? ("permitted" as const)
                  : ("revoked" as const);
              }
              if (!categoryEffective(policy, current.category)) return "revoked" as const;
              // The claimed row belongs to one consent interval. A different
              // interval in the live policy means the Owner withdrew and re-consented
              // since this row was produced, so the row describes declined activity.
              const liveInterval = policy.categories[current.category].intervalStartedAt;
              const rowInterval = isoOrNull(current.interval_started_at);
              if (rowInterval === null || liveInterval !== rowInterval) {
                return "stale_interval" as const;
              }
              return "permitted" as const;
            }),
          );
          if (decision === "lost") {
            // Another pass reclaimed the expired lease while this one was working;
            // its owner now decides the row's fate.
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
            // Both identities are frozen on the row, so a retry after a partial
            // send repeats the same PostHog de-duplication key instead of
            // creating a second measurement.
            eventUuid: row.event_uuid,
            properties,
            timestamp:
              row.event_timestamp instanceof Date
                ? row.event_timestamp.toISOString()
                : new Date(row.event_timestamp).toISOString(),
          });
          if (result.ok) {
            delivered += 1;
            // Fenced on the lease token: if this lease expired and another pass
            // reclaimed the row, this completion must not overwrite that pass's
            // ownership or its outcome.
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
        // Terminal payloads are deleted on the same bounded pass that produces
        // them. Only the minimal delivery receipt survives, so the optional data
        // window is enforced on the bytes, not just on the row's state.
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

/** One report ready to be written to the bounded pending queue. */
interface PendingInsert {
  category: PendingReportCategory;
  distinctId: string;
  eventName: string;
  eventTimestamp: Date;
  /** Consent interval that produced the report; delivery compares it to the live one. */
  intervalStartedAt: string;
  logicalId: string;
  payload: Record<string, unknown>;
}

/**
 * Caps a category's pending backlog so bounded storage is a property of the module.
 *
 * The cap is checked under the reporting mutation lock, so concurrent producers
 * cannot each observe a below-cap count and then all insert past it. A logical
 * identity already receipted as sent or discarded is not rewritten either:
 * re-creating it would send a measurement the installation already declined or
 * delivered.
 */
function insertPending(
  client: ReportingClient,
  input: PendingInsert,
): Effect.Effect<boolean, DatabaseError> {
  return Effect.gen(function* () {
    const receipt = yield* client.query(
      `SELECT 1 FROM reporting_delivery_receipts WHERE category = $1 AND logical_id = $2`,
      [input.category, input.logicalId],
    );
    if (receipt.rows.length > 0) return false;
    const backlog = yield* client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reporting_pending_reports
       WHERE state IN ('pending', 'leased')`,
    );
    if (Number(backlog.rows[0]?.count ?? "0") >= REPORTING_MAX_PENDING_ROWS) return false;
    // Validated again here: this is the last point before the payload is stored,
    // so a producer cannot persist bytes the allowlist would reject at send time.
    if (payloadViolation(input.payload)) return false;
    return yield* enqueuePending(client, input);
  });
}

/**
 * Inserts one pending report, reusing an existing logical identity.
 *
 * The frozen `event_uuid` and `event_timestamp` are what make a retry the same
 * measurement, so a repeated enqueue keeps the original row instead of minting a
 * second identity.
 */
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

/**
 * Creates a service whose every call is a failure-free no-op.
 *
 * Used where reporting is unavailable and by tests that must prove the product
 * works without it: every method resolves without touching the database or the
 * network. `policy` still reports the deployment's real requested/effective
 * status so the UI can explain why nothing is sent.
 */
export function createReportingServiceTest(
  impl?: Partial<ReportingServiceShape>,
  configuration: ReportingConfiguration = {
    deploymentCategory: "unknown",
    destination: null,
    forcedOff: true,
  },
): Layer.Layer<ReportingService, never, never> {
  const unavailable: ReportingServiceShape = {
    deliverPending: () => Effect.succeed(emptySummary),
    enqueueDiagnostic: () => Effect.succeed("skipped"),
    enqueueUsageReport: () => Effect.succeed("skipped"),
    feedbackState: () =>
      Effect.succeed({
        deliveryStatus: "not_shared",
        discoverySource: null,
        shared: false,
        submittedAt: null,
      }),
    policy: () => Effect.succeed(policySnapshot(null, configuration)),
    setPreferences: () =>
      Effect.succeed({ changed: false, policy: policySnapshot(null, configuration) }),
    submitFeedback: () =>
      Effect.succeed({
        deliveryStatus: "not_recorded",
        discoverySource: null,
        shared: false,
        submittedAt: null,
      }),
  };
  return Layer.succeed(ReportingService, { ...unavailable, ...impl });
}
