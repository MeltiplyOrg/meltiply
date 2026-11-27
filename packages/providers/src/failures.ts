import type { Platform } from "@meltiply/domain";

import type { ProviderFailure, ProviderFailureClass, ProviderPageInput } from "./types";
import { boundedCursor, providerIdentifier } from "./values";

const failureCodePattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const MAX_RETRY_AFTER_SECONDS = 86_400;
const maxPageLimit = 100;

export interface ProviderFailureInput {
  code?: string;
  malformedResponse?: boolean;
  quotaExceeded?: boolean;
  rateLimited?: boolean;
  retryAfterSeconds?: number;
  sideEffectPossible?: boolean;
  status?: number;
  timedOut?: boolean;
}

const messages: Readonly<Record<ProviderFailureClass, string>> = {
  ambiguous: "The provider outcome could not be confirmed.",
  auth: "The provider authorization must be refreshed.",
  deterministic: "The provider rejected this request.",
  quota: "The provider quota has been reached.",
  rate_limit: "The provider rate limit has been reached.",
  timeout: "The provider request timed out before an outcome was confirmed.",
  transient: "The provider is temporarily unavailable.",
};

const retryableClasses: ReadonlySet<ProviderFailureClass> = new Set([
  "rate_limit",
  "timeout",
  "transient",
]);

const uncertainClasses: ReadonlySet<ProviderFailureClass> = new Set([
  "ambiguous",
  "timeout",
  "transient",
]);

function classification(input: ProviderFailureInput): ProviderFailureClass {
  if (
    input.sideEffectPossible &&
    (input.timedOut || input.malformedResponse || input.status === undefined)
  ) {
    return "ambiguous";
  }
  if (input.timedOut || input.status === 408) return "timeout";
  if (input.quotaExceeded) return "quota";
  if (input.rateLimited) return "rate_limit";
  if (input.status === 401 || input.status === 403) return "auth";
  if (input.status === 402 || input.status === 507) return "quota";
  if (input.status === 429) return "rate_limit";
  if (input.malformedResponse || input.status === undefined || input.status >= 500) {
    return "transient";
  }
  return "deterministic";
}

function canonicalFailure<C extends ProviderFailureClass>(
  failureClass: C,
  code: string | undefined,
  retryAfterSeconds?: number,
): ProviderFailure & { classification: C } {
  const normalizedCode = code?.trim().toLowerCase();
  const retryable = retryableClasses.has(failureClass);
  const delay =
    retryable &&
    retryAfterSeconds !== undefined &&
    Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds >= 0 &&
    retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
      ? retryAfterSeconds
      : undefined;
  return {
    classification: failureClass,
    code:
      normalizedCode && failureCodePattern.test(normalizedCode)
        ? normalizedCode
        : `provider_${failureClass}`,
    message: messages[failureClass],
    retryable,
    ...(delay === undefined ? {} : { retryAfterSeconds: delay }),
  };
}

export function isUncertainFailure(failure: ProviderFailure): boolean {
  return uncertainClasses.has(failure.classification);
}

export function normalizeProviderFailure(failure: ProviderFailure): ProviderFailure {
  return canonicalFailure(failure.classification, failure.code, failure.retryAfterSeconds);
}

/**
 * Maps transport facts to the failure taxonomy. A write whose outcome cannot be
 * observed (timeout, malformed response, no status) is `ambiguous`, never retried.
 */
export function classifyProviderFailure(input: ProviderFailureInput): ProviderFailure {
  return canonicalFailure(classification(input), input.code, input.retryAfterSeconds);
}

export function ambiguousFailure(code: string): ProviderFailure & { classification: "ambiguous" } {
  return canonicalFailure("ambiguous", code);
}

export function rejection(code: string, status = 400): ProviderFailure {
  return classifyProviderFailure({ code, status });
}

/** Credential-free facts identifying a failed outbound provider request. */
export interface ProviderRequestDiagnostic {
  method: string;
  origin: string;
  status_code?: number;
}

export interface ProviderAdapterErrorOptions extends ErrorOptions {
  request?: ProviderRequestDiagnostic;
  /** Public OAuth scope names the provider did not grant. */
  missingScopes?: readonly string[];
}

export class ProviderAdapterError extends Error {
  readonly failure: ProviderFailure;
  readonly request?: ProviderRequestDiagnostic;
  readonly missingScopes?: readonly string[];

  constructor(failure: ProviderFailure, options?: ProviderAdapterErrorOptions) {
    const normalized = normalizeProviderFailure(failure);
    super(normalized.message, options);
    this.name = "ProviderAdapterError";
    this.failure = normalized;
    this.request = options?.request;
    this.missingScopes = options?.missingScopes;
  }
}

export function rejected(code: string, status = 400): ProviderAdapterError {
  return new ProviderAdapterError(rejection(code, status));
}

export function malformed(sideEffectPossible = false, code?: string): ProviderAdapterError {
  return new ProviderAdapterError(
    classifyProviderFailure({ code, malformedResponse: true, sideEffectPossible }),
  );
}

export function requiredIdentifier(value: unknown, code: string): string {
  const identifier = providerIdentifier(value);
  if (!identifier) throw rejected(code);
  return identifier;
}

export function optionalLookupPostId(value: unknown): string | undefined {
  const identifier = providerIdentifier(value);
  if (value && !identifier) throw malformed();
  return identifier;
}

export function validatePageInput(platform: Platform, input: ProviderPageInput): void {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > maxPageLimit ||
    (input.cursor !== undefined && !boundedCursor(input.cursor))
  ) {
    throw rejected(`${platform}_page_invalid`);
  }
}

/** Analytics endpoints return one snapshot per Post, so a cursor can never be valid. */
export function validateSnapshotPage(platform: Platform, input: ProviderPageInput): void {
  validatePageInput(platform, input);
  if (input.cursor) throw rejected(`${platform}_analytics_not_paginated`);
}

export function isHttp404(cause: unknown): boolean {
  return cause instanceof ProviderAdapterError && cause.failure.code === "provider_http_404";
}

/** Log-safe projection: canonical failure fields and credential-free request facts only. */
export function failureDiagnostic(error: ProviderAdapterError): {
  classification: ProviderFailureClass;
  code: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  request?: ProviderRequestDiagnostic;
  missing_scopes?: readonly string[];
} {
  const { classification, code, retryable, retryAfterSeconds } = error.failure;
  return {
    classification,
    code,
    retryable,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(error.request ? { request: error.request } : {}),
    ...(error.missingScopes ? { missing_scopes: error.missingScopes } : {}),
  };
}
