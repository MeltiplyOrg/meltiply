import { describe, expect, it, vi } from "vite-plus/test";

// Unit tests exercise resolveActor + loader seams only: the database module
// pulls in `pg`, which cannot load in the workers vitest pool. Mocking it
// keeps actor resolution's dynamic database import from evaluating pg.
vi.mock("../src/database", () => ({}));

import type { JwtIdentity } from "@meltiply/auth";
import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import type { ApiWorkerEnv } from "../src/env";

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

// Better Auth subject plus the internal Workspace membership the server
// resolved from org_members, mirroring the confirmed actor claims contract:
// subject = Better Auth user id, userId = internal users.id UUID,
// organizationId = resolved workspace UUID, organizationRole = member role.
const alphaActor: ResolvedActor = {
  authUserId: "auth_user_alpha",
  claims: {
    organizationId: "20000000-0000-4000-8000-000000000001",
    organizationRole: "admin",
    subject: "auth_user_alpha",
    userId: "10000000-0000-4000-8000-000000000001",
  },
  role: "admin",
  userId: "10000000-0000-4000-8000-000000000001",
  workspace: {
    id: "20000000-0000-4000-8000-000000000001",
    isPersonal: false,
    name: "Alpha",
    plan: "pro",
    slug: "alpha",
  },
};

const personalActor: ResolvedActor = {
  authUserId: "auth_user_personal",
  claims: {
    organizationId: "20000000-0000-4000-8000-000000000011",
    organizationRole: "member",
    subject: "auth_user_personal",
    userId: "10000000-0000-4000-8000-000000000011",
  },
  role: "member",
  userId: "10000000-0000-4000-8000-000000000011",
  workspace: {
    id: "20000000-0000-4000-8000-000000000011",
    isPersonal: true,
    name: "Personal workspace",
    plan: "free",
    slug: "personal-workspace",
  },
};

function userProfileFor(actor: ResolvedActor) {
  return {
    active_organization: {
      id: actor.workspace.id,
      name: actor.workspace.name,
      plan: actor.workspace.plan,
      role: actor.role,
      slug: actor.workspace.slug,
    },
    avatar_url: null,
    created_at: "2026-01-01T00:00:00.000Z",
    display_name: actor.authUserId,
    email: `${actor.authUserId}@example.test`,
    id: actor.userId,
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

// JWT bearer Authorization header standing in for the Better Auth session
// cookie on protected-route requests.
const bearerAuthorization = "Bearer test-only.jwt";

// Builds the verified Better Auth JWT identity the `verifyJwtToken` test
// double returns for the given actor; the bearer JWT is the only credential
// protected routes may accept.
function jwtIdentityFor(actor: ResolvedActor): JwtIdentity {
  return {
    email: `${actor.authUserId}@example.test`,
    name: actor.authUserId,
    subject: actor.authUserId,
  };
}

// Builds an app whose JWT bearer middleware resolves to the given actor without
// a session cookie or database, and whose user loader asserts it receives the
// actor's identity-bearing claims.
function appForActor(actor: ResolvedActor) {
  return createApiApp({
    betterAuth: {
      api: { getSession: async () => null },
      handler: async () => new Response("ok"),
    } as never,
    loadCurrentUser: async (_env, claims) => {
      expect(claims).toMatchObject(actor.claims);
      return userProfileFor(actor);
    },
    resolveActor: async () => actor,
    verifyJwtToken: async () => jwtIdentityFor(actor),
  });
}

describe("authenticated API slices", () => {
  it("returns the normative current-user shape from the resolved actor", async () => {
    const app = appForActor(alphaActor);

    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Authorization: bearerAuthorization } },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      active_organization: { id: alphaActor.workspace.id, role: "admin" },
      email: "auth_user_alpha@example.test",
      id: alphaActor.userId,
    });
  });

  it("returns a personal workspace for an actor without a team membership", async () => {
    const app = appForActor(personalActor);
    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Authorization: bearerAuthorization } },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      active_organization: {
        id: personalActor.workspace.id,
        name: "Personal workspace",
        role: "member",
      },
      email: "auth_user_personal@example.test",
    });
  });

  it("fails closed when actor resolution rejects the request", async () => {
    const app = createApiApp({
      betterAuth: {
        api: { getSession: async () => null },
        handler: async () => new Response("ok"),
      } as never,
      loadCurrentUser: async () => userProfileFor(alphaActor),
      resolveActor: async () => {
        const { CoreApiError } = await import("../src/core-types");
        throw new CoreApiError(
          403,
          "workspace_forbidden",
          "The selected workspace is not accessible to this account.",
        );
      },
      verifyJwtToken: async () => jwtIdentityFor(alphaActor),
    });
    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Authorization: bearerAuthorization } },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });
});
