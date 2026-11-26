import { Data, Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import { createObjectStoreFromEnv, type ConfiguredObjectStore } from "@meltiply/storage";

import { classifyJobError, type AutomationJobError } from "./effect/index";
import type { AutomationEnv } from "./env";
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
    const reclaimedObjectIds: string[] = [];
    let failure: RetentionStorageError | undefined;
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
      const outcomes = yield* Effect.forEach(
        claimed,
        (object) =>
          Effect.match(
            Effect.tryPromise({
              catch: (cause) =>
                new RetentionStorageError({
                  cause,
                  message: `unable to delete brand profile object ${object.r2_key}`,
                }),
              try: () => store.delete(object.r2_key),
            }),
            {
              onFailure: (error) => ({ error, id: null as string | null }),
              onSuccess: () => ({
                error: undefined as RetentionStorageError | undefined,
                id: object.id,
              }),
            },
          ),
        { concurrency: 8 },
      );
      for (const outcome of outcomes) {
        if (outcome.id !== null) reclaimedObjectIds.push(outcome.id);
        else failure ??= outcome.error;
      }
    }

    if (reclaimedObjectIds.length > 0) {
      yield* repository.settleDeletedObjects(reclaimedObjectIds.map((id) => ({ id })));
    }
    if (failure) {
      return yield* Effect.fail(failure);
    }

    return yield* repository.deletePurgedBrandProfiles(profileIds);
  });

const cleanups: readonly RetentionCleanup[] = [
  (_env, repository, batchSize) => repository.deleteExpiredIdempotencyKeys(batchSize),
  (_env, repository, batchSize) => repository.deleteProcessedWebhookEvents(batchSize),
  (_env, repository, batchSize) => repository.deleteTerminalOutboxEvents(batchSize),
  (_env, repository, batchSize) => repository.deleteCompletedAsyncJobEvents(batchSize),
  (_env, repository, batchSize) => repository.deleteOldUsageCorrections(batchSize),
  (_env, repository, batchSize) => repository.deleteOldAnalyticsSnapshots(batchSize),
  (_env, repository, batchSize) => repository.deleteStaleUsageBuckets(batchSize),
  purgeDueBrandProfiles,
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
        cleanup(env, repository, batchSize).pipe(Effect.mapError(classifyJobError)),
        {
          onFailure: () => ({ deleted: 0, errors: 1 }),
          onSuccess: (count) => ({ deleted: count, errors: 0 }),
        },
      );
      deleted += outcome.deleted;
      errors += outcome.errors;
    }
    return { deleted, errors };
  });
}
