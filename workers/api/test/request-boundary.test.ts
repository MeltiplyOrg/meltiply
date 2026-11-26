import type { BetterAuthInstance, JwtIdentity } from "@meltiply/auth";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResolvedActor } from "../src/actor-resolution";
import { createApiApp } from "../src/app";
import { authPolicyHandler } from "../src/auth-policy";
import { CoreApiError } from "../src/core-types";
import type { ApiWorkerEnv } from "../src/env";
import { logRecords } from "./log-records";

const database = vi.hoisted(() => ({
  pool: { connect: vi.fn(), query: vi.fn() },
  withSystemTransactionEffect: vi.fn(),
}));

vi.mock("../src/database", () => ({
  authenticatedPoolFor: () => database.pool,
  systemPoolFor: () => database.pool,
  withSystemTransactionEffect: database.withSystemTransactionEffect,
}));

const setupSecret = "setup-secret-with-at-least-32-characters";
const env = {
  APP_URL: "https://app.example.test",
  AUTH_SETUP_SECRET: setupSecret,
  ENVIRONMENT: "test",
  VERSION: "test",
} satisfies ApiWorkerEnv;
const databaseEnv = {
  ...env,
  DB_SYSTEM: { connectionString: "postgres://system.example.test/meltiply" } as Hyperdrive,
} satisfies ApiWorkerEnv;
const identity: JwtIdentity = { email: "owner@example.test", subject: "auth-owner" };
const actor: ResolvedActor = {
  authUserId: "auth-owner",
  claims: {
    organizationId: "00000000-0000-4000-8000-000000000001",
    organizationRole: "admin",
    subject: "auth-owner",
    userId: "00000000-0000-4000-8000-000000000011",
  },
  displayName: "Owner",
  email: "owner@example.test",
  isInstallationOwner: true,
  role: "admin",
  userId: "00000000-0000-4000-8000-000000000011",
  workspace: { id: "00000000-0000-4000-8000-000000000001", name: "Workspace", slug: "workspace" },
};
const authorized = { headers: { Authorization: "Bearer session-token" } };

function postgresTypeError(message: string) {
  return Object.assign(new Error(message), { code: "22P02" });
}

function flowTransaction(values: readonly unknown[]) {
  const rejected = values.find((value) => typeof value === "number" && !Number.isInteger(value));
  if (rejected !== undefined) {
    return Effect.die(postgresTypeError("invalid input syntax for type bigint"));
  }
  if (typeof values[0] === "string" && values[0].startsWith("not-")) {
    return Effect.die(postgresTypeError("invalid input syntax for type uuid"));
  }
  return Effect.succeed({ rowCount: 0, rows: [] });
}

beforeEach(() => {
  database.pool.connect.mockReset();
  database.pool.query.mockReset();
  database.withSystemTransactionEffect.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tenant authentication boundary", () => {
  it("returns a typed identity rejection instead of an internal error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = createApiApp({
      verifyJwtToken: async () => {
        throw new CoreApiError(
          403,
          "email_verification_required",
          "Verify your email to continue.",
        );
      },
    });

    const response = await app.request("/api/v1/users/me", authorized, env);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "email_verification_required" },
    });
  });
});

describe("error code logging", () => {
  it("reads a small error code without parsing bodies past the probe limit", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const app = createApiApp();
    const jsonError = (code: string, padding: number) =>
      new Response(JSON.stringify({ error: { code, padding: "x".repeat(padding) } }), {
        headers: { "Content-Type": "application/json" },
        status: 400,
      });
    app.get("/small-error", () => jsonError("small_error", 0));
    app.get("/oversized-error", () => jsonError("oversized_error", 9 * 1024));

    await app.request("/small-error", {}, env);
    const oversized = await app.request("/oversized-error", {}, env);

    await expect(oversized.json()).resolves.toMatchObject({ error: { code: "oversized_error" } });
    const requests = logRecords(info)
      .map((record) => record.context as Record<string, unknown>)
      .filter((context) => context.event === "http_request");
    expect(requests.map((context) => context.error_code)).toEqual(["small_error", undefined]);
  });
});

describe("first-account bootstrap", () => {
  it("serializes setup with a transaction-scoped advisory lock", async () => {
    const statements: string[] = [];
    database.pool.connect.mockResolvedValue({
      query: async (text: string) => {
        statements.push(text);
        return { rowCount: 0, rows: [] };
      },
      release: () => undefined,
    });
    database.pool.query.mockImplementation(async (text: string) => ({
      rows: text.includes('FROM "user"') ? [{ initialized: false }] : [],
    }));
    database.withSystemTransactionEffect.mockImplementation(
      (_env: ApiWorkerEnv, operation: (client: unknown) => Effect.Effect<unknown>) =>
        operation({
          query: (text: string) =>
            Effect.sync(() => {
              statements.push(text);
              return { rowCount: 0, rows: [] };
            }),
        }),
    );
    const handler = vi.fn(async () => Response.json({ user: { id: "auth-owner" } }));
    const auth: BetterAuthInstance = { handler };

    const response = await authPolicyHandler(env, auth).handler(
      new Request("https://app.example.test/api/auth/sign-up/email", {
        body: JSON.stringify({
          email: "owner@example.test",
          name: "Owner",
          password: "correct horse battery",
        }),
        headers: { "Content-Type": "application/json", "X-Setup-Secret": setupSecret },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(statements.some((text) => text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(statements.some((text) => text.includes("pg_advisory_lock("))).toBe(false);
  });
});

describe("flow explorer input", () => {
  beforeEach(() => {
    database.withSystemTransactionEffect.mockImplementation(
      (_env: ApiWorkerEnv, operation: (client: unknown) => Effect.Effect<unknown>) =>
        operation({
          query: (_text: string, values: readonly unknown[] = []) => flowTransaction(values),
        }),
    );
  });

  const app = () =>
    createApiApp({
      resolveActor: async () => actor,
      verifyJwtToken: async () => identity,
    });

  it("treats a malformed run id as an unknown run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = await app().request("/api/v1/flows/runs/not-a-uuid", authorized, databaseEnv);
    const steps = await app().request(
      "/api/v1/flows/runs/not-a-uuid/steps",
      authorized,
      databaseEnv,
    );

    expect(run.status).toBe(404);
    expect(steps.status).toBe(200);
    await expect(steps.json()).resolves.toEqual({ steps: [] });
  });

  it("truncates a fractional run limit before querying", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await app().request("/api/v1/flows/runs?limit=1.5", authorized, databaseEnv);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runs: [] });
  });
});
