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

const organizationId = actor.workspace.id;
const distributionId = "d1000000-0000-4000-8000-000000000001";

const idleRelayOutbox = async () => ({ claimed: 0, dead: 0, failed: 0, published: 0 });

async function openInbox(
  options: {
    automation?: AutomationRelayStub;
    executionContext?: ExecutionContext | null;
    query?: string;
  } = {},
) {
  const waited: Promise<unknown>[] = [];
  let inboxCalls = 0;
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
    coreService: fakeCoreService({
      inbox: () => {
        inboxCalls += 1;
        return Effect.succeed({
          comments: [],
          has_more: false,
          limit: 20,
          offset: 0,
        });
      },
    }),
    resolveActor: async () => actor,
    verifyJwtToken: async () => jwtIdentity,
  });

  const response = await app.fetch(
    new Request(`http://localhost:8787/api/v1/inbox${options.query ?? ""}`, {
      headers: {
        Authorization: "Bearer test-only.jwt",
        "X-Request-ID": "request-inbox-open-1",
      },
    }),
    options.automation ? { ...baseEnv, AUTOMATION: options.automation } : baseEnv,
    executionCtx,
  );
  return { inboxCalls, response, waited };
}

describe("Inbox open comment sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests the fetch on waitUntil without delaying the read and logs structured diagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const syncCalls: Array<[string, string | null]> = [];
    const requestCommentsSync = async (orgId: string, distId: string | null) => {
      syncCalls.push([orgId, distId]);
      await pending;
      return 3;
    };

    const { inboxCalls, response, waited } = await openInbox({
      automation: { relayOutbox: idleRelayOutbox, requestCommentsSync },
    });

    expect(response.status).toEqual(200);
    expect(inboxCalls).toEqual(1);
    expect(waited.length).toBeGreaterThan(0);
    expect(syncCalls).toEqual([[organizationId, null]]);

    settle();
    await Promise.all(waited);

    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          event: "inbox_comment_sync",
          outcome: "ok",
          retry_class: "none",
          route: "/api/v1/inbox",
          sync_enqueued: 3,
        }),
        level: "info",
        request_id: "request-inbox-open-1",
        service: "api",
      }),
    );
  });

  it("narrows the fetch to the distribution in view", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const syncCalls: Array<[string, string | null]> = [];

    const { response, waited } = await openInbox({
      automation: {
        relayOutbox: idleRelayOutbox,
        requestCommentsSync: async (orgId, distId) => {
          syncCalls.push([orgId, distId]);
          return 1;
        },
      },
      query: `?distribution_id=${distributionId}`,
    });

    expect(response.status).toEqual(200);
    await Promise.all(waited);
    expect(syncCalls).toEqual([[organizationId, distributionId]]);
  });

  it.each([
    ["malformed distribution_id", "?distribution_id=not-a-uuid"],
    ["invalid reply_status", "?reply_status=nonsense"],
  ])("requests nothing for a rejected Inbox read (%s)", async (_example, query) => {
    const syncCalls: Array<[string, string | null]> = [];

    const { response } = await openInbox({
      automation: {
        relayOutbox: idleRelayOutbox,
        requestCommentsSync: async (orgId, distId) => {
          syncCalls.push([orgId, distId]);
          return 0;
        },
      },
      query,
    });

    expect(response.status).toEqual(400);
    expect(syncCalls).toEqual([]);
  });

  it("keeps the Inbox read successful and absorbs background sync rejection", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { response, waited } = await openInbox({
      automation: {
        relayOutbox: idleRelayOutbox,
        requestCommentsSync: async () => {
          throw new Error("injected Automation RPC failure");
        },
      },
    });

    expect(response.status).toEqual(200);
    await expect(Promise.all(waited)).resolves.not.toThrow();
    expect(logRecords(errors)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "inbox_comment_sync_failed",
          event: "inbox_comment_sync",
          outcome: "failed",
          retry_class: "client_retry",
          route: "/api/v1/inbox",
        }),
        level: "error",
        request_id: "request-inbox-open-1",
        service: "api",
      }),
    );
  });

  it("runs comment sync directly without an execution context", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const { inboxCalls, response, waited } = await openInbox({
      automation: {
        relayOutbox: idleRelayOutbox,
        requestCommentsSync: async () => {
          try {
            return 5;
          } finally {
            settle();
          }
        },
      },
      executionContext: null,
    });

    expect(response.status).toEqual(200);
    expect(inboxCalls).toEqual(1);
    expect(waited).toEqual([]);
    await settled;
    await vi.waitFor(() => {
      expect(logRecords(info)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            event: "inbox_comment_sync",
            outcome: "ok",
            sync_enqueued: 5,
          }),
          level: "info",
        }),
      );
    });
  });

  it("logs direct sync rejection without an execution context", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const { response } = await openInbox({
      automation: {
        relayOutbox: idleRelayOutbox,
        requestCommentsSync: async () => {
          try {
            throw new Error("injected direct invocation sync failure");
          } finally {
            settle();
          }
        },
      },
      executionContext: null,
    });

    expect(response.status).toEqual(200);
    await settled;
    await vi.waitFor(() => {
      expect(logRecords(errors)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            error_code: "inbox_comment_sync_failed",
            event: "inbox_comment_sync",
            outcome: "failed",
          }),
          level: "error",
        }),
      );
    });
  });

  it("serves the Inbox without an Automation binding", async () => {
    const { inboxCalls, response } = await openInbox();

    expect(response.status).toEqual(200);
    expect(inboxCalls).toEqual(1);
  });
});
