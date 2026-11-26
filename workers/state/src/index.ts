import { DurableObject } from "cloudflare:workers";
import { Cause, Data, Effect, Exit } from "effect";
import type {
  CancelSelectionResult,
  ClaimSelectionResult,
  OAuthSelectionAccount,
  OAuthSelectionCandidate,
  OAuthSelectionInit,
  OAuthSelectionPublic,
  OAuthSelectionRecord,
  OAuthStateCoordinatorStub,
  OAuthStateRecord,
} from "@meltiply/contracts";

interface StateWorkerEnv {
  OAUTH_STATE: DurableObjectNamespace<OAuthStateCoordinator>;
}

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
): Effect.Effect<void, InvalidOAuthStateError> {
  if (!state || record.expires_at <= Date.now()) {
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
): Effect.Effect<void, InvalidOAuthStateError> {
  if (
    !selectionId ||
    selectionId.length < 16 ||
    selectionId.length > 256 ||
    init.expires_at <= Date.now()
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

function storageEffect<A>(
  message: string,
  thunk: () => Promise<A>,
): Effect.Effect<A, OAuthStateStorageError> {
  return Effect.tryPromise({
    catch: (cause) =>
      new OAuthStateStorageError({
        cause: cause instanceof Error ? cause.name : undefined,
        message,
      }),
    try: thunk,
  });
}

const SELECTION_EVIDENCE_RETENTION_MS = 10 * 60 * 1_000;

function selectionEvidenceExpiry(record: OAuthSelectionRecord): number {
  return record.evidence_expires_at ?? record.expires_at + SELECTION_EVIDENCE_RETENTION_MS;
}

const STORAGE_DELETE_BATCH = 128;

function deleteStorageKeysEffect(
  storage: DurableObjectStorage,
  keys: ReadonlyArray<string>,
  message: string,
): Effect.Effect<void, OAuthStateStorageError> {
  return Effect.gen(function* () {
    for (let i = 0; i < keys.length; i += STORAGE_DELETE_BATCH) {
      const batch = keys.slice(i, i + STORAGE_DELETE_BATCH);
      yield* storageEffect(message, () => storage.delete(batch));
    }
  });
}

function putStorageEntriesEffect(
  storage: DurableObjectStorage,
  entries: Record<string, unknown>,
  message: string,
): Effect.Effect<void, OAuthStateStorageError> {
  return Effect.gen(function* () {
    const pairs = Object.entries(entries);
    for (let i = 0; i < pairs.length; i += STORAGE_DELETE_BATCH) {
      const batch = pairs.slice(i, i + STORAGE_DELETE_BATCH);
      yield* storageEffect(message, () => storage.put(Object.fromEntries(batch)));
    }
  });
}

function armExpiryAlarmEffect(
  storage: DurableObjectStorage,
  expiresAt: number,
): Effect.Effect<void, OAuthStateStorageError> {
  return Effect.gen(function* () {
    const currentAlarm = yield* storageEffect("Failed to read the OAuth state alarm.", () =>
      storage.getAlarm(),
    );
    if (currentAlarm === null || expiresAt < currentAlarm) {
      yield* storageEffect("Failed to arm the OAuth state alarm.", () =>
        storage.setAlarm(expiresAt),
      );
    }
  });
}

function deleteSelectionCandidatesEffect(
  storage: DurableObjectStorage,
  selectionId: string,
): Effect.Effect<void, OAuthStateStorageError> {
  return Effect.gen(function* () {
    const prefix = `selection-account:${selectionId}:`;
    let startAfter: string | undefined;
    for (;;) {
      const page = yield* storageEffect("Failed to list candidate entries for cleanup.", () =>
        storage.list<unknown>({
          limit: STORAGE_DELETE_BATCH,
          prefix,
          ...(startAfter !== undefined ? { startAfter } : {}),
        }),
      );
      if (page.size === 0) break;
      const keys: string[] = [];
      let lastKey: string | undefined;
      for (const metadataKey of page.keys()) {
        lastKey = metadataKey;
        keys.push(metadataKey);
        keys.push(`selection-credential:${metadataKey.slice("selection-account:".length)}`);
      }
      yield* deleteStorageKeysEffect(storage, keys, "Failed to delete candidate entries.");
      if (page.size < STORAGE_DELETE_BATCH || lastKey === undefined) break;
      startAfter = lastKey;
    }
  });
}
async function runStateProgram<A>(
  program: Effect.Effect<A, InvalidOAuthStateError | OAuthStateStorageError>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const error = Cause.squash(exit.cause);
  if (error instanceof InvalidOAuthStateError) {
    throw new TypeError(error.message);
  }
  throw error;
}

export class OAuthStateCoordinator
  extends DurableObject<StateWorkerEnv>
  implements OAuthStateCoordinatorStub
{
  async create(state: string, record: OAuthStateRecord): Promise<void> {
    const storage = this.ctx.storage;
    const program = Effect.gen(function* () {
      yield* validateOAuthStateCreateEffect(state, record);
      yield* storageEffect("Failed to persist OAuth state.", () =>
        storage.put(`oauth:${state}`, record),
      );
      yield* armExpiryAlarmEffect(storage, record.expires_at);
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    const storage = this.ctx.storage;
    const key = `oauth:${state}`;
    const program = Effect.gen(function* () {
      const record = yield* storageEffect("Failed to read OAuth state.", () =>
        storage.get<OAuthStateRecord>(key),
      );
      if (!record) return null;
      yield* storageEffect("Failed to delete OAuth state.", () => storage.delete(key));
      return record.expires_at > Date.now() ? record : null;
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async createSelection(selectionId: string, init: OAuthSelectionInit): Promise<void> {
    const storage = this.ctx.storage;
    const program = Effect.gen(function* () {
      yield* validateOAuthSelectionCreateEffect(selectionId, init);
      const record: OAuthSelectionRecord = {
        account_ids: [],
        expires_at: init.expires_at,
        id: selectionId,
        organization_id: init.organization_id,
        platform: init.platform,
        ready: false,
        status: "pending",
        user_id: init.user_id,
      };
      yield* storageEffect("Failed to persist OAuth selection.", () =>
        storage.put(`selection:${selectionId}`, record),
      );
      yield* armExpiryAlarmEffect(storage, record.expires_at);
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async appendSelectionCandidates(
    selectionId: string,
    candidates: ReadonlyArray<OAuthSelectionCandidate>,
  ): Promise<void> {
    const storage = this.ctx.storage;
    const program = Effect.gen(function* () {
      const key = `selection:${selectionId}`;
      const record = yield* storageEffect(
        "Failed to read OAuth selection for appending candidates.",
        () => storage.get<OAuthSelectionRecord>(key),
      );
      if (!record || record.ready || record.status !== "pending") {
        return yield* Effect.fail(
          new InvalidOAuthStateError({
            message: "Cannot append candidates to an uninitialized or finalized selection.",
          }),
        );
      }
      const newAccountIds: string[] = [];
      const seenAccountIds = new Set(record.account_ids);
      const entriesToPut: Record<string, unknown> = {};
      for (const candidate of candidates) {
        if (!candidate.account.id || candidate.account.id.length > 255) {
          return yield* Effect.fail(
            new InvalidOAuthStateError({
              message: "Account ID must be a non-empty string under 255 characters",
            }),
          );
        }
        if (seenAccountIds.has(candidate.account.id)) {
          return yield* Effect.fail(
            new InvalidOAuthStateError({
              message: "Account IDs must be unique within a selection.",
            }),
          );
        }
        seenAccountIds.add(candidate.account.id);
        newAccountIds.push(candidate.account.id);
        entriesToPut[`selection-account:${selectionId}:${candidate.account.id}`] =
          candidate.account;
        entriesToPut[`selection-credential:${selectionId}:${candidate.account.id}`] = {
          encrypted_connection: candidate.encryptedConnection,
        };
      }
      if (record.account_ids.length + newAccountIds.length > 1000) {
        return yield* Effect.fail(
          new InvalidOAuthStateError({
            message: "Accounts list must not exceed 1000 items",
          }),
        );
      }
      yield* putStorageEntriesEffect(
        storage,
        entriesToPut,
        "Failed to persist candidate OAuth connections.",
      );
      const updated: OAuthSelectionRecord = {
        ...record,
        account_ids: [...record.account_ids, ...newAccountIds],
      };
      yield* storageEffect("Failed to update OAuth selection account IDs.", () =>
        storage.put(key, updated),
      );
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async finalizeSelection(selectionId: string): Promise<void> {
    const storage = this.ctx.storage;
    const program = Effect.gen(function* () {
      const key = `selection:${selectionId}`;
      const record = yield* storageEffect("Failed to read OAuth selection for finalization.", () =>
        storage.get<OAuthSelectionRecord>(key),
      );
      if (!record || record.status !== "pending") {
        return yield* Effect.fail(
          new InvalidOAuthStateError({
            message: "Selection does not exist or is not pending.",
          }),
        );
      }
      const updated: OAuthSelectionRecord = {
        ...record,
        ready: true,
      };
      yield* storageEffect("Failed to finalize OAuth selection.", () => storage.put(key, updated));
      yield* armExpiryAlarmEffect(storage, record.expires_at);
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async getSelection(
    selectionId: string,
    actor: { organizationId: string; userId: string },
  ): Promise<OAuthSelectionPublic | null> {
    const storage = this.ctx.storage;
    const key = `selection:${selectionId}`;
    const program = Effect.gen(function* () {
      const record = yield* storageEffect("Failed to read OAuth selection.", () =>
        storage.get<OAuthSelectionRecord>(key),
      );
      if (!record || !record.ready) return null;
      if (record.expires_at <= Date.now()) return null;
      if (record.status !== "pending") return null;
      if (record.organization_id !== actor.organizationId || record.user_id !== actor.userId) {
        return null;
      }
      const metadataEntries = yield* storageEffect(
        "Failed to list candidate accounts for selection.",
        () =>
          storage.list<OAuthSelectionAccount>({
            prefix: `selection-account:${selectionId}:`,
          }),
      );
      const byId = new Map<string, OAuthSelectionAccount>();
      for (const entry of metadataEntries.values()) {
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
    });
    return runStateProgram(program);
  }

  async claimSelection(
    selectionId: string,
    accountId: string,
    actor: { brandProfileId: string; organizationId: string; userId: string },
    idempotencyKey: string,
    leaseMs: number = 30_000,
  ): Promise<ClaimSelectionResult> {
    const storage = this.ctx.storage;
    const key = `selection:${selectionId}`;
    const program = Effect.gen(function* () {
      const record = yield* storageEffect("Failed to read OAuth selection for claim.", () =>
        storage.get<OAuthSelectionRecord>(key),
      );
      const now = Date.now();
      if (!record || !record.ready) {
        return { status: "not_found" } as const;
      }
      if (record.organization_id !== actor.organizationId || record.user_id !== actor.userId) {
        return { status: "not_found" } as const;
      }
      const evidenceExpiry = selectionEvidenceExpiry(record);
      if (now >= evidenceExpiry) {
        return { status: "not_found" } as const;
      }
      if (record.status === "cancelled") {
        return { status: "not_found" } as const;
      }
      if (record.status === "completed") {
        if (
          record.completed_account_id === accountId &&
          record.completed_brand_profile_id === actor.brandProfileId &&
          record.completed_idempotency_key === idempotencyKey
        ) {
          return { status: "replayed" } as const;
        }
        return {
          code: "already_completed",
          message: "This OAuth account selection has already been completed.",
          status: "conflict",
        } as const;
      }
      if (record.expires_at <= now) {
        return { status: "not_found" } as const;
      }
      if (record.pinned_account_id && record.pinned_account_id !== accountId) {
        return {
          code: "pinned_account_mismatch",
          message:
            "This selection was already confirmed for a different account. Restart authorization to choose another account.",
          status: "conflict",
        } as const;
      }
      if (record.claim && record.claim.brand_profile_id !== actor.brandProfileId) {
        return {
          code: "pinned_profile_mismatch",
          message:
            "This confirmation may still be saving to another Brand Profile. Retry the original assignment.",
          status: "conflict",
        } as const;
      }
      if (record.claim && record.claim.expires_at > now) {
        return {
          code: "claim_active",
          message: "Selection confirmation is currently in progress.",
          status: "conflict",
        } as const;
      }
      if (!record.account_ids.includes(accountId)) {
        return {
          message: "The selected account was not found in this authorization.",
          status: "invalid_account",
        } as const;
      }
      const candidateEntry = yield* storageEffect(
        "Failed to read candidate OAuth connection.",
        () =>
          storage.get<{ encrypted_connection: string }>(
            `selection-credential:${selectionId}:${accountId}`,
          ),
      );
      if (!candidateEntry?.encrypted_connection) {
        return {
          message: "The selected account was not found in this authorization.",
          status: "invalid_account",
        } as const;
      }
      const claimToken = crypto.randomUUID();
      const updated: OAuthSelectionRecord = {
        ...record,
        claim: {
          brand_profile_id: actor.brandProfileId,
          claimed_at: now,
          expires_at: now + leaseMs,
          idempotency_key: idempotencyKey,
          token: claimToken,
        },
        pinned_account_id: accountId,
      };
      yield* storageEffect("Failed to update OAuth selection claim.", () =>
        storage.put(key, updated),
      );
      return {
        claimToken,
        encryptedConnection: candidateEntry.encrypted_connection,
        organizationId: record.organization_id,
        platform: record.platform,
        status: "claimed",
        userId: record.user_id,
      } as const;
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async completeSelection(
    selectionId: string,
    accountId: string,
    claimToken: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const storage = this.ctx.storage;
    const key = `selection:${selectionId}`;
    const program = Effect.gen(function* () {
      const record = yield* storageEffect("Failed to read OAuth selection for completion.", () =>
        storage.get<OAuthSelectionRecord>(key),
      );
      if (!record) return false;
      if (record.claim?.token !== claimToken) return false;
      if (
        record.pinned_account_id !== accountId ||
        record.claim.idempotency_key !== idempotencyKey
      ) {
        return false;
      }
      const now = Date.now();
      const evidenceExpiry = selectionEvidenceExpiry(record);
      if (now >= evidenceExpiry) return false;
      yield* deleteSelectionCandidatesEffect(storage, selectionId);
      const updated: OAuthSelectionRecord = {
        ...record,
        account_ids: [],
        claim: undefined,
        completed_account_id: accountId,
        completed_brand_profile_id: record.claim.brand_profile_id,
        completed_idempotency_key: idempotencyKey,
        status: "completed",
      };
      yield* storageEffect("Failed to save completed OAuth selection.", () =>
        storage.put(key, updated),
      );
      return true;
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async releaseSelectionClaim(selectionId: string, claimToken: string): Promise<boolean> {
    const storage = this.ctx.storage;
    const key = `selection:${selectionId}`;
    const program = Effect.gen(function* () {
      const record = yield* storageEffect("Failed to read OAuth selection for release.", () =>
        storage.get<OAuthSelectionRecord>(key),
      );
      if (!record) return false;
      if (record.claim?.token !== claimToken) return false;
      const updated: OAuthSelectionRecord = {
        ...record,
        claim: undefined,
      };
      yield* storageEffect("Failed to release OAuth selection claim.", () =>
        storage.put(key, updated),
      );
      return true;
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async cancelSelection(
    selectionId: string,
    actor: { organizationId: string; userId: string },
    idempotencyKey: string,
  ): Promise<CancelSelectionResult> {
    const storage = this.ctx.storage;
    const key = `selection:${selectionId}`;
    const program = Effect.gen(function* () {
      const record = yield* storageEffect("Failed to read OAuth selection for cancellation.", () =>
        storage.get<OAuthSelectionRecord>(key),
      );
      const now = Date.now();
      if (!record || !record.ready) {
        return { status: "not_found" } as const;
      }
      if (record.organization_id !== actor.organizationId || record.user_id !== actor.userId) {
        return { status: "not_found" } as const;
      }
      if (record.claim) {
        return {
          message: "Cannot cancel selection while confirmation is or was in progress.",
          status: "conflict",
        } as const;
      }
      if (record.status === "completed") {
        return {
          message: "Cannot cancel an already completed selection.",
          status: "conflict",
        } as const;
      }
      if (record.status === "cancelled") {
        return { status: "cancelled" } as const;
      }
      if (record.expires_at <= now) {
        return { status: "not_found" } as const;
      }
      yield* deleteSelectionCandidatesEffect(storage, selectionId);
      const updated: OAuthSelectionRecord = {
        ...record,
        account_ids: [],
        cancelled_idempotency_key: idempotencyKey,
        claim: undefined,
        status: "cancelled",
      };
      yield* storageEffect("Failed to cancel OAuth selection.", () => storage.put(key, updated));
      return { status: "cancelled" } as const;
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async alarm(): Promise<void> {
    const storage = this.ctx.storage;
    const program = Effect.gen(function* () {
      const now = Date.now();
      const oauthEntries = yield* storageEffect("Failed to list OAuth state entries.", () =>
        storage.list<OAuthStateRecord>({ prefix: "oauth:" }),
      );
      const selectionEntries = yield* storageEffect("Failed to list OAuth selection entries.", () =>
        storage.list<OAuthSelectionRecord>({ prefix: "selection:" }),
      );

      const expiredKeys: string[] = [];
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
        yield* deleteSelectionCandidatesEffect(storage, key.slice("selection:".length));
        const retainEvidence = record.status !== "pending" || record.claim !== undefined;
        const evidenceExpiry =
          record.evidence_expires_at ?? record.expires_at + SELECTION_EVIDENCE_RETENTION_MS;
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

      yield* deleteStorageKeysEffect(
        storage,
        expiredKeys,
        "Failed to delete expired OAuth entries.",
      );
      yield* putStorageEntriesEffect(
        storage,
        strippedMasters,
        "Failed to strip expired OAuth selections.",
      );
      if (nextAlarm !== undefined) {
        const alarmAt = nextAlarm;
        yield* storageEffect("Failed to reschedule the OAuth state alarm.", () =>
          storage.setAlarm(alarmAt),
        );
      }
    });
    return storage.transaction(() => runStateProgram(program));
  }
}

export default {
  fetch() {
    return Response.json(
      {
        error: {
          code: "not_found",
          details: [],
          message: "The State Worker has no public HTTP routes.",
          request_id: crypto.randomUUID(),
          retryable: false,
        },
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<StateWorkerEnv>;
