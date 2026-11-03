import { Effect } from "effect";

import type { DatabaseError, Platform } from "@meltiply/domain";

import type { ReportingConfiguration } from "./configuration";
import { categoryStatus, type PreferencesRow } from "./policy";
import type { ReportingClient } from "./service";

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
   * Post the Distribution belongs to. Only its first confirmed success counts,
   * so this identity is kept locally to deduplicate that one Post.
   */
  readonly postId: string;
  /**
   * `published_at` of the Distribution: the instant the Provider's success was
   * recorded. It is the measurement's UTC day and the interval-fence comparison,
   * so a reconciliation that lands later still credits the publication's day.
   */
  readonly confirmedAt: Date;
}

/**
 * Outcome of one measurement attempt.
 *
 * `counted` means the aggregate advanced; `already_counted` means the durable
 * marker proved a prior observation (a reconciliation that re-read a published
 * row), so nothing advanced; `not_counted` means reporting was not effective or
 * the confirmation predates the enabled interval, so the domain mark was kept
 * but no aggregate moved; `unavailable` means the reporting tables rejected the
 * write and the savepoint was rolled back.
 */
export type PublicationMeasurementOutcome =
  | "counted"
  | "already_counted"
  | "not_counted"
  | "unavailable";

/** Savepoint scoping every statement this module writes. */
const measurementSavepoint = "reporting_publication_measurement";

/**
 * Records one confirmed publication, at most once per Distribution and once per
 * Post, within the caller's transaction.
 *
 * Domain marks are written unconditionally — including while reporting is off —
 * because they record what happened, not what may be sent. That is what keeps a
 * Post whose first success predates consent from counting as a new Post when a
 * later Distribution succeeds after the Owner opts in, and what keeps a
 * reconciliation that re-observes `published` from incrementing again.
 *
 * Aggregate counters advance only while the usage category is effective under
 * persisted policy (requested, readable schema, an enabled interval, no operator
 * force-off, a configured destination) and only for confirmations inside that
 * interval, so a re-enable starts counting from its own interval and declined
 * activity is never replayed.
 *
 * Never fails: a reporting write that the schema rejects is rolled back to its
 * savepoint and reported as `unavailable`, leaving the publication untouched.
 *
 * @param client - Query client bound to the caller's open transaction.
 * @param confirmation - Confirmed publication facts.
 * @param configuration - This invocation's deployment reporting configuration.
 * @returns Effect resolving to the measurement outcome, never failing.
 */
export function recordPublicationUsage(
  client: ReportingClient,
  confirmation: PublicationConfirmation,
  configuration: ReportingConfiguration,
): Effect.Effect<PublicationMeasurementOutcome, never> {
  // An unrepresentable instant is not a measurement; the caller still commits.
  if (Number.isNaN(confirmation.confirmedAt.getTime())) {
    return Effect.succeed("not_counted" as const);
  }
  const confirmedAt = confirmation.confirmedAt.toISOString();
  return Effect.gen(function* () {
    yield* client.query(`SAVEPOINT ${measurementSavepoint}`);
    const preferences = yield* Effect.map(
      client.query<PreferencesRow>(
        `SELECT diagnostics_decided_at, diagnostics_interval_started_at, diagnostics_requested,
                installation_reporting_id, schema_version, usage_decided_at,
                usage_interval_started_at, usage_requested
         FROM reporting_preferences
         WHERE id`,
      ),
      (result) => result.rows[0] ?? null,
    );
    // The interval and the marks are written regardless of consent: the marks
    // are the durable evidence that this Distribution and this Post have been
    // observed, which is exactly what a later observation must not double-count.
    const distributionMark = yield* client.query<{ distribution_id: string }>(
      `INSERT INTO reporting_distribution_marks (distribution_id, platform, confirmed_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (distribution_id) DO NOTHING
       RETURNING distribution_id`,
      [confirmation.distributionId, confirmation.platform, confirmedAt],
    );
    if ((distributionMark.rowCount ?? distributionMark.rows.length) === 0) {
      yield* client.query(`RELEASE SAVEPOINT ${measurementSavepoint}`);
      return "already_counted" as const;
    }
    const policy = categoryStatus(preferences, "usage", configuration);
    const intervalStartedAt = policy.intervalStartedAt;
    const confirmedInstant = new Date(confirmedAt).getTime();
    const insideEnabledInterval =
      policy.effective &&
      intervalStartedAt !== null &&
      confirmedInstant >= new Date(intervalStartedAt).getTime();
    // The Post mark carries the whole domain fact: when the Post's first success
    // happened, and whether that instant was inside an effective reporting
    // interval. Deciding `counted` here, once, is what makes a later success of
    // the same Post unable to promote a pre-consent first success into a counted
    // one — and what keeps an operator force-off from being backfilled when the
    // operator later allows reporting again.
    yield* client.query(
      `INSERT INTO reporting_post_marks (post_id, first_confirmed_at, counted)
       VALUES ($1, $2, $3)
       ON CONFLICT (post_id) DO NOTHING`,
      [confirmation.postId, confirmedAt, insideEnabledInterval],
    );
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
      [
        intervalStartedAt,
        // The bucket is the UTC day the publication itself was confirmed on
        // (`published_at`), not the day a later reconciliation observed it, so a
        // catch-up credits the day the success happened rather than shifting it.
        confirmedAt.slice(0, 10),
        confirmation.platform,
      ],
    );
    yield* client.query(`RELEASE SAVEPOINT ${measurementSavepoint}`);
    return "counted" as const;
  }).pipe(
    // A reporting write must never fail the transaction that recorded a real
    // publication. The savepoint makes recovery exact: only this measurement's
    // statements are undone.
    Effect.catch((cause: DatabaseError) =>
      Effect.as(
        Effect.catch(
          client.query(`ROLLBACK TO SAVEPOINT ${measurementSavepoint}`),
          () => Effect.succeed(undefined),
        ),
        "unavailable" as const,
      ),
    ),
  );
}
