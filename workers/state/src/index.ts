import { DurableObject } from "cloudflare:workers";
import { Cause, Effect, Exit } from "effect";
import type {
  CancelSelectionResult,
  ClaimSelectionResult,
  OAuthSelectionAccount,
  OAuthSelectionCandidate,
  OAuthSelectionInit,
  OAuthSelectionPublic,
  OAuthStateCoordinatorStub,
  OAuthStateRecord,
} from "@meltiply/contracts";

import {
  decideSelectionCancel,
  decideSelectionClaim,
  decideSelectionCompletion,
  decideSelectionRelease,
  InvalidOAuthStateError,
  OAuthStateStorageError,
  planAlarmSweep,
  planCandidateAppend,
  projectPublicSelection,
  STORAGE_DELETE_BATCH,
  validateOAuthSelectionCreateEffect,
  validateOAuthStateCreateEffect,
  type OAuthSelectionRecord,
} from "./oauth-state-rules";

export {
  InvalidOAuthStateError,
  OAuthStateStorageError,
  validateOAuthSelectionCreateEffect,
  validateOAuthStateCreateEffect,
  type OAuthSelectionRecord,
};

interface StateWorkerEnv {
  OAUTH_STATE: DurableObjectNamespace<OAuthStateCoordinator>;
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
      const { entries, updated } = yield* planCandidateAppend(selectionId, record, candidates);
      yield* putStorageEntriesEffect(
        storage,
        entries,
        "Failed to persist candidate OAuth connections.",
      );
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
      const now = Date.now();
      if (projectPublicSelection(record, actor, [], now) === null) return null;
      const metadataEntries = yield* storageEffect(
        "Failed to list candidate accounts for selection.",
        () =>
          storage.list<OAuthSelectionAccount>({
            prefix: `selection-account:${selectionId}:`,
          }),
      );
      return projectPublicSelection(record, actor, metadataEntries.values(), now);
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
      const decision = decideSelectionClaim(record, accountId, actor, idempotencyKey, now);
      if (decision.kind === "result") {
        return decision.result;
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
        ...decision.record,
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
        organizationId: decision.record.organization_id,
        platform: decision.record.platform,
        status: "claimed",
        userId: decision.record.user_id,
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
      const updated = decideSelectionCompletion(
        record,
        accountId,
        claimToken,
        idempotencyKey,
        Date.now(),
      );
      if (!updated) return false;
      yield* deleteSelectionCandidatesEffect(storage, selectionId);
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
      const updated = decideSelectionRelease(record, claimToken);
      if (!updated) return false;
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
      const decision = decideSelectionCancel(record, actor, idempotencyKey, Date.now());
      if (decision.kind === "return") {
        return decision.result;
      }
      yield* deleteSelectionCandidatesEffect(storage, selectionId);
      yield* storageEffect("Failed to cancel OAuth selection.", () =>
        storage.put(key, decision.updated),
      );
      return { status: "cancelled" } as const;
    });
    return storage.transaction(() => runStateProgram(program));
  }

  async alarm(): Promise<void> {
    const storage = this.ctx.storage;
    const program = Effect.gen(function* () {
      const oauthEntries = yield* storageEffect("Failed to list OAuth state entries.", () =>
        storage.list<OAuthStateRecord>({ prefix: "oauth:" }),
      );
      const selectionEntries = yield* storageEffect("Failed to list OAuth selection entries.", () =>
        storage.list<OAuthSelectionRecord>({ prefix: "selection:" }),
      );
      const plan = planAlarmSweep(oauthEntries, selectionEntries, Date.now());
      for (const selectionId of plan.cleanupSelectionIds) {
        yield* deleteSelectionCandidatesEffect(storage, selectionId);
      }
      yield* deleteStorageKeysEffect(
        storage,
        plan.expiredKeys,
        "Failed to delete expired OAuth entries.",
      );
      yield* putStorageEntriesEffect(
        storage,
        plan.strippedMasters,
        "Failed to strip expired OAuth selections.",
      );
      if (plan.nextAlarm !== undefined) {
        const alarmAt = plan.nextAlarm;
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
