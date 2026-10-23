import type { JwtIdentity } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { createExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createApiApp } from "../src/app";
import type { ResolvedActor } from "../src/actor-resolution";
import { CoreApiError } from "../src/core-types";
import worker from "../src/index";
import type { ApiWorkerEnv, AutomationRelayStub, OAuthStateStub } from "../src/env";
import { requiresEmailVerification, validateProductionBindings } from "../src/env";
import { logRecords } from "./log-records";

afterEach(() => {
  vi.restoreAllMocks();
});

const { authenticatedPoolFor, release, systemPoolFor } = vi.hoisted(() => {
  const release = vi.fn();
  const client = {
    query: vi.fn(async () => ({ rows: [{ ok: 1 }] })),
    release,
  };
  const pool = { connect: vi.fn(async () => client) };
  return {
    authenticatedPoolFor: vi.fn(() => pool),
    release,
    systemPoolFor: vi.fn(() => pool),
  };
});

vi.mock("../src/database", () => ({
  authenticatedPoolFor,
  systemPoolFor,
}));

const stagingEnv = {
  ALLOWED_ORIGINS: "https://staging.example.com",
  ASSETS: {} as R2Bucket,
  AUTOMATION: {} as AutomationRelayStub,
  BETTER_AUTH_SECRET: "staging-auth-secret-32-chars-minimum",
  AUTH_SETUP_SECRET: "staging-bootstrap-placeholder-not-a-real-secret",
  DB_AUTHENTICATED: {} as Hyperdrive,
  DB_SYSTEM: {} as Hyperdrive,
  ENVIRONMENT: "staging",
  APP_URL: "https://staging.example.com",
  MAIL: { send: vi.fn(async () => ({ messageId: "test-message" })) },
  MAIL_FROM_ADDRESS: "no-reply@staging.example.com",
  MAIL_FROM_NAME: "Meltiply Staging",
  OAUTH_STATE: {} as DurableObjectNamespace<OAuthStateStub>,
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_ACCOUNT_ID: "r2-account",
  R2_BUCKET_NAME: "assets",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  TOKEN_ENCRYPTION_KEY: "token-key",
  VERSION: "test",
} satisfies ApiWorkerEnv;

const actor: ResolvedActor = {
  authUserId: "user_better_alpha",
  claims: {
    organizationId: "00000000-0000-4000-8000-000000000001",
    organizationRole: "admin",
    subject: "user_better_alpha",
    userId: "00000000-0000-4000-8000-000000000011",
  },
  displayName: "Alpha Admin",
  email: "alpha@example.com",
  isInstallationOwner: false,
  role: "admin",
  userId: "00000000-0000-4000-8000-000000000011",
  workspace: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Alpha",
    slug: "alpha",
  },
};

// Verified Better Auth JWT identity returned by the `verifyJwtToken` test
// double; the bearer JWT is the only credential protected routes may accept.
const jwtIdentity: JwtIdentity = {
  email: "alpha@example.com",
  name: "Alpha User",
  subject: "user_better_alpha",
};

const bearerAuthorization = "Bearer test-only.jwt";

type UserProfile = components["schemas"]["UserProfile"];

/**
 * Minimal contract-shaped profile returned by the `loadCurrentUser` test double
 * whenever a route must reach the current-user handler.
 */
const userProfile: UserProfile = {
  active_organization: {
    id: actor.workspace.id,
    name: "Alpha",
    role: "admin",
    slug: "alpha",
  },
  avatar_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  display_name: "Alpha User",
  email: "alpha@example.com",
  id: actor.userId,
  is_installation_owner: true,
  updated_at: "2026-01-01T00:00:00.000Z",
};

const fakeBetterAuth = {
  api: {
    getSession: vi.fn(async () => null),
  },
  handler: vi.fn(async (request: Request) => {
    return new Response(JSON.stringify({ status: "ok", url: request.url }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  }),
};

describe("API Worker foundation", () => {
  it("serves contract-conformant liveness without checking dependencies", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await exports.default.fetch(
      new Request("http://example.test/api/v1/health", {
        headers: {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "X-Request-ID": "request-health-1",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toBe("request-health-1");
    await expect(response.json()).resolves.toEqual({
      environment: "local",
      status: "ok",
      version: "1.0.0-target.0",
    });
    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          event: "http_request",
          latency_ms: expect.any(Number),
          outcome: 200,
          retry_class: "none",
          route: "/api/v1/health",
        }),
        environment: "local",
        request_id: "request-health-1",
        service: "api",
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      }),
    );
  });

  it("validates accepted provider bindings without making false mandatory", () => {
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        THREADS_LIVE_ACCEPTED: "false",
      }),
    ).not.toThrow();
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        AUTOMATION: undefined,
      }),
    ).toThrow("missing required Worker bindings: AUTOMATION");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        FACEBOOK_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("FACEBOOK_LIVE_ACCEPTED must be true or false");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        FACEBOOK_LIVE_ACCEPTED: "true",
      }),
    ).toThrow("Facebook provider requires client ID and client secret");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        FACEBOOK_CLIENT_ID: "facebook-client",
        FACEBOOK_CLIENT_SECRET: "facebook-secret",
        FACEBOOK_LIVE_ACCEPTED: "true",
      }),
    ).not.toThrow();
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        INSTAGRAM_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("INSTAGRAM_LIVE_ACCEPTED must be true or false");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED must be true or false");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED: "true",
        INSTAGRAM_LIVE_ACCEPTED: "false",
      }),
    ).toThrow("requires INSTAGRAM_LIVE_ACCEPTED=true");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        INSTAGRAM_LIVE_ACCEPTED: "true",
      }),
    ).toThrow("Instagram provider requires client ID and client secret");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        INSTAGRAM_CLIENT_ID: "instagram-client",
        INSTAGRAM_CLIENT_SECRET: "instagram-secret",
        INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED: "true",
        INSTAGRAM_LIVE_ACCEPTED: "true",
      }),
    ).not.toThrow();
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        THREADS_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("must be true or false");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        THREADS_ENGAGEMENT_LIVE_ACCEPTED: "yes",
        THREADS_LIVE_ACCEPTED: "false",
      }),
    ).toThrow("THREADS_ENGAGEMENT_LIVE_ACCEPTED must be true or false");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        THREADS_ENGAGEMENT_LIVE_ACCEPTED: "true",
        THREADS_LIVE_ACCEPTED: "false",
      }),
    ).toThrow("requires THREADS_LIVE_ACCEPTED=true");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        THREADS_LIVE_ACCEPTED: "true",
      }),
    ).toThrow("requires client ID and client secret");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        THREADS_CLIENT_ID: "threads-client",
        THREADS_CLIENT_SECRET: "threads-secret",
        THREADS_LIVE_ACCEPTED: "true",
      }),
    ).not.toThrow();
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        TIKTOK_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("TIKTOK_LIVE_ACCEPTED must be true or false");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        YOUTUBE_LIVE_ACCEPTED: "yes",
      }),
    ).toThrow("YOUTUBE_LIVE_ACCEPTED must be true or false");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        YOUTUBE_LIVE_ACCEPTED: "true",
      }),
    ).toThrow("YouTube provider requires client ID and client secret");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        YOUTUBE_LIVE_ACCEPTED: "true",
        YOUTUBE_SHORTS_CLIENT_ID: "youtube-client",
        YOUTUBE_SHORTS_CLIENT_SECRET: "youtube-secret",
      }),
    ).not.toThrow();
  });

  it.each(["BETTER_AUTH_SECRET", "AUTH_SETUP_SECRET"] as const)(
    "rejects missing or short %s in staging",
    (name) => {
      expect(() => validateProductionBindings({ ...stagingEnv, [name]: undefined })).toThrow();
      expect(() => validateProductionBindings({ ...stagingEnv, [name]: "short" })).toThrow();
    },
  );

  it("requires a usable mail binding and valid sender in staging", () => {
    expect(() => validateProductionBindings({ ...stagingEnv, MAIL: undefined })).toThrow(
      "MAIL must be an Email Sending binding",
    );
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        MAIL: {} as ApiWorkerEnv["MAIL"],
      }),
    ).toThrow("MAIL must be an Email Sending binding");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        MAIL_FROM_ADDRESS: undefined,
      }),
    ).toThrow("MAIL_FROM_ADDRESS/MAIL_FROM_NAME must configure a valid sender");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        MAIL_FROM_ADDRESS: "Meltiply <no-reply@staging.example.com>",
      }),
    ).toThrow("MAIL_FROM_ADDRESS/MAIL_FROM_NAME must configure a valid sender");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        MAIL_FROM_ADDRESS: "no-reply@staging.example.com\r\nBcc: evil@x.test",
      }),
    ).toThrow("MAIL_FROM_ADDRESS/MAIL_FROM_NAME must configure a valid sender");
    expect(() =>
      validateProductionBindings({
        ...stagingEnv,
        MAIL_FROM_NAME: "Meltiply\nBcc: evil@x.test",
      }),
    ).toThrow("MAIL_FROM_ADDRESS/MAIL_FROM_NAME must configure a valid sender");
  });

  it("allows missing mail when verification is explicitly disabled", () => {
    const env = {
      ...stagingEnv,
      MAIL: undefined,
      MAIL_FROM_ADDRESS: undefined,
      MAIL_FROM_NAME: undefined,
      REQUIRE_EMAIL_VERIFICATION: "false",
    };
    expect(requiresEmailVerification(env)).toBe(false);
    expect(() => validateProductionBindings(env)).not.toThrow();
  });

  it("keeps verification enabled by default in deployed environments", () => {
    expect(requiresEmailVerification(stagingEnv)).toBe(true);
    expect(requiresEmailVerification({ ...stagingEnv, ENVIRONMENT: "local" })).toBe(false);
    expect(requiresEmailVerification({ ...stagingEnv, REQUIRE_EMAIL_VERIFICATION: "true" })).toBe(
      true,
    );
  });

  it("logs invalid staging configuration and returns only a generic response", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request("https://api.example.test/api/v1/health", {
        headers: { "X-Request-ID": "request-config-1" },
      }) as Parameters<NonNullable<typeof worker.fetch>>[0],
      {
        ...stagingEnv,
        BETTER_AUTH_SECRET: undefined,
      },
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("An error has occurred.");
    expect(logRecords(error)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "configuration_invalid",
          event: "worker_configuration_failed",
          unavailable_bindings: ["BETTER_AUTH_SECRET"],
        }),
        error: expect.objectContaining({
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          name: "Error",
        }),
        request_id: "request-config-1",
      }),
    );
  });

  it("logs a safe diagnostic for unhandled API errors without exposing the cause", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createApiApp({
      betterAuth: fakeBetterAuth as never,
      loadCurrentUser: async () => {
        throw new TypeError("password=private-database-value");
      },
      resolveActor: async () => actor,
      verifyJwtToken: async () => jwtIdentity,
    });
    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Authorization: bearerAuthorization } },
      {
        ALLOWED_ORIGINS: "http://localhost:3000",
        ENVIRONMENT: "test",
        VERSION: "test",
      },
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("An unexpected error occurred.");
    expect(body).not.toContain("private-database-value");
    expect(logRecords(error)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "internal_error",
          event: "request_failed",
        }),
        error: expect.objectContaining({
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          name: "TypeError",
        }),
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-database-value");
  });

  it("fails readiness when required bindings are absent", async () => {
    const response = await exports.default.fetch("http://example.test/api/v1/ready");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      components: expect.arrayContaining([{ name: "DB_SYSTEM", status: "unavailable" }]),
      status: "unavailable",
    });
  });

  it("reports auth and mail bindings unavailable in staging readiness", async () => {
    const app = createApiApp();
    const response = await app.request(
      "/api/v1/ready",
      {},
      {
        ...stagingEnv,
        BETTER_AUTH_SECRET: undefined,
        MAIL: undefined,
        MAIL_FROM_ADDRESS: "not-an-email",
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      components: expect.arrayContaining([
        { name: "BETTER_AUTH_SECRET", status: "unavailable" },
        { name: "MAIL", status: "unavailable" },
        { name: "MAIL_FROM_ADDRESS", status: "unavailable" },
      ]),
      status: "unavailable",
    });
  });

  it("reports ready without mail when verification is disabled", async () => {
    const app = createApiApp();
    const response = await app.request(
      "/api/v1/ready",
      {},
      {
        ...stagingEnv,
        MAIL: undefined,
        MAIL_FROM_ADDRESS: undefined,
        MAIL_FROM_NAME: undefined,
        REQUIRE_EMAIL_VERIFICATION: "false",
      },
    );
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    for (const name of ["MAIL", "MAIL_FROM_ADDRESS"]) {
      expect(body).not.toEqual(
        expect.objectContaining({
          components: expect.arrayContaining([expect.objectContaining({ name })]),
        }),
      );
    }
  });

  it("reports mail ready without calling send on the binding", async () => {
    const send = vi.fn(async () => ({ messageId: "test-message" }));
    const probeDatabase = vi.fn(async () => undefined);
    const app = createApiApp({ probeDatabase });
    const response = await app.request(
      "/api/v1/ready",
      {},
      {
        ...stagingEnv,
        MAIL: { send },
        DB_AUTHENTICATED: {
          connectionString: "postgres://authenticated-mail",
        } as Hyperdrive,
        DB_SYSTEM: { connectionString: "postgres://system-mail" } as Hyperdrive,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      components: expect.arrayContaining([
        { name: "MAIL", status: "ready" },
        { name: "MAIL_FROM_ADDRESS", status: "ready" },
      ]),
      status: "ready",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("re-evaluates mail bindings after a cached ready result for the same databases", async () => {
    const send = vi.fn(async () => ({ messageId: "test-message" }));
    const probeDatabase = vi.fn(async () => undefined);
    const app = createApiApp({ probeDatabase });
    const databases = {
      DB_AUTHENTICATED: {
        connectionString: "postgres://authenticated-mail-evict",
      } as Hyperdrive,
      DB_SYSTEM: {
        connectionString: "postgres://system-mail-evict",
      } as Hyperdrive,
    };

    // A successful probe caches ready components for this database pair; the
    // next request under a different mail configuration must not reuse them.
    const ready = await app.request(
      "/api/v1/ready",
      {},
      { ...stagingEnv, ...databases, MAIL: { send } },
    );
    expect(ready.status).toBe(200);
    expect(send).not.toHaveBeenCalled();

    const degraded = await app.request(
      "/api/v1/ready",
      {},
      { ...stagingEnv, ...databases, MAIL: undefined },
    );
    expect(degraded.status).toBe(503);
    await expect(degraded.json()).resolves.toMatchObject({
      components: expect.arrayContaining([{ name: "MAIL", status: "unavailable" }]),
      status: "unavailable",
    });

    const malformedSender = await app.request(
      "/api/v1/ready",
      {},
      {
        ...stagingEnv,
        ...databases,
        MAIL: { send },
        MAIL_FROM_ADDRESS: "not-an-email",
      },
    );
    expect(malformedSender.status).toBe(503);
    await expect(malformedSender.json()).resolves.toMatchObject({
      components: expect.arrayContaining([{ name: "MAIL_FROM_ADDRESS", status: "unavailable" }]),
      status: "unavailable",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("probes both configured Hyperdrive bindings before reporting ready", async () => {
    const probeDatabase = vi.fn(async () => undefined);
    const app = createApiApp({ probeDatabase });
    const response = await app.request(
      "/api/v1/ready",
      {},
      {
        ...stagingEnv,
        DB_AUTHENTICATED: {
          connectionString: "postgres://authenticated",
        } as Hyperdrive,
        DB_SYSTEM: { connectionString: "postgres://system" } as Hyperdrive,
      },
    );

    expect(response.status).toBe(200);
    expect(probeDatabase).toHaveBeenCalledTimes(2);
    expect(probeDatabase).toHaveBeenCalledWith(expect.anything(), "DB_SYSTEM");
    expect(probeDatabase).toHaveBeenCalledWith(expect.anything(), "DB_AUTHENTICATED");
    await expect(response.json()).resolves.toMatchObject({ status: "ready" });
  });

  it("caches successful readiness probes briefly", async () => {
    const probeDatabase = vi.fn(async () => undefined);
    const app = createApiApp({ probeDatabase });
    const env = {
      ...stagingEnv,
      DB_AUTHENTICATED: {
        connectionString: "postgres://authenticated-cache",
      } as Hyperdrive,
      DB_SYSTEM: { connectionString: "postgres://system-cache" } as Hyperdrive,
    };

    await expect(app.request("/api/v1/ready", {}, env)).resolves.toMatchObject({
      status: 200,
    });
    await expect(app.request("/api/v1/ready", {}, env)).resolves.toMatchObject({
      status: 200,
    });
    expect(probeDatabase).toHaveBeenCalledTimes(2);
  });

  it("marks a failed Hyperdrive probe unavailable without exposing its error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const probeDatabase = vi.fn(
      async (_env: ApiWorkerEnv, component: "DB_SYSTEM" | "DB_AUTHENTICATED") => {
        if (component === "DB_AUTHENTICATED") {
          throw new Error("database password must stay private");
        }
      },
    );
    const app = createApiApp({ probeDatabase });
    const response = await app.request(
      "/api/v1/ready",
      {},
      {
        ...stagingEnv,
        DB_AUTHENTICATED: {
          connectionString: "postgres://authenticated",
        } as Hyperdrive,
        DB_SYSTEM: { connectionString: "postgres://system" } as Hyperdrive,
      },
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("database password");
    expect(JSON.parse(body)).toMatchObject({
      components: expect.arrayContaining([
        { name: "DB_SYSTEM", status: "ready" },
        { name: "DB_AUTHENTICATED", status: "unavailable" },
      ]),
      status: "unavailable",
    });
    expect(logRecords(error)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          component: "DB_AUTHENTICATED",
          error_code: "dependency_probe_failed",
          event: "dependency_probe_failed",
        }),
        error: expect.objectContaining({
          fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
          name: "Error",
        }),
      }),
    );
  });

  it("releases successful Hyperdrive probes without destroying clients", async () => {
    release.mockClear();
    const response = await createApiApp().request(
      "/api/v1/ready",
      {},
      {
        ...stagingEnv,
        DB_AUTHENTICATED: undefined,
        DB_SYSTEM: {
          connectionString: "postgres://system-release",
        } as Hyperdrive,
      },
    );

    expect(response.status).toBe(503);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith();
    expect(release).not.toHaveBeenCalledWith(true);
  });

  it("keeps binding-only readiness behavior when database bindings are absent", async () => {
    const probeDatabase = vi.fn(async () => undefined);
    const app = createApiApp({ probeDatabase });
    const response = await app.request(
      "/api/v1/ready",
      {},
      {
        ...stagingEnv,
        DB_AUTHENTICATED: undefined,
        DB_SYSTEM: undefined,
      },
    );

    expect(response.status).toBe(503);
    expect(probeDatabase).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      components: expect.arrayContaining([
        { name: "DB_SYSTEM", status: "unavailable" },
        { name: "DB_AUTHENTICATED", status: "unavailable" },
      ]),
      status: "unavailable",
    });
  });

  it("rejects unapproved browser origins", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = await exports.default.fetch("http://example.test/api/v1/health", {
      headers: {
        Origin: "https://attacker.example",
        "X-Request-ID": "request-origin-1",
      },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(logRecords(info)).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          error_code: "invalid_request",
          event: "http_request",
          outcome: 403,
          retry_class: "none",
        }),
        request_id: "request-origin-1",
        trace_id: "request-origin-1",
      }),
    );
  });

  it("trusts the app origin for preflight and normal responses without a CORS override", async () => {
    const app = createApiApp();
    const origin = stagingEnv.APP_URL;
    const env = { ...stagingEnv, ALLOWED_ORIGINS: undefined };

    const preflight = await app.fetch(
      new Request("http://example.test/api/v1/health", {
        headers: {
          "Access-Control-Request-Method": "GET",
          Origin: origin,
        },
        method: "OPTIONS",
      }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Vary")).toBe("Origin");

    const normal = await app.fetch(
      new Request("http://example.test/api/v1/health", {
        headers: { Origin: origin },
      }),
      env,
    );
    expect(normal.status).toBe(200);
    expect(normal.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(normal.headers.get("Vary")).toBe("Origin");
  });

  it("serves credentials-aware CORS preflights for the Better Auth surface", async () => {
    const app = createApiApp({
      betterAuth: fakeBetterAuth as never,
    });
    const origin = stagingEnv.ALLOWED_ORIGINS;
    const preflight = await app.fetch(
      new Request("http://example.test/api/auth/sign-in/email", {
        headers: {
          "Access-Control-Request-Method": "POST",
          Origin: origin,
        },
        method: "OPTIONS",
      }),
      stagingEnv,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("X-Workspace-ID");
  });

  it("exposes the Better Auth JWT header on credentialed cross-origin responses", async () => {
    // The JWT plugin answers session reads with `set-auth-jwt`; browsers only
    // let frontend code read response headers named by
    // Access-Control-Expose-Headers, so the wrapper must list it.
    const jwtAuth = {
      ...fakeBetterAuth,
      handler: vi.fn(
        async () =>
          new Response(JSON.stringify({ session: null }), {
            headers: {
              "Content-Type": "application/json",
              "set-auth-jwt": "test-only.jwt",
            },
            status: 200,
          }),
      ),
    };
    const app = createApiApp({
      betterAuth: jwtAuth as never,
    });
    const origin = stagingEnv.ALLOWED_ORIGINS;
    const response = await app.fetch(
      new Request("http://example.test/api/auth/get-session", {
        headers: { Origin: origin },
      }),
      stagingEnv,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-auth-jwt")).toBe("test-only.jwt");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Expose-Headers")?.toLowerCase()).toContain(
      "set-auth-jwt",
    );
  });

  it("rejects unapproved origins on the Better Auth surface", async () => {
    const app = createApiApp({
      betterAuth: fakeBetterAuth as never,
    });
    const response = await app.fetch(
      new Request("http://example.test/api/auth/sign-in/email", {
        headers: { Origin: "https://attacker.example" },
        method: "POST",
      }),
      stagingEnv,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("rejects over-limit auth attempts with 429 and Retry-After", async () => {
    const app = createApiApp({
      authRateLimiter: async () => ({
        retryAfterSeconds: 42,
        status: "limited",
      }),
      betterAuth: fakeBetterAuth as never,
    });
    const response = await app.fetch(
      new Request("http://example.test/api/auth/sign-in/email", {
        body: JSON.stringify({ email: "alpha@example.com" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
      {
        ...stagingEnv,
        DB_SYSTEM: { connectionString: "postgres://system" } as Hyperdrive,
      },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
  });

  it("refreshes the cached CORS allowlist when an environment changes", async () => {
    const app = createApiApp();
    const env = {
      ...stagingEnv,
      APP_URL: "https://first.example.com",
      ALLOWED_ORIGINS: undefined,
    } satisfies ApiWorkerEnv;

    const first = await app.fetch(
      new Request("http://example.test/api/v1/health", {
        headers: { Origin: "https://first.example.com" },
      }),
      env,
    );
    expect(first.status).toBe(200);

    env.APP_URL = "https://second.example.com";
    const stale = await app.fetch(
      new Request("http://example.test/api/v1/health", {
        headers: { Origin: "https://first.example.com" },
      }),
      env,
    );
    expect(stale.status).toBe(403);

    const second = await app.fetch(
      new Request("http://example.test/api/v1/health", {
        headers: { Origin: "https://second.example.com" },
      }),
      env,
    );
    expect(second.status).toBe(200);
  });

  it.each([
    undefined,
    "bearer test-only.jwt",
    "Bearer",
    "Bearer two tokens",
    "Token test-only.jwt",
  ])(
    "rejects requests without a well-formed bearer JWT as unauthenticated: %s",
    async (authorization) => {
      fakeBetterAuth.api.getSession.mockClear();
      const resolveActor = vi.fn(async () => actor);
      const verifyJwtToken = vi.fn(async () => jwtIdentity);
      const app = createApiApp({
        betterAuth: fakeBetterAuth as never,
        resolveActor,
        verifyJwtToken,
      });
      // A session cookie rides along on every row: it must never substitute
      // for a missing or malformed bearer JWT.
      const response = await app.request(
        "/api/v1/users/me",
        {
          headers: {
            Cookie: "better-auth.session_token=valid_cookie_value",
            ...(authorization ? { Authorization: authorization } : {}),
          },
        },
        {
          ALLOWED_ORIGINS: "http://localhost:3000",
          ENVIRONMENT: "test",
          VERSION: "test",
        },
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "authentication_required" },
      });
      expect(verifyJwtToken).not.toHaveBeenCalled();
      expect(resolveActor).not.toHaveBeenCalled();
      expect(fakeBetterAuth.api.getSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    "better-auth.session_token=valid_cookie_value",
    "__Secure-better-auth.session_token=secure_cookie_value",
    "better-auth.session_token_extra=valid_cookie_value",
    "other=better-auth.session_token",
  ])("rejects a session cookie without a bearer JWT as unauthenticated: %s", async (cookie) => {
    fakeBetterAuth.api.getSession.mockClear();
    const resolveActor = vi.fn(async () => actor);
    const verifyJwtToken = vi.fn(async () => jwtIdentity);
    const app = createApiApp({
      betterAuth: fakeBetterAuth as never,
      resolveActor,
      verifyJwtToken,
    });
    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Cookie: cookie } },
      {
        ALLOWED_ORIGINS: "http://localhost:3000",
        ENVIRONMENT: "test",
        VERSION: "test",
      },
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    });
    expect(verifyJwtToken).not.toHaveBeenCalled();
    expect(resolveActor).not.toHaveBeenCalled();
    expect(fakeBetterAuth.api.getSession).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer JWT without resolving the actor", async () => {
    const resolveActor = vi.fn(async () => actor);
    const verifyJwtToken = vi.fn(async () => {
      throw new CoreApiError(401, "authentication_required", "Authentication is required.");
    });
    const app = createApiApp({
      betterAuth: fakeBetterAuth as never,
      resolveActor,
      verifyJwtToken,
    });
    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Authorization: bearerAuthorization } },
      {
        ALLOWED_ORIGINS: "http://localhost:3000",
        ENVIRONMENT: "test",
        VERSION: "test",
      },
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    });
    expect(verifyJwtToken).toHaveBeenCalledWith(expect.anything(), "test-only.jwt");
    expect(resolveActor).not.toHaveBeenCalled();
  });

  it("does not let a session cookie rescue an invalid bearer JWT", async () => {
    fakeBetterAuth.api.getSession.mockClear();
    const resolveActor = vi.fn(async () => actor);
    const verifyJwtToken = vi.fn(async () => {
      throw new CoreApiError(401, "authentication_required", "Authentication is required.");
    });
    const app = createApiApp({
      betterAuth: fakeBetterAuth as never,
      resolveActor,
      verifyJwtToken,
    });
    const response = await app.request(
      "/api/v1/users/me",
      {
        headers: {
          Authorization: bearerAuthorization,
          Cookie: "better-auth.session_token=valid_cookie_value",
        },
      },
      {
        ALLOWED_ORIGINS: "http://localhost:3000",
        ENVIRONMENT: "test",
        VERSION: "test",
      },
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    });
    expect(resolveActor).not.toHaveBeenCalled();
    expect(fakeBetterAuth.api.getSession).not.toHaveBeenCalled();
  });

  it.each([
    new Error("Session database connection failed"),
    new CoreApiError(503, "dependency_unavailable", "Session database is unavailable"),
  ])(
    "does not report session infrastructure failure as invalid credentials: %s",
    async (failure) => {
      const resolveActor = vi.fn(async () => actor);
      const app = createApiApp({
        resolveActor,
        verifyJwtToken: async () => {
          throw failure;
        },
      });
      const response = await app.request(
        "/api/v1/users/me",
        { headers: { Authorization: bearerAuthorization } },
        { ALLOWED_ORIGINS: "http://localhost:3000", ENVIRONMENT: "test", VERSION: "test" },
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "internal_error" } });
      expect(resolveActor).not.toHaveBeenCalled();
    },
  );

  it("denies inaccessible workspace selections resolved by the actor", async () => {
    const app = createApiApp({
      betterAuth: fakeBetterAuth as never,
      resolveActor: async () => {
        throw new CoreApiError(
          403,
          "workspace_forbidden",
          "The selected workspace is not accessible to this account.",
        );
      },
      verifyJwtToken: async () => jwtIdentity,
    });
    const response = await app.request(
      "/api/v1/users/me",
      { headers: { Authorization: bearerAuthorization } },
      {
        ALLOWED_ORIGINS: "http://localhost:3000",
        ENVIRONMENT: "test",
        VERSION: "test",
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "workspace_forbidden" },
    });
  });

  it("routes /api/auth/* to the Better Auth handler", async () => {
    const app = createApiApp({ betterAuth: fakeBetterAuth as never });
    const response = await app.request("/api/auth/get-session", { method: "GET" }, stagingEnv);

    expect(response.status).toBe(200);
    expect(fakeBetterAuth.handler).toHaveBeenCalled();
  });

  it("passes the verified bearer JWT identity to actor resolution", async () => {
    fakeBetterAuth.api.getSession.mockClear();
    const loadCurrentUser = vi.fn(async () => userProfile);
    const resolveActor = vi.fn(async () => actor);
    const verifyJwtToken = vi.fn(async () => jwtIdentity);

    const app = createApiApp({
      betterAuth: fakeBetterAuth as never,
      loadCurrentUser,
      resolveActor,
      verifyJwtToken,
    });

    const response = await app.request(
      "/api/v1/users/me",
      {
        headers: {
          Authorization: bearerAuthorization,
          Cookie: "better-auth.session_token=valid_cookie_value",
        },
      },
      stagingEnv,
    );

    expect(response.status).toBe(200);
    expect(verifyJwtToken).toHaveBeenCalledWith(expect.anything(), "test-only.jwt");
    expect(resolveActor).toHaveBeenCalledWith(
      expect.anything(),
      jwtIdentity,
      expect.any(Request),
      response.headers.get("X-Request-ID"),
    );
    expect(loadCurrentUser).toHaveBeenCalledWith(expect.anything(), actor.claims);
    expect(fakeBetterAuth.api.getSession).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      email: "alpha@example.com",
    });
  });
});
