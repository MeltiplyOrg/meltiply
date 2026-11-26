export type LogLevel = "debug" | "error" | "info" | "warn";

export function samplingRate(rate: string | number | undefined): number {
  const parsed = typeof rate === "string" && rate.trim() !== "" ? Number(rate) : rate;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? Math.min(1, Math.max(0, parsed))
    : 1;
}

export function emitsLine(level: LogLevel, traceId: string, rate: number): boolean {
  if (level === "warn" || level === "error") return true;
  if (rate <= 0) return false;
  if (rate >= 1) return true;

  let hash = 2166136261;
  for (let index = 0; index < traceId.length; index++) {
    hash ^= traceId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296 < rate;
}
