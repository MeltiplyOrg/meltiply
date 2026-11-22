/**
 * Canonical retry backoff policy for the Automation Worker.
 *
 * Every retryable automation path (queue redelivery, outbox relay, publish/sync
 * provider backoff, reply reconciliation, and usage reconciliation) computes
 * its next delay from this single shape so timing semantics remain inspectable
 * and consistent.
 */

export interface RetryPolicy {
  /** Whether attempt counting starts at 0 (`base * 2^attempt`) or 1 (`base * 2^(attempt-1)`). */
  readonly attemptBase: 0 | 1;
  /** Base interval in seconds before exponential scaling. */
  readonly baseSeconds: number;
  /**
   * When true, clamp the exponential interval to `maxSeconds` before applying
   * jitter so a capped interval still jitters within `[0.75 * maxSeconds, maxSeconds]`.
   */
  readonly clampBeforeJitter?: boolean;
  /** Jitter strategy: `"none"` keeps deterministic intervals; `"quarter"` scales by `[0.75, 1.0]`. */
  readonly jitter: "none" | "quarter";
  /** Inclusive upper bound on `attempt` for scheduling a next retry (`undefined` means uncapped by this policy). */
  readonly maxAttempts?: number;
  /** Optional cap on the exponential exponent before multiplying by `baseSeconds`. */
  readonly maxExponent?: number;
  /** Maximum returned delay in seconds. */
  readonly maxSeconds: number;
}

/** Shared Cloudflare Queue and outbox relay backoff (`15 * 2^attempt`, cap 1h). */
export const QUEUE_RETRY_POLICY: RetryPolicy = {
  attemptBase: 0,
  baseSeconds: 15,
  jitter: "none",
  maxSeconds: 3_600,
};

/** Reply reconciliation backoff (`60 * 2^(attempt-1)`, cap 1h). */
export const REPLY_RECONCILIATION_RETRY_POLICY: RetryPolicy = {
  attemptBase: 1,
  baseSeconds: 60,
  jitter: "none",
  maxSeconds: 3_600,
};

/** Usage reconciliation backoff (`5m * 2^min(attempt-1, 6)`, cap 6h). */
export const USAGE_RECONCILIATION_RETRY_POLICY: RetryPolicy = {
  attemptBase: 1,
  baseSeconds: 5 * 60,
  jitter: "none",
  maxExponent: 6,
  maxSeconds: 6 * 60 * 60,
};

/**
 * Computes the next retry delay in seconds for one attempt under `policy`,
 * or `null` when `policy.maxAttempts` has been reached.
 *
 * When `policy.jitter` is `"quarter"`, applies `[0.75, 1.0]` scaling from
 * `options.random` (falling back to midpoint `0.875` if non-finite) and honors
 * `options.retryAfterSeconds` as a floor bounded by `policy.maxSeconds`.
 *
 * @param policy - Retry schedule parameters.
 * @param attempt - Attempt counter indexed according to `policy.attemptBase`.
 * @param options - Optional provider retry-after floor and deterministic PRNG.
 * @returns Delay in seconds, or `null` when the attempt ceiling is exhausted.
 */
export function nextDelaySeconds(
  policy: RetryPolicy,
  attempt: number,
  options?: {
    readonly random?: () => number;
    readonly retryAfterSeconds?: number;
  },
): number | null {
  if (policy.maxAttempts !== undefined && attempt >= policy.maxAttempts) {
    return null;
  }
  const rawExponent = Math.max(0, attempt - policy.attemptBase);
  const exponent =
    policy.maxExponent !== undefined ? Math.min(rawExponent, policy.maxExponent) : rawExponent;
  const rawDelay = policy.baseSeconds * 2 ** exponent;
  if (policy.jitter === "none") {
    return Math.min(policy.maxSeconds, Math.max(rawDelay, options?.retryAfterSeconds ?? 0));
  }
  const sample = (options?.random ?? Math.random)();
  const jitterFactor = Number.isFinite(sample)
    ? 0.75 + Math.min(1, Math.max(0, sample)) * 0.25
    : 0.875;
  const baseForJitter = policy.clampBeforeJitter ? Math.min(policy.maxSeconds, rawDelay) : rawDelay;
  const scaled = Math.ceil(baseForJitter * jitterFactor);
  return Math.min(policy.maxSeconds, Math.max(1, scaled, options?.retryAfterSeconds ?? 0));
}
