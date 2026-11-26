export function isoPeriodKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}
