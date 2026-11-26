import { isoDateTimeOrNull } from "@meltiply/domain";
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
  return isoDateTimeOrNull(value);
}

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

function categoryReason(
  row: PreferencesRow | null,
  requested: boolean,
  disclosureVersion: number | null,
  configuration: ReportingConfiguration,
): ReportingCategoryReason {
  if (row && row.schema_version !== REPORTING_SCHEMA_VERSION) return "preference_unavailable";
  if (
    row &&
    requested &&
    (disclosureVersion === null || disclosureVersion !== REPORTING_DISCLOSURE_VERSION)
  ) {
    return "preference_unavailable";
  }
  if (!requested) return "not_requested";
  if (configuration.forcedOff) return "operator_disabled";
  if (!configuration.destination) return "destination_unavailable";
  return "enabled";
}

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
  const reason = categoryReason(row, requested, base.disclosureVersion, configuration);
  return { ...base, effective: reason === "enabled", reason };
}

/**
 * Projects persisted state and deployment configuration into the policy the API
 * and the delivery path both act on.
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
 */
export function retryDelaySeconds(attempts: number, expiresAt: Date, now: Date): number | null {
  const delay = Math.min(3_600, 300 * 2 ** Math.max(0, attempts - 1));
  const nextAttempt = now.getTime() + delay * 1_000;
  return nextAttempt >= expiresAt.getTime() ? null : delay;
}
