import { Data, Effect } from "effect";
import type {
  CancelSelectionResult,
  ClaimSelectionResult,
  OAuthSelectionAccount,
  OAuthSelectionCandidate,
  OAuthSelectionInit,
  OAuthSelectionPublic,
  OAuthStateRecord,
} from "@meltiply/contracts";

export interface OAuthSelectionRecord {
  readonly account_ids: ReadonlyArray<string>;
  claim?: {
    readonly brand_profile_id: string;
    readonly claimed_at: number;
    readonly expires_at: number;
    readonly idempotency_key: string;
    readonly token: string;
  };
  completed_account_id?: string;
  completed_brand_profile_id?: string;
  completed_idempotency_key?: string;
  cancelled_idempotency_key?: string;
  evidence_expires_at?: number;
  expires_at: number;
  readonly id: string;
  readonly organization_id: string;
  pinned_account_id?: string;
  readonly platform: string;
  ready: boolean;
  status: "pending" | "completed" | "cancelled";
  readonly user_id: string;
}

export const SELECTION_EVIDENCE_RETENTION_MS = 10 * 60 * 1_000;
export const MAX_SELECTION_CANDIDATES = 1_000;
export const STORAGE_DELETE_BATCH = 128;

export class InvalidOAuthStateError extends Data.TaggedError("InvalidOAuthStateError")<{
  readonly message: string;
}> {}

export class OAuthStateStorageError extends Data.TaggedError("OAuthStateStorageError")<{
  readonly cause?: string;
  readonly message: string;
}> {}

export function validateOAuthStateCreateEffect(
  state: string,
  record: OAuthStateRecord,
  now: number = Date.now(),
): Effect.Effect<void, InvalidOAuthStateError> {
  if (!state || record.expires_at <= now) {
    return Effect.fail(
      new InvalidOAuthStateError({
        message: "OAuth state and a future expiry are required",
      }),
    );
  }
  return Effect.void;
}

export function validateOAuthSelectionCreateEffect(
  selectionId: string,
  init: OAuthSelectionInit,
  now: number = Date.now(),
): Effect.Effect<void, InvalidOAuthStateError> {
  if (
    !selectionId ||
    selectionId.length < 16 ||
    selectionId.length > 256 ||
    init.expires_at <= now
  ) {
    return Effect.fail(
      new InvalidOAuthStateError({
        message: "Selection ID and a future expiry are required",
      }),
    );
  }
  if (typeof init.organization_id !== "string" || init.organization_id.trim().length === 0) {
    return Effect.fail(
      new InvalidOAuthStateError({
        message: "An organization ID is required",
      }),
    );
  }
  if (typeof init.user_id !== "string" || init.user_id.trim().length === 0) {
    return Effect.fail(
      new InvalidOAuthStateError({
        message: "A user ID is required",
      }),
    );
  }
  if (typeof init.platform !== "string" || init.platform.trim().length === 0) {
    return Effect.fail(
      new InvalidOAuthStateError({
        message: "A platform is required",
      }),
    );
  }
  return Effect.void;
}

export function selectionEvidenceExpiry(record: OAuthSelectionRecord): number {
  return record.evidence_expires_at ?? record.expires_at + SELECTION_EVIDENCE_RETENTION_MS;
}

export function planCandidateAppend(
  selectionId: string,
  record: OAuthSelectionRecord | undefined,
  candidates: ReadonlyArray<OAuthSelectionCandidate>,
  maxCandidates: number = MAX_SELECTION_CANDIDATES,
): Effect.Effect<
  { entries: Record<string, unknown>; updated: OAuthSelectionRecord },
  InvalidOAuthStateError
> {
  if (!record || record.ready || record.status !== "pending") {
    return Effect.fail(
      new InvalidOAuthStateError({
        message: "Cannot append candidates to an uninitialized or finalized selection.",
      }),
    );
  }
  const newAccountIds: string[] = [];
  const seenAccountIds = new Set(record.account_ids);
  const entries: Record<string, unknown> = {};
  for (const candidate of candidates) {
    if (!candidate.account.id || candidate.account.id.length > 255) {
      return Effect.fail(
        new InvalidOAuthStateError({
          message: "Account ID must be a non-empty string under 255 characters",
        }),
      );
    }
    if (seenAccountIds.has(candidate.account.id)) {
      return Effect.fail(
        new InvalidOAuthStateError({
          message: "Account IDs must be unique within a selection.",
        }),
      );
    }
    seenAccountIds.add(candidate.account.id);
    newAccountIds.push(candidate.account.id);
    entries[`selection-account:${selectionId}:${candidate.account.id}`] = candidate.account;
    entries[`selection-credential:${selectionId}:${candidate.account.id}`] = {
      encrypted_connection: candidate.encryptedConnection,
    };
  }
  if (record.account_ids.length + newAccountIds.length > maxCandidates) {
    return Effect.fail(
      new InvalidOAuthStateError({
        message: "Accounts list must not exceed 1000 items",
      }),
    );
  }
  return Effect.succeed({
    entries,
    updated: {
      ...record,
      account_ids: [...record.account_ids, ...newAccountIds],
    },
  });
}

export function projectPublicSelection(
  record: OAuthSelectionRecord | undefined,
  actor: { organizationId: string; userId: string },
  metadataEntries: Iterable<OAuthSelectionAccount>,
  now: number,
): OAuthSelectionPublic | null {
  if (!record || !record.ready) return null;
  if (record.expires_at <= now) return null;
  if (record.status !== "pending") return null;
  if (record.organization_id !== actor.organizationId || record.user_id !== actor.userId) {
    return null;
  }
  const byId = new Map<string, OAuthSelectionAccount>();
  for (const entry of metadataEntries) {
    byId.set(entry.id, entry);
  }
  const accounts: OAuthSelectionAccount[] = [];
  for (const accountId of record.account_ids) {
    const account = byId.get(accountId);
    if (account) accounts.push(account);
  }
  return {
    accounts,
    expires_at: new Date(record.expires_at).toISOString(),
    id: record.id,
    platform: record.platform as OAuthSelectionPublic["platform"],
  };
}

export type ClaimDecision =
  | {
      readonly kind: "result";
      readonly result: Exclude<ClaimSelectionResult, { status: "claimed" }>;
    }
  | { readonly kind: "claim"; readonly record: OAuthSelectionRecord };

export function decideSelectionClaim(
  record: OAuthSelectionRecord | undefined,
  accountId: string,
  actor: { brandProfileId: string; organizationId: string; userId: string },
  idempotencyKey: string,
  now: number,
): ClaimDecision {
  if (!record || !record.ready) {
    return { kind: "result", result: { status: "not_found" } };
  }
  if (record.organization_id !== actor.organizationId || record.user_id !== actor.userId) {
    return { kind: "result", result: { status: "not_found" } };
  }
  if (now >= selectionEvidenceExpiry(record)) {
    return { kind: "result", result: { status: "not_found" } };
  }
  if (record.status === "cancelled") {
    return { kind: "result", result: { status: "not_found" } };
  }
  if (record.status === "completed") {
    if (
      record.completed_account_id === accountId &&
      record.completed_brand_profile_id === actor.brandProfileId &&
      record.completed_idempotency_key === idempotencyKey
    ) {
      return { kind: "result", result: { status: "replayed" } };
    }
    return {
      kind: "result",
      result: {
        code: "already_completed",
        message: "This OAuth account selection has already been completed.",
        status: "conflict",
      },
    };
  }
  if (record.expires_at <= now) {
    return { kind: "result", result: { status: "not_found" } };
  }
  if (record.pinned_account_id && record.pinned_account_id !== accountId) {
    return {
      kind: "result",
      result: {
        code: "pinned_account_mismatch",
        message:
          "This selection was already confirmed for a different account. Restart authorization to choose another account.",
        status: "conflict",
      },
    };
  }
  if (record.claim && record.claim.brand_profile_id !== actor.brandProfileId) {
    return {
      kind: "result",
      result: {
        code: "pinned_profile_mismatch",
        message:
          "This confirmation may still be saving to another Brand Profile. Retry the original assignment.",
        status: "conflict",
      },
    };
  }
  if (record.claim && record.claim.expires_at > now) {
    return {
      kind: "result",
      result: {
        code: "claim_active",
        message: "Selection confirmation is currently in progress.",
        status: "conflict",
      },
    };
  }
  if (!record.account_ids.includes(accountId)) {
    return {
      kind: "result",
      result: {
        message: "The selected account was not found in this authorization.",
        status: "invalid_account",
      },
    };
  }
  return { kind: "claim", record };
}

export function decideSelectionCompletion(
  record: OAuthSelectionRecord | undefined,
  accountId: string,
  claimToken: string,
  idempotencyKey: string,
  now: number,
): OAuthSelectionRecord | null {
  if (!record) return null;
  if (record.claim?.token !== claimToken) return null;
  if (record.pinned_account_id !== accountId || record.claim.idempotency_key !== idempotencyKey) {
    return null;
  }
  if (now >= selectionEvidenceExpiry(record)) return null;
  return {
    ...record,
    account_ids: [],
    claim: undefined,
    completed_account_id: accountId,
    completed_brand_profile_id: record.claim.brand_profile_id,
    completed_idempotency_key: idempotencyKey,
    status: "completed",
  };
}

export function decideSelectionRelease(
  record: OAuthSelectionRecord | undefined,
  claimToken: string,
): OAuthSelectionRecord | null {
  if (!record || record.claim?.token !== claimToken) return null;
  return {
    ...record,
    claim: undefined,
  };
}

export type CancelDecision =
  | { readonly kind: "return"; readonly result: CancelSelectionResult }
  | { readonly kind: "cancel"; readonly updated: OAuthSelectionRecord };

export function decideSelectionCancel(
  record: OAuthSelectionRecord | undefined,
  actor: { organizationId: string; userId: string },
  idempotencyKey: string,
  now: number,
): CancelDecision {
  if (!record || !record.ready) {
    return { kind: "return", result: { status: "not_found" } };
  }
  if (record.organization_id !== actor.organizationId || record.user_id !== actor.userId) {
    return { kind: "return", result: { status: "not_found" } };
  }
  if (record.claim) {
    return {
      kind: "return",
      result: {
        message: "Cannot cancel selection while confirmation is or was in progress.",
        status: "conflict",
      },
    };
  }
  if (record.status === "completed") {
    return {
      kind: "return",
      result: {
        message: "Cannot cancel an already completed selection.",
        status: "conflict",
      },
    };
  }
  if (record.status === "cancelled") {
    return { kind: "return", result: { status: "cancelled" } };
  }
  if (record.expires_at <= now) {
    return { kind: "return", result: { status: "not_found" } };
  }
  return {
    kind: "cancel",
    updated: {
      ...record,
      account_ids: [],
      cancelled_idempotency_key: idempotencyKey,
      claim: undefined,
      status: "cancelled",
    },
  };
}

export interface AlarmSweepPlan {
  readonly cleanupSelectionIds: string[];
  readonly expiredKeys: string[];
  readonly nextAlarm: number | undefined;
  readonly strippedMasters: Record<string, OAuthSelectionRecord>;
}

export function planAlarmSweep(
  oauthEntries: Iterable<readonly [string, OAuthStateRecord]>,
  selectionEntries: Iterable<readonly [string, OAuthSelectionRecord]>,
  now: number,
): AlarmSweepPlan {
  const expiredKeys: string[] = [];
  const cleanupSelectionIds: string[] = [];
  const strippedMasters: Record<string, OAuthSelectionRecord> = {};
  let nextAlarm: number | undefined;
  const scheduleAt = (at: number) => {
    if (nextAlarm === undefined || at < nextAlarm) nextAlarm = at;
  };

  for (const [key, record] of oauthEntries) {
    if (record.expires_at <= now) {
      expiredKeys.push(key);
    } else {
      scheduleAt(record.expires_at);
    }
  }

  for (const [key, record] of selectionEntries) {
    if (record.expires_at > now) {
      scheduleAt(record.expires_at);
      continue;
    }
    cleanupSelectionIds.push(key.slice("selection:".length));
    const retainEvidence = record.status !== "pending" || record.claim !== undefined;
    const evidenceExpiry = selectionEvidenceExpiry(record);
    if (!retainEvidence || now >= evidenceExpiry) {
      expiredKeys.push(key);
    } else {
      strippedMasters[key] = {
        ...record,
        account_ids: [],
        evidence_expires_at: evidenceExpiry,
      };
      scheduleAt(evidenceExpiry);
    }
  }

  return { cleanupSelectionIds, expiredKeys, nextAlarm, strippedMasters };
}
