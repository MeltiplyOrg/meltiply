import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { validateOAuthSelectionCreateEffect, validateOAuthStateCreateEffect } from "../src/index";
import type { OAuthSelectionCandidate, OAuthSelectionInit } from "@meltiply/contracts";
import type { OAuthSelectionRecord, OAuthStateCoordinator } from "../src/index";
describe("OAuthStateCoordinator", () => {
  it("atomically consumes state once", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-alpha");
    const record = {
      expires_at: Date.now() + 60_000,
      organization_id: "org-alpha",
      provider: "tiktok",
      redirect_path: "/channels",
      user_id: "user-alpha",
    };
    await coordinator.create("state-alpha", record);

    await expect(coordinator.consume("state-alpha")).resolves.toEqual(record);
    await expect(coordinator.consume("state-alpha")).resolves.toBeNull();
  });

  it("admits only one concurrent consume", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-concurrent");
    const record = {
      expires_at: Date.now() + 60_000,
      organization_id: "org-concurrent",
      provider: "threads",
      redirect_path: "/channels",
      user_id: "user-concurrent",
    };
    await coordinator.create("state-concurrent", record);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => coordinator.consume("state-concurrent")),
    );
    expect(results.filter((value) => value !== null)).toEqual([record]);
    expect(results.filter((value) => value === null)).toHaveLength(7);
  });

  it("retains state through consume", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-brand");
    const record = {
      expires_at: Date.now() + 60_000,
      organization_id: "org-brand",
      provider: "tiktok",
      redirect_path: "/channels",
      user_id: "user-brand",
    };
    await coordinator.create("state-brand", record);

    const consumed = await coordinator.consume("state-brand");
    expect(consumed).toEqual(record);
  });

  it("rejects already-expired state", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-expired");
    await expect(
      runInDurableObject(coordinator, (instance: OAuthStateCoordinator) =>
        instance.create("state-expired", {
          expires_at: Date.now() - 1,
          organization_id: "org-expired",
          provider: "threads",
          redirect_path: "/channels",
          user_id: "user-expired",
        }),
      ),
    ).rejects.toThrow("future expiry");
  });

  it("rejects invalid create input with a TypeError instance", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-typeerror");
    await expect(
      runInDurableObject(coordinator, (instance: OAuthStateCoordinator) =>
        instance.create("", {
          expires_at: Date.now() + 60_000,
          organization_id: "org-typeerror",
          provider: "tiktok",
          redirect_path: "/channels",
          user_id: "user-typeerror",
        }),
      ),
    ).rejects.toThrow(TypeError);
  });

  it("alarm deletes every expired record in one pass and reschedules", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-alarm");
    const liveExpiry = Date.now() + 60_000;
    const live = {
      expires_at: liveExpiry,
      organization_id: "org-alarm",
      provider: "youtube",
      redirect_path: "/channels",
      user_id: "user-live",
    };
    await coordinator.create("state-live", live);
    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const storage = ctx.storage;
        await storage.put("oauth:state-old-1", {
          ...live,
          expires_at: Date.now() - 10,
        });
        await storage.put("oauth:state-old-2", {
          ...live,
          expires_at: Date.now() - 1,
        });
        await instance.alarm();
        await expect(storage.getAlarm()).resolves.toBe(liveExpiry);
      },
    );

    await expect(coordinator.consume("state-old-1")).resolves.toBeNull();
    await expect(coordinator.consume("state-old-2")).resolves.toBeNull();
    await expect(coordinator.consume("state-live")).resolves.toEqual(live);
  });

  it("creates and retrieves public selection without leaking credentials", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-select-pub");
    const selectionId = "org-select-pub.nonce1234567890abcdef";
    await coordinator.createSelection(selectionId, {
      expires_at: Date.now() + 600_000,
      id: selectionId,
      organization_id: "org-select-pub",
      platform: "facebook",
      user_id: "user-select-pub",
    });
    await coordinator.appendSelectionCandidates(selectionId, [
      {
        account: {
          avatar_url: "https://example.com/avatar1.jpg",
          display_name: "Page One",
          id: "page-1",
          username: "pageone",
        },
        encryptedConnection: "meltiply:v2:primary:ciphertext1",
      },
      {
        account: {
          avatar_url: null,
          display_name: "Page Two",
          id: "page-2",
          username: null,
        },
        encryptedConnection: "meltiply:v2:primary:ciphertext2",
      },
    ]);
    await coordinator.finalizeSelection(selectionId);

    const publicDto = await coordinator.getSelection(selectionId, {
      organizationId: "org-select-pub",
      userId: "user-select-pub",
    });
    expect(publicDto).not.toBeNull();
    expect(publicDto?.id).toBe(selectionId);
    expect(publicDto?.platform).toBe("facebook");
    expect(publicDto?.accounts).toEqual([
      {
        avatar_url: "https://example.com/avatar1.jpg",
        display_name: "Page One",
        id: "page-1",
        username: "pageone",
      },
      {
        avatar_url: null,
        display_name: "Page Two",
        id: "page-2",
        username: null,
      },
    ]);

    const foreignOrg = await coordinator.getSelection(selectionId, {
      organizationId: "foreign-org",
      userId: "user-select-pub",
    });
    expect(foreignOrg).toBeNull();

    const foreignUser = await coordinator.getSelection(selectionId, {
      organizationId: "org-select-pub",
      userId: "foreign-user",
    });
    expect(foreignUser).toBeNull();
  });

  it("pins selected account and enforces cross-store crash invariants across retries", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-crash-invariant");
    const selectionId = "org-crash-invariant.nonce1234567890abcdef";
    await coordinator.createSelection(selectionId, {
      expires_at: Date.now() + 600_000,
      id: selectionId,
      organization_id: "org-crash-invariant",
      platform: "facebook",
      user_id: "user-crash-invariant",
    });
    await coordinator.appendSelectionCandidates(selectionId, [
      {
        account: {
          avatar_url: null,
          display_name: "Alpha Page",
          id: "page-alpha",
          username: null,
        },
        encryptedConnection: "sealed-alpha-creds",
      },
      {
        account: {
          avatar_url: null,
          display_name: "Beta Page",
          id: "page-beta",
          username: null,
        },
        encryptedConnection: "sealed-beta-creds",
      },
    ]);
    await coordinator.finalizeSelection(selectionId);

    const unlisted = await coordinator.claimSelection(
      selectionId,
      "page-unknown",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-crash-invariant",
        userId: "user-crash-invariant",
      },
      "idem-key-1",
    );
    expect(unlisted.status).toBe("invalid_account");

    const claim1 = await coordinator.claimSelection(
      selectionId,
      "page-alpha",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-crash-invariant",
        userId: "user-crash-invariant",
      },
      "idem-key-1",
    );
    expect(claim1.status).toBe("claimed");
    if (claim1.status !== "claimed") throw new Error("Expected claimed");
    expect(claim1.encryptedConnection).toBe("sealed-alpha-creds");

    const concurrent = await coordinator.claimSelection(
      selectionId,
      "page-alpha",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-crash-invariant",
        userId: "user-crash-invariant",
      },
      "idem-key-2",
    );
    expect(concurrent.status).toBe("conflict");
    if (concurrent.status === "conflict") {
      expect(concurrent.code).toBe("claim_active");
    }

    const cancelBusy = await coordinator.cancelSelection(
      selectionId,
      {
        organizationId: "org-crash-invariant",
        userId: "user-crash-invariant",
      },
      "idem-cancel",
    );
    expect(cancelBusy.status).toBe("conflict");

    const released = await coordinator.releaseSelectionClaim(selectionId, claim1.claimToken);
    expect(released).toBe(true);

    const switched = await coordinator.claimSelection(
      selectionId,
      "page-beta",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-crash-invariant",
        userId: "user-crash-invariant",
      },
      "idem-key-retry",
    );
    expect(switched.status).toBe("conflict");
    if (switched.status === "conflict") {
      expect(switched.code).toBe("pinned_account_mismatch");
    }

    const retryClaim = await coordinator.claimSelection(
      selectionId,
      "page-alpha",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-crash-invariant",
        userId: "user-crash-invariant",
      },
      "idem-key-retry",
    );
    expect(retryClaim.status).toBe("claimed");
    if (retryClaim.status !== "claimed") throw new Error("Expected claimed");

    const completed = await coordinator.completeSelection(
      selectionId,
      "page-alpha",
      retryClaim.claimToken,
      "idem-key-retry",
    );
    expect(completed).toBe(true);

    const replay = await coordinator.claimSelection(
      selectionId,
      "page-alpha",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-crash-invariant",
        userId: "user-crash-invariant",
      },
      "idem-key-retry",
    );
    expect(replay.status).toBe("replayed");

    const replayMismatch = await coordinator.claimSelection(
      selectionId,
      "page-alpha",
      {
        organizationId: "org-crash-invariant",
        brandProfileId: "profile-alpha",
        userId: "user-crash-invariant",
      },
      "different-key",
    );
    expect(replayMismatch.status).toBe("conflict");
    const changedProfile = await coordinator.claimSelection(
      selectionId,
      "page-alpha",
      {
        brandProfileId: "profile-beta",
        organizationId: "org-crash-invariant",
        userId: "user-crash-invariant",
      },
      "idem-key-retry",
    );
    expect(changedProfile.status).toBe("conflict");
  });

  it("rejects cancellation when claim lease has expired but save is unreleased (stale lease fence)", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-stale-fence");
    const selectionId = "org-stale-fence.nonce1234567890abcdef";
    await coordinator.createSelection(selectionId, {
      expires_at: Date.now() + 600_000,
      id: selectionId,
      organization_id: "org-stale-fence",
      platform: "facebook",
      user_id: "user-stale-fence",
    });
    await coordinator.appendSelectionCandidates(selectionId, [
      {
        account: {
          avatar_url: null,
          display_name: "Fenced Page",
          id: "page-fenced",
          username: null,
        },
        encryptedConnection: "sealed-fenced-creds",
      },
    ]);
    await coordinator.finalizeSelection(selectionId);

    const claim = await coordinator.claimSelection(
      selectionId,
      "page-fenced",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-stale-fence",
        userId: "user-stale-fence",
      },
      "idem-stale",
    );
    expect(claim.status).toBe("claimed");

    await runInDurableObject(
      coordinator,
      async (_instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const storage = ctx.storage;
        const stored = await storage.get<OAuthSelectionRecord>(`selection:${selectionId}`);
        if (stored && stored.claim) {
          await storage.put(`selection:${selectionId}`, {
            ...stored,
            claim: {
              ...stored.claim,
              expires_at: Date.now() - 100,
            },
          });
        }
      },
    );

    const cancelStale = await coordinator.cancelSelection(
      selectionId,
      { organizationId: "org-stale-fence", userId: "user-stale-fence" },
      "idem-cancel",
    );
    expect(cancelStale.status).toBe("conflict");
    if (cancelStale.status === "conflict") {
      expect(cancelStale.message).toContain("in progress");
    }

    const changedProfile = await coordinator.claimSelection(
      selectionId,
      "page-fenced",
      {
        brandProfileId: "profile-beta",
        organizationId: "org-stale-fence",
        userId: "user-stale-fence",
      },
      "idem-other-profile",
    );
    expect(changedProfile).toMatchObject({ status: "conflict", code: "pinned_profile_mismatch" });
    const retryClaim = await coordinator.claimSelection(
      selectionId,
      "page-fenced",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-stale-fence",
        userId: "user-stale-fence",
      },
      "idem-stale-retry",
    );
    expect(retryClaim.status).toBe("claimed");
  });

  it("enforces the original ticket deadline while permitting bounded late completion", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-near-expiry");
    const selectionId = "org-near-expiry.nonce1234567890abcdef";
    const expiry = Date.now() + 60_000;
    await coordinator.createSelection(selectionId, {
      expires_at: expiry,
      id: selectionId,
      organization_id: "org-near-expiry",
      platform: "facebook",
      user_id: "user-near-expiry",
    });
    const candidates: OAuthSelectionCandidate[] = [];
    for (let i = 0; i < 130; i++) {
      candidates.push({
        account: {
          avatar_url: null,
          display_name: `Edge Page ${i}`,
          id: `page-edge-${i}`,
          username: null,
        },
        encryptedConnection: `sealed-edge-creds-${i}`,
      });
    }
    await coordinator.appendSelectionCandidates(selectionId, candidates);
    await coordinator.finalizeSelection(selectionId);

    const claim = await coordinator.claimSelection(
      selectionId,
      "page-edge-7",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-near-expiry",
        userId: "user-near-expiry",
      },
      "idem-edge",
    );
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("Expected claimed");

    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const storage = ctx.storage;
        const stored = await storage.get<OAuthSelectionRecord>(`selection:${selectionId}`);
        expect(stored?.expires_at).toBe(expiry);
        await storage.put(`selection:${selectionId}`, {
          ...stored!,
          expires_at: Date.now() - 100,
        });
        await instance.alarm();
        const metadata = await storage.list({
          prefix: `selection-account:${selectionId}:`,
        });
        const credentials = await storage.list({
          prefix: `selection-credential:${selectionId}:`,
        });
        expect(metadata.size).toBe(0);
        expect(credentials.size).toBe(0);
        const stripped = await storage.get<OAuthSelectionRecord>(`selection:${selectionId}`);
        expect(stripped).toBeDefined();
        expect(stripped?.account_ids).toEqual([]);
        expect(stripped?.claim?.token).toBe(claim.claimToken);
        expect(stripped?.pinned_account_id).toBe("page-edge-7");
      },
    );

    const reclaim = await coordinator.claimSelection(
      selectionId,
      "page-edge-7",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-near-expiry",
        userId: "user-near-expiry",
      },
      "idem-edge-retry",
    );
    expect(reclaim.status).toBe("not_found");

    const cancel = await coordinator.cancelSelection(
      selectionId,
      { organizationId: "org-near-expiry", userId: "user-near-expiry" },
      "idem-cancel",
    );
    expect(cancel.status).toBe("conflict");

    const completed = await coordinator.completeSelection(
      selectionId,
      "page-edge-7",
      claim.claimToken,
      "idem-edge",
    );
    expect(completed).toBe(true);
    const afterComplete = await coordinator.getSelection(selectionId, {
      organizationId: "org-near-expiry",
      userId: "user-near-expiry",
    });
    expect(afterComplete).toBeNull();

    const replay = await coordinator.claimSelection(
      selectionId,
      "page-edge-7",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-near-expiry",
        userId: "user-near-expiry",
      },
      "idem-edge",
    );
    expect(replay.status).toBe("replayed");

    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const storage = ctx.storage;
        const stored = await storage.get<OAuthSelectionRecord>(`selection:${selectionId}`);
        await storage.put(`selection:${selectionId}`, {
          ...stored!,
          evidence_expires_at: Date.now() - 1,
        });
        const expiredReplay = await instance.claimSelection(
          selectionId,
          "page-edge-7",
          {
            brandProfileId: "profile-alpha",
            organizationId: "org-near-expiry",
            userId: "user-near-expiry",
          },
          "idem-edge",
        );
        expect(expiredReplay.status).toBe("not_found");
        await instance.alarm();
        const gone = await storage.get<OAuthSelectionRecord>(`selection:${selectionId}`);
        expect(gone).toBeUndefined();
      },
    );
    const late = await coordinator.claimSelection(
      selectionId,
      "page-edge-7",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-near-expiry",
        userId: "user-near-expiry",
      },
      "idem-edge",
    );
    expect(late.status).toBe("not_found");
  });

  it("expires interrupted initialization and partially appended candidates", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-interrupted");
    const selectionId = "org-interrupted.nonce1234567890abcdef";
    await coordinator.createSelection(selectionId, {
      expires_at: Date.now() + 600_000,
      id: selectionId,
      organization_id: "org-interrupted",
      platform: "facebook",
      user_id: "user-interrupted",
    });
    await runInDurableObject(
      coordinator,
      async (_instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const storage = ctx.storage;
        await storage.put({
          [`selection-account:${selectionId}:partial-1`]: {
            avatar_url: null,
            display_name: "Partial 1",
            id: "partial-1",
            username: null,
          },
          [`selection-credential:${selectionId}:partial-1`]: {
            encrypted_connection: "orphaned-ciphertext",
          },
        });
        const stored = await storage.get<OAuthSelectionRecord>(`selection:${selectionId}`);
        await storage.put(`selection:${selectionId}`, {
          ...stored!,
          expires_at: Date.now() - 1,
        });
        await _instance.alarm();
        expect(await storage.get<OAuthSelectionRecord>(`selection:${selectionId}`)).toBeUndefined();
        expect((await storage.list({ prefix: `selection-account:${selectionId}:` })).size).toBe(0);
        expect(
          (
            await storage.list({
              prefix: `selection-credential:${selectionId}:`,
            })
          ).size,
        ).toBe(0);
      },
    );
    const after = await coordinator.getSelection(selectionId, {
      organizationId: "org-interrupted",
      userId: "user-interrupted",
    });
    expect(after).toBeNull();
  });

  it("stores, lists, claims, completes, and cancels large candidate sets without oversized storage ops", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-large-scale");
    const selectionId = "org-large-scale.nonce1234567890abcdef";
    await coordinator.createSelection(selectionId, {
      expires_at: Date.now() + 600_000,
      id: selectionId,
      organization_id: "org-large-scale",
      platform: "facebook",
      user_id: "user-large-scale",
    });

    const largePayload = "X".repeat(20_000);
    const buildBatch = (from: number, to: number): OAuthSelectionCandidate[] => {
      const batch: OAuthSelectionCandidate[] = [];
      for (let i = from; i < to; i++) {
        batch.push({
          account: {
            avatar_url: `https://example.com/avatar/${i}.png`,
            display_name: `Page ${i}`,
            id: `page-${i}`,
            username: `page_${i}`,
          },
          encryptedConnection: largePayload,
        });
      }
      return batch;
    };
    await coordinator.appendSelectionCandidates(selectionId, buildBatch(0, 65));
    await coordinator.appendSelectionCandidates(selectionId, buildBatch(65, 130));
    await coordinator.finalizeSelection(selectionId);

    const publicDto = await coordinator.getSelection(selectionId, {
      organizationId: "org-large-scale",
      userId: "user-large-scale",
    });
    expect(publicDto?.accounts).toHaveLength(130);

    const claim = await coordinator.claimSelection(
      selectionId,
      "page-85",
      {
        brandProfileId: "profile-alpha",
        organizationId: "org-large-scale",
        userId: "user-large-scale",
      },
      "idem-large",
    );
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("Expected claimed");
    expect(claim.encryptedConnection).toBe(largePayload);

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
            instance.completeSelection(selectionId, "page-85", claim.claimToken, "idem-large"),
          ).rejects.toMatchObject({ _tag: "OAuthStateStorageError" });
        } finally {
          failure.mockRestore();
        }
        const recovered = await instance.getSelection(selectionId, {
          organizationId: "org-large-scale",
          userId: "user-large-scale",
        });
        expect(recovered?.accounts).toHaveLength(130);
      },
    );
    const completed = await coordinator.completeSelection(
      selectionId,
      "page-85",
      claim.claimToken,
      "idem-large",
    );
    expect(completed).toBe(true);
    await runInDurableObject(
      coordinator,
      async (_instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        expect(
          (
            await ctx.storage.list({
              prefix: `selection-account:${selectionId}:`,
            })
          ).size,
        ).toBe(0);
        expect(
          (
            await ctx.storage.list({
              prefix: `selection-credential:${selectionId}:`,
            })
          ).size,
        ).toBe(0);
      },
    );

    const cancelId = "org-large-scale.cancelled1234567890";
    await coordinator.createSelection(cancelId, {
      expires_at: Date.now() + 600_000,
      id: cancelId,
      organization_id: "org-large-scale",
      platform: "facebook",
      user_id: "user-large-scale",
    });
    await coordinator.appendSelectionCandidates(cancelId, buildBatch(0, 65));
    await coordinator.appendSelectionCandidates(cancelId, buildBatch(65, 130));
    await coordinator.finalizeSelection(cancelId);
    const cancelled = await coordinator.cancelSelection(
      cancelId,
      { organizationId: "org-large-scale", userId: "user-large-scale" },
      "idem-large-cancel",
    );
    expect(cancelled.status).toBe("cancelled");
    await runInDurableObject(
      coordinator,
      async (_instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        expect(
          (
            await ctx.storage.list({
              prefix: `selection-account:${cancelId}:`,
            })
          ).size,
        ).toBe(0);
        expect(
          (
            await ctx.storage.list({
              prefix: `selection-credential:${cancelId}:`,
            })
          ).size,
        ).toBe(0);
      },
    );
  });

  it("cancels an in-flight selection and wipes candidate credential entries", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-cancel");
    const selectionId = "org-cancel.nonce1234567890abcdef";
    await coordinator.createSelection(selectionId, {
      expires_at: Date.now() + 600_000,
      id: selectionId,
      organization_id: "org-cancel",
      platform: "facebook",
      user_id: "user-cancel",
    });
    await coordinator.appendSelectionCandidates(selectionId, [
      {
        account: {
          avatar_url: null,
          display_name: "Page X",
          id: "page-x",
          username: null,
        },
        encryptedConnection: "secret-credentials-to-delete",
      },
    ]);
    await coordinator.finalizeSelection(selectionId);

    const foreignCancel = await coordinator.cancelSelection(
      selectionId,
      { organizationId: "other-org", userId: "user-cancel" },
      "idem-cancel",
    );
    expect(foreignCancel.status).toBe("not_found");

    const cancelled = await coordinator.cancelSelection(
      selectionId,
      { organizationId: "org-cancel", userId: "user-cancel" },
      "idem-cancel",
    );
    expect(cancelled.status).toBe("cancelled");

    const afterCancel = await coordinator.getSelection(selectionId, {
      organizationId: "org-cancel",
      userId: "user-cancel",
    });
    expect(afterCancel).toBeNull();

    const repeatCancel = await coordinator.cancelSelection(
      selectionId,
      { organizationId: "org-cancel", userId: "user-cancel" },
      "idem-cancel",
    );
    expect(repeatCancel.status).toBe("cancelled");
  });

  it("alarm sweeps both expired OAuth state and selection entries", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-combined-alarm");
    const now = Date.now();

    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const storage = ctx.storage;
        await storage.put("oauth:state-expired", {
          expires_at: now - 100,
          organization_id: "org-combined-alarm",
          provider: "facebook",
          redirect_path: "/channels",
          user_id: "u1",
        });
        await storage.put("selection:sel-expired", {
          account_ids: [],
          expires_at: now - 50,
          id: "sel-expired",
          organization_id: "org-combined-alarm",
          platform: "facebook",
          ready: true,
          status: "pending",
          user_id: "u1",
        });
        await storage.put("selection:sel-live", {
          account_ids: [],
          expires_at: now + 50_000,
          id: "sel-live",
          organization_id: "org-combined-alarm",
          platform: "facebook",
          ready: true,
          status: "pending",
          user_id: "u1",
        });
        await instance.alarm();
      },
    );

    await expect(coordinator.consume("state-expired")).resolves.toBeNull();
    await runInDurableObject(
      coordinator,
      async (_instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        await expect(ctx.storage.get("selection:sel-expired")).resolves.toBeUndefined();
      },
    );
    const publicLive = await coordinator.getSelection("sel-live", {
      organizationId: "org-combined-alarm",
      userId: "u1",
    });
    expect(publicLive).not.toBeNull();
  });

  it("executes consume inside storage.transaction so read and delete cannot interleave", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-consume-tx");
    const record = {
      expires_at: Date.now() + 60_000,
      organization_id: "org-consume-tx",
      provider: "tiktok",
      redirect_path: "/channels",
      user_id: "user-consume-tx",
    };
    await coordinator.create("state-tx", record);

    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const txSpy = vi.spyOn(ctx.storage, "transaction");
        try {
          await expect(instance.consume("state-tx")).resolves.toEqual(record);
          expect(txSpy).toHaveBeenCalledTimes(1);
          await expect(instance.consume("state-tx")).resolves.toBeNull();
          expect(txSpy).toHaveBeenCalledTimes(2);
        } finally {
          txSpy.mockRestore();
        }
      },
    );
  });

  it("paginates candidate deletion via startAfter across >1000 keys", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-paginated-delete");
    const selectionId = "org-paginated-delete.nonce1234567890";
    await coordinator.createSelection(selectionId, {
      expires_at: Date.now() + 600_000,
      id: selectionId,
      organization_id: "org-paginated-delete",
      platform: "facebook",
      user_id: "user-paginated-delete",
    });

    const totalCandidates = 600;
    const batchSize = 100;
    for (let start = 0; start < totalCandidates; start += batchSize) {
      const batch: OAuthSelectionCandidate[] = [];
      for (let i = start; i < start + batchSize; i++) {
        const id = `acct-${String(i).padStart(4, "0")}`;
        batch.push({
          account: {
            avatar_url: null,
            display_name: `Account ${i}`,
            id,
            username: null,
          },
          encryptedConnection: `sealed-${i}`,
        });
      }
      await coordinator.appendSelectionCandidates(selectionId, batch);
    }
    await coordinator.finalizeSelection(selectionId);

    await runInDurableObject(
      coordinator,
      async (instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const listSpy = vi.spyOn(ctx.storage, "list");
        try {
          const cancelled = await instance.cancelSelection(
            selectionId,
            { organizationId: "org-paginated-delete", userId: "user-paginated-delete" },
            "idem-paginated-cancel",
          );
          expect(cancelled.status).toBe("cancelled");

          const cleanupCalls = listSpy.mock.calls
            .map(([options]) => options)
            .filter((options) => options?.prefix === `selection-account:${selectionId}:`);
          expect(cleanupCalls).toHaveLength(5);
          expect(cleanupCalls[0]?.limit).toBe(128);
          expect(cleanupCalls[0]?.startAfter).toBeUndefined();
          for (let page = 1; page < cleanupCalls.length; page++) {
            expect(cleanupCalls[page]?.limit).toBe(128);
            expect(cleanupCalls[page]?.startAfter).toMatch(
              new RegExp(`^selection-account:${selectionId}:acct-\\d{4}$`),
            );
          }
        } finally {
          listSpy.mockRestore();
        }

        expect((await ctx.storage.list({ prefix: `selection-account:${selectionId}:` })).size).toBe(
          0,
        );
        expect(
          (await ctx.storage.list({ prefix: `selection-credential:${selectionId}:` })).size,
        ).toBe(0);
      },
    );
  });

  it("rejects duplicate candidate account IDs and >1000-account appends before writing entries", async () => {
    const coordinator = env.OAUTH_STATE.getByName("org-dedupe-candidates");
    const selectionId = "org-dedupe-candidates.nonce1234567890";
    await coordinator.createSelection(selectionId, {
      expires_at: Date.now() + 600_000,
      id: selectionId,
      organization_id: "org-dedupe-candidates",
      platform: "facebook",
      user_id: "user-dedupe-candidates",
    });

    const candidate = (id: string, secret: string): OAuthSelectionCandidate => ({
      account: {
        avatar_url: null,
        display_name: `Page ${id}`,
        id,
        username: null,
      },
      encryptedConnection: secret,
    });

    await expect(
      runInDurableObject(coordinator, (instance: OAuthStateCoordinator) =>
        instance.appendSelectionCandidates(selectionId, [
          candidate("dup-1", "secret-a"),
          candidate("dup-1", "secret-b"),
        ]),
      ),
    ).rejects.toThrow(TypeError);

    await runInDurableObject(
      coordinator,
      async (_instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        expect((await ctx.storage.list({ prefix: `selection-account:${selectionId}:` })).size).toBe(
          0,
        );
        expect(
          (await ctx.storage.list({ prefix: `selection-credential:${selectionId}:` })).size,
        ).toBe(0);
      },
    );

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
        const record = await ctx.storage.get<OAuthSelectionRecord>(`selection:${selectionId}`);
        expect(record?.account_ids).toEqual(["page-1"]);
        expect(await ctx.storage.get(`selection-credential:${selectionId}:page-1`)).toEqual({
          encrypted_connection: "secret-1",
        });
        expect(await ctx.storage.get(`selection-account:${selectionId}:page-2`)).toBeUndefined();
      },
    );

    const overflowingBatch: OAuthSelectionCandidate[] = [];
    for (let i = 0; i < 1000; i++) {
      overflowingBatch.push(candidate(`overflow-${i}`, `secret-overflow-${i}`));
    }
    await expect(
      runInDurableObject(coordinator, (instance: OAuthStateCoordinator) =>
        instance.appendSelectionCandidates(selectionId, overflowingBatch),
      ),
    ).rejects.toThrow("1000");

    await runInDurableObject(
      coordinator,
      async (_instance: OAuthStateCoordinator, ctx: DurableObjectState) => {
        const record = await ctx.storage.get<OAuthSelectionRecord>(`selection:${selectionId}`);
        expect(record?.account_ids).toEqual(["page-1"]);
        expect((await ctx.storage.list({ prefix: `selection-account:${selectionId}:` })).size).toBe(
          1,
        );
        expect(
          (await ctx.storage.list({ prefix: `selection-credential:${selectionId}:` })).size,
        ).toBe(1);
      },
    );
  });
});
describe("OAuthState Effect programs", () => {
  it("validates creation input without touching storage", async () => {
    const record = {
      expires_at: Date.now() + 60_000,
      organization_id: "org-effect",
      provider: "tiktok",
      redirect_path: "/channels",
      user_id: "user-effect",
    };
    await expect(
      Effect.runPromise(validateOAuthStateCreateEffect("state-ok", record)),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(validateOAuthStateCreateEffect("", record)),
    ).rejects.toMatchObject({ _tag: "InvalidOAuthStateError" });
    await expect(
      Effect.runPromise(
        validateOAuthStateCreateEffect("state-old", {
          ...record,
          expires_at: Date.now() - 1,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "InvalidOAuthStateError" });
  });

  it("validates selection creation input without touching storage", async () => {
    const validInit: OAuthSelectionInit = {
      expires_at: Date.now() + 60_000,
      id: "routing.nonce1234567890",
      organization_id: "org-1",
      platform: "facebook",
      user_id: "user-1",
    };

    await expect(
      Effect.runPromise(validateOAuthSelectionCreateEffect("routing.nonce1234567890", validInit)),
    ).resolves.toBeUndefined();

    await expect(
      Effect.runPromise(validateOAuthSelectionCreateEffect("short", validInit)),
    ).rejects.toMatchObject({ _tag: "InvalidOAuthStateError" });

    await expect(
      Effect.runPromise(
        validateOAuthSelectionCreateEffect("routing.nonce1234567890", {
          ...validInit,
          expires_at: Date.now() - 1,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "InvalidOAuthStateError" });
  });
});
