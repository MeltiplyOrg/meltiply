import type { EffectTransactionClient } from "@meltiply/database";
import {
  classifyProviderFailure,
  ProviderAdapterError,
  ProviderRegistry,
  type ProviderAdapter,
} from "@meltiply/providers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { withTenantTransactionEffect } = vi.hoisted(() => ({
  withTenantTransactionEffect: vi.fn(),
}));
// pg cannot run inside the workerd test isolate. Only database I/O is scripted;
// the HTTP guard, broadcast program, token cryptography and Provider Layer run.
vi.mock("../src/database", () => ({ withTenantTransactionEffect }));

import { createApiApp } from "../src/app";
import type { ResolvedActor } from "../src/actor-resolution";
import type { ApiWorkerEnv } from "../src/env";
import { tokenCipherFor } from "../src/token-credentials";

const distributionId = "00000000-0000-4000-8000-000000000701";
const path = `/api/v1/distributions/${distributionId}/broadcast`;
const env = {
  ENVIRONMENT: "test",
  APP_URL: "http://localhost:3000",
  VERSION: "test",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
} satisfies ApiWorkerEnv;
const actor: ResolvedActor = {
  authUserId: "broadcast-writer",
  userId: "00000000-0000-4000-8000-000000000011",
  displayName: "Writer",
  email: "writer@example.test",
  isInstallationOwner: false,
  role: "editor",
  claims: {
    subject: "broadcast-writer",
    userId: "00000000-0000-4000-8000-000000000011",
    organizationId: "00000000-0000-4000-8000-000000000001",
    organizationRole: "editor",
  },
  workspace: { id: "00000000-0000-4000-8000-000000000001", name: "Workspace", slug: "workspace" },
};

/** Supplies explicit database outcomes; unexpected I/O fails rather than silently authorizing a request. */
function databaseAnswers(...answers: Array<Record<string, unknown>[]>) {
  const query = vi.fn<EffectTransactionClient["query"]>();
  for (const rows of answers)
    query.mockReturnValueOnce(
      Effect.succeed({
        rows,
        rowCount: rows.length,
        command: "SELECT",
        fields: [],
        oid: 0,
      }),
    );
  query.mockImplementation(() => Effect.die(new Error("Unexpected broadcast database query")));
  withTenantTransactionEffect.mockImplementation(
    (
      _env: ApiWorkerEnv,
      _claims: ResolvedActor["claims"],
      operation: (client: { query: typeof query }) => Effect.Effect<unknown, unknown>,
    ) => operation({ query }),
  );
}

/** Builds one eligible encrypted Channel row; individual cases override database-derived authorization/state. */
async function broadcastRow(patch: Record<string, unknown> = {}) {
  return {
    org_id: actor.workspace.id,
    platform: "youtube",
    platform_user_id: "channel-one",
    provider_operation_id: "live:broadcast-one",
    access_token: await tokenCipherFor(env).encrypt("provider-access-token"),
    token_expires_at: null,
    connection_status: "connected",
    revoked_at: null,
    role: "editor",
    ...patch,
  };
}

/** Runs the actual authenticated routes with a per-test Provider adapter; no broadcast service is replaced. */
function appWithProvider(overrides: Partial<ProviderAdapter> = {}) {
  const provider: ProviderAdapter = {
    capability: {
      platform: "youtube",
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
      publish: false,
      reply: false,
    },
    transferModes: [],
    ...overrides,
  };
  const registry = new ProviderRegistry();
  registry.register("youtube", provider);
  return createApiApp({
    providerRegistry: registry,
    resolveActor: async () => actor,
    verifyJwtToken: async () => ({
      subject: actor.authUserId,
      email: actor.email,
      name: actor.displayName ?? undefined,
    }),
  });
}

beforeEach(() => {
  withTenantTransactionEffect.mockReset();
});

describe("broadcast controls HTTP boundary", () => {
  it("denies a database-derived Viewer role before decrypting credentials or contacting the Provider", async () => {
    databaseAnswers([
      await broadcastRow({ role: "viewer", access_token: "meltiply:v2:primary:invalid" }),
    ]);
    const getBroadcastInfo = vi.fn<NonNullable<ProviderAdapter["getBroadcastInfo"]>>();
    const response = await appWithProvider({ getBroadcastInfo }).request(
      path,
      {
        headers: { Authorization: "Bearer test.jwt" },
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden_role" } });
    expect(getBroadcastInfo).not.toHaveBeenCalled();
  });

  it("does not disclose encoder credentials for a missing or invisible Distribution", async () => {
    databaseAnswers([]);
    const getBroadcastInfo = vi.fn<NonNullable<ProviderAdapter["getBroadcastInfo"]>>();
    const response = await appWithProvider({ getBroadcastInfo }).request(
      path,
      {
        headers: { Authorization: "Bearer test.jwt" },
      },
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    expect(getBroadcastInfo).not.toHaveBeenCalled();
  });

  it.each([
    [{ provider_operation_id: "video:ordinary-upload" }, 422],
    [{ revoked_at: "2026-01-01T00:00:00Z" }, 409],
    [{ connection_status: "disconnected" }, 409],
    [{ token_expires_at: "2020-01-01T00:00:00Z" }, 409],
  ] as const)("refuses encoder access for ineligible Channel state %j", async (patch, status) => {
    databaseAnswers([
      await broadcastRow({ ...patch, access_token: "meltiply:v2:primary:invalid" }),
    ]);
    const getBroadcastInfo = vi.fn<NonNullable<ProviderAdapter["getBroadcastInfo"]>>();
    const response = await appWithProvider({ getBroadcastInfo }).request(
      path,
      {
        headers: { Authorization: "Bearer test.jwt" },
      },
      env,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
    expect(getBroadcastInfo).not.toHaveBeenCalled();
  });

  it("makes writer-only encoder responses uncacheable", async () => {
    databaseAnswers([await broadcastRow()], []);
    const response = await appWithProvider({
      getBroadcastInfo: async () => ({
        state: "live",
        ingestUrl: "rtmps://example.test/live",
        streamKey: "encoder-secret",
        providerPostId: "live-publication",
        providerUrl: "https://youtu.be/live-publication",
      }),
    }).request(path, { headers: { Authorization: "Bearer test.jwt" } }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ streamKey: "encoder-secret" });
  });

  it("does not attempt Provider access when stored credentials cannot be decrypted", async () => {
    databaseAnswers([await broadcastRow({ access_token: "meltiply:v2:primary:invalid" })]);
    const getBroadcastInfo = vi.fn<NonNullable<ProviderAdapter["getBroadcastInfo"]>>();
    const response = await appWithProvider({ getBroadcastInfo }).request(
      path,
      {
        headers: { Authorization: "Bearer test.jwt" },
      },
      env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "dependency_unavailable" } });
    expect(getBroadcastInfo).not.toHaveBeenCalled();
  });

  it("sanitizes a Provider read failure instead of exposing remote credential diagnostics", async () => {
    databaseAnswers([await broadcastRow()]);
    const response = await appWithProvider({
      getBroadcastInfo: async () => {
        throw new ProviderAdapterError({
          ...classifyProviderFailure({ status: 400 }),
          message: "Sensitive provider-access-token and encoder-secret",
        });
      },
    }).request(path, { headers: { Authorization: "Bearer test.jwt" } }, env);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "provider_unavailable" } });
    expect(body).not.toMatch(/provider-access-token|encoder-secret|Sensitive/);
  });

  it("requires an idempotency key before dispatching a destructive end request", async () => {
    const endBroadcast = vi.fn<NonNullable<ProviderAdapter["endBroadcast"]>>();
    const response = await appWithProvider({ endBroadcast }).request(
      `${path}/end`,
      {
        method: "POST",
        headers: { Authorization: "Bearer test.jwt" },
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
    expect(endBroadcast).not.toHaveBeenCalled();
    expect(withTenantTransactionEffect).not.toHaveBeenCalled();
  });

  it("ends once and replays completed history even after the Channel disconnects", async () => {
    databaseAnswers(
      [await broadcastRow()],
      [{ idempotency_key: distributionId }],
      [],
      [],
      [
        await broadcastRow({
          connection_status: "disconnected",
          access_token: "meltiply:v2:primary:invalid",
        }),
      ],
      [],
      [
        {
          request_hash: "371d09f890c435d5b299e8b0b08903ce39726f3273a23fb15dcb5520a9f466d8",
          response_status: 200,
          response_body: { ended: true },
        },
      ],
    );
    const endBroadcast = vi.fn<NonNullable<ProviderAdapter["endBroadcast"]>>().mockResolvedValue({
      outcome: "confirmed_success",
      providerOperationId: "live:broadcast-one",
      providerPostId: "recorded-broadcast",
      providerUrl: "https://youtu.be/recorded-broadcast",
    });
    const app = appWithProvider({ endBroadcast });
    for (const key of ["original-end-command", "different-http-key"]) {
      const response = await app.request(
        `${path}/end`,
        {
          method: "POST",
          headers: { Authorization: "Bearer test.jwt", "Idempotency-Key": key },
        },
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ ended: true });
    }
    expect(endBroadcast).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "pending",
      "371d09f890c435d5b299e8b0b08903ce39726f3273a23fb15dcb5520a9f466d8",
      null,
      "idempotency_in_progress",
    ],
    ["conflicting", "unrelated-request-hash", 200, "idempotency_conflict"],
  ] as const)(
    "keeps a %s end reservation fenced without another Provider write",
    async (_state, requestHash, responseStatus, code) => {
      databaseAnswers(
        [await broadcastRow()],
        [],
        [
          {
            request_hash: requestHash,
            response_status: responseStatus,
            response_body: null,
          },
        ],
      );
      const endBroadcast = vi.fn<NonNullable<ProviderAdapter["endBroadcast"]>>();
      const response = await appWithProvider({ endBroadcast }).request(
        `${path}/end`,
        {
          method: "POST",
          headers: { Authorization: "Bearer test.jwt", "Idempotency-Key": "repeat-end-command" },
        },
        env,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(endBroadcast).not.toHaveBeenCalled();
    },
  );

  it("returns reconciliation rather than success when ending may have succeeded upstream", async () => {
    databaseAnswers([await broadcastRow()], [{ idempotency_key: distributionId }]);
    const endBroadcast = vi.fn<NonNullable<ProviderAdapter["endBroadcast"]>>().mockResolvedValue({
      outcome: "unknown",
      providerOperationId: "live:broadcast-one",
      failure: {
        classification: "ambiguous",
        code: "provider_outcome_ambiguous",
        message: "Sensitive encoder-secret",
        retryable: false,
      },
    });
    const response = await appWithProvider({ endBroadcast }).request(
      `${path}/end`,
      {
        method: "POST",
        headers: { Authorization: "Bearer test.jwt", "Idempotency-Key": "uncertain-end-command" },
      },
      env,
    );
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "needs_reconciliation" } });
    expect(body).not.toContain("encoder-secret");
    expect(endBroadcast).toHaveBeenCalledTimes(1);
  });

  it("does not retry an end request after Provider transport failure", async () => {
    databaseAnswers([await broadcastRow()], [{ idempotency_key: distributionId }]);
    const endBroadcast = vi
      .fn<NonNullable<ProviderAdapter["endBroadcast"]>>()
      .mockRejectedValue(new Error("Sensitive encoder-secret transport details"));
    const response = await appWithProvider({ endBroadcast }).request(
      `${path}/end`,
      {
        method: "POST",
        headers: { Authorization: "Bearer test.jwt", "Idempotency-Key": "failed-end-command" },
      },
      env,
    );
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "provider_unavailable" } });
    expect(body).not.toMatch(/encoder-secret|transport details/);
    expect(endBroadcast).toHaveBeenCalledTimes(1);
  });
});
