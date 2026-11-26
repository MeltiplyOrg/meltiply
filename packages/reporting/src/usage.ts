import { Effect } from "effect";

import type { Platform } from "@meltiply/domain";

import type { ReportingConfiguration } from "./configuration";
import { categoryStatus } from "./policy";
import {
  createPostgresPublicationUsageRepository,
  type PublicationUsageRepository,
} from "./repository";
import type { ReportingClient } from "./service";

/** The facts a confirmed publication contributes to the counters. */
export interface PublicationConfirmation {
  readonly distributionId: string;
  readonly platform: Platform;
  readonly postId: string;
}

/**
 * Outcome of one measurement attempt.
 *
 * `counted` means the aggregate advanced; `already_counted` means the durable
 * marker proved a prior observation (a reconciliation that re-read a published
 * row), so nothing advanced; `not_counted` means reporting was not effective or
 * the observation predates the enabled interval, so the domain mark was kept but
 * no aggregate moved — never because a day was already reported; `unavailable`
 * means the reporting tables rejected the write and the savepoint was rolled
 * back.
 */
export type PublicationMeasurementOutcome =
  | "counted"
  | "already_counted"
  | "not_counted"
  | "unavailable";

/**
 * Records one confirmed publication, at most once per Distribution, within the
 * caller's transaction. Every eligible confirmed Distribution is counted, and the
 * Post it belongs to is marked once so a Post published to several Channels stays
 * one Post.
 *
 * Never fails: a reporting write that the schema rejects is rolled back to its
 * savepoint and reported as `unavailable`, leaving the publication untouched.
 */
export function recordPublicationUsage(
  client: ReportingClient,
  confirmation: PublicationConfirmation,
  configuration: ReportingConfiguration,
  options: {
    readonly now?: () => Date;
    readonly repository?: PublicationUsageRepository;
  } = {},
): Effect.Effect<PublicationMeasurementOutcome, never> {
  const repository = options.repository ?? createPostgresPublicationUsageRepository(client);
  return Effect.gen(function* () {
    yield* repository.beginSavepoint();
    yield* repository.lockMeasurement();
    const observedAt = options.now ? options.now() : yield* repository.currentTime();
    if (Number.isNaN(observedAt.getTime())) {
      yield* repository.releaseSavepoint();
      return "not_counted" as const;
    }
    const observedInstant = observedAt.toISOString();
    const observedDay = observedInstant.slice(0, 10);
    const marked = yield* repository.markDistribution(
      confirmation.distributionId,
      confirmation.platform,
      observedInstant,
    );
    if (!marked) {
      yield* repository.releaseSavepoint();
      return "already_counted" as const;
    }
    const policy = categoryStatus(yield* repository.loadPreferences(), "usage", configuration);
    const intervalStartedAt = policy.intervalStartedAt;
    const insideEnabledInterval =
      policy.effective &&
      intervalStartedAt !== null &&
      observedAt.getTime() >= new Date(intervalStartedAt).getTime();
    const postMarked = yield* repository.hasPostMark(confirmation.postId);
    if (!postMarked) {
      const prior = yield* repository.findPriorPublishedDistribution(
        confirmation.postId,
        confirmation.distributionId,
      );
      const firstConfirmedAt =
        !prior.found || prior.publishedAt === null
          ? observedInstant
          : new Date(prior.publishedAt).toISOString();
      yield* repository.insertPostMark(
        confirmation.postId,
        firstConfirmedAt,
        !prior.found && insideEnabledInterval,
      );
    }
    if (!insideEnabledInterval) {
      yield* repository.releaseSavepoint();
      return "not_counted" as const;
    }
    yield* repository.incrementDailyDistribution(
      intervalStartedAt,
      observedDay,
      confirmation.platform,
    );
    yield* repository.releaseSavepoint();
    return "counted" as const;
  }).pipe(
    Effect.catch(() =>
      Effect.as(
        Effect.catch(repository.rollbackSavepoint(), () => Effect.succeed(undefined)),
        "unavailable" as const,
      ),
    ),
  );
}
