import { ProviderAdapterError } from "../src/failures";
import type { ProviderFailureClass } from "../src/types";

const messages: Record<ProviderFailureClass, string> = {
  ambiguous: "The provider outcome could not be confirmed.",
  auth: "The provider authorization must be refreshed.",
  deterministic: "The provider rejected this request.",
  quota: "The provider quota has been reached.",
  rate_limit: "The provider rate limit has been reached.",
  timeout: "The provider request timed out before an outcome was confirmed.",
  transient: "The provider is temporarily unavailable.",
};

const retried: ReadonlySet<ProviderFailureClass> = new Set(["rate_limit", "timeout", "transient"]);

export const providerFailure = (
  classification: ProviderFailureClass,
  code = `provider_${classification}`,
) => ({
  classification,
  code,
  message: messages[classification],
  retryable: retried.has(classification),
});

export const refused = (code: string) => providerFailure("deterministic", code);

export const unavailable = providerFailure("transient", "provider_http_503");

export const malformedAnswer = providerFailure("transient");

export const unconfirmed = providerFailure("ambiguous");

function failureIn(cause: unknown): unknown {
  return cause instanceof ProviderAdapterError ? cause.failure : cause;
}

export async function failureOf(attempt: Promise<unknown>): Promise<unknown> {
  try {
    await attempt;
  } catch (cause) {
    return failureIn(cause);
  }
  return "no failure";
}

export function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (cause) {
    return cause;
  }
  return "nothing thrown";
}

export function failureThrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (cause) {
    return failureIn(cause);
  }
  return "no failure";
}
