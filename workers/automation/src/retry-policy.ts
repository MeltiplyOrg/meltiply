export interface RetryPolicy {
  readonly attemptBase: 0 | 1;
  readonly baseSeconds: number;
  readonly clampBeforeJitter?: boolean;
  readonly jitter: "none" | "quarter";
  readonly maxAttempts?: number;
  readonly maxExponent?: number;
  readonly maxSeconds: number;
}

export const QUEUE_RETRY_POLICY: RetryPolicy = {
  attemptBase: 0,
  baseSeconds: 15,
  jitter: "none",
  maxSeconds: 3_600,
};

export const REPLY_RECONCILIATION_RETRY_POLICY: RetryPolicy = {
  attemptBase: 1,
  baseSeconds: 60,
  jitter: "none",
  maxSeconds: 3_600,
};

export const USAGE_RECONCILIATION_RETRY_POLICY: RetryPolicy = {
  attemptBase: 1,
  baseSeconds: 5 * 60,
  jitter: "none",
  maxExponent: 6,
  maxSeconds: 6 * 60 * 60,
};

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
