function isLogRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
