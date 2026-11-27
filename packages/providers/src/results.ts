import { ambiguousFailure, isUncertainFailure, ProviderAdapterError } from "./failures";
import type {
  ProviderAnalyticsRecord,
  ProviderFailure,
  ProviderOperationResult,
  ProviderPage,
} from "./types";

export type ConfirmedSuccess = Extract<ProviderOperationResult, { outcome: "confirmed_success" }>;
type ConfirmedFailure = Extract<ProviderOperationResult, { outcome: "confirmed_failure" }>;
type UnknownOutcome = Extract<ProviderOperationResult, { outcome: "unknown" }>;

export function confirmedFailure(
  failure: ProviderFailure,
  providerOperationId?: string,
): ConfirmedFailure {
  return {
    failure,
    outcome: "confirmed_failure",
    ...(providerOperationId ? { providerOperationId } : {}),
  };
}

/** A write that may already have been accepted remotely; reconcile, never retry. */
export function unknownResult(code: string, providerOperationId?: string): UnknownOutcome {
  return {
    failure: ambiguousFailure(code),
    outcome: "unknown",
    ...(providerOperationId ? { providerOperationId } : {}),
  };
}

export function failedWriteResult(
  cause: unknown,
  uncertainOperationId?: string,
  confirmedOperationId = uncertainOperationId,
): UnknownOutcome | ConfirmedFailure {
  if (!(cause instanceof ProviderAdapterError)) throw cause;
  return isUncertainFailure(cause.failure)
    ? unknownResult(cause.failure.code, uncertainOperationId)
    : confirmedFailure(cause.failure, confirmedOperationId);
}

export function engagementSnapshot(
  counts: Pick<
    ProviderAnalyticsRecord,
    "comments" | "likes" | "providerPostId" | "shares" | "views"
  > &
    Partial<Pick<ProviderAnalyticsRecord, "reach">>,
  recordedAt: Date,
): ProviderPage<ProviderAnalyticsRecord> {
  return {
    items: [
      {
        impressions: 0,
        reach: 0,
        watchTimeSeconds: 0,
        ...counts,
        recordedAt: recordedAt.toISOString(),
      },
    ],
  };
}
