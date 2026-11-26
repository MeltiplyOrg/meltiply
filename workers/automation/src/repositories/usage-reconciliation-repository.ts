import type { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";

import { withSystemTransactionEffect } from "../database";
import type { AutomationEnv } from "../env";

export interface ClaimedUsageOrganization extends Record<string, unknown> {
  consecutive_failures: number;
  org_id: string;
}

export interface UsageCounters {
  readonly api_calls: number;
  readonly distributions: number;
  readonly storage_bytes: number;
  readonly uploads: number;
}

export interface AuthoritativeUsageCounts {
  readonly active_platforms: number;
  readonly distributions: number;
  readonly provider_operations: number;
  readonly storage_bytes: number;
  readonly uploads: number;
}

interface UsagePeriod {
  readonly end: Date;
  readonly key: string;
  readonly start: Date;
}

export interface UsageCorrectionInput {
  readonly evidence: {
    readonly active_platforms: number;
    readonly provider_operations: number;
    readonly source: string;
  };
  readonly organizationId: string;
  readonly periodKey: string;
  readonly prior: UsageCounters;
  readonly reconciled: UsageCounters;
}

interface UsageReconciliationTransaction {
  readonly ensureUsageRecord: (
    organizationId: string,
    periodKey: string,
  ) => Effect.Effect<
    {
      readonly api_calls: number | string;
      readonly distributions: number | string;
      readonly storage_bytes: number | string;
      readonly uploads: number | string;
    } | null,
    DatabaseError
  >;
  readonly loadAuthoritativeUsage: (
    organizationId: string,
    period: UsagePeriod,
  ) => Effect.Effect<
    {
      readonly active_platforms: number | string;
      readonly distributions: number | string;
      readonly provider_operations: number | string;
      readonly storage_bytes: number | string;
      readonly uploads: number | string;
    },
    DatabaseError
  >;
  readonly updateUsageRecord: (
    organizationId: string,
    periodKey: string,
    reconciled: UsageCounters,
    now: Date,
  ) => Effect.Effect<void, DatabaseError>;
  readonly insertCorrection: (input: UsageCorrectionInput) => Effect.Effect<void, DatabaseError>;
  readonly markReconciled: (
    organizationId: string,
    now: Date,
    intervalSeconds: number,
  ) => Effect.Effect<void, DatabaseError>;
}

export interface UsageReconciliationRepository {
  readonly claimDueOrganizations: (
    now: Date,
    batchLimit: number,
    leaseSeconds: number,
  ) => Effect.Effect<ClaimedUsageOrganization[], DatabaseError>;
  readonly transaction: <A, E>(
    operation: (tx: UsageReconciliationTransaction) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | DatabaseError>;
  readonly releaseAfterFailure: (
    organizationId: string,
    now: Date,
    retrySeconds: number,
    consecutiveFailures: number,
  ) => Effect.Effect<void, DatabaseError>;
}

export function createPostgresUsageReconciliationRepository(
  env: AutomationEnv,
): UsageReconciliationRepository {
  return {
    claimDueOrganizations: (now, batchLimit, leaseSeconds) =>
      withSystemTransactionEffect(env, (client) =>
        Effect.map(
          client.query<ClaimedUsageOrganization>(
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
      ),

    transaction: (operation) =>
      withSystemTransactionEffect(env, (client) =>
        operation({
          ensureUsageRecord: (organizationId, periodKey) =>
            Effect.map(
              client.query<{
                api_calls: number | string;
                distributions: number | string;
                storage_bytes: number | string;
                uploads: number | string;
              }>(
                `INSERT INTO usage_records (org_id, period)
                 SELECT id, $2
                 FROM organizations
                 WHERE id = $1
                 ON CONFLICT (org_id, period) DO UPDATE
                 SET updated_at = usage_records.updated_at
                 RETURNING uploads, distributions, api_calls, storage_bytes`,
                [organizationId, periodKey],
              ),
              (result) => (result.rowCount === 1 ? (result.rows[0] ?? null) : null),
            ),

          loadAuthoritativeUsage: (organizationId, period) =>
            Effect.map(
              client.query<{
                active_platforms: number | string;
                distributions: number | string;
                provider_operations: number | string;
                storage_bytes: number | string;
                uploads: number | string;
              }>(
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
                [organizationId, period.start, period.end],
              ),
              (result) => result.rows[0]!,
            ),

          updateUsageRecord: (organizationId, periodKey, reconciled, now) =>
            Effect.asVoid(
              client.query(
                `UPDATE usage_records
                 SET uploads = $3, distributions = $4, storage_bytes = $5,
                     updated_at = $6
                 WHERE org_id = $1 AND period = $2`,
                [
                  organizationId,
                  periodKey,
                  reconciled.uploads,
                  reconciled.distributions,
                  reconciled.storage_bytes,
                  now,
                ],
              ),
            ),

          insertCorrection: (input) =>
            Effect.asVoid(
              client.query(
                `INSERT INTO usage_corrections
                   (org_id, period, reason, prior_usage, reconciled_usage, evidence)
                 VALUES (
                   $1, $2, 'scheduled_authoritative_reconciliation', $3, $4, $5
                 )`,
                [
                  input.organizationId,
                  input.periodKey,
                  input.prior,
                  input.reconciled,
                  input.evidence,
                ],
              ),
            ),

          markReconciled: (organizationId, now, intervalSeconds) =>
            Effect.asVoid(
              client.query(
                `UPDATE usage_reconciliation_state
                 SET next_reconciliation_at = $2::timestamptz
                       + ($3::integer * INTERVAL '1 second'),
                     lease_until = NULL,
                     last_completed_at = $2,
                     consecutive_failures = 0,
                     last_error_code = NULL,
                     updated_at = $2
                 WHERE org_id = $1`,
                [organizationId, now, intervalSeconds],
              ),
            ),
        }),
      ),

    releaseAfterFailure: (organizationId, now, retrySeconds, consecutiveFailures) =>
      withSystemTransactionEffect(env, (client) =>
        Effect.asVoid(
          client.query(
            `UPDATE usage_reconciliation_state
             SET next_reconciliation_at = $2::timestamptz
                   + ($3::integer * INTERVAL '1 second'),
                 lease_until = NULL,
                 consecutive_failures = $4,
                 last_error_code = 'usage_reconciliation_failed',
                 updated_at = $2
             WHERE org_id = $1`,
            [organizationId, now, retrySeconds, consecutiveFailures],
          ),
        ),
      ),
  };
}

export class FakeUsageReconciliationStore {
  due: ClaimedUsageOrganization[] = [];
  readonly priorByOrg = new Map<string, UsageCounters>();
  readonly authoritativeByOrg = new Map<string, AuthoritativeUsageCounts>();
  readonly failOrg = new Map<string, DatabaseError>();
  readonly updatedRecords: Array<{ orgId: string; periodKey: string; counters: UsageCounters }> =
    [];
  readonly corrections: UsageCorrectionInput[] = [];
  readonly reconciledOrgs: string[] = [];
  readonly failedReleases: Array<{
    consecutiveFailures: number;
    orgId: string;
    retrySeconds: number;
  }> = [];
  claimCalls = 0;
}

export function createFakeUsageReconciliationRepository(
  store: FakeUsageReconciliationStore,
): UsageReconciliationRepository {
  return {
    claimDueOrganizations: (_now, batchLimit) =>
      Effect.sync(() => {
        store.claimCalls += 1;
        return store.due.slice(0, batchLimit).map((row) => ({ ...row }));
      }),

    transaction: (operation) =>
      operation({
        ensureUsageRecord: (organizationId) => {
          const failure = store.failOrg.get(organizationId);
          if (failure) return Effect.fail(failure);
          return Effect.sync(() => store.priorByOrg.get(organizationId) ?? null);
        },

        loadAuthoritativeUsage: (organizationId) =>
          Effect.sync(
            () =>
              store.authoritativeByOrg.get(organizationId) ?? {
                active_platforms: 0,
                distributions: 0,
                provider_operations: 0,
                storage_bytes: 0,
                uploads: 0,
              },
          ),

        updateUsageRecord: (organizationId, periodKey, counters) =>
          Effect.sync(() => {
            store.updatedRecords.push({ counters, orgId: organizationId, periodKey });
          }),

        insertCorrection: (input) =>
          Effect.sync(() => {
            store.corrections.push(input);
          }),

        markReconciled: (organizationId) =>
          Effect.sync(() => {
            store.reconciledOrgs.push(organizationId);
          }),
      }),

    releaseAfterFailure: (orgId, _now, retrySeconds, consecutiveFailures) =>
      Effect.sync(() => {
        store.failedReleases.push({ consecutiveFailures, orgId, retrySeconds });
      }),
  };
}
