import { ApiError } from "./api";
import { isInFlightPublicationStatus } from "./publication-status";

const maxQueryRetries = 2;
const maxRetryDelayMs = 30_000;
const pollingIntervalMs = 10_000;

export const referenceFreshnessMs = 5 * 60_000;
export const privateCacheRetentionMs = 30 * 60_000;

const activeAssetStatuses = new Set(["pending_upload", "uploading", "processing", "deleting"]);

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= maxQueryRetries) return false;
  if (!(error instanceof ApiError)) return true;
  if (error.status === 401 || error.status === 403) return false;
  return error.retryable;
}

export function queryRetryDelay(attempt: number, error: unknown): number {
  if (error instanceof ApiError && error.retryAfterSeconds !== null) {
    return Math.min(error.retryAfterSeconds * 1000, maxRetryDelayMs);
  }
  return Math.min(1000 * 2 ** attempt, maxRetryDelayMs);
}

function containsActiveState(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsActiveState);
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (typeof record.status === "string") {
    if (activeAssetStatuses.has(record.status) || isInFlightPublicationStatus(record.status)) {
      return true;
    }
  }
  return Object.values(record).some(containsActiveState);
}

export function pollingInterval(data: unknown): number | false {
  return containsActiveState(data) ? pollingIntervalMs : false;
}
