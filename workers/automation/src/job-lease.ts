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

export class JobInProgressError extends Error {
  constructor(message = "job is already being processed") {
    super(message);
    this.name = "JobInProgressError";
  }
}

const assetProcessingLeaseSeconds = 600;

const assetDeletionLeaseSeconds = 300;

export function assetLeaseSeconds(topic: string): number {
  return topic === "asset.deletion.requested"
    ? assetDeletionLeaseSeconds
    : assetProcessingLeaseSeconds;
}

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
