import { DatabaseError } from "@meltiply/domain";
import type { OAuthConnection } from "@meltiply/providers";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { CoreApiError } from "../src/core-types";
import type { ApiWorkerEnv } from "../src/env";
import { saveOAuthConnectionEffect } from "../src/oauth-connection";
import {
  createFakeOAuthConnectionRepository,
  FakeOAuthConnectionStore,
} from "../src/repositories/oauth-connection-repository";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const primaryKey = "0123456789abcdef0123456789abcdef";
const env = { TOKEN_ENCRYPTION_KEY: primaryKey } as ApiWorkerEnv;

const owner = {
  brandProfileId: "00000000-0000-4000-8000-000000000111",
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "user-1",
};

const connection: OAuthConnection = {
  accessToken: "provider-access-token",
  account: { displayName: "Creator", id: "provider-account" },
  expiresAt: "2027-01-01T00:00:00.000Z",
  refreshToken: "provider-refresh-token",
  scopes: ["publish", "read", "publish"],
};

function setup() {
  const store = new FakeOAuthConnectionStore();
  store.organizations.add(owner.organizationId);
  store.members.add(store.memberKey(owner.organizationId, owner.userId));
  store.brandProfiles.set(owner.brandProfileId, {
    deletedAt: null,
    organizationId: owner.organizationId,
  });
  const repository = createFakeOAuthConnectionRepository(store);
  const save = (
    input: OAuthConnection = connection,
    targetOwner = owner,
    platform: "threads" | "youtube" = "threads",
  ) =>
    saveOAuthConnectionEffect(env, platform, targetOwner, input, {
      now: () => NOW,
      repository,
    });
  return { save, store };
}

describe("saveOAuthConnectionEffect", () => {
  it("encrypts tokens, sorts deduplicated scopes, and arms refresh 7 days before expiry", async () => {
    const { save, store } = setup();

    await Effect.runPromise(save());

    expect(store.accounts).toHaveLength(1);
    expect(store.accounts[0]).toMatchObject({
      brandProfileId: owner.brandProfileId,
      displayName: "Creator",
      encryptedAccessToken: expect.stringMatching(/^meltiply:v2:primary:/),
      encryptedRefreshToken: expect.stringMatching(/^meltiply:v2:primary:/),
      organizationId: owner.organizationId,
      platform: "threads",
      platformUserId: "provider-account",
      scopes: ["publish", "read"],
      tokenRefreshNextAttemptAt: new Date("2026-12-25T00:00:00.000Z"),
    });
  });

  it("leaves tokenRefreshNextAttemptAt null when the grant has no expiry", async () => {
    const { save, store } = setup();

    await Effect.runPromise(save({ ...connection, expiresAt: undefined }));

    expect(store.accounts[0]?.tokenRefreshNextAttemptAt).toEqual(null);
  });

  it("floors tokenRefreshNextAttemptAt to one hour from now for short-lived grants", async () => {
    const { save, store } = setup();

    await Effect.runPromise(save({ ...connection, expiresAt: "2026-06-02T00:00:00.000Z" }));

    expect(store.accounts[0]?.tokenRefreshNextAttemptAt).toEqual(
      new Date("2026-06-01T01:00:00.000Z"),
    );
  });

  it("reconnects an existing account on the same Brand Profile and preserves stored refresh token", async () => {
    const { save, store } = setup();
    await Effect.runPromise(save());
    const originalRefresh = store.accounts[0]?.encryptedRefreshToken;

    await Effect.runPromise(save({ ...connection, refreshToken: undefined }));

    expect(store.accounts).toHaveLength(1);
    expect(store.accounts[0]?.encryptedRefreshToken).toEqual(originalRefresh);
  });

  it("rejects a second Channel of the same Provider on one Brand Profile", async () => {
    const { save, store } = setup();
    await Effect.runPromise(save());

    const error = await Effect.runPromise(
      Effect.flip(
        save({ ...connection, account: { displayName: "Second", id: "provider-account-2" } }),
      ),
    );

    expect(error).toEqual(
      new CoreApiError(
        409,
        "invalid_state",
        "This Brand Profile is already connected to a threads Channel. Disconnect it before connecting another.",
      ),
    );
    expect(store.accounts).toHaveLength(1);
  });

  it("rejects connecting an account already attached to another Brand Profile", async () => {
    const { save, store } = setup();
    const otherProfileId = "00000000-0000-4000-8000-000000000222";
    store.brandProfiles.set(otherProfileId, {
      deletedAt: null,
      organizationId: owner.organizationId,
    });
    await Effect.runPromise(save());

    const error = await Effect.runPromise(
      Effect.flip(save(connection, { ...owner, brandProfileId: otherProfileId })),
    );

    expect(error).toEqual(
      new CoreApiError(
        409,
        "invalid_state",
        "This platform account is already connected. Disconnect it before connecting it to another brand profile.",
      ),
    );
  });

  it("rejects when the organization is missing", async () => {
    const { save, store } = setup();
    store.organizations.clear();

    expect(await Effect.runPromise(Effect.flip(save()))).toEqual(
      new CoreApiError(409, "invalid_state", "The OAuth organization is no longer available."),
    );
  });

  it("rejects when the user is not a member of the organization", async () => {
    const { save, store } = setup();
    store.members.clear();

    expect(await Effect.runPromise(Effect.flip(save()))).toEqual(
      new CoreApiError(
        403,
        "forbidden",
        "The OAuth organization is not accessible to this account.",
      ),
    );
  });

  it("rejects a deleted Brand Profile", async () => {
    const { save, store } = setup();
    store.brandProfiles.set(owner.brandProfileId, {
      deletedAt: NOW.toISOString(),
      organizationId: owner.organizationId,
    });

    expect(await Effect.runPromise(Effect.flip(save()))).toEqual(
      new CoreApiError(
        409,
        "brand_profile_deleted",
        "The brand profile is deleted and cannot accept new data.",
      ),
    );
  });

  it("rolls back on commit failure", async () => {
    const { save, store } = setup();
    const down = new DatabaseError({ message: "commit failed" });
    store.nextCommitFailure = down;

    expect(await Effect.runPromise(Effect.flip(save()))).toEqual(down);
    expect(store.accounts).toEqual([]);
  });
});
