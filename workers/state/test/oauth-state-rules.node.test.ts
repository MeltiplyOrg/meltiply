import type {
  OAuthSelectionAccount,
  OAuthSelectionCandidate,
  OAuthSelectionInit,
  OAuthSelectionRecord,
  OAuthStateRecord,
} from "@meltiply/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  decideSelectionCancel,
  decideSelectionClaim,
  decideSelectionCompletion,
  decideSelectionRelease,
  InvalidOAuthStateError,
  MAX_SELECTION_CANDIDATES,
  planAlarmSweep,
  planCandidateAppend,
  projectPublicSelection,
  SELECTION_EVIDENCE_RETENTION_MS,
  selectionEvidenceExpiry,
  validateOAuthSelectionCreateEffect,
  validateOAuthStateCreateEffect,
} from "../src/oauth-state-rules";

const NOW = 1_700_000_000_000;
const FUTURE = NOW + 60_000;
const SELECTION_ID = "org-1.nonce1234567890";
const ACTOR = { organizationId: "org-1", userId: "user-1" };
const CLAIM_ACTOR = { brandProfileId: "profile-1", organizationId: "org-1", userId: "user-1" };

const stateRecord = (patch: Partial<OAuthStateRecord> = {}): OAuthStateRecord => ({
  expires_at: FUTURE,
  organization_id: "org-1",
  provider: "tiktok",
  redirect_path: "/channels",
  user_id: "user-1",
  ...patch,
});

const selectionInit = (patch: Partial<OAuthSelectionInit> = {}): OAuthSelectionInit => ({
  expires_at: FUTURE,
  id: SELECTION_ID,
  organization_id: "org-1",
  platform: "facebook",
  user_id: "user-1",
  ...patch,
});

const selectionRecord = (patch: Partial<OAuthSelectionRecord> = {}): OAuthSelectionRecord => ({
  account_ids: ["page-1", "page-2"],
  expires_at: FUTURE,
  id: SELECTION_ID,
  organization_id: "org-1",
  platform: "facebook",
  ready: true,
  status: "pending",
  user_id: "user-1",
  ...patch,
});

const account = (id: string): OAuthSelectionAccount => ({
  avatar_url: null,
  display_name: `Page ${id}`,
  id,
  username: null,
});

const candidate = (id: string, encryptedConnection = `sealed-${id}`): OAuthSelectionCandidate => ({
  account: account(id),
  encryptedConnection,
});

const run = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(program);
const failure = <A, E>(program: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(program));

describe("validateOAuthStateCreateEffect", () => {
  it("a non-empty state expiring one millisecond in the future", async () => {
    expect(
      await run(validateOAuthStateCreateEffect("s", stateRecord({ expires_at: NOW + 1 }), NOW)),
    ).toEqual(undefined);
  });

  it.each([
    ["an empty state", "", stateRecord()],
    ["an expiry equal to now", "state-1", stateRecord({ expires_at: NOW })],
    ["an expiry in the past", "state-1", stateRecord({ expires_at: NOW - 1 })],
  ])("%s", async (_example, state, record) => {
    expect(await failure(validateOAuthStateCreateEffect(state, record, NOW))).toEqual(
      new InvalidOAuthStateError({ message: "OAuth state and a future expiry are required" }),
    );
  });
});

describe("validateOAuthSelectionCreateEffect", () => {
  it.each([
    ["a 16-character selection id", "a".repeat(16)],
    ["a 256-character selection id", "a".repeat(256)],
  ])("%s", async (_example, id) => {
    expect(await run(validateOAuthSelectionCreateEffect(id, selectionInit({ id }), NOW))).toEqual(
      undefined,
    );
  });

  it.each([
    ["an empty selection id", "", {}, "Selection ID and a future expiry are required"],
    [
      "a 15-character selection id",
      "a".repeat(15),
      {},
      "Selection ID and a future expiry are required",
    ],
    [
      "a 257-character selection id",
      "a".repeat(257),
      {},
      "Selection ID and a future expiry are required",
    ],
    [
      "an expiry equal to now",
      SELECTION_ID,
      { expires_at: NOW },
      "Selection ID and a future expiry are required",
    ],
    [
      "a blank organization id",
      SELECTION_ID,
      { organization_id: "   " },
      "An organization ID is required",
    ],
    ["a blank user id", SELECTION_ID, { user_id: "  " }, "A user ID is required"],
    ["a blank platform", SELECTION_ID, { platform: "" as never }, "A platform is required"],
  ])("%s", async (_example, id, patch, message) => {
    expect(
      await failure(validateOAuthSelectionCreateEffect(id, selectionInit(patch), NOW)),
    ).toEqual(new InvalidOAuthStateError({ message }));
  });
});

describe("selectionEvidenceExpiry", () => {
  it("defaults to ten minutes past expires_at", () => {
    expect(selectionEvidenceExpiry(selectionRecord({ expires_at: NOW }))).toEqual(
      NOW + SELECTION_EVIDENCE_RETENTION_MS,
    );
  });

  it("keeps an explicit evidence_expires_at", () => {
    expect(selectionEvidenceExpiry(selectionRecord({ evidence_expires_at: NOW + 5_000 }))).toEqual(
      NOW + 5_000,
    );
  });
});

describe("planCandidateAppend", () => {
  const unfinalized = (account_ids: string[] = []): OAuthSelectionRecord =>
    selectionRecord({ account_ids, ready: false });

  it("builds account and credential entries and appends account ids", async () => {
    const base = unfinalized(["page-0"]);
    const result = await run(
      planCandidateAppend(SELECTION_ID, base, [candidate("page-1", "cipher-1")]),
    );

    expect(result).toEqual({
      entries: {
        [`selection-account:${SELECTION_ID}:page-1`]: account("page-1"),
        [`selection-credential:${SELECTION_ID}:page-1`]: { encrypted_connection: "cipher-1" },
      },
      updated: {
        ...base,
        account_ids: ["page-0", "page-1"],
      },
    });
  });

  it("accepts an empty candidate batch", async () => {
    const base = unfinalized(["page-0"]);

    expect(await run(planCandidateAppend(SELECTION_ID, base, []))).toEqual({
      entries: {},
      updated: base,
    });
  });

  it("accepts a 255-character account id and exactly the candidate cap", async () => {
    const id = "x".repeat(255);
    const result = await run(
      planCandidateAppend(SELECTION_ID, unfinalized(["a"]), [candidate(id)], 2),
    );

    expect(result.updated.account_ids).toEqual(["a", id]);
  });

  it.each([
    [
      "missing selection",
      undefined,
      [candidate("page-1")],
      MAX_SELECTION_CANDIDATES,
      "Cannot append candidates to an uninitialized or finalized selection.",
    ],
    [
      "already finalized selection",
      selectionRecord({ ready: true }),
      [candidate("page-3")],
      MAX_SELECTION_CANDIDATES,
      "Cannot append candidates to an uninitialized or finalized selection.",
    ],
    [
      "cancelled selection",
      selectionRecord({ ready: false, status: "cancelled" }),
      [candidate("page-3")],
      MAX_SELECTION_CANDIDATES,
      "Cannot append candidates to an uninitialized or finalized selection.",
    ],
    [
      "empty account id",
      unfinalized(),
      [candidate("")],
      MAX_SELECTION_CANDIDATES,
      "Account ID must be a non-empty string under 255 characters",
    ],
    [
      "256-character account id",
      unfinalized(),
      [candidate("x".repeat(256))],
      MAX_SELECTION_CANDIDATES,
      "Account ID must be a non-empty string under 255 characters",
    ],
    [
      "duplicate account id within the batch",
      unfinalized(),
      [candidate("dup"), candidate("dup")],
      MAX_SELECTION_CANDIDATES,
      "Account IDs must be unique within a selection.",
    ],
    [
      "account id already stored on the selection",
      unfinalized(["page-1"]),
      [candidate("page-2"), candidate("page-1")],
      MAX_SELECTION_CANDIDATES,
      "Account IDs must be unique within a selection.",
    ],
    [
      "exceeding the candidate cap",
      unfinalized(["page-1"]),
      [candidate("page-2"), candidate("page-3")],
      2,
      "Accounts list must not exceed 1000 items",
    ],
  ])("%s", async (_example, record, batch, cap, message) => {
    expect(await failure(planCandidateAppend(SELECTION_ID, record, batch, cap))).toEqual(
      new InvalidOAuthStateError({ message }),
    );
  });
});

describe("projectPublicSelection", () => {
  it("orders public accounts by record.account_ids and omits missing entries", () => {
    const record = selectionRecord({ account_ids: ["page-2", "missing", "page-1"] });

    expect(
      projectPublicSelection(record, ACTOR, [account("page-1"), account("page-2")], NOW),
    ).toEqual({
      accounts: [account("page-2"), account("page-1")],
      expires_at: new Date(FUTURE).toISOString(),
      id: SELECTION_ID,
      platform: "facebook",
    });
  });

  it.each([
    ["missing record", undefined, ACTOR],
    ["unfinalized record", selectionRecord({ ready: false }), ACTOR],
    ["expired record at boundary", selectionRecord({ expires_at: NOW }), ACTOR],
    ["completed record", selectionRecord({ status: "completed" }), ACTOR],
    ["cancelled record", selectionRecord({ status: "cancelled" }), ACTOR],
    ["different organization", selectionRecord(), { organizationId: "org-2", userId: "user-1" }],
    ["different user", selectionRecord(), { organizationId: "org-1", userId: "user-2" }],
  ])("%s", (_example, record, actor) => {
    expect(projectPublicSelection(record, actor, [account("page-1")], NOW)).toEqual(null);
  });
});

describe("decideSelectionClaim", () => {
  it("allows claiming an available candidate", () => {
    const record = selectionRecord();

    expect(decideSelectionClaim(record, "page-1", CLAIM_ACTOR, "idem-1", NOW)).toEqual({
      kind: "claim",
      record,
    });
  });

  it("allows reclaiming the same account and brand profile after a stale lease", () => {
    const record = selectionRecord({
      claim: {
        brand_profile_id: "profile-1",
        claimed_at: NOW - 40_000,
        expires_at: NOW,
        idempotency_key: "idem-old",
        token: "tok-old",
      },
      pinned_account_id: "page-1",
    });

    expect(decideSelectionClaim(record, "page-1", CLAIM_ACTOR, "idem-new", NOW)).toEqual({
      kind: "claim",
      record,
    });
  });

  it("replays a completed selection with matching account, brand profile, and idempotency key", () => {
    const record = selectionRecord({
      account_ids: [],
      completed_account_id: "page-1",
      completed_brand_profile_id: "profile-1",
      completed_idempotency_key: "idem-1",
      expires_at: NOW - 100,
      status: "completed",
    });

    expect(decideSelectionClaim(record, "page-1", CLAIM_ACTOR, "idem-1", NOW)).toEqual({
      kind: "result",
      result: { status: "replayed" },
    });
  });

  it.each([
    ["missing record", undefined, "page-1", CLAIM_ACTOR, "idem-1"],
    ["unfinalized record", selectionRecord({ ready: false }), "page-1", CLAIM_ACTOR, "idem-1"],
    [
      "foreign organization",
      selectionRecord(),
      "page-1",
      { ...CLAIM_ACTOR, organizationId: "org-2" },
      "idem-1",
    ],
    ["foreign user", selectionRecord(), "page-1", { ...CLAIM_ACTOR, userId: "user-2" }, "idem-1"],
    [
      "past evidence expiry",
      selectionRecord({ evidence_expires_at: NOW, status: "completed" }),
      "page-1",
      CLAIM_ACTOR,
      "idem-1",
    ],
    [
      "cancelled selection",
      selectionRecord({ status: "cancelled" }),
      "page-1",
      CLAIM_ACTOR,
      "idem-1",
    ],
    [
      "expired pending selection",
      selectionRecord({ expires_at: NOW }),
      "page-1",
      CLAIM_ACTOR,
      "idem-1",
    ],
  ])("returns not_found for %s", (_example, record, accountId, actor, key) => {
    expect(decideSelectionClaim(record, accountId, actor, key, NOW)).toEqual({
      kind: "result",
      result: { status: "not_found" },
    });
  });

  it.each([
    [
      "completed with a different idempotency key",
      selectionRecord({
        completed_account_id: "page-1",
        completed_brand_profile_id: "profile-1",
        completed_idempotency_key: "idem-1",
        status: "completed",
      }),
      "page-1",
      CLAIM_ACTOR,
      "idem-2",
      {
        code: "already_completed",
        message: "This OAuth account selection has already been completed.",
        status: "conflict",
      },
    ],
    [
      "completed for a different brand profile",
      selectionRecord({
        completed_account_id: "page-1",
        completed_brand_profile_id: "profile-1",
        completed_idempotency_key: "idem-1",
        status: "completed",
      }),
      "page-1",
      { ...CLAIM_ACTOR, brandProfileId: "profile-2" },
      "idem-1",
      {
        code: "already_completed",
        message: "This OAuth account selection has already been completed.",
        status: "conflict",
      },
    ],
    [
      "pinned to a different account",
      selectionRecord({ pinned_account_id: "page-1" }),
      "page-2",
      CLAIM_ACTOR,
      "idem-1",
      {
        code: "pinned_account_mismatch",
        message:
          "This selection was already confirmed for a different account. Restart authorization to choose another account.",
        status: "conflict",
      },
    ],
    [
      "stale claim pinned to a different brand profile",
      selectionRecord({
        claim: {
          brand_profile_id: "profile-1",
          claimed_at: NOW - 40_000,
          expires_at: NOW - 1_000,
          idempotency_key: "idem-old",
          token: "tok-old",
        },
        pinned_account_id: "page-1",
      }),
      "page-1",
      { ...CLAIM_ACTOR, brandProfileId: "profile-2" },
      "idem-new",
      {
        code: "pinned_profile_mismatch",
        message:
          "This confirmation may still be saving to another Brand Profile. Retry the original assignment.",
        status: "conflict",
      },
    ],
    [
      "active claim on the same account and brand profile",
      selectionRecord({
        claim: {
          brand_profile_id: "profile-1",
          claimed_at: NOW - 1_000,
          expires_at: NOW + 1_000,
          idempotency_key: "idem-1",
          token: "tok-1",
        },
        pinned_account_id: "page-1",
      }),
      "page-1",
      CLAIM_ACTOR,
      "idem-2",
      {
        code: "claim_active",
        message: "Selection confirmation is currently in progress.",
        status: "conflict",
      },
    ],
    [
      "account not listed in selection",
      selectionRecord(),
      "page-unknown",
      CLAIM_ACTOR,
      "idem-1",
      {
        message: "The selected account was not found in this authorization.",
        status: "invalid_account",
      },
    ],
  ])("returns %s", (_example, record, accountId, actor, key, expected) => {
    expect(decideSelectionClaim(record, accountId, actor, key, NOW)).toEqual({
      kind: "result",
      result: expected,
    });
  });
});

describe("decideSelectionCompletion", () => {
  const claimed = (patch: Partial<OAuthSelectionRecord> = {}): OAuthSelectionRecord =>
    selectionRecord({
      claim: {
        brand_profile_id: "profile-1",
        claimed_at: NOW - 1_000,
        expires_at: NOW + 29_000,
        idempotency_key: "idem-1",
        token: "tok-1",
      },
      pinned_account_id: "page-1",
      ...patch,
    });

  it("completes a claimed selection inside the bounded evidence window after expires_at", () => {
    const record = claimed({ expires_at: NOW - 1_000 });

    expect(decideSelectionCompletion(record, "page-1", "tok-1", "idem-1", NOW)).toEqual({
      ...record,
      account_ids: [],
      claim: undefined,
      completed_account_id: "page-1",
      completed_brand_profile_id: "profile-1",
      completed_idempotency_key: "idem-1",
      status: "completed",
    });
  });

  it.each([
    ["missing record", undefined, "page-1", "tok-1", "idem-1"],
    ["wrong claim token", claimed(), "page-1", "tok-wrong", "idem-1"],
    ["wrong account id", claimed(), "page-2", "tok-1", "idem-1"],
    ["wrong idempotency key", claimed(), "page-1", "tok-1", "idem-wrong"],
    ["at evidence expiry", claimed({ evidence_expires_at: NOW }), "page-1", "tok-1", "idem-1"],
  ])("rejects %s", (_example, record, accountId, token, key) => {
    expect(decideSelectionCompletion(record, accountId, token, key, NOW)).toEqual(null);
  });
});

describe("decideSelectionRelease", () => {
  it("clears the active claim while preserving the pinned account", () => {
    const record = selectionRecord({
      claim: {
        brand_profile_id: "profile-1",
        claimed_at: NOW,
        expires_at: FUTURE,
        idempotency_key: "idem-1",
        token: "tok-1",
      },
      pinned_account_id: "page-1",
    });

    expect(decideSelectionRelease(record, "tok-1")).toEqual({
      ...record,
      claim: undefined,
    });
  });

  it.each([
    ["missing record", undefined],
    ["no active claim", selectionRecord()],
    [
      "mismatched token",
      selectionRecord({
        claim: {
          brand_profile_id: "profile-1",
          claimed_at: NOW,
          expires_at: FUTURE,
          idempotency_key: "idem-1",
          token: "tok-other",
        },
      }),
    ],
  ])("returns null for %s", (_example, record) => {
    expect(decideSelectionRelease(record, "tok-1")).toEqual(null);
  });
});

describe("decideSelectionCancel", () => {
  it("cancels a pending claim-free selection", () => {
    const record = selectionRecord();

    expect(decideSelectionCancel(record, ACTOR, "idem-cancel", NOW)).toEqual({
      kind: "cancel",
      updated: {
        ...record,
        account_ids: [],
        cancelled_idempotency_key: "idem-cancel",
        claim: undefined,
        status: "cancelled",
      },
    });
  });

  it.each([
    ["missing record", undefined, ACTOR, { status: "not_found" }],
    ["unfinalized record", selectionRecord({ ready: false }), ACTOR, { status: "not_found" }],
    [
      "foreign organization",
      selectionRecord(),
      { organizationId: "org-2", userId: "user-1" },
      { status: "not_found" },
    ],
    [
      "foreign user",
      selectionRecord(),
      { organizationId: "org-1", userId: "user-2" },
      { status: "not_found" },
    ],
    [
      "stale unreleased claim",
      selectionRecord({
        claim: {
          brand_profile_id: "profile-1",
          claimed_at: NOW - 40_000,
          expires_at: NOW - 100,
          idempotency_key: "idem-1",
          token: "tok-1",
        },
      }),
      ACTOR,
      {
        message: "Cannot cancel selection while confirmation is or was in progress.",
        status: "conflict",
      },
    ],
    [
      "completed selection",
      selectionRecord({ status: "completed" }),
      ACTOR,
      {
        message: "Cannot cancel an already completed selection.",
        status: "conflict",
      },
    ],
    [
      "already cancelled selection",
      selectionRecord({ status: "cancelled" }),
      ACTOR,
      { status: "cancelled" },
    ],
    [
      "expired pending selection",
      selectionRecord({ expires_at: NOW }),
      ACTOR,
      { status: "not_found" },
    ],
  ])("returns decision for %s", (_example, record, actor, result) => {
    expect(decideSelectionCancel(record, actor, "idem-cancel", NOW)).toEqual({
      kind: "return",
      result,
    });
  });
});

describe("planAlarmSweep", () => {
  it("returns an empty plan with no next alarm when storage is empty", () => {
    expect(planAlarmSweep([], [], NOW)).toEqual({
      cleanupSelectionIds: [],
      expiredKeys: [],
      nextAlarm: undefined,
      strippedMasters: {},
    });
  });

  it("deletes expired oauth states and schedules the earliest live expiry", () => {
    expect(
      planAlarmSweep(
        [
          ["oauth:old", stateRecord({ expires_at: NOW })],
          ["oauth:later", stateRecord({ expires_at: NOW + 90_000 })],
          ["oauth:sooner", stateRecord({ expires_at: NOW + 30_000 })],
        ],
        [],
        NOW,
      ),
    ).toEqual({
      cleanupSelectionIds: [],
      expiredKeys: ["oauth:old"],
      nextAlarm: NOW + 30_000,
      strippedMasters: {},
    });
  });

  it("deletes expired unclaimed pending selections and strips claimed or settled ones until evidence expires", () => {
    const expiredPending = selectionRecord({ expires_at: NOW - 1, id: "sel-pending" });
    const expiredClaimed = selectionRecord({
      claim: {
        brand_profile_id: "profile-1",
        claimed_at: NOW - 5_000,
        expires_at: NOW + 25_000,
        idempotency_key: "idem-1",
        token: "tok-1",
      },
      expires_at: NOW - 100,
      id: "sel-claimed",
    });
    const evidenceDone = selectionRecord({
      evidence_expires_at: NOW,
      expires_at: NOW - 10_000,
      id: "sel-evidence-done",
      status: "completed",
    });
    const liveSelection = selectionRecord({ expires_at: NOW + 900_000, id: "sel-live" });

    expect(
      planAlarmSweep(
        [],
        [
          ["selection:sel-pending", expiredPending],
          ["selection:sel-claimed", expiredClaimed],
          ["selection:sel-evidence-done", evidenceDone],
          ["selection:sel-live", liveSelection],
        ],
        NOW,
      ),
    ).toEqual({
      cleanupSelectionIds: ["sel-pending", "sel-claimed", "sel-evidence-done"],
      expiredKeys: ["selection:sel-pending", "selection:sel-evidence-done"],
      nextAlarm: NOW - 100 + SELECTION_EVIDENCE_RETENTION_MS,
      strippedMasters: {
        "selection:sel-claimed": {
          ...expiredClaimed,
          account_ids: [],
          evidence_expires_at: NOW - 100 + SELECTION_EVIDENCE_RETENTION_MS,
        },
      },
    });
  });
});
