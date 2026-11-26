import type { JwtIdentity } from "@meltiply/auth";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import type { ApiWorkerEnv, AutomationRelayStub } from "../src/env";
import { fakeCoreService, fakeExecutionContext } from "../test-support/fakes";
import { logRecords } from "./log-records";

const baseEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

const actor: ResolvedActor = {
  authUserId: "auth_user_alpha",
  claims: {
    organizationId: "20000000-0000-4000-8000-000000000001",
    organizationRole: "admin",
    subject: "auth_user_alpha",
    userId: "10000000-0000-4000-8000-000000000001",
  },
  displayName: "Alpha Admin",
  email: "alpha@meltiply.local",
  isInstallationOwner: false,
  role: "admin",
  userId: "10000000-0000-4000-8000-000000000001",
  workspace: {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Alpha",
    slug: "alpha",
  },
};

const jwtIdentity: JwtIdentity = {
  email: "alpha@example.test",
  name: "Alpha",
  subject: actor.authUserId,
};

const commentId = "00000000-0000-4000-8000-000000000001";
const brandProfileId = "00000000-0000-4000-8000-000000000111";
const idleCommentsSync = async () => 0;

function replyResult() {
  return Effect.succeed({
    replayed: false,
    value: {
      author_avatar: null,
      author_name: "Commenter",
      body: "Nice post!",
      brand_profile_id: brandProfileId,
      commented_at: "2026-08-24T00:00:00.000Z",
      distribution_id: "00000000-0000-4000-8000-000000000003",
      failure: null,
      id: commentId,
      platform: "threads" as const,
      platform_comment_id: "platform-comment-1",
      post_id: "00000000-0000-4000-8000-000000000004",
      reply_attempted_at: "2026-08-24T00:00:00.000Z",
      reply_status: "queued" as const,
      reply_text: "Thanks!",
      synced_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z",
    },
  });
}

async function postReply(
  options: {
    automation?: AutomationRelayStub;
    executionContext?: ExecutionContext | null;
    idempotencyKey?: string;
    text?: string;
  } = {},
) {
  const waited: Promise<unknown>[] = [];
  const executionCtx =
    options.executionContext === null
      ? undefined
      : (options.executionContext ??
        fakeExecutionContext({
          passThroughOnException: () => undefined,
          waitUntil: (promise) => {
            waited.push(promise);
          },
        }));

  const app = createApiApp({
    coreService: fakeCoreService({ replyToComment: () => replyResult() }),
    resolveActor: async () => actor,
    verifyJwtToken: async () => jwtIdentity,
  });

  const response = await app.fetch(
    new Request(`http://localhost:8787/api/v1/inbox/${commentId}/reply`, {
      body: JSON.stringify({
        brand_profile_id: brandProfileId,
        text: options.text ?? "Thanks!",
      }),
      headers: {
        Authorization: "Bearer test-only.jwt",
        "Content-Type": "application/json",
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        "X-Request-ID": "request-eager-12345",
      },
      method: "POST",
    }),
    options.automation ? { ...baseEnv, AUTOMATION: options.automation } : baseEnv,
    executionCtx,
  );
  return { response, waited };
}

describe("API eager Outbox relay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relays on waitUntil without delaying the mutation response and logs diagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let relayCalls = 0;

    const { response, waited } = await postReply({
      automation: {
        relayOutbox: async () => {
          relayCalls += 1;
          await pending;
          return { claimed: 1, dead: 0, failed: 0, published: 1 };
        },
        requestCommentsSync: idleCommentsSync,
      },
      idempotencyKey: "eager-relay-success",
    });

    expect(response.status).toEqual(202);
    expect(relayCalls).toEqual(1);
    expect(waited.length).toBeGreaterThan(0);

    settle();
    await Promise.all(waited);

    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          event: "outbox_eager_relay",
          outcome: "ok",
          relayed_claimed: 1,
          relayed_failed: 0,
          relayed_published: 1,
          retry_class: "none",
          route: `/api/v1/inbox/${commentId}/reply`,
        }),
        level: "info",
        request_id: "request-eager-12345",
      }),
    );
  });

  it("classifies partial relay failures as platform_retry", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const { response, waited } = await postReply({
      automation: {
        relayOutbox: async () => ({ claimed: 3, dead: 0, failed: 1, published: 2 }),
        requestCommentsSync: idleCommentsSync,
      },
      idempotencyKey: "eager-relay-partial-fail",
    });

    expect(response.status).toEqual(202);
    await Promise.all(waited);

    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          event: "outbox_eager_relay",
          outcome: "ok",
          relayed_failed: 1,
          retry_class: "platform_retry",
        }),
        level: "info",
      }),
    );
  });

  it("keeps the mutation successful and absorbs relay rejections", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { response, waited } = await postReply({
      automation: {
        relayOutbox: async () => {
          throw new Error("injected Automation RPC failure");
        },
        requestCommentsSync: idleCommentsSync,
      },
      idempotencyKey: "eager-relay-failure",
    });

    expect(response.status).toEqual(202);
    await expect(Promise.all(waited)).resolves.not.toThrow();

    expect(logRecords(errors)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "outbox_eager_relay_failed",
          event: "outbox_eager_relay",
          outcome: "failed",
          retry_class: "platform_retry",
        }),
        level: "error",
        request_id: "request-eager-12345",
      }),
    );
  });

  it("runs the relay directly without an execution context", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const { response, waited } = await postReply({
      automation: {
        relayOutbox: async () => {
          try {
            return { claimed: 2, dead: 0, failed: 0, published: 2 };
          } finally {
            settle();
          }
        },
        requestCommentsSync: idleCommentsSync,
      },
      executionContext: null,
      idempotencyKey: "eager-relay-no-ctx-success",
    });

    expect(response.status).toEqual(202);
    expect(waited).toEqual([]);
    await settled;
    await vi.waitFor(() => {
      expect(logRecords(info)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            event: "outbox_eager_relay",
            outcome: "ok",
            relayed_published: 2,
          }),
          level: "info",
        }),
      );
    });
  });

  it("logs direct relay failure without an execution context", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const { response } = await postReply({
      automation: {
        relayOutbox: async () => {
          try {
            throw new Error("injected direct invocation failure");
          } finally {
            settle();
          }
        },
        requestCommentsSync: idleCommentsSync,
      },
      executionContext: null,
      idempotencyKey: "eager-relay-no-ctx-failure",
    });

    expect(response.status).toEqual(202);
    await settled;
    await vi.waitFor(() => {
      expect(logRecords(errors)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            error_code: "outbox_eager_relay_failed",
            event: "outbox_eager_relay",
            outcome: "failed",
          }),
          level: "error",
        }),
      );
    });
  });

  it("does not relay for a rejected mutation", async () => {
    let relayCalls = 0;

    const { response } = await postReply({
      automation: {
        relayOutbox: async () => {
          relayCalls += 1;
          return { claimed: 0, dead: 0, failed: 0, published: 0 };
        },
        requestCommentsSync: idleCommentsSync,
      },
      text: "",
    });

    expect(response.status).toEqual(400);
    expect(relayCalls).toEqual(0);
  });

  it("does not relay for a read-only health request", async () => {
    let relayCalls = 0;
    const app = createApiApp({
      resolveActor: async () => actor,
      verifyJwtToken: async () => jwtIdentity,
    });

    const response = await app.fetch(
      new Request("http://localhost:8787/api/v1/health", {
        headers: { Authorization: "Bearer test-only.jwt" },
      }),
      {
        ...baseEnv,
        AUTOMATION: {
          relayOutbox: async () => {
            relayCalls += 1;
            return { claimed: 0, dead: 0, failed: 0, published: 0 };
          },
          requestCommentsSync: idleCommentsSync,
        },
      },
    );

    expect(response.status).toEqual(200);
    expect(relayCalls).toEqual(0);
  });

  it("succeeds without an Automation binding", async () => {
    const { response } = await postReply({ idempotencyKey: "eager-relay-no-binding" });

    expect(response.status).toEqual(202);
  });
});
