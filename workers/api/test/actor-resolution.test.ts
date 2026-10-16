import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { JwtIdentity } from "@meltiply/auth";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));
vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import { resolveActor } from "../src/actor-resolution";
import { CoreApiError } from "../src/core-types";
import type { ApiWorkerEnv } from "../src/env";

const env = {
  ENVIRONMENT: "test",
  VERSION: "actor-resolution-test",
} as ApiWorkerEnv;

const userId = "00000000-0000-4000-8000-000000000011";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const teamWorkspaceId = "00000000-0000-4000-8000-000000000002";

// Verified Better Auth JWT identity as produced by the bearer verifier in the
// app middleware; actor resolution consumes it without any session lookup.
const identity: JwtIdentity = {
  email: "alpha@example.com",
  name: "Alpha User",
  subject: "user_better_alpha",
};

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://api.example.test/api/v1/assets", { headers });
}

/**
 * Builds an Effect transaction client whose query handler dispatches on SQL shape.
 *
 * Each test configures user/workspace rows: the collision lookup, the user
 * upsert (optionally returning zero rows to exercise the read-back path), and
 * the workspace membership lookup.
 */
function effectClient(options: {
  collision?: boolean;
  upsertReturnsRow?: boolean;
  workspace?: {
    id: string;
    is_personal: boolean;
    name: string;
    role: string;
    slug: string;
  } | null;
}) {
  const userRow = {
    auth_user_id: "user_better_alpha",
    display_name: "Alpha User",
    email: "alpha@example.com",
    id: userId,
  };
  return {
    query: vi.fn((sql: string, _params?: unknown[]) =>
      Effect.tryPromise({
        catch: (cause) => (cause instanceof Error ? cause : new Error("Query failed")),
        try: async () => {
          if (sql.includes("lower(email)")) {
            return {
              rows: options.collision === true ? [{ id: "other-user" }] : [],
            };
          }
          if (sql.includes("INSERT INTO users")) {
            return {
              rows: options.upsertReturnsRow === false ? [] : [userRow],
            };
          }
          if (sql.includes("FROM users WHERE auth_user_id")) {
            return { rows: [userRow] };
          }
          if (sql.includes("INSERT INTO organizations")) {
            return { rows: [] };
          }
          if (sql.includes("INSERT INTO org_members")) {
            return { rows: [] };
          }
          if (sql.includes("INSERT INTO usage_reconciliation_state")) {
            return { rows: [] };
          }
          if (sql.includes("FROM org_members om")) {
            return { rows: options.workspace ? [options.workspace] : [] };
          }
          return { rows: [] };
        },
      }),
    ),
  };
}

const personalWorkspace = {
  id: workspaceId,
  is_personal: true,
  name: "Alpha's workspace",
  role: "admin",
  slug: "personal-alpha",
};

beforeEach(() => {
  vi.clearAllMocks();
  withSystemTransactionEffect.mockImplementation((_env, operation) =>
    operation(effectClient({ workspace: personalWorkspace })),
  );
});

describe("resolveActor", () => {
  it.each([
    { email: "alpha@example.com" },
    { email: "   ", subject: "user_better_alpha" },
    { subject: "user_better_alpha" },
    { subject: "   ", email: "alpha@example.com" },
  ])(
    "rejects structurally invalid JWT identities with 401 before any database work: %j",
    async (malformed) => {
      await expect(resolveActor(env, malformed as JwtIdentity, request())).rejects.toMatchObject({
        code: "authentication_required",
        status: 401,
      });
      expect(withSystemTransactionEffect).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed workspace selections with 400 before any database work", async () => {
    await expect(
      resolveActor(env, identity, request({ "x-workspace-id": "not-a-uuid" })),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });

  it("rejects email collisions with 409 instead of attaching identity", async () => {
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(effectClient({ collision: true, workspace: personalWorkspace })),
    );
    const error = await resolveActor(env, identity, request()).catch((cause) => cause);
    expect(error).toBeInstanceOf(CoreApiError);
    expect(error).toMatchObject({
      code: "identity_conflict",
      status: 409,
    });
  });

  it("rejects inaccessible workspace selections with 403", async () => {
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(effectClient({ workspace: null })),
    );
    await expect(
      resolveActor(env, identity, request({ "x-workspace-id": teamWorkspaceId })),
    ).rejects.toMatchObject({ code: "workspace_forbidden", status: 403 });
  });

  it("binds the verified JWT identity to the internal user upsert", async () => {
    const client = effectClient({ workspace: personalWorkspace });
    withSystemTransactionEffect.mockImplementation((_env, operation) => operation(client));
    await resolveActor(env, identity, request());
    const upsert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO users"),
    );
    expect(upsert?.[1]).toEqual(["user_better_alpha", "alpha@example.com", "Alpha User", null]);
  });

  it("resolves the personal workspace with admin claims by default", async () => {
    const actor = await resolveActor(env, identity, request());
    expect(actor).toEqual({
      authUserId: "user_better_alpha",
      claims: {
        organizationId: workspaceId,
        organizationRole: "admin",
        subject: "user_better_alpha",
        userId,
      },
      role: "admin",
      userId,
      workspace: {
        id: workspaceId,
        isPersonal: true,
        name: "Alpha's workspace",
        slug: "personal-alpha",
      },
    });
  });

  it("resolves a selected team workspace with its membership role", async () => {
    const teamWorkspace = {
      id: teamWorkspaceId,
      is_personal: false,
      name: "Team",
      role: "member",
      slug: "team",
    };
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(effectClient({ workspace: teamWorkspace })),
    );
    const actor = await resolveActor(env, identity, request({ "x-workspace-id": teamWorkspaceId }));
    expect(actor.workspace.id).toBe(teamWorkspaceId);
    expect(actor.role).toBe("member");
    expect(actor.claims).toMatchObject({
      organizationId: teamWorkspaceId,
      organizationRole: "member",
    });
  });

  it("reads the user row back when the profile upsert changes nothing", async () => {
    const client = effectClient({
      upsertReturnsRow: false,
      workspace: personalWorkspace,
    });
    withSystemTransactionEffect.mockImplementation((_env, operation) => operation(client));
    const actor = await resolveActor(env, identity, request());
    expect(actor.userId).toBe(userId);
    const selects = client.query.mock.calls.filter(([sql]) =>
      String(sql).includes("FROM users WHERE auth_user_id"),
    );
    expect(selects.length).toBe(1);
  });
});
