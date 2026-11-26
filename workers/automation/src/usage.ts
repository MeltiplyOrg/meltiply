import { Cause, Effect, Exit } from "effect";
import type { DatabaseError } from "@meltiply/domain";

import { runJobProgram } from "./effect/boundary";
import type { AutomationEnv } from "./env";
import {
  createPostgresUsageReconciliationRepository,
  type ClaimedUsageOrganization,
  type UsageReconciliationRepository,
} from "./repositories/usage-reconciliation-repository";
import { nextDelaySeconds, USAGE_RECONCILIATION_RETRY_POLICY } from "./retry-policy";

export interface UsageReconciliationOptions {
  batchLimit?: number;
  now?: Date;
  repository?: UsageReconciliationRepository;
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
    key: start.toISOString().slice(0, 7),
    start,
  };
}

function reconcileOrganization(
  repository: UsageReconciliationRepository,
  organizationId: string,
  now: Date,
): Effect.Effect<{ corrected: boolean; reconciled: boolean }, DatabaseError> {
  const currentPeriod = period(now);
  return repository.transaction((tx) =>
    Effect.gen(function* () {
      const priorRow = yield* tx.ensureUsageRecord(organizationId, currentPeriod.key);
      if (!priorRow) {
        return { corrected: false, reconciled: false };
      }
      const source = yield* tx.loadAuthoritativeUsage(organizationId, currentPeriod);
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

      yield* tx.updateUsageRecord(organizationId, currentPeriod.key, reconciled, now);
      if (corrected) {
        yield* tx.insertCorrection({
          evidence: {
            active_platforms: boundedCount(source.active_platforms, "active_platforms"),
            provider_operations: boundedCount(source.provider_operations, "provider_operations"),
            source: "domain_rows_and_r2_verified_metadata",
          },
          organizationId,
          periodKey: currentPeriod.key,
          prior,
          reconciled,
        });
      }
      yield* tx.markReconciled(organizationId, now, reconciliationIntervalSeconds);
      return { corrected, reconciled: true };
    }),
  );
}

function releaseAfterFailure(
  repository: UsageReconciliationRepository,
  organization: ClaimedUsageOrganization,
  now: Date,
): Effect.Effect<void, DatabaseError> {
  const completedFailures = organization.consecutive_failures + 1;
  const retrySeconds =
    nextDelaySeconds(USAGE_RECONCILIATION_RETRY_POLICY, completedFailures) ??
    reconciliationIntervalSeconds;
  return repository.releaseAfterFailure(organization.org_id, now, retrySeconds, completedFailures);
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
    const repository = options.repository ?? createPostgresUsageReconciliationRepository(env);
    const claimed = yield* repository.claimDueOrganizations(now, batchLimit, leaseSeconds);
    const outcomes = yield* Effect.forEach(
      claimed,
      (organization) =>
        reconcileOrganization(repository, organization.org_id, now).pipe(
          Effect.map((result) => ({
            corrected: Number(result.corrected),
            failed: 0,
            reconciled: Number(result.reconciled),
          })),
          Effect.catchCause(() =>
            releaseAfterFailure(repository, organization, now).pipe(
              Effect.as({ corrected: 0, failed: 1, reconciled: 0 }),
            ),
          ),
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
