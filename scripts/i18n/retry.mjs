/** Statuses worth another attempt: rate limits, request timeouts, and server faults. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Reports whether an HTTP status represents a transient provider failure.
 *
 * @param {number | string | undefined} status HTTP status code.
 * @returns {boolean} True for rate limits, timeouts, and server faults.
 */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status));
}

/**
 * Decides whether a provider failure is safe to retry. An explicit `retryable`
 * flag wins; otherwise only transient HTTP statuses retry.
 *
 * @param {unknown} error Provider failure.
 * @returns {boolean} True when another attempt may succeed.
 */
function isRetryable(error) {
  if (typeof error?.retryable === "boolean") return error.retryable;
  return isRetryableStatus(error?.status);
}

/**
 * Default retry delay. Injectable so tests never wait on wall-clock backoff.
 *
 * @param {number} milliseconds Delay before the next attempt.
 * @returns {Promise<void>} Resolves after the delay.
 */
function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Wraps a provider with bounded exponential backoff for transient failures.
 * Authentication, permission, and malformed-request failures have no retryable
 * flag and surface immediately, so an expired token never hides behind delays.
 *
 * @param {{name?: string, complete: (prompt: string, options?: {maxTokens?: number}) => Promise<string>}} provider Translation provider.
 * @param {{retries?: number, baseDelayMs?: number, sleep?: (milliseconds: number) => Promise<void>}} [options]
 *   `retries` counts attempts after the first; `sleep` is injectable for tests.
 * @returns {{name?: string, complete: (prompt: string, options?: {maxTokens?: number}) => Promise<string>}}
 */
export function withRetry(provider, { retries = 3, baseDelayMs = 500, sleep = defaultSleep } = {}) {
  return {
    name: provider.name,
    async complete(prompt, options) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await provider.complete(prompt, options);
        } catch (error) {
          if (!isRetryable(error) || attempt >= retries) throw error;
          await sleep(baseDelayMs * 2 ** attempt);
        }
      }
    },
  };
}
