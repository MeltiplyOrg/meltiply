/**
 * Idempotent response helper.
 *
 * Absorbs the repeated Idempotency-Replayed header pattern across route
 * handlers. Callers pass the replayed flag and get back the correct header
 * object.
 */

/**
 * Returns the `Idempotency-Replayed` HTTP response header when a cached result is returned.
 *
 * Informs calling clients whether a mutating operation was newly performed or safely replayed
 * from a stored idempotency ledger record.
 *
 * @param replayed - True if the response payload was retrieved from a prior completed execution.
 * @returns Header dictionary with `Idempotency-Replayed: true` when replayed, or empty object if fresh.
 * @example idempotencyHeaders(true) -> { "Idempotency-Replayed": "true" }.
 */
export function idempotencyHeaders(replayed: boolean): Record<string, string> {
  return replayed ? { "Idempotency-Replayed": "true" } : {};
}
