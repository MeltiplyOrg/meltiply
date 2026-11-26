import { Effect } from "effect";

import type { Platform } from "@meltiply/domain";

import type { ReportingConfiguration } from "./configuration";
import { categoryStatus } from "./policy";
import { loadPreferences, lockReportingMeasurement, type ReportingClient } from "./service";

export interface PublicationConfirmation {
  readonly distributionId: string;
  readonly platform: Platform;
  readonly postId: string;
}

export type PublicationMeasurementOutcome =
  | "counted"
  | "already_counted"
  | "not_counted"
  | "unavailable";

const measurementSavepoint = "reporting_publication_measurement";

/** Records one confirmed publication inside the caller's transaction, rolling back only its own savepoint on failure. */
export function recordPublicationUsage(
  client: ReportingClient,
  confirmation: PublicationConfirmation,
  configuration: ReportingConfiguration,
  options: { readonly now?: () => Date } = {},
): Effect.Effect<PublicationMeasurementOutcome, never> {
  return Effect.suspend(() => {
    let savepointActive = false;
    return Effect.gen(function* () {
      yield* client.query(`SAVEPOINT ${measurementSavepoint}`);
      savepointActive = true;
      yield* lockReportingMeasurement(client);
      const observedAt = options.now
        ? options.now()
        : yield* Effect.map(
            client.query<{ observed_at: Date | string }>("SELECT clock_timestamp() AS observed_at"),
            (result) => new Date(result.rows[0]?.observed_at ?? Date.now()),
          );
      if (Number.isNaN(observedAt.getTime())) {
        yield* client.query(`RELEASE SAVEPOINT ${measurementSavepoint}`);
        savepointActive = false;
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
        savepointActive = false;
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
        savepointActive = false;
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
      savepointActive = false;
      return "counted" as const;
    }).pipe(
      Effect.catch(() => {
        if (!savepointActive) return Effect.succeed("unavailable" as const);
        return Effect.as(
          Effect.catch(client.query(`ROLLBACK TO SAVEPOINT ${measurementSavepoint}`), () =>
            Effect.succeed(undefined),
          ),
          "unavailable" as const,
        );
      }),
    );
  });
}
