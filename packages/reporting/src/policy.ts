import type { ReportingConfiguration } from "./configuration";
import {
  REPORTING_DISCLOSURE_VERSION,
  REPORTING_SCHEMA_VERSION,
  type ReportingCategory,
  type ReportingCategoryReason,
  type ReportingCategoryStatus,
  type ReportingPolicySnapshot,
} from "./contracts";

/** The persisted preference row as the database returns it. */
export interface PreferencesRow extends Record<string, unknown> {
  diagnostics_decided_at: Date | string | null;
  diagnostics_disclosure_version: number | null;
  diagnostics_interval_started_at: Date | string | null;
  diagnostics_requested: boolean;
  installation_reporting_id: string | null;
  schema_version: number;
  usage_decided_at: Date | string | null;
  usage_disclosure_version: number | null;
  usage_interval_started_at: Date | string | null;
  usage_requested: boolean;
}

/** Converts a driver timestamp to an ISO string, preserving null. */
export function isoOrNull(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Columns backing one category, so both categories read the same way. */
function categoryColumns(row: PreferencesRow, category: ReportingCategory) {
  return category === "usage"
    ? {
        decidedAt: row.usage_decided_at,
        disclosureVersion: row.usage_disclosure_version ?? null,
        intervalStartedAt: row.usage_interval_started_at,
        requested: row.usage_requested === true,
      }
    : {
        decidedAt: row.diagnostics_decided_at,
        disclosureVersion: row.diagnostics_disclosure_version ?? null,
        intervalStartedAt: row.diagnostics_interval_started_at,
        requested: row.diagnostics_requested === true,
      };
}

/**
 * Decides one category's requested and effective status.
 *
 * The order is deliberate and answers the operator's real question: an Owner who
 * never asked sees `not_requested`; an Owner who asked but cannot transmit sees
 * why. Unreadable preference state outranks everything because the stored choice
 * itself is untrustworthy.
 *
 * Consent is granted against a specific disclosure text, so a category whose
 * stored disclosure version is missing or no longer the supported one fails
 * closed as `preference_unavailable`: the persisted choice cannot authorize a
 * payload the Owner never saw described. Retrieval is unaffected — the Owner can
 * still read the state and record a fresh decision.
 *
 * @param row - Persisted preference row, or null when no choice was ever saved.
 * @param category - Category to evaluate.
 * @param configuration - Deployment configuration for the current invocation.
 * @returns Requested status, effective status, reason and interval bounds.
 */
export function categoryStatus(
  row: PreferencesRow | null,
  category: ReportingCategory,
  configuration: ReportingConfiguration,
): ReportingCategoryStatus {
  const stored = row ? categoryColumns(row, category) : null;
  const requested = stored?.requested ?? false;
  const base = {
    decidedAt: stored ? isoOrNull(stored.decidedAt) : null,
    disclosureVersion: stored?.disclosureVersion ?? null,
    intervalStartedAt: stored ? isoOrNull(stored.intervalStartedAt) : null,
    requested,
  };
  const reason: ReportingCategoryReason = ((): ReportingCategoryReason => {
    if (row && row.schema_version !== REPORTING_SCHEMA_VERSION) return "preference_unavailable";
    // A stored request without a supported disclosure decision is not consent:
    // it is an unreadable choice, and sending under it would report activity no
    // disclosure covered.
    if (
      row &&
      requested &&
      (base.disclosureVersion === null || base.disclosureVersion !== REPORTING_DISCLOSURE_VERSION)
    ) {
      return "preference_unavailable";
    }
    if (!requested) return "not_requested";
    if (configuration.forcedOff) return "operator_disabled";
    if (!configuration.destination) return "destination_unavailable";
    return "enabled";
  })();
  return { ...base, effective: reason === "enabled", reason };
}

/**
 * Projects persisted state and deployment configuration into the policy the API
 * and the delivery path both act on.
 *
 * @param row - Persisted preference row, or null for an installation that has
 *   never saved a choice (existing installations and fresh ones alike).
 * @param configuration - Deployment configuration for the current invocation.
 * @returns Complete policy snapshot for a member-readable response.
 */
export function policySnapshot(
  row: PreferencesRow | null,
  configuration: ReportingConfiguration,
): ReportingPolicySnapshot {
  return {
    categories: {
      diagnostics: categoryStatus(row, "diagnostics", configuration),
      usage: categoryStatus(row, "usage", configuration),
    },
    destinationConfigured: configuration.destination !== null,
    disclosureVersion: REPORTING_DISCLOSURE_VERSION,
    installationReportingId: row?.installation_reporting_id ?? null,
    operatorForcedOff: configuration.forcedOff,
  };
}

/**
 * Reports whether one category may transmit under the current policy.
 *
 * @param policy - Snapshot already evaluated for this invocation's configuration.
 * @param category - Category the pending report belongs to.
 * @returns True only when the category is effective.
 */
export function categoryEffective(
  policy: ReportingPolicySnapshot,
  category: ReportingCategory,
): boolean {
  return policy.categories[category].effective;
}

/** Reports whether the one-time feedback action may transmit right now. */
export function feedbackEffective(configuration: ReportingConfiguration): boolean {
  return !configuration.forcedOff && configuration.destination !== null;
}

/**
 * Computes the next attempt delay for a failed delivery.
 *
 * Reuses the repository's exponential convention rather than inventing a second
 * delivery framework, and never schedules beyond the row's expiry: a pending
 * report that would retry after it expired is discarded instead.
 *
 * @param attempts - Attempts already recorded, including the current one.
 * @param expiresAt - The row's hard expiry.
 * @param now - Current instant.
 * @returns Backoff delay in seconds, or null when the row should be discarded.
 */
export function retryDelaySeconds(attempts: number, expiresAt: Date, now: Date): number | null {
  const delay = Math.min(3_600, 300 * 2 ** Math.max(0, attempts - 1));
  const nextAttempt = now.getTime() + delay * 1_000;
  return nextAttempt >= expiresAt.getTime() ? null : delay;
}
