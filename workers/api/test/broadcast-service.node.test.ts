import {
  classifyProviderFailure,
  createProviderServiceLive,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderAdapter,
} from "@meltiply/providers";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { createApiApp } from "../src/app";
import { broadcastControlEffect } from "../src/broadcast-service";
import { CoreApiError } from "../src/api-errors";
import type { ApiWorkerEnv } from "../src/env";
import {
  createFakeBroadcastRepository,
  FakeBroadcastStore,
  type BroadcastRow,
} from "../src/repositories/broadcast-repository";
import { tokenCipherFor } from "../src/token-credentials";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const distributionId = "00000000-0000-4000-8000-000000000701";
const orgId = "00000000-0000-4000-8000-000000000001";
const env = {
  APP_URL: "http://localhost:3000",
  ENVIRONMENT: "test",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "test",
} satisfies ApiWorkerEnv;

const session = {
  organizationId: orgId,
  organizationRole: "editor",
  subject: "broadcast-writer",
  userId: "00000000-0000-4000-8000-000000000011",
};

async function broadcastRow(patch: Partial<BroadcastRow> = {}): Promise<BroadcastRow> {
  return {
    access_token: await tokenCipherFor(env).encrypt("provider-access-token"),
    connection_status: "connected",
    org_id: orgId,
    platform: "youtube",
    platform_user_id: "channel-one",
    provider_operation_id: "live:broadcast-one",
    revoked_at: null,
    role: "editor",
    token_expires_at: null,
    ...patch,
  };
}

function registryWith(overrides: Partial<ProviderAdapter> = {}) {
  const registry = new ProviderRegistry();
  registry.register("youtube", {
    capability: {
      accepted_mime_types: [],
      analytics: false,
      asset_types: [],
      comments: false,
      connect_available: false,
      max_caption_length: null,
      max_file_size: null,
      max_hashtags: null,
      max_media_count: null,
      max_video_duration_sec: null,
      min_media_count: 0,
      multi_asset_types: [],
      notes: [],
      platform: "youtube",
      publish: false,
      reply: false,
    },
    transferModes: [],
    ...overrides,
  });
  return registry;
}

function runControl(
  store: FakeBroadcastStore,
  action: { kind: "read" } | { kind: "end"; key: string },
  adapterOverrides: Partial<ProviderAdapter> = {},
) {
  return Effect.runPromise(
    Effect.provide(
      broadcastControlEffect(env, session, distributionId, "req-1", action, {
        now: () => NOW,
        repository: createFakeBroadcastRepository(store),
      }),
      createProviderServiceLive(registryWith(adapterOverrides)),
    ),
  );
}

function failControl(
  store: FakeBroadcastStore,
  action: { kind: "read" } | { kind: "end"; key: string },
  adapterOverrides: Partial<ProviderAdapter> = {},
) {
  return Effect.runPromise(
    Effect.flip(
      Effect.provide(
        broadcastControlEffect(env, session, distributionId, "req-1", action, {
          now: () => NOW,
          repository: createFakeBroadcastRepository(store),
        }),
        createProviderServiceLive(registryWith(adapterOverrides)),
      ),
    ),
  );
}

describe("broadcastControlEffect", () => {
  it("denies a database-derived Viewer role before decrypting credentials or contacting Provider", async () => {
    const store = new FakeBroadcastStore();
    store.rows.set(
      distributionId,
      await broadcastRow({ access_token: "meltiply:v2:primary:invalid", role: "viewer" }),
    );
    let providerCalls = 0;

    const error = await failControl(
      store,
      { kind: "read" },
      {
        getBroadcastInfo: async () => {
          providerCalls += 1;
          throw new Error("should not call");
        },
      },
    );

    expect(error).toEqual(
      new CoreApiError(
        403,
        "forbidden_role",
        "Your Workspace role cannot access encoder credentials.",
      ),
    );
    expect(providerCalls).toEqual(0);
  });

  it("returns 404 for a missing or invisible Distribution", async () => {
    const store = new FakeBroadcastStore();

    expect(await failControl(store, { kind: "read" })).toEqual(
      new CoreApiError(404, "not_found", "The broadcast was not found."),
    );
  });

  it.each([
    [
      "non-live upload",
      { provider_operation_id: "video:ordinary-upload" },
      new CoreApiError(422, "invalid_state", "This Distribution is not a live broadcast."),
    ],
    [
      "revoked channel",
      { revoked_at: "2026-01-01T00:00:00Z" },
      new CoreApiError(
        409,
        "invalid_state",
        "Reconnect this Channel before controlling the broadcast.",
      ),
    ],
    [
      "disconnected channel",
      { connection_status: "disconnected" },
      new CoreApiError(
        409,
        "invalid_state",
        "Reconnect this Channel before controlling the broadcast.",
      ),
    ],
    [
      "expired token",
      { token_expires_at: "2020-01-01T00:00:00Z" },
      new CoreApiError(
        409,
        "invalid_state",
        "Reconnect this Channel before controlling the broadcast.",
      ),
    ],
  ] as const)(
    "rejects ineligible state (%s) before decrypting",
    async (_example, patch, expected) => {
      const store = new FakeBroadcastStore();
      store.rows.set(
        distributionId,
        await broadcastRow({ ...patch, access_token: "meltiply:v2:primary:invalid" }),
      );
      let providerCalls = 0;

      const error = await failControl(
        store,
        { kind: "read" },
        {
          getBroadcastInfo: async () => {
            providerCalls += 1;
            throw new Error("should not call");
          },
        },
      );

      expect(error).toEqual(expected);
      expect(providerCalls).toEqual(0);
    },
  );

  it("returns broadcast details and records published provider post metadata on read", async () => {
    const store = new FakeBroadcastStore();
    store.rows.set(distributionId, await broadcastRow());
    const info = {
      ingestUrl: "rtmps://example.test/live",
      providerPostId: "live-publication",
      providerUrl: "https://youtu.be/live-publication",
      state: "live" as const,
      streamKey: "encoder-secret",
    };

    expect(
      await runControl(store, { kind: "read" }, { getBroadcastInfo: async () => info }),
    ).toEqual(info);
    expect(store.readUpdates).toEqual([
      {
        distributionId,
        providerPostId: "live-publication",
        providerUrl: "https://youtu.be/live-publication",
      },
    ]);
  });

  it("fails with 503 dependency_unavailable when credentials cannot be decrypted", async () => {
    const store = new FakeBroadcastStore();
    store.rows.set(
      distributionId,
      await broadcastRow({ access_token: "meltiply:v2:primary:invalid" }),
    );

    expect(await failControl(store, { kind: "read" })).toEqual(
      new CoreApiError(
        503,
        "dependency_unavailable",
        "Platform credentials are temporarily unavailable.",
      ),
    );
  });

  it("sanitizes Provider read failures without leaking credential diagnostics", async () => {
    const store = new FakeBroadcastStore();
    store.rows.set(distributionId, await broadcastRow());

    const error = await failControl(
      store,
      { kind: "read" },
      {
        getBroadcastInfo: async () => {
          throw new ProviderAdapterError({
            ...classifyProviderFailure({ status: 400 }),
            message: "Sensitive provider-access-token and encoder-secret",
          });
        },
      },
    );

    expect(error).toEqual(
      new CoreApiError(
        502,
        "provider_unavailable",
        "The broadcast details could not be retrieved.",
      ),
    );
  });

  it("ends once and replays completed history even after the Channel disconnects", async () => {
    const store = new FakeBroadcastStore();
    store.rows.set(distributionId, await broadcastRow());
    let endCalls = 0;
    const endBroadcast: NonNullable<ProviderAdapter["endBroadcast"]> = async () => {
      endCalls += 1;
      return {
        outcome: "confirmed_success",
        providerOperationId: "live:broadcast-one",
        providerPostId: "recorded-broadcast",
        providerUrl: "https://youtu.be/recorded-broadcast",
      };
    };

    expect(await runControl(store, { key: "first-key", kind: "end" }, { endBroadcast })).toEqual({
      ended: true,
    });

    store.rows.set(
      distributionId,
      await broadcastRow({
        access_token: "meltiply:v2:primary:invalid",
        connection_status: "disconnected",
      }),
    );

    expect(
      await runControl(store, { key: "different-http-key", kind: "end" }, { endBroadcast }),
    ).toEqual({ ended: true });
    expect(endCalls).toEqual(1);
    expect(store.endCompletions).toHaveLength(1);
  });

  it.each([
    [
      "pending reservation",
      "371d09f890c435d5b299e8b0b08903ce39726f3273a23fb15dcb5520a9f466d8",
      null,
      "idempotency_in_progress",
    ],
    ["conflicting reservation", "unrelated-hash", 200, "idempotency_conflict"],
  ] as const)("keeps %s fenced without calling Provider", async (_example, hash, status, code) => {
    const store = new FakeBroadcastStore();
    store.rows.set(distributionId, await broadcastRow());
    store.idempotency.set(`${orgId}:broadcast.end:${distributionId}`, {
      request_hash: hash,
      response_body: null,
      response_status: status,
    });
    let endCalls = 0;

    const error = await failControl(
      store,
      { key: "repeat-key", kind: "end" },
      {
        endBroadcast: async () => {
          endCalls += 1;
          throw new Error("should not call");
        },
      },
    );

    expect(error).toMatchObject({ code, status: 409 });
    expect(endCalls).toEqual(0);
  });

  it("returns 409 needs_reconciliation when end outcome is uncertain", async () => {
    const store = new FakeBroadcastStore();
    store.rows.set(distributionId, await broadcastRow());

    const error = await failControl(
      store,
      { key: "uncertain-key", kind: "end" },
      {
        endBroadcast: async () => ({
          failure: {
            classification: "ambiguous",
            code: "provider_outcome_ambiguous",
            message: "Sensitive encoder-secret",
            retryable: false,
          },
          outcome: "unknown",
          providerOperationId: "live:broadcast-one",
        }),
      },
    );

    expect(error).toEqual(
      new CoreApiError(
        409,
        "needs_reconciliation",
        "The end request is uncertain. Refresh the broadcast state.",
      ),
    );
  });

  it("sanitizes Provider transport failures on end without retrying", async () => {
    const store = new FakeBroadcastStore();
    store.rows.set(distributionId, await broadcastRow());
    let endCalls = 0;

    const error = await failControl(
      store,
      { key: "failed-key", kind: "end" },
      {
        endBroadcast: async () => {
          endCalls += 1;
          throw new Error("Sensitive encoder-secret transport details");
        },
      },
    );

    expect(error).toEqual(
      new CoreApiError(
        502,
        "provider_unavailable",
        "The end request could not be confirmed. Refresh the broadcast state before trying again.",
      ),
    );
    expect(endCalls).toEqual(1);
  });

  it("HTTP end route rejects missing Idempotency-Key with 400", async () => {
    const app = createApiApp({
      providerRegistry: registryWith(),
      resolveActor: async () => ({
        authUserId: "broadcast-writer",
        claims: session,
        displayName: "Writer",
        email: "writer@example.test",
        isInstallationOwner: false,
        role: "editor",
        userId: session.userId,
        workspace: { id: orgId, name: "Workspace", slug: "workspace" },
      }),
      verifyJwtToken: async () => ({ email: "writer@example.test", subject: "broadcast-writer" }),
    });

    const response = await app.request(
      `/api/v1/distributions/${distributionId}/broadcast/end`,
      { headers: { Authorization: "Bearer test.jwt" }, method: "POST" },
      env,
    );

    expect(response.status).toEqual(400);
    expect(await response.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
  });
});
