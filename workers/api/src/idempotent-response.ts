export function idempotencyHeaders(replayed: boolean): Record<string, string> {
  return replayed ? { "Idempotency-Replayed": "true" } : {};
}
