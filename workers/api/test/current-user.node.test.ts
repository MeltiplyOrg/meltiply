import type { JwtIdentity, SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { ActiveOrganizationRequiredError, DatabaseError } from "@meltiply/domain";
import { effectTracerLayer, type LogContext, type OtlpSpanInput } from "@meltiply/observability";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import { CoreApiError } from "../src/core-types";
import {
  createCurrentUserServiceLive,
  createCurrentUserServiceTest,
  CurrentUserService,
} from "../src/effect/services/current-user";
import type { ApiWorkerEnv } from "../src/env";
import { fakeEnv } from "../test-support/fakes";

type UserProfile = components["schemas"]["UserProfile"];

const baseEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

const alphaActor: ResolvedActor = {
  authUserId: "auth_user_alpha",
  claims: {
    organizationId: "20000000-0000-4000-8000-000000000001",
    organizationRole: "admin",
    subject: "auth_user_alpha",
    userId: "10000000-0000-4000-8000-000000000001",
  },
  displayName: "Alpha Admin",
  email: "alpha@example.test",
  isInstallationOwner: false,
  role: "admin",
  userId: "10000000-0000-4000-8000-000000000001",
  workspace: {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Alpha",
    slug: "alpha",
  },
};

const viewerActor: ResolvedActor = {
  authUserId: "auth_user_personal",
  claims: {
    organizationId: "20000000-0000-4000-8000-000000000011",
    organizationRole: "viewer",
    subject: "auth_user_personal",
    userId: "10000000-0000-4000-8000-000000000011",
  },
  displayName: "Personal Viewer",
  email: "personal@example.com",
  isInstallationOwner: false,
  role: "viewer",
  userId: "10000000-0000-4000-8000-000000000011",
  workspace: {
    id: "20000000-0000-4000-8000-000000000011",
    name: "Shared workspace",
    slug: "shared-workspace",
  },
};

function profileFor(actor: ResolvedActor): UserProfile {
  return {
    active_organization: {
      id: actor.workspace.id,
      name: actor.workspace.name,
      role: actor.role,
      slug: actor.workspace.slug,
    },
    avatar_url: null,
    created_at: "2026-09-12T12:00:00.000Z",
    display_name: actor.displayName,
    email: actor.email,
    id: actor.userId,
    is_installation_owner: actor.isInstallationOwner,
    updated_at: "2026-09-12T12:00:00.000Z",
  };
}

const jwtIdentity = (actor: ResolvedActor): JwtIdentity => ({
  email: actor.email,
  name: actor.displayName ?? undefined,
  subject: actor.authUserId,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CurrentUserService", () => {
  it("createCurrentUserServiceTest returns the injected profile", async () => {
    const profile = profileFor(alphaActor);
    const layer = createCurrentUserServiceTest({
      getCurrentUser: () => Effect.succeed(profile),
    });

    expect(
      await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(CurrentUserService, (s) => s.getCurrentUser()),
          layer,
        ),
      ),
    ).toEqual(profile);
  });

  it("createCurrentUserServiceTest defaults to ActiveOrganizationRequiredError", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.flatMap(CurrentUserService, (s) => s.getCurrentUser()),
          createCurrentUserServiceTest(),
        ),
      ),
    );

    expect(error).toEqual(
      new ActiveOrganizationRequiredError({
        message: "The authenticated identity is not an active organization member.",
      }),
    );
  });

  it("createCurrentUserServiceLive passes env and claims to the loader and returns the profile", async () => {
    const env = fakeEnv();
    const profile = profileFor(alphaActor);
    const received: Array<{ claims: SessionClaims; env: ApiWorkerEnv }> = [];
    const layer = createCurrentUserServiceLive(
      env,
      alphaActor.claims,
      async (passedEnv, claims) => {
        received.push({ claims, env: passedEnv });
        return profile;
      },
    );

    expect(
      await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(CurrentUserService, (s) => s.getCurrentUser()),
          layer,
        ),
      ),
    ).toEqual(profile);
    expect(received).toEqual([{ claims: alphaActor.claims, env }]);
  });

  it("createCurrentUserServiceLive fails with ActiveOrganizationRequiredError when loader returns null", async () => {
    const layer = createCurrentUserServiceLive(fakeEnv(), alphaActor.claims, async () => null);

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.flatMap(CurrentUserService, (s) => s.getCurrentUser()),
          layer,
        ),
      ),
    );

    expect(error).toBeInstanceOf(ActiveOrganizationRequiredError);
  });

  it("createCurrentUserServiceLive maps loader exceptions to DatabaseError preserving cause", async () => {
    const cause = new Error("connection terminated unexpectedly");
    const layer = createCurrentUserServiceLive(fakeEnv(), alphaActor.claims, async () => {
      throw cause;
    });

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          Effect.flatMap(CurrentUserService, (s) => s.getCurrentUser()),
          layer,
        ),
      ),
    );

    expect(error).toEqual(
      new DatabaseError({ cause, message: "connection terminated unexpectedly" }),
    );
  });

  it("createCurrentUserServiceLive records a current_user.load span with identity attributes", async () => {
    const exportedSpans: OtlpSpanInput[] = [];
    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace-live-user",
      version: "1.0.0",
    };
    const layer = createCurrentUserServiceLive(fakeEnv(), alphaActor.claims, async () =>
      profileFor(alphaActor),
    );

    await Effect.runPromise(
      Effect.flatMap(CurrentUserService, (s) => s.getCurrentUser()).pipe(
        Effect.provide(layer),
        Effect.provide(
          effectTracerLayer(context, {
            exporter: async (_env, span) => {
              exportedSpans.push(span);
            },
          }),
        ),
      ),
    );

    expect(exportedSpans).toHaveLength(1);
    expect(exportedSpans[0]).toMatchObject({
      attributes: {
        "organization.id": alphaActor.workspace.id,
        "user.id": alphaActor.authUserId,
      },
      name: "current_user.load",
      status: "ok",
    });
  });
});

describe("GET /api/v1/users/me", () => {
  it.each([
    ["Admin actor", alphaActor],
    ["Viewer actor", viewerActor],
  ])("returns the normative profile for a %s", async (_example, actor) => {
    const expected = profileFor(actor);
    const seenClaims: SessionClaims[] = [];
    const app = createApiApp({
      loadCurrentUser: async (_env, claims) => {
        seenClaims.push(claims);
        return expected;
      },
      resolveActor: async () => actor,
      verifyJwtToken: async () => jwtIdentity(actor),
    });

    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Authorization: "Bearer test-only.jwt" } },
      baseEnv,
    );

    expect(response.status).toEqual(200);
    expect(await response.json()).toEqual(expected);
    expect(seenClaims).toEqual([actor.claims]);
  });

  it("exports correlated users.me.get and current_user.load spans", async () => {
    const spanNames: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/v1/traces") && typeof init?.body === "string") {
        const payload: unknown = JSON.parse(init.body);
        const name = (
          payload as {
            resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ name?: string }> }> }>;
          }
        ).resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.name;
        if (name) spanNames.push(name);
      }
      return new Response("ok");
    });

    const app = createApiApp({
      loadCurrentUser: async () => profileFor(alphaActor),
      resolveActor: async () => alphaActor,
      verifyJwtToken: async () => jwtIdentity(alphaActor),
    });

    const response = await app.request(
      "/api/v1/users/me",
      {
        headers: {
          Authorization: "Bearer test-only.jwt",
          "X-Request-ID": "req-trace-users-me",
        },
      },
      baseEnv,
    );

    expect(response.status).toEqual(200);
    expect(spanNames).toEqual(expect.arrayContaining(["current_user.load", "users.me.get"]));
  });

  it("fails closed with 403 when actor resolution rejects the workspace", async () => {
    const app = createApiApp({
      loadCurrentUser: async () => profileFor(alphaActor),
      resolveActor: async () => {
        throw new CoreApiError(
          403,
          "workspace_forbidden",
          "The selected workspace is not accessible to this account.",
        );
      },
      verifyJwtToken: async () => jwtIdentity(alphaActor),
    });

    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Authorization: "Bearer test-only.jwt" } },
      baseEnv,
    );

    expect(response.status).toEqual(403);
    expect(await response.json()).toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });
});
