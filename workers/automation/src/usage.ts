import { Cause, Effect, Exit } from "effect";
import { isoPeriodKey, type DatabaseError } from "@meltiply/domain";
import { errorDiagnostic, log } from "@meltiply/observability";

import { withSystemTransactionEffect } from "./database";
import { runJobProgram } from "./effect/boundary";
import type { AutomationEnv } from "./env";
import { nextDelaySeconds, USAGE_RECONCILIATION_RETRY_POLICY } from "./retry-policy";

interface ClaimedOrganization extends Record<string, unknown> {
  consecutive_failures: number;
  org_id: string;
}

interface UsageRow extends Record<string, unknown> {
  api_calls: number | string;
  distributions: number | string;
  storage_bytes: number | string;
  uploads: number | string;
}

interface AuthoritativeUsageRow extends Record<string, unknown> {
  active_platforms: number | string;
  distributions: number | string;
  provider_operations: number | string;
  storage_bytes: number | string;
  uploads: number | string;
}

export interface UsageReconciliationOptions {
  batchLimit?: number;
  now?: Date;
}

export interface UsageReconciliationResult {
  claimed: number;
  corrected: number;
  failed: number;
  reconciled: number;
}

const leaseSeconds = 5 * 60;
const reconciliationIntervalSeconds = 6 * 60 * 60;

function boundedCount(value: number | string, name: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`${name} is outside the safe usage range`);
  }
  return count;
}

function period(now: Date): { end: Date; key: string; start: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    key: isoPeriodKey(start),
    start,
  };
}

function claimDueOrganizations(
  env: AutomationEnv,
  now: Date,
  batchLimit: number,
): Effect.Effect<ClaimedOrganization[], DatabaseError> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.map(
      client.query<ClaimedOrganization>(
        `WITH due AS (
           SELECT org_id
           FROM usage_reconciliation_state
           WHERE next_reconciliation_at <= $1
             AND (lease_until IS NULL OR lease_until <= $1)
           ORDER BY next_reconciliation_at, org_id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE usage_reconciliation_state AS state
         SET lease_until = $1::timestamptz + ($3::integer * INTERVAL '1 second'),
             last_started_at = $1,
             updated_at = $1
         FROM due
         WHERE state.org_id = due.org_id
         RETURNING state.org_id, state.consecutive_failures`,
        [now, batchLimit, leaseSeconds],
      ),
      (result) => result.rows,
    ),
  );
}

function reconcileOrganization(
  env: AutomationEnv,
  organizationId: string,
  now: Date,
): Effect.Effect<{ corrected: boolean; reconciled: boolean }, DatabaseError> {
  const currentPeriod = period(now);
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      const priorResult = yield* client.query<UsageRow>(
        `INSERT INTO usage_records (org_id, period)
         SELECT id, $2
         FROM organizations
         WHERE id = $1
         ON CONFLICT (org_id, period) DO UPDATE
         SET updated_at = usage_records.updated_at
         RETURNING uploads, distributions, api_calls, storage_bytes`,
        [organizationId, currentPeriod.key],
      );
      if (priorResult.rowCount !== 1) {
        return { corrected: false, reconciled: false };
      }
      const authoritativeResult = yield* client.query<AuthoritativeUsageRow>(
        `SELECT
           (
             SELECT COUNT(*)
             FROM assets AS asset
             WHERE asset.org_id = $1
               AND asset.finalized_at >= $2
               AND asset.finalized_at < $3
           ) AS uploads,
           (
             SELECT COUNT(*) FROM distributions AS distribution
             WHERE distribution.org_id = $1
               AND distribution.created_at >= $2
               AND distribution.created_at < $3
           ) AS distributions,
           (
             SELECT COALESCE(SUM(resident.resident_bytes), 0)
             FROM (
               SELECT GREATEST(
                        COALESCE(object.bytes, 0),
                        COALESCE(object.reserved_bytes, 0)
                      ) AS resident_bytes
               FROM asset_objects AS object
               WHERE object.org_id = $1
                 AND object.status <> 'deleted'
               UNION ALL
               SELECT COALESCE(reservation.bytes, 0) AS resident_bytes
               FROM asset_quota_reservations AS reservation
               WHERE reservation.org_id = $1
                 AND reservation.state = 'reserved'
             ) AS resident
           ) AS storage_bytes,
           (
             SELECT COUNT(*) FROM platform_accounts AS account
             WHERE account.org_id = $1 AND account.revoked_at IS NULL
           ) AS active_platforms,
           (
             SELECT COUNT(*) FROM provider_operations AS operation
             WHERE operation.org_id = $1
               AND operation.created_at >= $2
               AND operation.created_at < $3
           ) AS provider_operations`,
        [organizationId, currentPeriod.start, currentPeriod.end],
      );
      const priorRow = priorResult.rows[0]!;
      const source = authoritativeResult.rows[0]!;
      const prior = {
        api_calls: boundedCount(priorRow.api_calls, "api_calls"),
        distributions: boundedCount(priorRow.distributions, "distributions"),
        storage_bytes: boundedCount(priorRow.storage_bytes, "storage_bytes"),
        uploads: boundedCount(priorRow.uploads, "uploads"),
      };
      const reconciled = {
        ...prior,
        distributions: boundedCount(source.distributions, "distributions"),
        storage_bytes: boundedCount(source.storage_bytes, "storage_bytes"),
        uploads: boundedCount(source.uploads, "uploads"),
      };
      const corrected =
        prior.uploads !== reconciled.uploads ||
        prior.distributions !== reconciled.distributions ||
        prior.storage_bytes !== reconciled.storage_bytes;

      yield* client.query(
        `UPDATE usage_records
         SET uploads = $3, distributions = $4, storage_bytes = $5,
             updated_at = $6
         WHERE org_id = $1 AND period = $2`,
        [
          organizationId,
          currentPeriod.key,
          reconciled.uploads,
          reconciled.distributions,
          reconciled.storage_bytes,
          now,
        ],
      );
      if (corrected) {
        yield* client.query(
          `INSERT INTO usage_corrections
             (org_id, period, reason, prior_usage, reconciled_usage, evidence)
           VALUES (
             $1, $2, 'scheduled_authoritative_reconciliation', $3, $4, $5
           )`,
          [
            organizationId,
            currentPeriod.key,
            prior,
            reconciled,
            {
              active_platforms: boundedCount(source.active_platforms, "active_platforms"),
              provider_operations: boundedCount(source.provider_operations, "provider_operations"),
              source: "domain_rows_and_r2_verified_metadata",
            },
          ],
        );
      }
      yield* client.query(
        `UPDATE usage_reconciliation_state
         SET next_reconciliation_at = $2::timestamptz
               + ($3::integer * INTERVAL '1 second'),
             lease_until = NULL,
             last_completed_at = $2,
             consecutive_failures = 0,
             last_error_code = NULL,
             updated_at = $2
         WHERE org_id = $1`,
        [organizationId, now, reconciliationIntervalSeconds],
      );
      return { corrected, reconciled: true };
    }),
  );
}

function releaseAfterFailure(
  env: AutomationEnv,
  organization: ClaimedOrganization,
  now: Date,
): Effect.Effect<void, DatabaseError> {
  const completedFailures = organization.consecutive_failures + 1;
  const retrySeconds =
    nextDelaySeconds(USAGE_RECONCILIATION_RETRY_POLICY, completedFailures) ??
    reconciliationIntervalSeconds;
  return withSystemTransactionEffect(env, (client) =>
    client.query(
      `UPDATE usage_reconciliation_state
       SET next_reconciliation_at = $2::timestamptz
             + ($3::integer * INTERVAL '1 second'),
           lease_until = NULL,
           consecutive_failures = $4,
           last_error_code = 'usage_reconciliation_failed',
           updated_at = $2
       WHERE org_id = $1`,
      [organization.org_id, now, retrySeconds, completedFailures],
    ),
  ).pipe(Effect.asVoid);
}

export function reconcileDueUsageEffect(
  env: AutomationEnv,
  options: UsageReconciliationOptions = {},
): Effect.Effect<UsageReconciliationResult, DatabaseError | RangeError> {
  return Effect.gen(function* () {
    const batchLimit = options.batchLimit ?? 25;
    if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) {
      return yield* Effect.fail(
        new RangeError("usage reconciliation batch limit must be 1 to 100"),
      );
    }
    const now = options.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      return yield* Effect.fail(new RangeError("usage reconciliation time must be valid"));
    }
    const claimed = yield* claimDueOrganizations(env, now, batchLimit);
    const outcomes = yield* Effect.forEach(
      claimed,
      (organization) =>
        reconcileOrganization(env, organization.org_id, now).pipe(
          Effect.map((result) => ({
            corrected: Number(result.corrected),
            failed: 0,
            reconciled: Number(result.reconciled),
          })),
          Effect.catchCause((cause) => {
            log(
              "warn",
              {
                environment: env.ENVIRONMENT,
                job_id: organization.org_id,
                service: "automation",
                trace_id: organization.org_id,
                version: env.VERSION,
              },
              {
                ...errorDiagnostic(Cause.squash(cause)),
                event: "usage_reconciliation_failed",
                job: "usage_reconciliation",
                org_id: organization.org_id,
                outcome: "failed",
                retry_class: "platform_retry",
              },
            );
            return releaseAfterFailure(env, organization, now).pipe(
              Effect.as({ corrected: 0, failed: 1, reconciled: 0 }),
            );
          }),
        ),
      { concurrency: 4 },
    );
    let corrected = 0;
    let failed = 0;
    let reconciled = 0;
    for (const outcome of outcomes) {
      corrected += outcome.corrected;
      failed += outcome.failed;
      reconciled += outcome.reconciled;
    }
    return { claimed: claimed.length, corrected, failed, reconciled };
  });
}

export async function reconcileDueUsage(
  env: AutomationEnv,
  options: UsageReconciliationOptions = {},
): Promise<UsageReconciliationResult> {
  const exit = await runJobProgram(reconcileDueUsageEffect(env, options));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
