import { Effect } from "effect";

import type { Platform } from "@meltiply/domain";

import type { ReportingConfiguration } from "./configuration";
import { categoryStatus } from "./policy";
import { loadPreferences, lockReportingMeasurement, type ReportingClient } from "./service";

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

const measurementSavepoint = "reporting_publication_measurement";

/**
 * Records one confirmed publication, at most once per Distribution, within the
 * caller's transaction. Every eligible confirmed Distribution is counted, and the
 * Post it belongs to is marked once so a Post published to several Channels stays
 * one Post.
 *
 * Domain marks are written unconditionally — including while reporting is off —
 * because they record what happened, not what may be sent. That is what keeps a
 * reconciliation that re-observes `published` from incrementing again, and what
 * records a pre-consent first success without ever presenting it as a new Post.
 *
 * Aggregate counters advance only while the usage category is effective under
 * persisted policy (requested, a supported disclosure version, an enabled
 * interval, no operator force-off, a configured destination) and only for
 * observations inside that interval, so a re-enable starts counting from its own
 * interval and declined activity is never replayed.
 *
 * Concurrency is ordered by one installation-wide lock: the daily producer takes
 * the same lock before it derives a day, so an increment can never land after the
 * day it belongs to was measured, and the day it belongs to is the one the
 * database clock read *after* the lock — never the transaction's start instant.
 *
 * Never fails: a reporting write that the schema rejects is rolled back to its
 * savepoint and reported as `unavailable`, leaving the publication untouched.
 */
export function recordPublicationUsage(
  client: ReportingClient,
  confirmation: PublicationConfirmation,
  configuration: ReportingConfiguration,
  options: { readonly now?: () => Date } = {},
): Effect.Effect<PublicationMeasurementOutcome, never> {
  return Effect.gen(function* () {
    yield* client.query(`SAVEPOINT ${measurementSavepoint}`);
    yield* lockReportingMeasurement(client);
    const observedAt = options.now
      ? options.now()
      : yield* Effect.map(
          client.query<{ observed_at: Date | string }>("SELECT clock_timestamp() AS observed_at"),
          (result) => new Date(result.rows[0]?.observed_at ?? Date.now()),
        );
    if (Number.isNaN(observedAt.getTime())) {
      yield* client.query(`RELEASE SAVEPOINT ${measurementSavepoint}`);
      return "not_counted" as const;
    }
    const observedInstant = observedAt.toISOString();
    const observedDay = observedInstant.slice(0, 10);
    const distributionMark = yield* client.query<{ distribution_id: string }>(
      `INSERT INTO reporting_distribution_marks (distribution_id, platform, confirmed_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (distribution_id) DO NOTHING
       RETURNING distribution_id`,
      [confirmation.distributionId, confirmation.platform, observedInstant],
    );
    if ((distributionMark.rowCount ?? distributionMark.rows.length) === 0) {
      yield* client.query(`RELEASE SAVEPOINT ${measurementSavepoint}`);
      return "already_counted" as const;
    }
    const policy = categoryStatus(yield* loadPreferences(client, false), "usage", configuration);
    const intervalStartedAt = policy.intervalStartedAt;
    const insideEnabledInterval =
      policy.effective &&
      intervalStartedAt !== null &&
      observedAt.getTime() >= new Date(intervalStartedAt).getTime();
    const postMark = yield* client.query<{ counted: boolean }>(
      "SELECT counted FROM reporting_post_marks WHERE post_id = $1",
      [confirmation.postId],
    );
    if (postMark.rows.length === 0) {
      const prior = yield* client.query<{ published_at: Date | string | null }>(
        `SELECT published_at FROM distributions
         WHERE post_id = $1 AND status = 'published' AND id <> $2
         ORDER BY published_at NULLS LAST, id
         LIMIT 1`,
        [confirmation.postId, confirmation.distributionId],
      );
      const priorSuccess = prior.rows[0];
      const firstConfirmedAt =
        priorSuccess?.published_at === undefined || priorSuccess.published_at === null
          ? observedInstant
          : new Date(priorSuccess.published_at).toISOString();
      yield* client.query(
        `INSERT INTO reporting_post_marks (post_id, first_confirmed_at, counted)
         VALUES ($1, $2, $3)
         ON CONFLICT (post_id) DO NOTHING`,
        [
          confirmation.postId,
          firstConfirmedAt,
          priorSuccess === undefined && insideEnabledInterval,
        ],
      );
    }
    if (!insideEnabledInterval) {
      yield* client.query(`RELEASE SAVEPOINT ${measurementSavepoint}`);
      return "not_counted" as const;
    }
    yield* client.query(
      `INSERT INTO reporting_publication_daily
         (interval_started_at, report_date, platform, distributions)
       VALUES ($1, $2::date, $3, 1)
       ON CONFLICT (interval_started_at, report_date, platform) DO UPDATE
       SET distributions = reporting_publication_daily.distributions + 1,
           updated_at = now()`,
      [intervalStartedAt, observedDay, confirmation.platform],
    );
    yield* client.query(`RELEASE SAVEPOINT ${measurementSavepoint}`);
    return "counted" as const;
  }).pipe(
    Effect.catch(() =>
      Effect.as(
        Effect.catch(client.query(`ROLLBACK TO SAVEPOINT ${measurementSavepoint}`), () =>
          Effect.succeed(undefined),
        ),
        "unavailable" as const,
      ),
    ),
  );
}
