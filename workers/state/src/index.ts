import { DurableObject } from "cloudflare:workers";
import { Cause, Data, Effect, Exit } from "effect";

interface StateWorkerEnv {
  OAUTH_STATE: DurableObjectNamespace<OAuthStateCoordinator>;
}

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

/**
 * Tagged error for invalid OAuth state input: empty state, non-future
 * expiry, or missing/blank brand profile.
 */
export class InvalidOAuthStateError extends Data.TaggedError("InvalidOAuthStateError")<{
  readonly message: string;
}> {}

/**
 * Tagged error for Durable Object storage adapter failures: put, get, delete,
 * list, and alarm reads/writes. `cause` preserves the underlying error name
 * for diagnostics; surfaces to RPC callers as a plain rejection, never a 400.
 */
export class OAuthStateStorageError extends Data.TaggedError("OAuthStateStorageError")<{
  readonly cause?: string;
  readonly message: string;
}> {}

/**
 * Validates OAuth state creation input as an Effect program.
 *
 * Pure validation core shared by the Durable Object method and its tests:
 * rejects empty state strings, non-future expiries, and missing or blank
 * `brand_profile_id` values before any storage write, so invalid handoffs
 * fail before arming alarms. The brand profile is required because every
 * connected platform account must belong to one.
 *
 * @param state - Unique opaque state string from authorization initiation.
 * @param record - Context containing brand profile, org/user/provider/redirect/expiry.
 * @returns Effect resolving to void on valid input, else InvalidOAuthStateError.
 */
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
  // typeof guard: RPC-deserialized records may carry non-string values that
  // would throw on .trim(); treat them as missing.
  if (typeof record.brand_profile_id !== "string" || record.brand_profile_id.trim().length === 0) {
    return Effect.fail(
      new InvalidOAuthStateError({
        message: "A brand profile is required",
      }),
    );
  }
  return Effect.void;
}

/**
 * Validates OAuth selection initialization input as an Effect program.
 *
 * Ensures selection ID meets length constraints (16-256), expiry is in the future,
 * and tenant/brand profile context is present.
 *
 * @param selectionId - Opaque selection ID string.
 * @param init - Pending selection context without candidates.
 * @returns Effect resolving to void on valid input, else InvalidOAuthStateError.
 */
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
  if (typeof init.brand_profile_id !== "string" || init.brand_profile_id.trim().length === 0) {
    return Effect.fail(
      new InvalidOAuthStateError({
        message: "A brand profile is required",
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

/**
 * Adapts one Durable Object storage call into a typed Effect.
 *
 * Applies the immediate `Effect.tryPromise` adapter convention: every storage
 * op fails with `OAuthStateStorageError` carrying an operation-specific
 * message plus the underlying error name as `cause` for diagnostics.
 *
 * @param message - Operation-specific failure description (e.g. "put OAuth state").
 * @param thunk - Deferred storage call (e.g. `() => storage.put(key, record)`).
 * @returns Effect resolving to the storage result, else OAuthStateStorageError.
 */
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

/**
 * Extra retention (10 min) for secret-free fence/replay evidence after a
 * selection ticket expires. Bounds how long a stripped master record may
 * acknowledge late completions or replays; never extends credential lifetime.
 */
const SELECTION_EVIDENCE_RETENTION_MS = 10 * 60 * 1_000;

/**
 * Asynchronous `storage.delete` accepts at most 128 keys per call.
 */
const STORAGE_DELETE_BATCH = 128;

/** Deletes storage keys in batches of 128 to stay within the async delete limit. */
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

/** Writes storage entries in batches of 128 to stay within the async put limit. */
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

/**
 * Deletes every `selection-account:`/`selection-credential:` entry for a
 * selection in batches of 128. Listing the metadata prefix keeps large
 * ciphertext values out of memory while still covering entries orphaned by a
 * partially failed append.
 */
function deleteSelectionCandidatesEffect(
  storage: DurableObjectStorage,
  selectionId: string,
): Effect.Effect<void, OAuthStateStorageError> {
  return Effect.gen(function* () {
    const metadataEntries = yield* storageEffect(
      "Failed to list candidate entries for cleanup.",
      () => storage.list({ prefix: `selection-account:${selectionId}:` }),
    );
    const keys: string[] = [];
    for (const metadataKey of metadataEntries.keys()) {
      keys.push(metadataKey);
      keys.push(`selection-credential:${metadataKey.slice("selection-account:".length)}`);
    }
    yield* deleteStorageKeysEffect(storage, keys, "Failed to delete candidate entries.");
  });
}
/**
 * Executes one composed OAuth state program at the Durable Object boundary.
 *
 * The single approved `Effect.run*` site in the state worker
 * (docs/architecture/effect-v4.md §1.4): `create`, `consume`, and `alarm`
 * compose programs from pure cores plus storage adapters and delegate here.
 * `InvalidOAuthStateError` maps to `TypeError` because the RPC contract — the
 * API Worker caller and tests — relies on TypeError rejections for invalid
 * handoffs; every other failure or defect rethrows the squashed cause.
 *
 * @param program - OAuth state program with typed validation/storage errors.
 * @returns The program's success value; rejects on typed failure or defect.
 */
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
  /**
   * Persists single-use OAuth state and arms a storage alarm for automatic expiry.
   * Required to guard authorization code grant handoffs with organization, user, and PKCE verifier context.
   * Composes the create program — validateOAuthStateCreateEffect, then storage
   * put/getAlarm/setAlarm adapters — executed via runStateProgram; schedules or
   * advances the DO alarm to match earliest expiry.
   *
   * @param state - Unique opaque state string generated during authorization initiation.
   * @param record - Context containing brand_profile_id, org_id, user_id, provider, redirect path, expiry ms, and optional PKCE verifier.
   * @throws {TypeError} When state is empty, record.expires_at is not in the future, or brand_profile_id is missing/blank.
   */
  async create(state: string, record: OAuthStateRecord): Promise<void> {
    const storage = this.ctx.storage;
    const program = Effect.gen(function* () {
      yield* validateOAuthStateCreateEffect(state, record);
      yield* storageEffect("Failed to persist OAuth state.", () =>
        storage.put(`oauth:${state}`, record),
      );
      const currentAlarm = yield* storageEffect("Failed to read the OAuth state alarm.", () =>
        storage.getAlarm(),
      );
      if (currentAlarm === null || record.expires_at < currentAlarm) {
        yield* storageEffect("Failed to arm the OAuth state alarm.", () =>
          storage.setAlarm(record.expires_at),
        );
      }
    });
    return runStateProgram(program);
  }

  /**
   * Atomically consumes and deletes an OAuth state record, enforcing consume-once replay protection.
   * Needed during OAuth callback verification so authorization codes cannot be replayed or shared across tenants.
   * Runs the get/delete/expiry-check sequence as one Effect program via
   * runStateProgram; deletes the stored key unconditionally and returns the
   * record only if found and not yet expired.
   *
   * @param state - Opaque state string received in the provider authorization callback.
   * @returns The stored OAuthStateRecord if present and unexpired; null otherwise.
   */
  async consume(state: string): Promise<OAuthStateRecord | null> {
    // SQLite-backed DO storage is atomic and the instance is single-threaded,
    // so the get/delete pair needs no storage.transaction() wrapper (AUD-036).
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
    return runStateProgram(program);
  }

  /**
   * Initiates a candidate OAuth account selection session before candidates are appended.
   * Stores master tenant/lifecycle context with ready=false so partial selections cannot be listed.
   *
   * @param selectionId - Unique opaque selection identifier.
   * @param init - Candidate session metadata.
   */
  async createSelection(selectionId: string, init: OAuthSelectionInit): Promise<void> {
    const storage = this.ctx.storage;
    const program = Effect.gen(function* () {
      yield* validateOAuthSelectionCreateEffect(selectionId, init);
      const record: OAuthSelectionRecord = {
        account_ids: [],
        brand_profile_id: init.brand_profile_id,
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
      // Arm expiry before any candidate credentials exist so an interrupted
      // append/finalize sequence cannot leave secrets unswept.
      const currentAlarm = yield* storageEffect("Failed to read the OAuth state alarm.", () =>
        storage.getAlarm(),
      );
      if (currentAlarm === null || record.expires_at < currentAlarm) {
        yield* storageEffect("Failed to arm the OAuth state alarm.", () =>
          storage.setAlarm(record.expires_at),
        );
      }
    });
    return runStateProgram(program);
  }

  /**
   * Appends public metadata and sealed credentials under separate bounded key families.
   * Batch writes and the master index commit atomically, so a failure cannot orphan a partial append.
   * Listings read metadata only; later confirmation reads just the chosen credential.
   */
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
      const entriesToPut: Record<string, unknown> = {};
      for (const candidate of candidates) {
        if (!candidate.account.id || candidate.account.id.length > 255) {
          return yield* Effect.fail(
            new InvalidOAuthStateError({
              message: "Account ID must be a non-empty string under 255 characters",
            }),
          );
        }
        newAccountIds.push(candidate.account.id);
        entriesToPut[`selection-account:${selectionId}:${candidate.account.id}`] =
          candidate.account;
        entriesToPut[`selection-credential:${selectionId}:${candidate.account.id}`] = {
          encrypted_connection: candidate.encryptedConnection,
        };
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
      if (updated.account_ids.length > 1000) {
        return yield* Effect.fail(
          new InvalidOAuthStateError({
            message: "Accounts list must not exceed 1000 items",
          }),
        );
      }
      yield* storageEffect("Failed to update OAuth selection account IDs.", () =>
        storage.put(key, updated),
      );
    });
    return storage.transaction(() => runStateProgram(program));
  }

  /**
   * Marks the selection ready for listing and confirmation once candidate
   * discovery completes; re-arms the expiry alarm if it advanced past it.
   *
   * @param selectionId - Unique opaque selection identifier.
   */
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
      const currentAlarm = yield* storageEffect("Failed to read the OAuth state alarm.", () =>
        storage.getAlarm(),
      );
      if (currentAlarm === null || record.expires_at < currentAlarm) {
        yield* storageEffect("Failed to arm the OAuth state alarm.", () =>
          storage.setAlarm(record.expires_at),
        );
      }
    });
    return runStateProgram(program);
  }

  /**
   * Retrieves public candidate metadata for an unexpired, finalized selection.
   * Lists only `selection-account:` metadata entries in account_ids order;
   * never loads credential values. Foreign callers receive null.
   *
   * @param selectionId - Opaque selection identifier.
   * @param actor - Organization and user context of the authenticated requester.
   * @returns Sanitized public selection DTO if present, unexpired, and owned; null otherwise.
   */
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
        brand_profile_id: record.brand_profile_id,
        expires_at: new Date(record.expires_at).toISOString(),
        id: record.id,
        platform: record.platform as OAuthSelectionPublic["platform"],
      };
    });
    return runStateProgram(program);
  }

  /**
   * Claims an owner-bound candidate before the original deadline; the default 30s lease excludes concurrent saves.
   * The chosen account stays pinned across retries, and only its credential is read.
   * Completed same-key requests replay only before the evidence deadline, independent of alarm delivery.
   * Returns a credential claim, replay, conflict, or not-found; custom lease durations are milliseconds.
   */
  async claimSelection(
    selectionId: string,
    accountId: string,
    actor: { organizationId: string; userId: string },
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
      const evidenceExpiry =
        record.evidence_expires_at ?? record.expires_at + SELECTION_EVIDENCE_RETENTION_MS;
      if (now >= evidenceExpiry) {
        return { status: "not_found" } as const;
      }
      if (record.status === "cancelled") {
        return { status: "not_found" } as const;
      }
      if (record.status === "completed") {
        if (
          record.completed_account_id === accountId &&
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
      // Original ticket expiry is absolute; claims never extend it.
      if (record.expires_at <= now) {
        return { status: "not_found" } as const;
      }
      // Once any confirmation claim is acquired, the selected account stays
      // pinned for the ticket lifetime, even if the claim is released.
      if (record.pinned_account_id && record.pinned_account_id !== accountId) {
        return {
          code: "pinned_account_mismatch",
          message:
            "This selection was already confirmed for a different account. Restart authorization to choose another account.",
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
        brandProfileId: record.brand_profile_id,
        claimToken,
        encryptedConnection: candidateEntry.encrypted_connection,
        organizationId: record.organization_id,
        platform: record.platform,
        status: "claimed",
        userId: record.user_id,
      } as const;
    });
    return runStateProgram(program);
  }

  /**
   * Completes a matching save claim before the bounded evidence deadline.
   * Candidate cleanup and terminal replay state commit atomically, preserving retry credentials on failure.
   * Returns false for a missing/mismatched/expired claim; successful completion exposes no candidate metadata.
   */
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
      const now = Date.now();
      const evidenceExpiry =
        record.evidence_expires_at ?? record.expires_at + SELECTION_EVIDENCE_RETENTION_MS;
      if (now >= evidenceExpiry) return false;
      yield* deleteSelectionCandidatesEffect(storage, selectionId);
      const updated: OAuthSelectionRecord = {
        ...record,
        account_ids: [],
        claim: undefined,
        completed_account_id: accountId,
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

  /**
   * Releases an active claim after a deterministic failed-save (e.g. quota limit exceeded).
   * Permitting retry without losing authorization while preserving the pinned account invariant.
   *
   * @param selectionId - Opaque selection identifier.
   * @param claimToken - Unique claim identity token issued during claimSelection.
   * @returns True if claim was released; false if claim token mismatched or ticket missing.
   */
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
    return runStateProgram(program);
  }

  /**
   * Cancels an owner-bound pending ticket with atomic credential cleanup and terminal state.
   * Any retained save claim conflicts, regardless of lease age, so cancellation cannot promise a false 204.
   * Returns cancelled, not-found, or conflict; a failed cleanup leaves the ticket safely retryable.
   */
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
      // A retained claim can still mean an in-flight save; never cancel it.
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

  /**
   * Atomically expires OAuth states and candidate credentials at their original deadlines.
   * Retained claims and terminal statuses keep only secret-free evidence for the bounded grace window.
   * Cleanup, stripped evidence, and rescheduling commit together so interrupted batches remain retryable.
   */
  async alarm(): Promise<void> {
    const storage = this.ctx.storage;
    const program = Effect.gen(function* () {
      const now = Date.now();
      const oauthEntries = yield* storageEffect("Failed to list OAuth state entries.", () =>
        storage.list<OAuthStateRecord>({ prefix: "oauth:" }),
      );
      // selection-account:/selection-credential: live outside this prefix, so
      // listing masters never loads candidate values.
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
        // Sweep candidate entries unconditionally so credentials appended by a
        // partially failed append (never recorded in account_ids) still expire.
        yield* deleteSelectionCandidatesEffect(storage, key.slice("selection:".length));
        // Pending masters keep fence value only while a claim is retained;
        // terminal statuses keep replay/cancel evidence. Both are stripped of
        // candidate entries and bounded by the evidence deadline.
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
  /**
   * Default HTTP fetch handler for the State Worker.
   * Rejects direct HTTP ingress with a 404 response because the State Worker
   * exposes only internal Durable Object bindings to the API Worker.
   *
   * @returns 404 JSON response with standard error envelope.
   */
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
