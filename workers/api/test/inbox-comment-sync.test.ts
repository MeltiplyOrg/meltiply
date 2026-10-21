// Unit tests exercise resolveActor + core service seams only: the database
// module pulls in `pg`, which cannot load in the workers vitest pool. Mocking
// it keeps actor resolution's dynamic database import from evaluating pg.
import type { JwtIdentity } from "@meltiply/auth";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Effect } from "effect";
vi.mock("../src/database", () => ({}));

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import type { CoreApiService } from "../src/core-types";
import type { ApiWorkerEnv, AutomationRelayStub } from "../src/env";
import { logRecords } from "./log-records";

const baseEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  ENVIRONMENT: "test",
  FRONTEND_URL: "http://localhost:3000",
  PUBLIC_API_URL: "http://localhost:8787",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

// Better Auth subject plus the internal Workspace membership the server
// resolved from org_members, mirroring the confirmed actor claims contract:
// subject = Better Auth user id, userId = internal users.id UUID,
// organizationId = resolved workspace UUID, organizationRole = member role.
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

// Verified Better Auth JWT identity returned by the `verifyJwtToken` test
// double; the bearer JWT is the only credential protected routes may accept.
const jwtIdentity: JwtIdentity = {
  email: "alpha@example.test",
  name: "Alpha",
  subject: actor.authUserId,
};

const bearerAuthorization = "Bearer test-only.jwt";

const organizationId = actor.workspace.id;
const distributionId = "d1000000-0000-4000-8000-000000000001";

const relayOutbox = async () => ({
  claimed: 0,
  dead: 0,
  failed: 0,
  published: 0,
});

/**
 * Drives the Inbox read through the API entry point with a recording execution
 * context, so a test can observe what the open hands to Automation on the
 * background continuation without awaiting it on the response path.
 */
async function openInbox(
  options: {
    automation?: AutomationRelayStub;
    executionContext?: ExecutionContext | null;
    query?: string;
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
        ({
          passThroughOnException: vi.fn(),
          props: {},
          waitUntil,
        } as unknown as ExecutionContext));

  const inbox = vi.fn(() =>
    Effect.succeed({
      comments: [],
      has_more: false,
      limit: 20,
      offset: 0,
    }),
  );
  const app = createApiApp({
    betterAuth: {
      api: { getSession: async () => null },
      handler: async () => new Response("ok"),
    } as never,
    coreService: {
      inbox,
    } as unknown as CoreApiService,
    resolveActor: async () => actor,
    verifyJwtToken: async () => jwtIdentity,
  });

  const response = await app.fetch(
    new Request(`http://localhost:8787/api/v1/inbox${options.query ?? ""}`, {
      headers: {
        Authorization: bearerAuthorization,
        "X-Request-ID": "request-inbox-open-1",
      },
    }),
    options.automation ? { ...baseEnv, AUTOMATION: options.automation } : baseEnv,
    executionCtx,
  );
  return { inbox, response, waitUntil, waited };
}

describe("Inbox open comment sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests the fetch on the background continuation without delaying the read and emits structured diagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const requestCommentsSync = vi.fn(async () => {
      await pending;
      return 3;
    });

    const { inbox, response, waitUntil, waited } = await openInbox({
      automation: { relayOutbox, requestCommentsSync },
    });

    // The Inbox response resolves while the fetch request is still in flight,
    // and the request was handed to the continuation rather than awaited.
    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalled();
    expect(waited.length).toBeGreaterThan(0);
    // Scoped to the resolved actor's workspace, not a caller-supplied one.
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(requestCommentsSync).toHaveBeenCalledTimes(1);
    expect(requestCommentsSync).toHaveBeenCalledWith(organizationId, null);

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
        environment: "test",
        level: "info",
        request_id: "request-inbox-open-1",
        service: "api",
      }),
    );
  });

  it("narrows the fetch to the distribution in view and logs structured diagnostics", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const requestCommentsSync = vi.fn(async () => 1);

    const { response, waited } = await openInbox({
      automation: { relayOutbox, requestCommentsSync },
      query: `?distribution_id=${distributionId}`,
    });

    expect(response.status).toBe(200);
    await Promise.all(waited);
    expect(requestCommentsSync).toHaveBeenCalledWith(organizationId, distributionId);
    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          event: "inbox_comment_sync",
          outcome: "ok",
          retry_class: "none",
          sync_enqueued: 1,
        }),
        level: "info",
        service: "api",
      }),
    );
  });

  it("requests nothing for a rejected Inbox read", async () => {
    const requestCommentsSync = vi.fn(async () => 0);

    const rejected = await openInbox({
      automation: { relayOutbox, requestCommentsSync },
      query: "?distribution_id=not-a-uuid",
    });
    expect(rejected.response.status).toBe(400);

    const invalidStatus = await openInbox({
      automation: { relayOutbox, requestCommentsSync },
      query: "?reply_status=nonsense",
    });
    expect(invalidStatus.response.status).toBe(400);

    expect(requestCommentsSync).not.toHaveBeenCalled();
  });

  it("keeps the Inbox read successful and passes a rejection-handled promise when the fetch request rejects", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const requestCommentsSync = vi.fn(async () => {
      throw new Error("injected Automation RPC failure");
    });

    const { response, waitUntil, waited } = await openInbox({
      automation: { relayOutbox, requestCommentsSync },
    });

    expect(response.status).toBe(200);
    expect(waitUntil).toHaveBeenCalled();
    expect(waited.length).toBeGreaterThan(0);

    // The promise passed to waitUntil must resolve cleanly without unhandled rejection.
    await expect(Promise.all(waited)).resolves.not.toThrow();

    // The next open arms the same work again; the failure is logged with structured diagnostics.
    expect(logRecords(errors)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "inbox_comment_sync_failed",
          event: "inbox_comment_sync",
          outcome: "failed",
          retry_class: "client_retry",
          route: "/api/v1/inbox",
        }),
        error: expect.objectContaining({
          fingerprint: expect.any(String),
          name: "Error",
        }),
        level: "error",
        request_id: "request-inbox-open-1",
        service: "api",
      }),
    );
  });

  it("runs the comment sync to completion and logs diagnostics when invoked directly without an execution context", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let settleSync!: () => void;
    const syncSettled = new Promise<void>((resolve) => {
      settleSync = resolve;
    });
    const requestCommentsSync = vi.fn(async () => {
      try {
        return 5;
      } finally {
        settleSync();
      }
    });

    const { inbox, response, waitUntil } = await openInbox({
      automation: { relayOutbox, requestCommentsSync },
      executionContext: null,
    });

    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(inbox).toHaveBeenCalledTimes(1);
    await syncSettled;
    await vi.waitFor(() => {
      expect(logRecords(info)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            event: "inbox_comment_sync",
            outcome: "ok",
            retry_class: "none",
            sync_enqueued: 5,
          }),
          level: "info",
          service: "api",
        }),
      );
    });
  });

  it("handles comment sync rejection gracefully and logs diagnostics when invoked directly without an execution context", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let settleSync!: () => void;
    const syncSettled = new Promise<void>((resolve) => {
      settleSync = resolve;
    });
    const requestCommentsSync = vi.fn(async () => {
      try {
        throw new Error("injected direct invocation sync failure");
      } finally {
        settleSync();
      }
    });

    const { inbox, response, waitUntil } = await openInbox({
      automation: { relayOutbox, requestCommentsSync },
      executionContext: null,
    });

    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(inbox).toHaveBeenCalledTimes(1);
    await syncSettled;
    await vi.waitFor(() => {
      expect(logRecords(errors)).toContainEqual(
        expect.objectContaining({
          context: expect.objectContaining({
            error_code: "inbox_comment_sync_failed",
            event: "inbox_comment_sync",
            outcome: "failed",
            retry_class: "client_retry",
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

  it("serves the Inbox without an Automation binding", async () => {
    const { inbox, response } = await openInbox();
    expect(response.status).toBe(200);
    expect(inbox).toHaveBeenCalledTimes(1);
  });
});
