import { Effect } from "effect";

import type { Platform } from "@meltiply/domain";

import type { ReportingConfiguration } from "./configuration";
import { categoryStatus } from "./policy";
import { loadPreferences, lockReportingMeasurement, type ReportingClient } from "./service";

/**
 * Transactional publication measurement for the opt-in daily usage summary.
 *
 * This module answers one question: "a Distribution just reached `published`
 * — does that count, and once?" It is deliberately part of the reporting module
 * so policy evaluation has one authority, and it writes only installation-local
 * aggregates. Nothing here transmits, logs or identifies a Post, Distribution,
 * Channel, Workspace or member.
 *
 * The caller runs it inside the same database transaction that recorded the
 * publication, so a counted success and the domain commit are atomic. Each
 * measurement owns a savepoint: if the reporting write fails, the savepoint is
 * rolled back and the publication still commits. Reporting must never be able
 * to roll back a publication.
 */

/** The facts a confirmed publication contributes to the counters. */
export interface PublicationConfirmation {
  /** Distribution that just transitioned to `published`. */
  readonly distributionId: string;
  /** Platform the Distribution published to; the counter's only dimension. */
  readonly platform: Platform;
  /**
   * Post the Distribution belongs to. The Post is counted at most once, and its
   * own mark never suppresses a Distribution counter: a Post published to three
   * Channels is one Post and three Distributions.
   */
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

/** Savepoint scoping every statement this module writes. */
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
 *
 * @param client - Query client bound to the caller's open transaction.
 * @param confirmation - Confirmed publication facts.
 * @param configuration - This invocation's deployment reporting configuration.
 * @param options - Optional clock seam; deployments read the database clock.
 * @returns Effect resolving to the measurement outcome, never failing.
 */
export function recordPublicationUsage(
  client: ReportingClient,
  confirmation: PublicationConfirmation,
  configuration: ReportingConfiguration,
  options: { readonly now?: () => Date } = {},
): Effect.Effect<PublicationMeasurementOutcome, never> {
  return Effect.gen(function* () {
    yield* client.query(`SAVEPOINT ${measurementSavepoint}`);
    // One installation-wide lock orders every measurement against every other
    // measurement and against the daily producer's snapshot. It is taken before
    // the measurement instant is read, so the instant reflects the order the
    // work actually commits in: a transaction that had to wait for another
    // measurement, or for a producer that had already frozen a day, reads the
    // later clock instead of its own transaction start. That is what lets a
    // publication that began before midnight still be counted — in the day it
    // truly committed — rather than silently dropped or backdated.
    yield* lockReportingMeasurement(client);
    // The measurement instant is the database's own clock, read after the lock.
    // Transaction-start `now()` would be stale for exactly the long transaction
    // this lock exists to order, and the Distribution's `published_at` describes
    // when the Provider succeeded, not when this counter commits. The injected
    // clock is a test seam mirroring the module's other seams; deployments use
    // the database clock.
    const observedAt = options.now
      ? options.now()
      : yield* Effect.map(
          client.query<{ observed_at: Date | string }>("SELECT clock_timestamp() AS observed_at"),
          (result) => new Date(result.rows[0]?.observed_at ?? Date.now()),
        );
    // An unrepresentable instant is not a measurement; the caller still commits.
    if (Number.isNaN(observedAt.getTime())) {
      yield* client.query(`RELEASE SAVEPOINT ${measurementSavepoint}`);
      return "not_counted" as const;
    }
    const observedInstant = observedAt.toISOString();
    const observedDay = observedInstant.slice(0, 10);
    // The Distribution mark is the "each Distribution once" guard and is written
    // regardless of consent: it records that this success was observed, which is
    // what keeps a re-observed `published` row from counting twice.
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
    // The Post mark answers one question only: did this Post's first *eligible*
    // success happen while reporting was in force? It never decides whether this
    // Distribution counts. A Post can succeed on several Channels, and each of
    // those successes is its own confirmed Distribution.
    const postMark = yield* client.query<{ counted: boolean }>(
      "SELECT counted FROM reporting_post_marks WHERE post_id = $1",
      [confirmation.postId],
    );
    if (postMark.rows.length === 0) {
      // A Post that reached `published` before this module existed has history
      // but no mark. That earlier success is a pre-consent fact — recording it as
      // a fresh first success would present an old publication as a new Post — so
      // the mark is written uncounted. The sibling's own stored instant is the
      // local provenance; no Provider is queried and nothing is backfilled. The
      // Distribution being measured now is still counted below when policy
      // allows it.
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
    // An eligible confirmed success always advances its Platform's counter. The
    // lock above is what makes that safe against the daily producer: the producer
    // takes the same lock before it derives and freezes a day, so it waits for
    // this commit and includes the increment. No day is ever refused after the
    // fact, and no valid count is dropped.
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
    // A reporting write must never fail the transaction that recorded a real
    // publication. The savepoint makes recovery exact: only this measurement's
    // statements are undone.
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
