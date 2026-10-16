// Worker-internal time helpers (AUD-021).

/**
 * Generates a calendar-month period key (`YYYY-MM`, UTC) used to bucket usage and billing limits.
 *
 * Slices the UTC ISO string to ensure consistent monthly accounting across all workspace
 * quota checks (uploads, storage, and distributions) regardless of local runtime timezone.
 *
 * @param now - Reference timestamp to format.
 * @returns 7-character string formatted as `YYYY-MM` in UTC.
 * @example isoPeriodKey(new Date("2026-09-12T06:55:22Z")) -> "2026-09".
 */
export function isoPeriodKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}
