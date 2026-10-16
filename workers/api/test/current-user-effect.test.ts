// Unit tests exercise resolveActor + service seams only: the database module
// pulls in `pg`, which cannot load in the workers vitest pool. Mocking it
// keeps actor resolution's dynamic database import from evaluating pg.
import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("../src/database", () => ({}));
import { Effect } from "effect";
import type { JwtIdentity } from "@meltiply/auth";
import { ActiveOrganizationRequiredError } from "@meltiply/domain";
import { effectTracerLayer, type LogContext, type OtlpSpanInput } from "@meltiply/observability";
import type { components } from "@meltiply/contracts/schema";

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import type { ApiWorkerEnv } from "../src/env";
import {
  CurrentUserService,
  createCurrentUserServiceTest,
  createCurrentUserServiceLive,
} from "../src/effect/services/current-user";

type UserProfile = components["schemas"]["UserProfile"];

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
  role: "admin",
  userId: "10000000-0000-4000-8000-000000000001",
  workspace: {
    id: "20000000-0000-4000-8000-000000000001",
    isPersonal: false,
    name: "Alpha",
    slug: "alpha",
  },
};

const mockProfile: UserProfile = {
  active_organization: {
    id: "20000000-0000-4000-8000-000000000001",
    name: "Alpha",
    role: "admin",
    slug: "alpha",
  },
  avatar_url: null,
  created_at: "2026-09-12T12:00:00.000Z",
  display_name: "Alpha User",
  email: "alpha@example.test",
  id: "10000000-0000-4000-8000-000000000001",
  updated_at: "2026-09-12T12:00:00.000Z",
};

// Verified Better Auth JWT identity returned by the `verifyJwtToken` test
// double; the bearer JWT is the only credential protected routes may accept.
const jwtIdentity: JwtIdentity = {
  email: "alpha@example.test",
  name: "Alpha User",
  subject: actor.authUserId,
};

// JWT bearer Authorization header standing in for the Better Auth session
// cookie on protected-route requests.
const bearerAuthorization = "Bearer test-only.jwt";

describe("CurrentUserService (Effect v4 application service)", () => {
  it("returns user profile successfully through Effect service contract", async () => {
    const testLayer = createCurrentUserServiceTest({
      getCurrentUser: () => Effect.succeed(mockProfile),
    });

    const program = Effect.gen(function* () {
      const service = yield* CurrentUserService;
      return yield* service.getCurrentUser();
    }).pipe(Effect.provide(testLayer));

    const result = await Effect.runPromise(program);
    expect(result).toEqual(mockProfile);
  });

  it("fails with ActiveOrganizationRequiredError when user has no active organization", async () => {
    const testLayer = createCurrentUserServiceTest({
      getCurrentUser: () =>
        Effect.fail(
          new ActiveOrganizationRequiredError({
            message: "The authenticated identity is not an active organization member.",
          }),
        ),
    });

    const program = Effect.gen(function* () {
      const service = yield* CurrentUserService;
      return yield* service.getCurrentUser();
    }).pipe(
      Effect.provide(testLayer),
      Effect.catchTag("ActiveOrganizationRequiredError", (err) =>
        Effect.succeed({ caught: err.code, status: err.status }),
      ),
    );

    const result = await Effect.runPromise(program);
    expect(result).toEqual({
      caught: "active_organization_required",
      status: 403,
    });
  });

  it("createCurrentUserServiceTest defaults to ActiveOrganizationRequiredError when called without args", async () => {
    const defaultLayer = createCurrentUserServiceTest();

    const program = Effect.gen(function* () {
      const service = yield* CurrentUserService;
      return yield* service.getCurrentUser();
    }).pipe(
      Effect.provide(defaultLayer),
      Effect.catchTag("ActiveOrganizationRequiredError", (err) => Effect.succeed(err.code)),
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe("active_organization_required");
  });

  it("createCurrentUserServiceLive loads user successfully through loader", async () => {
    const mockEnv = {} as unknown as ApiWorkerEnv;
    const liveLayer = createCurrentUserServiceLive(mockEnv, actor.claims, async () => mockProfile);

    const program = Effect.gen(function* () {
      const service = yield* CurrentUserService;
      return yield* service.getCurrentUser();
    }).pipe(Effect.provide(liveLayer));

    const result = await Effect.runPromise(program);
    expect(result).toEqual(mockProfile);
  });

  it("createCurrentUserServiceLive fails with ActiveOrganizationRequiredError when user is null", async () => {
    const mockEnv = {} as unknown as ApiWorkerEnv;
    const liveLayer = createCurrentUserServiceLive(mockEnv, actor.claims, async () => null);

    const program = Effect.gen(function* () {
      const service = yield* CurrentUserService;
      return yield* service.getCurrentUser();
    }).pipe(
      Effect.provide(liveLayer),
      Effect.catchTag("ActiveOrganizationRequiredError", (err) => Effect.succeed(err.code)),
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe("active_organization_required");
  });

  it("createCurrentUserServiceLive passes actor claims to the loader", async () => {
    const mockEnv = {} as unknown as ApiWorkerEnv;
    const loader = vi.fn(async () => mockProfile);
    const liveLayer = createCurrentUserServiceLive(mockEnv, actor.claims, loader);

    const program = Effect.gen(function* () {
      const service = yield* CurrentUserService;
      return yield* service.getCurrentUser();
    }).pipe(Effect.provide(liveLayer));

    await Effect.runPromise(program);
    expect(loader).toHaveBeenCalledWith(mockEnv, actor.claims);
  });

  it("createCurrentUserServiceLive maps database exception to DatabaseError with cause preserved", async () => {
    const mockEnv = {} as unknown as ApiWorkerEnv;
    const originalError = new Error("connection terminated unexpectedly");
    const liveLayer = createCurrentUserServiceLive(mockEnv, actor.claims, async () => {
      throw originalError;
    });

    const program = Effect.gen(function* () {
      const service = yield* CurrentUserService;
      return yield* service.getCurrentUser();
    }).pipe(
      Effect.provide(liveLayer),
      Effect.catchTag("DatabaseError", (err) =>
        Effect.succeed({
          cause: err.cause,
          code: err.code,
          message: err.message,
          status: err.status,
        }),
      ),
    );

    const result = await Effect.runPromise(program);
    expect(result).toEqual({
      cause: originalError,
      code: "internal_error",
      message: "connection terminated unexpectedly",
      status: 500,
    });
  });

  it("createCurrentUserServiceLive wraps loader in current_user.load span with attributes", async () => {
    const mockEnv = {} as unknown as ApiWorkerEnv;

    const exportedSpans: OtlpSpanInput[] = [];
    const mockExporter = vi.fn(async (_env: unknown, span: OtlpSpanInput) => {
      exportedSpans.push(span);
    });

    const context: LogContext = {
      environment: "test",
      service: "api",
      trace_id: "trace-live-user",
      version: "1.0.0",
    };

    const liveLayer = createCurrentUserServiceLive(mockEnv, actor.claims, async () => mockProfile);

    const program = Effect.gen(function* () {
      const service = yield* CurrentUserService;
      return yield* service.getCurrentUser();
    }).pipe(Effect.provide(liveLayer), Effect.provide(effectTracerLayer(context, mockExporter)));

    const result = await Effect.runPromise(program);
    expect(result).toEqual(mockProfile);

    expect(mockExporter).toHaveBeenCalledTimes(1);
    expect(exportedSpans[0]?.name).toBe("current_user.load");
    expect(exportedSpans[0]?.attributes?.["user.id"]).toBe(actor.authUserId);
    expect(exportedSpans[0]?.attributes?.["organization.id"]).toBe(actor.workspace.id);
    expect(exportedSpans[0]?.status).toBe("ok");
  });

  it("GET /api/v1/users/me serves the resolved actor profile with correlated spans", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const app = createApiApp({
      betterAuth: {
        api: { getSession: async () => null },
        handler: async () => new Response("ok"),
      } as never,
      loadCurrentUser: async () => mockProfile,
      resolveActor: async () => actor,
      verifyJwtToken: async () => jwtIdentity,
    });

    const testEnv = {
      ALLOWED_ORIGINS: "http://localhost:3000",
      ENVIRONMENT: "test",
      VERSION: "1.0.0-target.0",
    } as ApiWorkerEnv;

    const response = await app.request(
      "/api/v1/users/me",
      {
        headers: {
          Authorization: bearerAuthorization,
          "X-Request-ID": "req-trace-users-me",
        },
      },
      testEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      email: "alpha@example.test",
    });

    // Check OTLP trace exports to Tempo receiver
    const traceCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/v1/traces"));
    expect(traceCalls.length).toBeGreaterThanOrEqual(2);

    const exportedSpanNames = traceCalls.map((call) => {
      const body = JSON.parse(String(call[1]?.body ?? "{}"));
      return body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.name;
    });

    expect(exportedSpanNames).toContain("current_user.load");
    expect(exportedSpanNames).toContain("users.me.get");

    vi.unstubAllGlobals();
  });

  it("GET /api/v1/users/me returns 403 when actor resolution rejects the workspace", async () => {
    const app = createApiApp({
      betterAuth: {
        api: { getSession: async () => null },
        handler: async () => new Response("ok"),
      } as never,
      loadCurrentUser: async () => mockProfile,
      resolveActor: async () => {
        const { CoreApiError } = await import("../src/core-types");
        throw new CoreApiError(
          403,
          "workspace_forbidden",
          "The selected workspace is not accessible to this account.",
        );
      },
      verifyJwtToken: async () => jwtIdentity,
    });

    const testEnv = {
      ALLOWED_ORIGINS: "http://localhost:3000",
      ENVIRONMENT: "test",
      VERSION: "1.0.0-target.0",
    } as ApiWorkerEnv;

    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Authorization: bearerAuthorization } },
      testEnv,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });
});
