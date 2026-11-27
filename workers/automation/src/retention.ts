import { Data, Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import { errorDiagnostic, log } from "@meltiply/observability";
import { createObjectStoreFromEnv, type ConfiguredObjectStore } from "@meltiply/storage";

import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";
import { deleteStorageObjectsEffect } from "./object-cleanup";
import {
  createPostgresRetentionRepository,
  type RetentionRepository,
} from "./repositories/retention-repository";

export interface RetentionResult {
  deleted: number;
  errors: number;
}

export interface RetentionOptions {
  batchSize?: number;
  repository?: RetentionRepository;
}

const defaultBatchSize = 1_000;
const maximumBatchSize = 5_000;

class RetentionStorageError extends Data.TaggedError("RetentionStorageError")<{
  cause: unknown;
  message: string;
}> {}

type RetentionCleanup = (
  env: AutomationEnv,
  repository: RetentionRepository,
  batchSize: number,
) => Effect.Effect<number, DatabaseError | RetentionStorageError>;

const purgeDueBrandProfiles: RetentionCleanup = (env, repository, batchSize) =>
  Effect.gen(function* () {
    const profileIds = yield* repository.findDueBrandProfiles(batchSize);
    if (profileIds.length === 0) {
      return 0;
    }

    const claimed = yield* repository.claimBrandProfileObjects(profileIds);
    if (claimed.length > 0) {
      let store: ConfiguredObjectStore;
      try {
        store = createObjectStoreFromEnv(env);
      } catch (cause) {
        return yield* Effect.fail(
          new RetentionStorageError({
            cause,
            message: "object storage is unavailable for brand profile purge",
          }),
        );
      }
      const cleanup = yield* deleteStorageObjectsEffect(store, claimed);
      if (cleanup.deletedIds.length > 0) {
        yield* repository.settleDeletedObjects(cleanup.deletedIds);
      }
      if (cleanup.firstError) {
        return yield* Effect.fail(
          new RetentionStorageError({
            cause: cleanup.firstError,
            message: cleanup.firstError.message,
          }),
        );
      }
    }

    return yield* repository.deletePurgedBrandProfiles(profileIds);
  });

const cleanups: readonly { name: string; run: RetentionCleanup }[] = [
  {
    name: "expired_idempotency_keys",
    run: (_env, repository, batchSize) => repository.deleteExpiredIdempotencyKeys(batchSize),
  },
  {
    name: "processed_webhook_events",
    run: (_env, repository, batchSize) => repository.deleteProcessedWebhookEvents(batchSize),
  },
  {
    name: "terminal_outbox_events",
    run: (_env, repository, batchSize) => repository.deleteTerminalOutboxEvents(batchSize),
  },
  {
    name: "completed_async_job_events",
    run: (_env, repository, batchSize) => repository.deleteCompletedAsyncJobEvents(batchSize),
  },
  {
    name: "old_usage_corrections",
    run: (_env, repository, batchSize) => repository.deleteOldUsageCorrections(batchSize),
  },
  {
    name: "old_analytics_snapshots",
    run: (_env, repository, batchSize) => repository.deleteOldAnalyticsSnapshots(batchSize),
  },
  {
    name: "stale_usage_buckets",
    run: (_env, repository, batchSize) => repository.deleteStaleUsageBuckets(batchSize),
  },
  { name: "due_brand_profiles", run: purgeDueBrandProfiles },
];

export function runRetention(
  env: AutomationEnv,
  options: RetentionOptions = {},
): Effect.Effect<RetentionResult, AutomationJobError> {
  const batchSize = options.batchSize ?? defaultBatchSize;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maximumBatchSize) {
    return Effect.fail(
      classifyJobError(
        new RangeError("retention batch size must be an integer between 1 and 5000"),
      ),
    );
  }
  const repository = options.repository ?? createPostgresRetentionRepository(env);

  return Effect.gen(function* () {
    let deleted = 0;
    let errors = 0;
    for (const cleanup of cleanups) {
      const outcome = yield* Effect.match(
        cleanup.run(env, repository, batchSize).pipe(Effect.mapError(classifyJobError)),
        {
          onFailure: (cause) => {
            log(
              "warn",
              {
                environment: env.ENVIRONMENT,
                job_id: cleanup.name,
                service: "automation",
                trace_id: cleanup.name,
                version: env.VERSION,
              },
              {
                ...errorDiagnostic(cause),
                cleanup: cleanup.name,
                event: "retention_cleanup_failed",
                job: "retention",
                outcome: "failed",
                retry_class: "platform_retry",
              },
            );
            return { deleted: 0, errors: 1 };
          },
          onSuccess: (count) => ({ deleted: count, errors: 0 }),
        },
      );
      deleted += outcome.deleted;
      errors += outcome.errors;
    }
    return { deleted, errors };
  });
}
