import { Cause, Effect, Exit } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import { withSystemTransactionEffect } from "./database";
import type { AutomationEnv } from "./env";

/**
 * Runs one system-transaction Effect at this module's Promise boundary.
 *
 * `reconcileDueUsage` keeps its Promise signature because callers wrap it in
 * `Effect.tryPromise`; the transaction itself runs through
 * `withSystemTransactionEffect`, and runPromiseExit plus Cause.squash rethrows
 * the original DatabaseError (not a FiberFailure) so the caller's catch sees
 * the real error identity.
 *
 * @param env - Automation worker environment.
 * @param operation - Function returning an Effect given the scoped EffectTransactionClient.
 * @returns Result from the transactional Effect.
 */
async function runWithSystemTransaction<T>(
  env: AutomationEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<T, DatabaseError>,
): Promise<T> {
  const exit = await Effect.runPromiseExit(withSystemTransactionEffect(env, operation));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

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

/**
 * Asserts and parses a non-negative safe integer count from database query results.
 *
 * @param value - Raw database count as number or string.
 * @param name - Metric label for error diagnostics.
 * @returns Parsed non-negative integer.
 * @throws {TypeError} When value is not a finite safe integer or is negative.
 */
function boundedCount(value: number | string, name: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`${name} is outside the safe usage range`);
  }
  return count;
}

/**
 * Calculates UTC month boundaries and period key for a given timestamp.
 *
 * @param now - Reference date.
 * @returns Object with period key (YYYY-MM), UTC start Date, and UTC end Date.
 */
function period(now: Date): { end: Date; key: string; start: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    key: start.toISOString().slice(0, 7),
    start,
  };
}

/**
 * Claims a bounded batch of organizations due for usage reconciliation using `FOR UPDATE SKIP LOCKED`.
 * Sets a lease and records the start timestamp for each claimed organization.
 *
 * @param env - Automation worker environment.
 * @param now - Execution timestamp.
 * @param batchLimit - Maximum number of organizations to claim.
 * @returns Array of claimed organization records.
 */
async function claimDueOrganizations(
  env: AutomationEnv,
  now: Date,
  batchLimit: number,
): Promise<ClaimedOrganization[]> {
  return runWithSystemTransaction(env, (client) =>
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

/**
 * Recomputes authoritative usage for a single organization over the current billing period.
 * Aggregates verified asset uploads, active distributions, and active R2 storage bytes,
 * records a correction audit entry in `usage_corrections` if values differed, and updates
 * `usage_reconciliation_state` to schedule the next run in 6 hours.
 *
 * @param env - Automation worker environment.
 * @param organizationId - UUID of the organization.
 * @param now - Execution timestamp.
 * @returns Object indicating whether a correction was recorded and reconciliation succeeded.
/**
 * Recomputes authoritative usage for a single organization over the current billing period.
 *
 * Storage is counted as resident inventory rather than as Asset rows in the
 * current month: every verified object in `asset_objects` (originals,
 * thumbnails, and renditions) is charged for as long as it still occupies
 * storage, every in-flight write is charged for its reservation, and live
 * upload reservations are charged before their bytes are committed. Resident
 * bytes are therefore independent of the billing period key, so a monthly
 * rollover records a new period row without ever making stored media appear
 * to vanish from accounting.
 *
 * Uploads and distributions remain period-scoped counters: an Asset counts as
 * an upload when a completed upload session finalized it inside the period.
 *
 * @param env - Automation worker environment.
 * @param organizationId - UUID of the organization.
 * @param now - Execution timestamp.
 * @returns Object indicating whether a correction was recorded and reconciliation succeeded.
 */
async function reconcileOrganization(
  env: AutomationEnv,
  organizationId: string,
  now: Date,
): Promise<{ corrected: boolean; reconciled: boolean }> {
  const currentPeriod = period(now);
  return runWithSystemTransaction(env, (client) =>
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
               -- The authoritative inventory rule, byte for byte identical to
               -- the API's resident formula: every row that is not 'deleted'
               -- contributes GREATEST(bytes, reserved_bytes). Verified objects
               -- charge their real bytes, an in-flight write charges the
               -- reservation it still holds, and a superseded or deleting object
               -- stays charged until its bytes are gone, so a deleted object
               -- stops being charged exactly once. GREATEST rather than a sum
               -- because one physical key cannot hold its old and replacement
               -- bytes simultaneously: a row that recorded measured output
               -- while still holding the planned reservation is charged the
               -- larger of the two, never both. Any divergence from the API
               -- here would make reconciliation correct real drift into fresh
               -- drift instead of settling it.
               SELECT GREATEST(
                        COALESCE(object.bytes, 0),
                        COALESCE(object.reserved_bytes, 0)
                      ) AS resident_bytes
               FROM asset_objects AS object
               WHERE object.org_id = $1
                 AND object.status <> 'deleted'
               UNION ALL
               -- Live upload reservations are charged before any bytes exist.
               -- They belong to no inventory row yet, which is why the API keeps
               -- them out of its inventory total and reports them as a separate
               -- term; the period counter folds both together.
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

/**
 * Releases a failed organization usage reconciliation claim with exponential backoff.
 * Increments consecutive_failures, applies exponential delay (5m * 2^failures capped at 6h),
 * and records 'usage_reconciliation_failed' in `usage_reconciliation_state`.
 *
 * @param env - Automation worker environment.
 * @param organization - Claimed organization record.
 * @param now - Execution timestamp.
 */
async function releaseAfterFailure(
  env: AutomationEnv,
  organization: ClaimedOrganization,
  now: Date,
): Promise<void> {
  const completedFailures = organization.consecutive_failures + 1;
  const retrySeconds = Math.min(
    reconciliationIntervalSeconds,
    5 * 60 * 2 ** Math.min(completedFailures - 1, 6),
  );
  await runWithSystemTransaction(env, (client) =>
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
  );
}

/**
 * Main entrypoint for periodic organization usage reconciliation.
 * Claims a bounded batch of due organizations, reconciles each against authoritative database
 * and storage rows, logs audit corrections when discrepancy occurs, and applies failure backoff.
 *
 * @param env - Automation worker environment.
 * @param options - Configuration containing batchLimit (1-100, default 25) and optional reference timestamp.
 * @returns UsageReconciliationResult summarizing claimed, corrected, failed, and reconciled counts.
 * @throws {RangeError} When batchLimit is not an integer between 1 and 100, or now is invalid.
 */
export async function reconcileDueUsage(
  env: AutomationEnv,
  options: UsageReconciliationOptions = {},
): Promise<UsageReconciliationResult> {
  const batchLimit = options.batchLimit ?? 25;
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 100) {
    throw new RangeError("usage reconciliation batch limit must be 1 to 100");
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("usage reconciliation time must be valid");
  }
  const claimed = await claimDueOrganizations(env, now, batchLimit);
  let corrected = 0;
  let failed = 0;
  let reconciled = 0;
  for (const organization of claimed) {
    try {
      const result = await reconcileOrganization(env, organization.org_id, now);
      corrected += Number(result.corrected);
      reconciled += Number(result.reconciled);
    } catch {
      failed += 1;
      await releaseAfterFailure(env, organization, now);
    }
  }
  return { claimed: claimed.length, corrected, failed, reconciled };
}
