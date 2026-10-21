import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { JwtIdentity } from "@meltiply/auth";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));
vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import {
  resolveActor as resolveActorWithRequestId,
  type ResolvedActor,
} from "../src/actor-resolution";
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

/** Resolves an actor with the middleware request id the app supplies. */
function resolveActor(
  env: ApiWorkerEnv,
  identity: JwtIdentity,
  request: Request,
): Promise<ResolvedActor> {
  return resolveActorWithRequestId(env, identity, request, "actor-resolution-test-request");
}

/**
 * Builds an Effect transaction client dispatching on SQL shape.
 *
 * Mirrors the statements actor resolution issues: user upsert, installation
 * bootstrap, invitation consumption, ownership read, and shared-workspace
 * resolution.
 */
function effectClient(options: {
  collision?: boolean;
  invitation?: boolean;
  upsertReturnsRow?: boolean;
  user?: {
    installation_owner: boolean;
    suspended_at?: Date | string | null;
  };
  workspace?: { id: string; name: string; role: string; slug: string } | null;
}) {
  let acceptedInvitation = false;
  const userRow = {
    auth_user_id: "user_better_alpha",
    display_name: "Alpha User",
    email: "alpha@example.com",
    id: userId,
    installation_owner: options.user?.installation_owner ?? false,
    suspended_at: options.user?.suspended_at ?? null,
  };
  return {
    query: vi.fn((sql: string, _params?: unknown[]) =>
      Effect.tryPromise({
        catch: (cause) => (cause instanceof Error ? cause : new Error("Query failed")),
        try: async () => {
          if (sql.includes("FROM workspace_invitations")) {
            return {
              rows: options.invitation
                ? [
                    {
                      accepted_at: null,
                      email: "alpha@example.com",
                      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
                      id: "00000000-0000-4000-8000-000000000601",
                      org_id: workspaceId,
                      revoked_at: null,
                      role: "editor",
                    },
                  ]
                : [],
            };
          }
          if (sql.includes("lower(email)")) {
            return { rows: options.collision === true ? [{ id: "other-user" }] : [] };
          }
          if (sql.includes("INSERT INTO users")) {
            return { rows: options.upsertReturnsRow === false ? [] : [userRow] };
          }
          if (sql.includes("FROM users WHERE auth_user_id")) {
            return { rows: [userRow] };
          }
          if (sql.includes("SELECT installation_owner FROM users")) {
            return { rows: [{ installation_owner: userRow.installation_owner }] };
          }
          if (sql.includes("FROM workspace_invitations")) {
            return {
              rows: options.invitation
                ? [
                    {
                      accepted_at: null,
                      email: "alpha@example.com",
                      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
                      id: "00000000-0000-4000-8000-000000000601",
                      org_id: workspaceId,
                      revoked_at: null,
                      role: "editor",
                    },
                  ]
                : [],
            };
          }
          if (sql.includes("INSERT INTO organizations")) return { rows: [] };
          if (sql.includes("INSERT INTO org_members")) {
            if ((_params?.length ?? 0) === 3) acceptedInvitation = true;
            return { rows: [] };
          }
          if (sql.includes("INSERT INTO usage_reconciliation_state")) return { rows: [] };
          if (sql.includes("INSERT INTO workspace_audit_entries")) return { rows: [] };
          if (sql.includes("UPDATE org_members")) return { rows: [] };
          if (sql.includes("SELECT id FROM organizations")) return { rows: [{ id: workspaceId }] };
          if (sql.includes("SELECT count(*)")) {
            return { rows: [{ active_members: 1, pending_invitations: 0 }] };
          }
          if (sql.includes("SELECT o.id, o.name, o.slug, om.role")) {
            return {
              rows:
                options.workspace && (!options.invitation || acceptedInvitation)
                  ? [options.workspace]
                  : [],
            };
          }
          return { rows: [] };
        },
      }),
    ),
  };
}

const sharedWorkspace = {
  id: workspaceId,
  name: "Alpha's workspace",
  role: "admin",
  slug: "alpha-workspace",
};

beforeEach(() => {
  vi.clearAllMocks();
  withSystemTransactionEffect.mockImplementation((_env, operation) =>
    operation(effectClient({ workspace: sharedWorkspace })),
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
      operation(effectClient({ collision: true, workspace: sharedWorkspace })),
    );
    const error = await resolveActor(env, identity, request()).catch((cause) => cause);
    expect(error).toBeInstanceOf(CoreApiError);
    expect(error).toMatchObject({ code: "identity_conflict", status: 409 });
  });

  it("rejects inaccessible workspace selections with 403", async () => {
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(effectClient({ workspace: null })),
    );
    await expect(
      resolveActor(env, identity, request({ "x-workspace-id": teamWorkspaceId })),
    ).rejects.toMatchObject({ code: "workspace_forbidden", status: 403 });
  });

  it("requires a workspace membership for an authenticated account", async () => {
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(effectClient({ workspace: null })),
    );
    await expect(resolveActor(env, identity, request())).rejects.toMatchObject({
      code: "workspace_membership_required",
      status: 403,
    });
  });

  it("binds the verified JWT identity to the internal user upsert", async () => {
    const client = effectClient({ workspace: sharedWorkspace });
    withSystemTransactionEffect.mockImplementation((_env, operation) => operation(client));
    await resolveActor(env, identity, request());
    const upsert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO users"),
    );
    expect(upsert?.[1]).toEqual(["user_better_alpha", "alpha@example.com", "Alpha User", null]);
  });

  it("resolves the shared workspace with the authoritative membership role", async () => {
    const actor = await resolveActor(env, identity, request());
    expect(actor).toEqual({
      authUserId: "user_better_alpha",
      claims: {
        organizationId: workspaceId,
        organizationRole: "admin",
        subject: "user_better_alpha",
        userId,
      },
      displayName: "Alpha User",
      email: "alpha@example.com",
      isInstallationOwner: false,
      role: "admin",
      userId,
      workspace: {
        id: workspaceId,
        name: "Alpha's workspace",
        slug: "alpha-workspace",
      },
    });
  });

  it("returns a Viewer role without upgrading it", async () => {
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(effectClient({ workspace: { ...sharedWorkspace, role: "viewer" } })),
    );
    const actor = await resolveActor(env, identity, request());
    expect(actor.role).toBe("viewer");
  });

  it("repairs the owner membership to Admin and reports ownership", async () => {
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(
        effectClient({
          user: { installation_owner: true },
          workspace: { ...sharedWorkspace, role: "viewer" },
        }),
      ),
    );
    const actor = await resolveActor(env, identity, request());
    expect(actor.isInstallationOwner).toBe(true);
    expect(actor.role).toBe("admin");
  });

  it("rejects a suspended account", async () => {
    withSystemTransactionEffect.mockImplementation((_env, operation) =>
      operation(
        effectClient({
          user: { installation_owner: false, suspended_at: new Date().toISOString() },
          workspace: sharedWorkspace,
        }),
      ),
    );
    await expect(resolveActor(env, identity, request())).rejects.toMatchObject({
      code: "account_suspended",
      status: 403,
    });
  });

  it("accepts a pending invitation for the verified email", async () => {
    const client = effectClient({ invitation: true, workspace: sharedWorkspace });
    withSystemTransactionEffect.mockImplementation((_env, operation) => operation(client));
    await resolveActor(env, identity, request());
    const membership = client.query.mock.calls.find(
      ([sql, params]) =>
        String(sql).includes("INSERT INTO org_members (org_id, user_id, role)") &&
        Array.isArray(params) &&
        params.length === 3,
    );
    expect(membership?.[1]).toEqual([workspaceId, userId, "editor"]);
    const accepted = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE workspace_invitations"),
    );
    expect(accepted).toBeDefined();
    const audit = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO workspace_audit_entries"),
    );
    expect(audit?.[1]?.[9]).toBe("actor-resolution-test-request");
  });

  it("reads the user row back when the profile upsert changes nothing", async () => {
    const client = effectClient({ upsertReturnsRow: false, workspace: sharedWorkspace });
    withSystemTransactionEffect.mockImplementation((_env, operation) => operation(client));
    const actor = await resolveActor(env, identity, request());
    expect(actor.userId).toBe(userId);
    const selects = client.query.mock.calls.filter(([sql]) =>
      String(sql).includes("FROM users WHERE auth_user_id"),
    );
    expect(selects.length).toBe(1);
  });
});
