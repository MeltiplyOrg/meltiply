import { Effect } from "effect";
import type { DatabaseError, Platform } from "@meltiply/domain";

import {
  REPORTING_MAX_PENDING_AGE_DAYS,
  REPORTING_MAX_PENDING_ROWS,
  REPORTING_SCHEMA_VERSION,
  type FeedbackDeliveryStatus,
  type PendingReportCategory,
  type ReportingCategory,
} from "./contracts";
import type { PreferencesRow } from "./policy";
import type { ReportingClient, ReportingTransactionRunner } from "./service";

const reportingMutationLockKey = 810_000_101;
const reportingMeasurementLockKey = 810_000_102;
const measurementSavepoint = "reporting_publication_measurement";

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

/** Persisted row returned when claiming pending reports for delivery. */
export interface ReportingPendingRow extends Record<string, unknown> {
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

/** Persisted attribution feedback row. */
export interface ReportingFeedbackRow extends Record<string, unknown> {
  discovery_source: string;
  response_id: string;
  shared: boolean;
  submitted_at: Date | string;
}

/** Input required to queue a pending report row. */
export interface ReportingPendingInsert {
  readonly category: PendingReportCategory;
  readonly distinctId: string;
  readonly eventName: string;
  readonly eventTimestamp: Date;
  readonly intervalStartedAt: string;
  readonly logicalId: string;
  readonly payload: Record<string, unknown>;
}

/** Live lease state re-read before transmitting a claimed report. */
export interface ReportingPendingLeaseState {
  readonly category: PendingReportCategory;
  readonly interval_started_at: Date | string | null;
  readonly lease_token: string | null;
  readonly state: string;
}

/** Transactional storage operations used by the reporting service. */
export interface ReportingTransaction {
  readonly lockMutations: () => Effect.Effect<void, DatabaseError>;
  readonly loadPreferences: (lock: boolean) => Effect.Effect<PreferencesRow | null, DatabaseError>;
  readonly savePreferences: (row: PreferencesRow) => Effect.Effect<void, DatabaseError>;
  readonly discardPendingByCategory: (
    category: ReportingCategory,
    errorCode: string,
  ) => Effect.Effect<void, DatabaseError>;
  readonly loadFeedback: (
    lock: boolean,
  ) => Effect.Effect<ReportingFeedbackRow | null, DatabaseError>;
  readonly feedbackDeliveryStatus: (
    responseId: string,
  ) => Effect.Effect<FeedbackDeliveryStatus, DatabaseError>;
  readonly insertFeedback: (
    row: ReportingFeedbackRow & { readonly schema_version: number },
  ) => Effect.Effect<void, DatabaseError>;
  readonly enqueueFeedbackPending: (
    input: ReportingPendingInsert,
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly countRecentDiagnostics: () => Effect.Effect<number, DatabaseError>;
  readonly insertBoundedPending: (
    input: ReportingPendingInsert,
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly expirePendingReports: () => Effect.Effect<number, DatabaseError>;
  readonly claimPendingReports: (
    limit: number,
  ) => Effect.Effect<ReportingPendingRow[], DatabaseError>;
  readonly releaseLeasedPending: (
    id: string,
    leaseToken: string | null,
  ) => Effect.Effect<number, DatabaseError>;
  readonly loadPendingForUpdate: (
    id: string,
  ) => Effect.Effect<ReportingPendingLeaseState | null, DatabaseError>;
  readonly markPendingDiscarded: (
    id: string,
    leaseToken: string | null,
    errorCode: string,
  ) => Effect.Effect<void, DatabaseError>;
  readonly markPendingSent: (
    id: string,
    leaseToken: string | null,
  ) => Effect.Effect<void, DatabaseError>;
  readonly reschedulePending: (
    id: string,
    leaseToken: string | null,
    errorCode: string,
    delaySeconds: number,
  ) => Effect.Effect<void, DatabaseError>;
  readonly pruneTerminalReports: () => Effect.Effect<number, DatabaseError>;
}

/** Repository boundary owning persistence for installation improvement reporting. */
export interface ReportingRepository {
  readonly transaction: <A, E>(
    operation: (tx: ReportingTransaction) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | DatabaseError>;
}

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

/** Loads the installation reporting preferences singleton row. */
export function loadPreferences(
  client: ReportingClient,
  lock: boolean,
): Effect.Effect<PreferencesRow | null, DatabaseError> {
  return Effect.map(
    client.query<PreferencesRow>(lock ? LOAD_PREFERENCES_FOR_UPDATE_SQL : LOAD_PREFERENCES_SQL),
    (result) => result.rows[0] ?? null,
  );
}

function postgresReportingTransaction(client: ReportingClient): ReportingTransaction {
  return {
    lockMutations: () =>
      Effect.asVoid(client.query("SELECT pg_advisory_xact_lock($1)", [reportingMutationLockKey])),

    loadPreferences: (lock) => loadPreferences(client, lock),

    savePreferences: (row) =>
      Effect.asVoid(
        client.query(
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
            row.schema_version,
            row.usage_requested,
            row.usage_disclosure_version,
            row.usage_decided_at,
            row.usage_interval_started_at,
            row.diagnostics_requested,
            row.diagnostics_disclosure_version,
            row.diagnostics_decided_at,
            row.diagnostics_interval_started_at,
            row.installation_reporting_id,
          ],
        ),
      ),

    discardPendingByCategory: (category, errorCode) =>
      Effect.asVoid(
        client.query(
          `UPDATE reporting_pending_reports
           SET state = 'discarded', updated_at = now(), last_error_code = $2
           WHERE category = $1 AND state IN ('pending', 'leased')`,
          [category, errorCode],
        ),
      ),

    loadFeedback: (lock) =>
      Effect.map(
        client.query<ReportingFeedbackRow>(lock ? LOAD_FEEDBACK_FOR_UPDATE_SQL : LOAD_FEEDBACK_SQL),
        (result) => result.rows[0] ?? null,
      ),

    feedbackDeliveryStatus: (responseId) =>
      Effect.map(
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
          if (state === "sent") return "delivered" as const;
          if (state === "pending" || state === "leased") return "pending" as const;
          return "not_recorded" as const;
        },
      ),

    insertFeedback: (row) =>
      Effect.asVoid(
        client.query(
          `INSERT INTO reporting_attribution_responses (
             id, response_id, discovery_source, shared, schema_version, submitted_at
           ) VALUES (TRUE, $1, $2, $3, $4, $5)`,
          [row.response_id, row.discovery_source, row.shared, row.schema_version, row.submitted_at],
        ),
      ),

    enqueueFeedbackPending: (input) =>
      Effect.map(
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
      ),

    countRecentDiagnostics: () =>
      Effect.map(
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM reporting_pending_reports
           WHERE category = 'diagnostics' AND created_at > now() - INTERVAL '1 hour'`,
        ),
        (result) => Number(result.rows[0]?.count ?? "0"),
      ),

    insertBoundedPending: (input) =>
      Effect.map(
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
      ),

    expirePendingReports: () =>
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

    claimPendingReports: (limit) =>
      Effect.map(
        client.query<ReportingPendingRow>(
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
        ),
        (result) => result.rows,
      ),

    releaseLeasedPending: (id, leaseToken) =>
      Effect.map(
        client.query(
          `UPDATE reporting_pending_reports
           SET state = 'pending', lease_token = NULL, lease_expires_at = NULL,
               attempts = GREATEST(attempts - 1, 0), updated_at = now()
           WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
          [id, leaseToken],
        ),
        (result) => result.rowCount ?? result.rows.length,
      ),

    loadPendingForUpdate: (id) =>
      Effect.map(
        client.query<{
          category: PendingReportCategory;
          interval_started_at: Date | string | null;
          lease_token: string | null;
          state: string;
        }>(
          `SELECT category, interval_started_at, lease_token, state
           FROM reporting_pending_reports WHERE id = $1 FOR UPDATE`,
          [id],
        ),
        (result) => result.rows[0] ?? null,
      ),

    markPendingDiscarded: (id, leaseToken, errorCode) =>
      Effect.asVoid(
        client.query(
          `UPDATE reporting_pending_reports
           SET state = 'discarded', updated_at = now(), last_error_code = $3,
               lease_token = NULL, lease_expires_at = NULL
           WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
          [id, leaseToken, errorCode],
        ),
      ),

    markPendingSent: (id, leaseToken) =>
      Effect.asVoid(
        client.query(
          `UPDATE reporting_pending_reports
           SET state = 'sent', updated_at = now(), last_error_code = NULL,
               lease_token = NULL, lease_expires_at = NULL
           WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
          [id, leaseToken],
        ),
      ),

    reschedulePending: (id, leaseToken, errorCode, delaySeconds) =>
      Effect.asVoid(
        client.query(
          `UPDATE reporting_pending_reports
           SET state = 'pending', updated_at = now(), last_error_code = $3,
               available_at = now() + ($4 * INTERVAL '1 second'),
               lease_token = NULL, lease_expires_at = NULL
           WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
          [id, leaseToken, errorCode, delaySeconds],
        ),
      ),

    pruneTerminalReports: () =>
      Effect.map(
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
      ),
  };
}

/** Builds the PostgreSQL reporting repository backed by a system transaction runner. */
export function createPostgresReportingRepository(
  transaction: ReportingTransactionRunner,
): ReportingRepository {
  return {
    transaction: (operation) =>
      transaction((client) => operation(postgresReportingTransaction(client))),
  };
}

/** In-memory pending report record stored by `FakeReportingStore`. */
export interface FakePendingReportRecord extends ReportingPendingRow {
  available_at: Date;
  created_at: Date;
  last_error_code: string | null;
  lease_expires_at: Date | null;
  state: "pending" | "leased" | "sent" | "discarded";
  updated_at: Date;
}

/** In-memory delivery receipt stored by `FakeReportingStore`. */
export interface FakeDeliveryReceipt {
  category: PendingReportCategory;
  event_timestamp: Date;
  event_uuid: string;
  logical_id: string;
  state: "sent" | "discarded";
}

/** In-memory backing store for `createFakeReportingRepository`. */
export class FakeReportingStore {
  preferences: PreferencesRow | null = null;
  feedback: (ReportingFeedbackRow & { schema_version: number }) | null = null;
  pending: FakePendingReportRecord[] = [];
  receipts: FakeDeliveryReceipt[] = [];
  nextCommitFailure: DatabaseError | null = null;
  private sequence = 0;

  constructor(readonly now: () => Date = () => new Date()) {}

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  snapshot() {
    return {
      feedback: structuredClone(this.feedback),
      pending: structuredClone(this.pending),
      preferences: structuredClone(this.preferences),
      receipts: structuredClone(this.receipts),
    };
  }

  restore(saved: ReturnType<FakeReportingStore["snapshot"]>) {
    this.feedback = saved.feedback;
    this.pending = saved.pending;
    this.preferences = saved.preferences;
    this.receipts = saved.receipts;
  }
}

/** Builds an in-memory transactional reporting repository for service tests. */
export function createFakeReportingRepository(store: FakeReportingStore): ReportingRepository {
  const tx: ReportingTransaction = {
    lockMutations: () => Effect.void,

    loadPreferences: () =>
      Effect.sync(() => (store.preferences ? structuredClone(store.preferences) : null)),

    savePreferences: (row) =>
      Effect.sync(() => {
        store.preferences = structuredClone(row);
      }),

    discardPendingByCategory: (category, errorCode) =>
      Effect.sync(() => {
        const current = store.now();
        for (const row of store.pending) {
          if (row.category === category && (row.state === "pending" || row.state === "leased")) {
            row.state = "discarded";
            row.last_error_code = errorCode;
            row.updated_at = current;
          }
        }
      }),

    loadFeedback: () =>
      Effect.sync(() => (store.feedback ? structuredClone(store.feedback) : null)),

    feedbackDeliveryStatus: (responseId) =>
      Effect.sync(() => {
        const states: string[] = [];
        for (const row of store.pending) {
          if (row.category === "feedback" && row.logical_id === responseId) states.push(row.state);
        }
        for (const receipt of store.receipts) {
          if (receipt.category === "feedback" && receipt.logical_id === responseId) {
            states.push(receipt.state);
          }
        }
        if (states.includes("sent")) return "delivered" as const;
        if (states.includes("pending") || states.includes("leased")) return "pending" as const;
        return "not_recorded" as const;
      }),

    insertFeedback: (row) =>
      Effect.sync(() => {
        store.feedback = structuredClone(row);
      }),

    enqueueFeedbackPending: (input) =>
      Effect.sync(() => {
        if (
          store.pending.some(
            (row) => row.category === input.category && row.logical_id === input.logicalId,
          )
        ) {
          return false;
        }
        const current = store.now();
        store.pending.push({
          attempts: 0,
          available_at: current,
          category: input.category,
          created_at: current,
          distinct_id: input.distinctId,
          event_name: input.eventName,
          event_timestamp: input.eventTimestamp,
          event_uuid: store.nextId("event"),
          expires_at: new Date(current.getTime() + REPORTING_MAX_PENDING_AGE_DAYS * 86_400_000),
          id: store.nextId("pending"),
          interval_started_at: input.intervalStartedAt,
          last_error_code: null,
          lease_expires_at: null,
          lease_token: null,
          logical_id: input.logicalId,
          payload: structuredClone(input.payload),
          state: "pending",
          updated_at: current,
        });
        return true;
      }),

    countRecentDiagnostics: () =>
      Effect.sync(() => {
        const cutoff = store.now().getTime() - 3_600_000;
        return store.pending.filter(
          (row) => row.category === "diagnostics" && row.created_at.getTime() > cutoff,
        ).length;
      }),

    insertBoundedPending: (input) =>
      Effect.sync(() => {
        if (
          store.receipts.some(
            (receipt) =>
              receipt.category === input.category && receipt.logical_id === input.logicalId,
          )
        ) {
          return false;
        }
        const activeCount = store.pending.filter(
          (row) => row.state === "pending" || row.state === "leased",
        ).length;
        if (activeCount >= REPORTING_MAX_PENDING_ROWS) return false;
        if (
          store.pending.some(
            (row) => row.category === input.category && row.logical_id === input.logicalId,
          )
        ) {
          return false;
        }
        const current = store.now();
        store.pending.push({
          attempts: 0,
          available_at: current,
          category: input.category,
          created_at: current,
          distinct_id: input.distinctId,
          event_name: input.eventName,
          event_timestamp: input.eventTimestamp,
          event_uuid: store.nextId("event"),
          expires_at: new Date(current.getTime() + REPORTING_MAX_PENDING_AGE_DAYS * 86_400_000),
          id: store.nextId("pending"),
          interval_started_at: input.intervalStartedAt,
          last_error_code: null,
          lease_expires_at: null,
          lease_token: null,
          logical_id: input.logicalId,
          payload: structuredClone(input.payload),
          state: "pending",
          updated_at: current,
        });
        return true;
      }),

    expirePendingReports: () =>
      Effect.sync(() => {
        const current = store.now();
        let count = 0;
        for (const row of store.pending) {
          const expiresAt =
            row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
          if (
            (row.state === "pending" || row.state === "leased") &&
            expiresAt.getTime() <= current.getTime()
          ) {
            row.state = "discarded";
            row.last_error_code = "expired";
            row.updated_at = current;
            count += 1;
          }
        }
        return count;
      }),

    claimPendingReports: (limit) =>
      Effect.sync(() => {
        const current = store.now();
        const nowMs = current.getTime();
        const candidates = store.pending
          .filter((row) => {
            const expiresAt =
              row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
            if (expiresAt.getTime() <= nowMs) return false;
            if (row.state === "pending") return row.available_at.getTime() <= nowMs;
            if (row.state === "leased") {
              return row.lease_expires_at !== null && row.lease_expires_at.getTime() <= nowMs;
            }
            return false;
          })
          .toSorted(
            (a, b) =>
              a.available_at.getTime() - b.available_at.getTime() ||
              a.created_at.getTime() - b.created_at.getTime() ||
              a.id.localeCompare(b.id),
          )
          .slice(0, limit);
        const claimed: ReportingPendingRow[] = [];
        for (const row of candidates) {
          row.state = "leased";
          row.attempts += 1;
          row.lease_token = store.nextId("lease");
          row.lease_expires_at = new Date(nowMs + 120_000);
          row.updated_at = current;
          claimed.push(structuredClone(row));
        }
        return claimed;
      }),

    releaseLeasedPending: (id, leaseToken) =>
      Effect.sync(() => {
        const row = store.pending.find(
          (entry) =>
            entry.id === id && entry.lease_token === leaseToken && entry.state === "leased",
        );
        if (!row) return 0;
        row.state = "pending";
        row.lease_token = null;
        row.lease_expires_at = null;
        row.attempts = Math.max(row.attempts - 1, 0);
        row.updated_at = store.now();
        return 1;
      }),

    loadPendingForUpdate: (id) =>
      Effect.sync(() => {
        const row = store.pending.find((entry) => entry.id === id);
        if (!row) return null;
        return {
          category: row.category,
          interval_started_at: row.interval_started_at,
          lease_token: row.lease_token,
          state: row.state,
        };
      }),

    markPendingDiscarded: (id, leaseToken, errorCode) =>
      Effect.sync(() => {
        const row = store.pending.find(
          (entry) =>
            entry.id === id && entry.lease_token === leaseToken && entry.state === "leased",
        );
        if (!row) return;
        row.state = "discarded";
        row.last_error_code = errorCode;
        row.lease_token = null;
        row.lease_expires_at = null;
        row.updated_at = store.now();
      }),

    markPendingSent: (id, leaseToken) =>
      Effect.sync(() => {
        const row = store.pending.find(
          (entry) =>
            entry.id === id && entry.lease_token === leaseToken && entry.state === "leased",
        );
        if (!row) return;
        row.state = "sent";
        row.last_error_code = null;
        row.lease_token = null;
        row.lease_expires_at = null;
        row.updated_at = store.now();
      }),

    reschedulePending: (id, leaseToken, errorCode, delaySeconds) =>
      Effect.sync(() => {
        const row = store.pending.find(
          (entry) =>
            entry.id === id && entry.lease_token === leaseToken && entry.state === "leased",
        );
        if (!row) return;
        const current = store.now();
        row.state = "pending";
        row.last_error_code = errorCode;
        row.available_at = new Date(current.getTime() + delaySeconds * 1_000);
        row.lease_token = null;
        row.lease_expires_at = null;
        row.updated_at = current;
      }),

    pruneTerminalReports: () =>
      Effect.sync(() => {
        const cutoff = store.now().getTime() - 3_600_000;
        const eligible = store.pending
          .filter(
            (row) =>
              (row.state === "sent" || row.state === "discarded") &&
              row.updated_at.getTime() <= cutoff,
          )
          .toSorted((a, b) => a.updated_at.getTime() - b.updated_at.getTime())
          .slice(0, 500);
        const ids = new Set(eligible.map((row) => row.id));
        store.pending = store.pending.filter((row) => !ids.has(row.id));
        for (const row of eligible) {
          if (
            !store.receipts.some(
              (receipt) =>
                receipt.category === row.category && receipt.logical_id === row.logical_id,
            )
          ) {
            store.receipts.push({
              category: row.category,
              event_timestamp:
                row.event_timestamp instanceof Date
                  ? row.event_timestamp
                  : new Date(row.event_timestamp),
              event_uuid: row.event_uuid,
              logical_id: row.logical_id,
              state: row.state === "sent" ? "sent" : "discarded",
            });
          }
        }
        return eligible.length;
      }),
  };

  return {
    transaction: (operation) =>
      Effect.gen(function* () {
        const saved = store.snapshot();
        const result = yield* operation(tx).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              store.restore(saved);
            }),
          ),
        );
        if (store.nextCommitFailure) {
          const failure = store.nextCommitFailure;
          store.nextCommitFailure = null;
          store.restore(saved);
          return yield* Effect.fail(failure);
        }
        return result;
      }),
  };
}

/** Storage boundary used by `recordPublicationUsage` inside a caller's transaction. */
export interface PublicationUsageRepository {
  readonly beginSavepoint: () => Effect.Effect<void, DatabaseError>;
  readonly releaseSavepoint: () => Effect.Effect<void, DatabaseError>;
  readonly rollbackSavepoint: () => Effect.Effect<void, DatabaseError>;
  readonly lockMeasurement: () => Effect.Effect<void, DatabaseError>;
  readonly currentTime: () => Effect.Effect<Date, DatabaseError>;
  readonly markDistribution: (
    distributionId: string,
    platform: Platform,
    confirmedAt: string,
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly loadPreferences: () => Effect.Effect<PreferencesRow | null, DatabaseError>;
  readonly hasPostMark: (postId: string) => Effect.Effect<boolean, DatabaseError>;
  readonly findPriorPublishedDistribution: (
    postId: string,
    excludeDistributionId: string,
  ) => Effect.Effect<
    { readonly found: boolean; readonly publishedAt: Date | string | null },
    DatabaseError
  >;
  readonly insertPostMark: (
    postId: string,
    firstConfirmedAt: string,
    counted: boolean,
  ) => Effect.Effect<void, DatabaseError>;
  readonly incrementDailyDistribution: (
    intervalStartedAt: string,
    reportDate: string,
    platform: Platform,
  ) => Effect.Effect<void, DatabaseError>;
}

/** Builds the PostgreSQL publication-usage repository on a transaction client. */
export function createPostgresPublicationUsageRepository(
  client: ReportingClient,
): PublicationUsageRepository {
  return {
    beginSavepoint: () => Effect.asVoid(client.query(`SAVEPOINT ${measurementSavepoint}`)),
    releaseSavepoint: () =>
      Effect.asVoid(client.query(`RELEASE SAVEPOINT ${measurementSavepoint}`)),
    rollbackSavepoint: () =>
      Effect.asVoid(client.query(`ROLLBACK TO SAVEPOINT ${measurementSavepoint}`)),
    lockMeasurement: () => lockReportingMeasurement(client),
    currentTime: () =>
      Effect.map(
        client.query<{ observed_at: Date | string }>("SELECT clock_timestamp() AS observed_at"),
        (result) => new Date(result.rows[0]?.observed_at ?? Date.now()),
      ),
    markDistribution: (distributionId, platform, confirmedAt) =>
      Effect.map(
        client.query<{ distribution_id: string }>(
          `INSERT INTO reporting_distribution_marks (distribution_id, platform, confirmed_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (distribution_id) DO NOTHING
           RETURNING distribution_id`,
          [distributionId, platform, confirmedAt],
        ),
        (result) => (result.rowCount ?? result.rows.length) > 0,
      ),
    loadPreferences: () => loadPreferences(client, false),
    hasPostMark: (postId) =>
      Effect.map(
        client.query<{ counted: boolean }>(
          "SELECT counted FROM reporting_post_marks WHERE post_id = $1",
          [postId],
        ),
        (result) => result.rows.length > 0,
      ),
    findPriorPublishedDistribution: (postId, excludeDistributionId) =>
      Effect.map(
        client.query<{ published_at: Date | string | null }>(
          `SELECT published_at FROM distributions
           WHERE post_id = $1 AND status = 'published' AND id <> $2
           ORDER BY published_at NULLS LAST, id
           LIMIT 1`,
          [postId, excludeDistributionId],
        ),
        (result) =>
          result.rows.length === 0
            ? { found: false, publishedAt: null }
            : { found: true, publishedAt: result.rows[0]?.published_at ?? null },
      ),
    insertPostMark: (postId, firstConfirmedAt, counted) =>
      Effect.asVoid(
        client.query(
          `INSERT INTO reporting_post_marks (post_id, first_confirmed_at, counted)
           VALUES ($1, $2, $3)
           ON CONFLICT (post_id) DO NOTHING`,
          [postId, firstConfirmedAt, counted],
        ),
      ),
    incrementDailyDistribution: (intervalStartedAt, reportDate, platform) =>
      Effect.asVoid(
        client.query(
          `INSERT INTO reporting_publication_daily
             (interval_started_at, report_date, platform, distributions)
           VALUES ($1, $2::date, $3, 1)
           ON CONFLICT (interval_started_at, report_date, platform) DO UPDATE
           SET distributions = reporting_publication_daily.distributions + 1,
               updated_at = now()`,
          [intervalStartedAt, reportDate, platform],
        ),
      ),
  };
}
