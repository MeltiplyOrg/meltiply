const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status));
}

function isRetryable(error) {
  if (typeof error?.retryable === "boolean") return error.retryable;
  return isRetryableStatus(error?.status);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
