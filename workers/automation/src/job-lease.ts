// Shared async_job_events lease lifecycle for the Automation Worker
// (AUD-025). All claim/finish transitions flow through these statements so
// the locking SQL and state transitions have exactly one definition.
import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

export interface JobLeaseInput {
  aggregateId: string | null;
  aggregateType: string;
  eventKey: string;
  jobType: string;
  leaseSeconds: number;
  orgId: string | null;
}

/** Thrown when a claim loses to a still-processing job with a live lease. */
export class JobInProgressError extends Error {
  /**
   * Initializes a JobInProgressError indicating that a job lease is currently active.
   *
   * @param message - Diagnostic message explaining that the job is being processed.
   */
  constructor(message = "job is already being processed") {
    super(message);
    this.name = "JobInProgressError";
  }
}

/**
 * Asset processing lease duration in seconds: strictly above the native
 * processor's 540-second engine job ceiling, so a duplicate Queue delivery
 * arriving while the native processor is still working loses the single-flight
 * claim rather than promoting or committing a second rendition. A shorter
 * lease would let a second consumer re-claim work that is still running and
 * multiply retained outputs.
 */
const assetProcessingLeaseSeconds = 600;

/**
 * Asset deletion lease duration in seconds. Deletion performs bounded
 * per-object bucket deletes and one durable settlement, so it needs far less
 * than the processing lease while still leaving room to retry after a lost
 * worker.
 */
const assetDeletionLeaseSeconds = 300;

/**
 * Resolves the lease duration for one Asset outbox topic.
 *
 * Processing claims must outlive the native processor's own job ceiling so an
 * at-least-once redelivery cannot start a second promotion or rendition while
 * the first is mid-flight. Deletion keeps the shorter lease because it only
 * drains a bounded object inventory, and prompt recovery of an interrupted
 * reclaim matters more there than for a nine-minute compute job.
 *
 * @param topic - Asset outbox topic being processed.
 * @returns Lease duration in seconds: 600s for processing topics, 300s for
 *   `asset.deletion.requested`.
 */
export function assetLeaseSeconds(topic: string): number {
  return topic === "asset.deletion.requested"
    ? assetDeletionLeaseSeconds
    : assetProcessingLeaseSeconds;
}

/**
 * Atomically claims (or re-claims) an async job lease in `async_job_events`.
 * Provides single-source concurrency control for distribution, reply, and asset processing (AUD-025).
 * Re-claims are permitted only if the previous attempt failed or if an in-progress lease has expired.
 *
 * @param client - Active PostgreSQL Effect transaction client.
 * @param input - Lease configuration containing eventKey, jobType, aggregateId, orgId, aggregateType, and leaseSeconds.
 * @returns Effect resolving to true if the lease was acquired or re-acquired, false if held by
 *   another active worker; fails with DatabaseError on query failure.
 */
export function claimJobLease(
  client: EffectTransactionClient,
  input: JobLeaseInput,
): Effect.Effect<boolean, DatabaseError> {
  return client
    .query(
      `INSERT INTO async_job_events
       (event_key, job_type, aggregate_id, org_id, aggregate_type, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 * INTERVAL '1 second'))
     ON CONFLICT (event_key) DO UPDATE
       SET outcome = 'processing',
           attempt_count = async_job_events.attempt_count + 1,
           lease_expires_at = now() + ($6 * INTERVAL '1 second'),
           last_error = NULL,
           processed_at = NULL,
           updated_at = now()
       WHERE async_job_events.outcome = 'failed'
          OR (async_job_events.outcome = 'processing'
              AND async_job_events.lease_expires_at <= now())
     RETURNING event_key`,
      [
        input.eventKey,
        input.jobType,
        input.aggregateId,
        input.orgId,
        input.aggregateType,
        input.leaseSeconds,
      ],
    )
    .pipe(Effect.map((result) => result.rowCount === 1));
}

/**
 * Reads the current outcome state of a job in `async_job_events` after a failed lease claim.
 * Used to distinguish whether an event is currently "processing" (requiring deferral)
 * or has reached a terminal outcome like "succeeded" or "skipped" (allowing safe deduplication).
 *
 * @param client - Active PostgreSQL Effect transaction client.
 * @param eventKey - Unique event lease key (typically `outbox:<event_id>`).
 * @returns Effect resolving to the recorded outcome string (e.g. "processing", "succeeded",
 *   "failed"), or undefined if absent; fails with DatabaseError on query failure.
 */
export function jobLeaseOutcome(
  client: EffectTransactionClient,
  eventKey: string,
): Effect.Effect<string | undefined, DatabaseError> {
  return client
    .query<{
      outcome: string;
    }>("SELECT outcome FROM async_job_events WHERE event_key = $1", [eventKey])
    .pipe(Effect.map((result) => result.rows[0]?.outcome));
}

/**
 * Updates a job event to a terminal outcome ("failed", "skipped", or "succeeded").
 * Clears the active lease expiration; stamps `processed_at` for successes and skips, or records
 * `last_error` for failures. Optionally backfills `aggregate_id` if resolved during execution.
 *
 * @param client - Active PostgreSQL Effect transaction client.
 * @param eventKey - Unique event lease key.
 * @param outcome - Terminal outcome classification.
 * @param options - Optional aggregate ID backfill or sanitized error message string.
 * @returns Effect resolving when the update completes; fails with DatabaseError on query failure.
 */
export function finishJobLease(
  client: EffectTransactionClient,
  eventKey: string,
  outcome: "failed" | "skipped" | "succeeded",
  options: { aggregateId?: string | null; error?: string } = {},
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `UPDATE async_job_events
     SET outcome = $2,
         aggregate_id = COALESCE($3, aggregate_id),
         last_error = $4,
         lease_expires_at = NULL,
         processed_at = CASE WHEN $2 = 'failed' THEN NULL ELSE now() END,
         updated_at = now()
     WHERE event_key = $1`,
      [eventKey, outcome, options.aggregateId ?? null, options.error ?? null],
    )
    .pipe(Effect.asVoid);
}
