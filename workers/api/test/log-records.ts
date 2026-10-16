/** Narrows JSON values to records so callers can inspect named log fields. */
function isLogRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parses every first-argument console call captured on a `console[level]`
 * spy into its structured log record. Worker logging emits one JSON string
 * per line; non-JSON noise and flat-object regressions are excluded so
 * assertions fail against an empty record set rather than masking the
 * serialized shape.
 *
 * @param spy - Vitest spy placed on a console method that receives JSON log lines.
 * @returns Parsed structured log records in call order.
 */
export function logRecords(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string") return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return isLogRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
