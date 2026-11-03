import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

const { withSystemTransactionEffect } = vi.hoisted(() => ({
  withSystemTransactionEffect: vi.fn(),
}));

// The route graph reaches ./database through the onboarding mutations. Every case
// here decides before a transaction is opened, or drives the transaction through
// this scripted double, so the Node pg client never enters the workerd isolate.
vi.mock("../src/database", () => ({ withSystemTransactionEffect }));

import type { EffectTransactionClient } from "@meltiply/database";
import type { Hono } from "hono";

import { createApiApp } from "../src/app";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "../src/env";

/**
 * First-run onboarding surface at the HTTP boundary.
 *
 * These cases prove the decisions the browser depends on and that a refusal is
 * inert: a non-Owner, an out-of-bounds name, an unknown step, and a save after
 * completion are each rejected before — or instead of — the Workspace mutation.
 * Persistence, resumption, idempotent replay and Audit are proven against real
 * PostgreSQL in `onboarding.integration.test.ts`; nothing here stubs a behavior
 * that suite already covers.
 */

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  APP_URL: "http://localhost:3000",
  ENVIRONMENT: "test",
  REQUIRE_EMAIL_VERIFICATION: "false",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} as ApiWorkerEnv;

const workspaceId = "20000000-0000-4000-8000-000000000005";

/** Builds the real app with an installation actor resolved to the requested authority. */
function appFor(isInstallationOwner: boolean) {
  return createApiApp({
    verifyJwtToken: async () => ({
      email: "alpha@meltiply.local",
      emailVerified: true,
      subject: "auth_user_local_alpha",
    }),
    resolveActor: async () => ({
      authUserId: "auth_user_local_alpha",
      claims: {
        organizationId: workspaceId,
        organizationRole: isInstallationOwner ? "admin" : "viewer",
        subject: "auth_user_local_alpha",
        userId: "10000000-0000-4000-8000-000000000001",
      },
      displayName: "Alpha Creator",
      email: "alpha@meltiply.local",
      isInstallationOwner,
      role: isInstallationOwner ? "admin" : "viewer",
      userId: "10000000-0000-4000-8000-000000000001",
      workspace: { id: workspaceId, name: "Alpha workspace", slug: "alpha-workspace" },
    }),
  });
}

/** Sends one authenticated onboarding request through the real app. */
function request(
  app: Hono<ApiWorkerEnvironment>,
  init: { body?: unknown; method: string; path?: string } = { method: "GET" },
) {
  return app.request(
    `/api/v1/onboarding${init.path ?? ""}`,
    {
      headers: {
        Authorization: "Bearer test-only.jwt",
        "Content-Type": "application/json",
        "Idempotency-Key": "onboarding-route-test-key",
      },
      method: init.method,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
  );
}

/**
 * Builds a transaction double that answers by statement shape.
 *
 * `Matcher`s are tried in order and the first match decides the answer, so a case
 * declares exactly the rows its path needs. `statements` records every statement
 * and parameter set the route actually issued, which is what lets a case prove a
 * refusal left the Workspace untouched rather than merely returning a status.
 */
function scriptedTransaction(matchers: readonly Matcher[]) {
  const statements: { params: unknown[] | undefined; sql: string }[] = [];
  withSystemTransactionEffect.mockImplementation(
    (
      _env: ApiWorkerEnv,
      operation: (client: EffectTransactionClient) => Effect.Effect<unknown, unknown>,
    ) =>
      operation({
        query: (sql: string, params?: unknown[]) => {
          statements.push({ params, sql });
          for (const matcher of matchers) {
            if (matcher.matches(sql)) return matcher.answer(sql);
          }
          return Effect.fail(new Error(`unscripted statement: ${sql}`));
        },
      } as unknown as EffectTransactionClient),
  );
  return statements;
}

interface Matcher {
  readonly answer: (sql: string) => Effect.Effect<unknown, unknown>;
  readonly matches: (sql: string) => boolean;
}

/** Answers one statement shape with a fixed row set. */
function match(pattern: RegExp, rows: readonly unknown[], rowCount = rows.length): Matcher {
  return {
    answer: () => Effect.succeed({ rowCount, rows }),
    matches: (sql) => pattern.test(sql),
  };
}

/** Answers the idempotency reservation as a fresh key, so the mutation body runs. */
const freshReservation = match(/INSERT INTO idempotency_keys/, [], 1);

/** Answers the onboarding row lock with a completed journey. */
const completedOnboardingRow = match(
  /SELECT completed_at, workspace_named FROM installation_onboarding/,
  [{ completed_at: "2026-01-02T03:04:05.000Z", workspace_named: true }],
);

/** Answers the onboarding row lock with a row the Owner is still working through. */
const inProgressOnboardingRow = match(
  /SELECT completed_at, workspace_named FROM installation_onboarding/,
  [{ completed_at: null, workspace_named: true }],
);

describe("onboarding authorization", () => {
  it("refuses a privileged read to a non-Owner without opening a transaction", async () => {
    const response = await request(appFor(false), { method: "GET" });

    expect(response.status).toBe(403);
    const body = await response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("installation_owner_required");
    // The refusal is decided from the live session, so no progress read happens.
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });

  it("refuses a non-Owner write before parsing the body or reserving the key", async () => {
    const response = await request(appFor(false), {
      body: { workspace_name: "Renamed by a viewer" },
      method: "PATCH",
    });

    expect(response.status).toBe(403);
    const body = await response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("installation_owner_required");
    // Nothing ran: an unauthorized caller cannot reach the Workspace rename.
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });

  it("refuses a non-Owner completion", async () => {
    const response = await request(appFor(false), { method: "POST", path: "/complete" });

    expect(response.status).toBe(403);
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });
});

describe("onboarding body bounds", () => {
  it("rejects a Workspace name outside the stored bounds and control characters", async () => {
    const app = appFor(true);
    const cases = ["", "   ", "x".repeat(201), "Alpha\u0000Workspace"];

    for (const workspace_name of cases) {
      const response = await request(app, { body: { workspace_name }, method: "PATCH" });
      expect(response.status).toBe(400);
      const body = await response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("validation_error");
    }
    // A rejected name never reaches the rename path.
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });

  it("rejects an unknown progress step", async () => {
    const response = await request(appFor(true), {
      body: { step: "completed" },
      method: "PATCH",
    });

    expect(response.status).toBe(400);
    const body = await response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("validation_error");
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });

  it("rejects a body with no progress field and an unknown field", async () => {
    const app = appFor(true);
    const empty = await request(app, { body: {}, method: "PATCH" });
    expect(empty.status).toBe(400);

    const unknown = await request(app, {
      body: { workspace_name: "Renamed", misuse: true },
      method: "PATCH",
    });
    expect(unknown.status).toBe(400);
    expect(withSystemTransactionEffect).not.toHaveBeenCalled();
  });
});

describe("onboarding terminal transition", () => {
  it("refuses a late Workspace rename after completion and leaves the Workspace untouched", async () => {
    // Completion is terminal: a save that observes it must not overwrite a name
    // the Owner has since set in Settings. The row lock reports the completed
    // journey, and an unscripted statement would fail the transaction, so the
    // absence of an `UPDATE organizations` is observable rather than assumed.
    const statements = scriptedTransaction([freshReservation, completedOnboardingRow]);

    const response = await request(appFor(true), {
      body: { workspace_name: "Rename after completion" },
      method: "PATCH",
    });

    expect(response.status).toBe(409);
    const body = await response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("onboarding_complete");
    // The name was never applied to the shared Workspace.
    expect(statements.some(({ sql }) => /UPDATE organizations/.test(sql))).toBe(false);
    expect(statements.some(({ sql }) => /UPDATE installation_onboarding/.test(sql))).toBe(false);
  });

  it("applies a first name before completion and records it on the onboarding row", async () => {
    const statements = scriptedTransaction([
      freshReservation,
      inProgressOnboardingRow,
      match(/SELECT name FROM organizations/, [{ name: "Original workspace" }]),
      match(/UPDATE organizations SET name/, [], 1),
      match(/INSERT INTO workspace_audit_entries/, [], 1),
      match(/UPDATE installation_onboarding/, [], 1),
      match(/SELECT o\.name AS workspace_name/, [
        {
          completed_at: null,
          progress_step: "improvement",
          workspace_name: "Chosen workspace",
          workspace_named: true,
        },
      ]),
      // The reservation is completed in the same transaction once the mutation
      // produced its response.
      match(/UPDATE idempotency_keys/, [], 1),
    ]);

    const response = await request(appFor(true), {
      body: { workspace_name: "Chosen workspace" },
      method: "PATCH",
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ status: string; workspace_name: string }>();
    expect(body.workspace_name).toBe("Chosen workspace");
    expect(body.status).toBe("in_progress");
    // The rename ran inside the same transaction as the onboarding record, and the
    // stored name is what the response reports.
    const rename = statements.find(({ sql }) => /UPDATE organizations SET name/.test(sql));
    expect(rename?.params).toEqual([workspaceId, "Chosen workspace"]);
  });

  it("reports an upgraded installation as not applicable instead of resuming a journey", async () => {
    // No onboarding row exists for an installation that was never set up through
    // the wizard; a step-only save must refuse rather than create one.
    const statements = scriptedTransaction([
      freshReservation,
      match(/SELECT completed_at, workspace_named FROM installation_onboarding/, []),
    ]);

    const response = await request(appFor(true), { body: { step: "ready" }, method: "PATCH" });

    expect(response.status).toBe(409);
    const body = await response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("onboarding_not_applicable");
    expect(statements.some(({ sql }) => /INSERT INTO installation_onboarding/.test(sql))).toBe(
      false,
    );
  });
});
