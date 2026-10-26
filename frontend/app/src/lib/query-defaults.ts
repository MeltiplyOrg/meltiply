import { ApiError } from "./api";
import { isInFlightPublicationStatus } from "./publication-status";

const maxQueryRetries = 2;
const maxRetryDelayMs = 30_000;
const pollingIntervalMs = 10_000;

/** Browser-only freshness for slow-changing reference data and stored Analytics. */
export const referenceFreshnessMs = 5 * 60_000;
/** Inactive private reads survive route navigation in memory, never persistent storage. */
export const privateCacheRetentionMs = 30 * 60_000;

const activeAssetStatuses = new Set(["pending_upload", "uploading", "processing", "deleting"]);
const activeReplyStatuses = new Set(["queued", "processing"]);

/**
 * Determines whether a failed query should be retried by TanStack Query.
 * Permits up to 2 retries, rejects 401/403 authentication failures immediately,
 * and defers to `error.retryable` on known `ApiError` instances.
 *
 * @param failureCount Number of consecutive failures encountered so far.
 * @param error Error thrown by the query function.
 * @returns `true` if TanStack Query should retry the request, `false` otherwise.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= maxQueryRetries) return false;
  if (!(error instanceof ApiError)) return true;
  if (error.status === 401 || error.status === 403) return false;
  return error.retryable;
}

/**
 * Calculates exponential backoff retry delay in milliseconds for failed queries.
 * Respects server-provided `Retry-After` header values on `ApiError` instances,
 * capped at a maximum delay of 30 seconds.
 *
 * @param attempt 0-indexed attempt count.
 * @param error Error thrown by the query function.
 * @returns Delay duration in milliseconds before the next query attempt.
 */
export function queryRetryDelay(attempt: number, error: unknown): number {
  if (error instanceof ApiError && error.retryAfterSeconds !== null) {
    return Math.min(error.retryAfterSeconds * 1000, maxRetryDelayMs);
  }
  return Math.min(1000 * 2 ** attempt, maxRetryDelayMs);
}

/**
 * Recursively scans arbitrary query response data to detect active/transient lifecycle states
 * (e.g. `uploading`, `processing`, `queued`, `awaiting_provider`, `cancel_requested`).
 *
 * @param value Query result data or sub-object.
 * @returns `true` if any nested item has an in-flight status, `false` otherwise.
 */
function containsActiveState(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsActiveState);
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (typeof record.status === "string") {
    if (activeAssetStatuses.has(record.status) || isInFlightPublicationStatus(record.status)) {
      return true;
    }
  }
  if (typeof record.reply_status === "string" && activeReplyStatuses.has(record.reply_status)) {
    return true;
  }
  return Object.values(record).some(containsActiveState);
}

/**
 * Determines the dynamic refetch interval for TanStack queries.
 * Returns 10,000ms (10 seconds) when the cached response contains active in-flight states,
 * or `false` to disable automatic polling when all items have settled.
 *
 * @param data Cached query response data.
 * @returns Polling interval in milliseconds (10,000) or `false`.
 */
export function pollingInterval(data: unknown): number | false {
  return containsActiveState(data) ? pollingIntervalMs : false;
}
