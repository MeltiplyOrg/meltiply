import type { JwtIdentity } from "@meltiply/auth";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";

vi.mock("../src/database", () => ({}));

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import { fakeCoreService, fakeExecutionContext } from "../test-support/fakes";
import type { ApiWorkerEnv, AutomationRelayStub } from "../src/env";
import { logRecords } from "./log-records";

const baseEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  ENVIRONMENT: "test",
  APP_URL: "http://localhost:3000",
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

const bearerAuthorization = "Bearer test-only.jwt";

const commentId = "00000000-0000-4000-8000-000000000001";
const brandProfileId = "00000000-0000-4000-8000-000000000111";

const requestCommentsSync = async () => 0;

const replyToComment = () =>
  vi.fn(() =>
    Effect.succeed({
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
    }),
  );

async function postReply(
  options: {
    automation?: AutomationRelayStub;
    executionContext?: ExecutionContext | null;
    idempotencyKey?: string;
    text?: string;
  } = {},
) {
  const waited: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    waited.push(promise);
  });
  const executionCtx =
    options.executionContext === null
      ? undefined
      : (options.executionContext ??
        fakeExecutionContext({
          passThroughOnException: vi.fn(),
          waitUntil,
        }));

  const app = createApiApp({
    betterAuth: {
      api: { getSession: async () => null },
      handler: async () => new Response("ok"),
    } as never,
    coreService: fakeCoreService({
      replyToComment: replyToComment(),
    }),
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
        "Content-Type": "application/json",
        Authorization: bearerAuthorization,
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        "X-Request-ID": "request-eager-12345",
      },
      method: "POST",
    }),
    options.automation ? { ...baseEnv, AUTOMATION: options.automation } : baseEnv,
    executionCtx,
  );
  return { response, waitUntil, waited };
}

describe("API eager Outbox relay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relays on the background continuation without delaying the response and emits structured diagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const relayOutbox = vi.fn(async () => {
      await pending;
      return { claimed: 1, dead: 0, failed: 0, published: 1 };
    });

    const { response, waitUntil, waited } = await postReply({
      automation: { relayOutbox, requestCommentsSync },
      idempotencyKey: "eager-relay-success",
    });

    expect(response.status).toBe(202);
    expect(relayOutbox).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalled();
    expect(waited.length).toBeGreaterThan(0);

    settle();
    await Promise.all(waited);

    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          event: "outbox_eager_relay",
          outcome: "ok",
          relayed_claimed: 1,
          relayed_dead: 0,
          relayed_failed: 0,
          relayed_published: 1,
          retry_class: "none",
          route: `/api/v1/inbox/${commentId}/reply`,
        }),
        environment: "test",
        level: "info",
        request_id: "request-eager-12345",
        service: "api",
      }),
    );
  });

  it("classifies partial relay failures as platform_retry in structured diagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const relayOutbox = vi.fn(async () => ({
      claimed: 3,
      dead: 0,
      failed: 1,
      published: 2,
    }));

    const { response, waited } = await postReply({
      automation: { relayOutbox, requestCommentsSync },
      idempotencyKey: "eager-relay-partial-fail",
    });

    expect(response.status).toBe(202);
    await Promise.all(waited);

    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          event: "outbox_eager_relay",
          outcome: "ok",
          relayed_claimed: 3,
          relayed_dead: 0,
          relayed_failed: 1,
          relayed_published: 2,
          retry_class: "platform_retry",
        }),
        level: "info",
        service: "api",
      }),
    );
  });

  it("keeps the mutation successful and passes a rejection-handled promise when the relay rejects", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const relayOutbox = vi.fn(async () => {
      throw new Error("injected Automation RPC failure");
    });

    const { response, waitUntil, waited } = await postReply({
      automation: { relayOutbox, requestCommentsSync },
      idempotencyKey: "eager-relay-failure",
    });

    expect(response.status).toBe(202);
    expect(waitUntil).toHaveBeenCalled();
    expect(waited.length).toBeGreaterThan(0);

    await expect(Promise.all(waited)).resolves.not.toThrow();

    expect(logRecords(errors)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "outbox_eager_relay_failed",
          event: "outbox_eager_relay",
          outcome: "failed",
          retry_class: "platform_retry",
          route: `/api/v1/inbox/${commentId}/reply`,
        }),
        error: expect.objectContaining({
          fingerprint: expect.any(String),
          name: "Error",
        }),
        level: "error",
        request_id: "request-eager-12345",
        service: "api",
      }),
    );
  });

  it("runs the relay to completion and logs diagnostics when invoked directly without an execution context", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let settleRelay!: () => void;
    const relaySettled = new Promise<void>((resolve) => {
      settleRelay = resolve;
    });
    const relayOutbox = vi.fn(async () => {
      try {
        return { claimed: 2, dead: 0, failed: 0, published: 2 };
      } finally {
        settleRelay();
      }
    });

    const { response, waitUntil } = await postReply({
      automation: { relayOutbox, requestCommentsSync },
      executionContext: null,
      idempotencyKey: "eager-relay-no-ctx-success",
    });

    expect(response.status).toBe(202);
    expect(waitUntil).not.toHaveBeenCalled();
    await relaySettled;
    await vi.waitFor(() => {
      expect(logRecords(info)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            event: "outbox_eager_relay",
            outcome: "ok",
            relayed_claimed: 2,
            relayed_dead: 0,
            relayed_failed: 0,
            relayed_published: 2,
            retry_class: "none",
          }),
          level: "info",
          service: "api",
        }),
      );
    });
  });

  it("handles relay rejection gracefully and logs diagnostics when invoked directly without an execution context", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let settleRelay!: () => void;
    const relaySettled = new Promise<void>((resolve) => {
      settleRelay = resolve;
    });
    const relayOutbox = vi.fn(async () => {
      try {
        throw new Error("injected direct invocation failure");
      } finally {
        settleRelay();
      }
    });

    const { response, waitUntil } = await postReply({
      automation: { relayOutbox, requestCommentsSync },
      executionContext: null,
      idempotencyKey: "eager-relay-no-ctx-failure",
    });

    expect(response.status).toBe(202);
    expect(waitUntil).not.toHaveBeenCalled();
    await relaySettled;
    await vi.waitFor(() => {
      expect(logRecords(errors)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            error_code: "outbox_eager_relay_failed",
            event: "outbox_eager_relay",
            outcome: "failed",
            retry_class: "platform_retry",
          }),
          error: expect.objectContaining({
            fingerprint: expect.any(String),
            name: "Error",
          }),
          level: "error",
          service: "api",
        }),
      );
    });
  });

  it("does not relay for a request that changed nothing", async () => {
    const relayOutbox = vi.fn(async () => ({
      claimed: 0,
      dead: 0,
      failed: 0,
      published: 0,
    }));

    const rejected = await postReply({
      automation: { relayOutbox, requestCommentsSync },
      text: "",
    });
    expect(rejected.response.status).toBe(400);

    const app = createApiApp({
      betterAuth: {
        api: { getSession: async () => null },
        handler: async () => new Response("ok"),
      } as never,
      resolveActor: async () => actor,
      verifyJwtToken: async () => jwtIdentity,
    });
    const read = await app.fetch(
      new Request("http://localhost:8787/api/v1/health", {
        headers: { Authorization: bearerAuthorization },
      }),
      { ...baseEnv, AUTOMATION: { relayOutbox, requestCommentsSync } },
    );
    expect(read.status).toBe(200);

    expect(relayOutbox).not.toHaveBeenCalled();
  });

  it("succeeds without an Automation binding", async () => {
    const { response } = await postReply({
      idempotencyKey: "eager-relay-no-binding",
    });
    expect(response.status).toBe(202);
  });
});
