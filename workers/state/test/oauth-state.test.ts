import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { OAuthSelectionCandidate, OAuthStateRecord } from "@meltiply/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import stateWorker, { type OAuthSelectionRecord, type OAuthStateCoordinator } from "../src/index";

const candidate = (id: string, encryptedConnection = `sealed-${id}`): OAuthSelectionCandidate => ({
  account: {
    avatar_url: null,
    display_name: `Page ${id}`,
    id,
    username: null,
  },
  encryptedConnection,
});

const oauthRecord = (org: string, expiresAt = Date.now() + 60_000): OAuthStateRecord => ({
  expires_at: expiresAt,
  organization_id: org,
  provider: "tiktok",
  redirect_path: "/channels",
  user_id: `user-${org}`,
});

async function seedFinalizedSelection(
  org: string,
  candidates: ReadonlyArray<OAuthSelectionCandidate>,
  expiresAt = Date.now() + 600_000,
) {
  const coordinator = env.OAUTH_STATE.getByName(org);
  const selectionId = `${org}.nonce1234567890`;
  await coordinator.createSelection(selectionId, {
    expires_at: expiresAt,
    id: selectionId,
    organization_id: org,
    platform: "facebook",
    user_id: `user-${org}`,
  });
  await coordinator.appendSelectionCandidates(selectionId, candidates);
  await coordinator.finalizeSelection(selectionId);
  return {
    actor: { organizationId: org, userId: `user-${org}` },
    claimActor: { brandProfileId: "profile-1", organizationId: org, userId: `user-${org}` },
    coordinator,
    selectionId,
  };
}

describe("OAuthStateCoordinator", () => {
  it("consumes stored state once and returns null on the second read", async () => {
    const coordinator = env.OAUTH_STATE.getByName("do-consume-once");
    const record = oauthRecord("do-consume-once");
    await coordinator.create("state-alpha", record);

    expect(await coordinator.consume("state-alpha")).toEqual(record);
    expect(await coordinator.consume("state-alpha")).toEqual(null);
  });

  it("admits only one winner across concurrent consume calls", async () => {
    const coordinator = env.OAUTH_STATE.getByName("do-consume-race");
    const record = oauthRecord("do-consume-race");
    await coordinator.create("state-race", record);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => coordinator.consume("state-race")),
    );

    expect(results.filter((value) => value !== null)).toEqual([record]);
    expect(results.filter((value) => value === null)).toHaveLength(7);
  });

  it("executes consume inside storage.transaction", async () => {
    const coordinator = env.OAUTH_STATE.getByName("do-consume-tx");
    const record = oauthRecord("do-consume-tx");
    await coordinator.create("state-tx", record);

    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const txSpy = vi.spyOn(ctx.storage, "transaction");
        try {
          expect(await instance.consume("state-tx")).toEqual(record);
          expect(txSpy).toHaveBeenCalledTimes(1);
        } finally {
          txSpy.mockRestore();
        }
      },
    );
  });

  it("surfaces invalid create input as a TypeError", async () => {
    const coordinator = env.OAUTH_STATE.getByName("do-typeerror");

    await expect(
      runInDurableObject(coordinator, (instance: OAuthStateCoordinator) =>
        instance.create("", oauthRecord("do-typeerror")),
      ),
    ).rejects.toThrow(TypeError);
  });

  it("returns public selection metadata without leaking credentials", async () => {
    const { actor, coordinator, selectionId } = await seedFinalizedSelection("do-public-dto", [
      {
        account: {
          avatar_url: "https://example.com/avatar1.jpg",
          display_name: "Page One",
          id: "page-1",
          username: "pageone",
        },
        encryptedConnection: "meltiply:v2:primary:ciphertext1",
      },
    ]);

    const dto = await coordinator.getSelection(selectionId, actor);

    expect(dto).toEqual({
      accounts: [
        {
          avatar_url: "https://example.com/avatar1.jpg",
          display_name: "Page One",
          id: "page-1",
          username: "pageone",
        },
      ],
      expires_at: expect.any(String),
      id: selectionId,
      platform: "facebook",
    });
    expect(JSON.stringify(dto)).not.toContain("ciphertext1");
  });

  it("rejects duplicate candidate appends without writing partial storage keys", async () => {
    const coordinator = env.OAUTH_STATE.getByName("do-append-atomic");
    const selectionId = "do-append-atomic.nonce1234567890";
    await coordinator.createSelection(selectionId, {
      expires_at: Date.now() + 600_000,
      id: selectionId,
      organization_id: "do-append-atomic",
      platform: "facebook",
      user_id: "user-1",
    });
    await coordinator.appendSelectionCandidates(selectionId, [candidate("page-1", "secret-1")]);

    await expect(
      runInDurableObject(coordinator, (instance: OAuthStateCoordinator) =>
        instance.appendSelectionCandidates(selectionId, [
          candidate("page-2", "secret-2"),
          candidate("page-1", "secret-overwrite"),
        ]),
      ),
    ).rejects.toThrow("unique");

    await runInDurableObject(
      coordinator,
      async (_instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const stored = await ctx.storage.get<OAuthSelectionRecord>(`selection:${selectionId}`);
        expect(stored?.account_ids).toEqual(["page-1"]);
        expect(await ctx.storage.get(`selection-credential:${selectionId}:page-1`)).toEqual({
          encrypted_connection: "secret-1",
        });
        expect(await ctx.storage.get(`selection-account:${selectionId}:page-2`)).toEqual(undefined);
      },
    );
  });

  it("claims a candidate with its sealed payload and releases the claim", async () => {
    const largeSecret = "X".repeat(20_000);
    const { claimActor, coordinator, selectionId } = await seedFinalizedSelection(
      "do-claim-release",
      [candidate("page-1", largeSecret)],
    );

    const claim = await coordinator.claimSelection(selectionId, "page-1", claimActor, "idem-1");
    expect(claim).toEqual({
      claimToken: expect.any(String),
      encryptedConnection: largeSecret,
      organizationId: "do-claim-release",
      platform: "facebook",
      status: "claimed",
      userId: "user-do-claim-release",
    });
    if (claim.status !== "claimed") throw new Error("Expected claimed");

    expect(await coordinator.releaseSelectionClaim(selectionId, claim.claimToken)).toEqual(true);
  });

  it("completes a claimed selection, replays it, and wipes candidate keys", async () => {
    const { claimActor, coordinator, selectionId } = await seedFinalizedSelection(
      "do-complete-replay",
      [candidate("page-1", "sealed-1"), candidate("page-2", "sealed-2")],
    );

    const claim = await coordinator.claimSelection(selectionId, "page-1", claimActor, "idem-1");
    if (claim.status !== "claimed") throw new Error("Expected claimed");

    expect(
      await coordinator.completeSelection(selectionId, "page-1", claim.claimToken, "idem-1"),
    ).toEqual(true);
    expect(await coordinator.claimSelection(selectionId, "page-1", claimActor, "idem-1")).toEqual({
      status: "replayed",
    });

    await runInDurableObject(
      coordinator,
      async (_instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        expect(
          (await ctx.storage.list({ prefix: `selection-account:${selectionId}:` })).size,
        ).toEqual(0);
        expect(
          (await ctx.storage.list({ prefix: `selection-credential:${selectionId}:` })).size,
        ).toEqual(0);
      },
    );
  });

  it("rolls back candidate cleanup when storage.delete fails mid-completion", async () => {
    const batch = Array.from({ length: 65 }, (_, index) => candidate(`page-${index}`));
    const { actor, claimActor, coordinator, selectionId } = await seedFinalizedSelection(
      "do-rollback-delete",
      batch,
    );
    const claim = await coordinator.claimSelection(selectionId, "page-7", claimActor, "idem-rb");
    if (claim.status !== "claimed") throw new Error("Expected claimed");

    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const deleteKeys = ctx.storage.delete.bind(ctx.storage);
        const failure = vi
          .spyOn(ctx.storage, "delete")
          .mockImplementationOnce((keys, options) => deleteKeys(keys, options))
          .mockRejectedValueOnce(new Error("Interrupted candidate cleanup"));
        try {
          await expect(
            instance.completeSelection(selectionId, "page-7", claim.claimToken, "idem-rb"),
          ).rejects.toMatchObject({ _tag: "OAuthStateStorageError" });
        } finally {
          failure.mockRestore();
        }
        const recovered = await instance.getSelection(selectionId, actor);
        expect(recovered?.accounts).toHaveLength(65);
      },
    );
  });

  it("paginates candidate deletion via startAfter across storage list pages", async () => {
    const batch = Array.from({ length: 140 }, (_, index) =>
      candidate(`acct-${String(index).padStart(4, "0")}`),
    );
    const { actor, coordinator, selectionId } = await seedFinalizedSelection(
      "do-paginated-cancel",
      batch,
    );

    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const listSpy = vi.spyOn(ctx.storage, "list");
        try {
          expect(await instance.cancelSelection(selectionId, actor, "idem-cancel")).toEqual({
            status: "cancelled",
          });
          const cleanupCalls = listSpy.mock.calls
            .map(([options]) => options)
            .filter((options) => options?.prefix === `selection-account:${selectionId}:`);
          expect(cleanupCalls).toEqual([
            { limit: 128, prefix: `selection-account:${selectionId}:` },
            {
              limit: 128,
              prefix: `selection-account:${selectionId}:`,
              startAfter: `selection-account:${selectionId}:acct-0127`,
            },
          ]);
        } finally {
          listSpy.mockRestore();
        }
        expect(
          (await ctx.storage.list({ prefix: `selection-account:${selectionId}:` })).size,
        ).toEqual(0);
        expect(
          (await ctx.storage.list({ prefix: `selection-credential:${selectionId}:` })).size,
        ).toEqual(0);
      },
    );
  });

  it("alarm sweeps expired state, strips claimed selection evidence, and reschedules", async () => {
    const coordinator = env.OAUTH_STATE.getByName("do-alarm-sweep");
    const now = Date.now();
    const liveExpiry = now + 60_000;
    const live = oauthRecord("do-alarm-sweep", liveExpiry);
    await coordinator.create("state-live", live);

    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        await ctx.storage.put({
          "oauth:state-old": oauthRecord("do-alarm-sweep", now - 10),
          "selection:sel-expired": {
            account_ids: ["p1"],
            expires_at: now - 10,
            id: "sel-expired",
            organization_id: "do-alarm-sweep",
            platform: "facebook",
            ready: false,
            status: "pending",
            user_id: "u1",
          } satisfies OAuthSelectionRecord,
          "selection-account:sel-expired:p1": candidate("p1").account,
          "selection-credential:sel-expired:p1": { encrypted_connection: "orphan" },
          "selection:sel-claimed": {
            account_ids: ["p2"],
            claim: {
              brand_profile_id: "profile-1",
              claimed_at: now - 5_000,
              expires_at: now + 25_000,
              idempotency_key: "idem-1",
              token: "tok-1",
            },
            expires_at: now - 50,
            id: "sel-claimed",
            organization_id: "do-alarm-sweep",
            pinned_account_id: "p2",
            platform: "facebook",
            ready: true,
            status: "pending",
            user_id: "u1",
          } satisfies OAuthSelectionRecord,
          "selection-account:sel-claimed:p2": candidate("p2").account,
          "selection-credential:sel-claimed:p2": { encrypted_connection: "claimed-secret" },
        });

        await instance.alarm();

        expect(await ctx.storage.getAlarm()).toEqual(liveExpiry);
        expect(await ctx.storage.get("oauth:state-old")).toEqual(undefined);
        expect(await ctx.storage.get("selection:sel-expired")).toEqual(undefined);
        expect(await ctx.storage.get("selection-credential:sel-expired:p1")).toEqual(undefined);
        expect(await ctx.storage.get("selection-credential:sel-claimed:p2")).toEqual(undefined);
        const stripped = await ctx.storage.get<OAuthSelectionRecord>("selection:sel-claimed");
        expect(stripped?.account_ids).toEqual([]);
        expect(stripped?.claim?.token).toEqual("tok-1");
      },
    );

    expect(await coordinator.consume("state-live")).toEqual(live);
  });

  it("returns a 404 JSON envelope from the HTTP fetch handler", async () => {
    const response = stateWorker.fetch();

    expect(response.status).toEqual(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        details: [],
        message: "The State Worker has no public HTTP routes.",
        request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        retryable: false,
      },
    });
  });
});
