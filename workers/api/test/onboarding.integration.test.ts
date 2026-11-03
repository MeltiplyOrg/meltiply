import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createHyperdrivePool } from "@meltiply/database";
import type { JwtIdentity } from "@meltiply/auth";
import type { Hono } from "hono";

import { createApiApp } from "../src/app";
import { systemPoolFor } from "../src/database";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "../src/env";
import { sha256Hex } from "../src/crypto";

/**
 * First-run bootstrap and onboarding against real PostgreSQL through the real
 * Worker HTTP entrypoints.
 *
 * The suite owns an isolated schema (like the auth lifecycle suite) so it can
 * truncate freely without disturbing the shared seeded Workspace that other
 * integration suites rely on, while still exercising the production sign-up
 * policy, actor resolution, route handlers, transactions, and Audit writes.
 */

const baseSystemConnectionString =
  "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";
const adminConnectionString =
  process.env.MELTIPLY_DATABASE_TEST_ADMIN_URL ??
  "postgres://postgres:meltiply-admin-local@127.0.0.1:5433/meltiply?sslmode=disable";
const schema = "onboarding_lifecycle";
const isolatedDatabase = new URL(baseSystemConnectionString);
isolatedDatabase.searchParams.set("options", `-c search_path=${schema},public`);
const systemConnectionString = isolatedDatabase.href;
const adminPool = createHyperdrivePool({ connectionString: adminConnectionString });

/** Tables this suite reads or writes, copied from the migrated public schema. */
const copiedTables = [
  "user",
  "session",
  "account",
  "verification",
  "jwks",
  "twoFactor",
  "users",
  "organizations",
  "org_members",
  "workspace_invitations",
  "workspace_audit_entries",
  "idempotency_keys",
  "usage_reconciliation_state",
  "installation_bootstrap",
  "installation_bootstrap_intent",
  "installation_onboarding",
  "reporting_preferences",
  "reporting_attribution_responses",
  "reporting_pending_reports",
  "reporting_delivery_receipts",
];

/** Truncated before each case so every test starts from an uninitialized installation. */
const truncatedTables = [
  "user",
  "session",
  "account",
  "verification",
  "twoFactor",
  "workspace_audit_entries",
  "idempotency_keys",
  "workspace_invitations",
  "installation_bootstrap",
  "installation_bootstrap_intent",
  "installation_onboarding",
  "reporting_preferences",
  "reporting_attribution_responses",
  "reporting_pending_reports",
  "reporting_delivery_receipts",
  "usage_reconciliation_state",
  "org_members",
  "organizations",
  "users",
];

const setupSecret = crypto.randomUUID() + crypto.randomUUID();
const authSecret = "meltiply-local-auth-secret-32-chars-long";
const authOrigin = "https://auth.onboarding.test";

beforeAll(async () => {
  for (const connection of [systemConnectionString, adminConnectionString]) {
    const url = new URL(connection);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/meltiply")
      throw new Error("Onboarding tests require the isolated local database.");
  }
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.query(`CREATE SCHEMA ${schema} AUTHORIZATION meltiply_system`);
  for (const table of copiedTables) {
    await adminPool.query(
      `CREATE TABLE ${schema}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
    );
    await adminPool.query(`GRANT ALL ON ${schema}."${table}" TO meltiply_system`);
  }
  await adminPool.query(`
    CREATE TRIGGER revoke_password_sessions AFTER UPDATE OF password ON ${schema}."account"
      FOR EACH ROW EXECUTE FUNCTION public.revoke_security_sessions();
  `);
});

beforeEach(async () => {
  await systemPoolFor(env()).query(
    `TRUNCATE ${truncatedTables.map((table) => `"${table}"`).join(", ")}`,
  );
});

afterAll(async () => {
  await systemPoolFor(env()).end();
  await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  await adminPool.end();
});

/**
 * Worker environment bound to the isolated schema.
 *
 * `test` policy keeps sign-in possible without verification while sign-up still
 * dispatches verification mail, matching the local deployment story this
 * feature targets.
 */
function env(): ApiWorkerEnv {
  return {
    ALLOWED_ORIGINS: authOrigin,
    APP_URL: authOrigin,
    AUTH_SETUP_SECRET: setupSecret,
    BETTER_AUTH_SECRET: authSecret,
    // The copied schema carries no RLS policies, so tenant reads use the same
    // privileged role here. Tenant isolation is covered by the database RLS
    // suite; this suite scopes the bootstrap/onboarding HTTP behavior.
    DB_AUTHENTICATED: { connectionString: systemConnectionString } as Hyperdrive,
    DB_SYSTEM: { connectionString: systemConnectionString } as Hyperdrive,
    ENVIRONMENT: "test",
    VERSION: "1.0.0-target.0",
  } satisfies ApiWorkerEnv;
}

/**
 * Builds the API app whose bearer verifier maps a token directly to an identity.
 *
 * Bearer verification is the one seam replaced: every other layer — the auth
 * policy, actor resolution, onboarding routes, transactions, and Audit — is the
 * production implementation against the real database.
 *
 * @param identities - Bearer token to verified identity map.
 * @returns The API application under test.
 */
function appWith(identities: Record<string, JwtIdentity>) {
  return createApiApp({
    authRateLimiter: async () => ({ status: "ok" }),
    verifyJwtToken: async (_env, token) => {
      const identity = identities[token];
      if (!identity) throw new Error(`unexpected bearer token ${token}`);
      return identity;
    },
  });
}

/** Owner credentials used by the first-run form. */
const owner = {
  email: "first-owner@onboarding.test",
  name: "First Owner",
  password: "correct horse battery staple",
  workspaceName: "Acme Studio",
};

/**
 * Submits the first-run setup form through the app's auth surface.
 *
 * @param app - API application under test.
 * @param body - Sign-up body, including the chosen `workspace_name`.
 * @param headers - Additional headers such as the setup secret override.
 * @returns The HTTP response.
 */
function signUp(
  app: Hono<ApiWorkerEnvironment>,
  body: Record<string, unknown>,
  headers: Record<string, string> = { "X-Setup-Secret": setupSecret },
) {
  return app.request(
    "/api/auth/sign-up/email",
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...headers },
      method: "POST",
    },
    env(),
  );
}

/**
 * Narrows a sign-up response to the created Better Auth subject.
 *
 * @param response - Sign-up response.
 * @returns The created account id.
 */
async function signedUpSubject(response: Response): Promise<string> {
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("user" in body) ||
    !body.user ||
    typeof body.user !== "object" ||
    !("id" in body.user) ||
    typeof body.user.id !== "string"
  ) {
    throw new Error("sign-up must return a user id");
  }
  return body.user.id;
}

/**
 * Sends an authenticated request to the onboarding surface.
 *
 * @param app - API application under test.
 * @param token - Bearer token resolved by the app's verifier.
 * @param path - Onboarding path below `/api/v1/onboarding`.
 * @param init - Method, body, and headers.
 * @returns The HTTP response.
 */
function onboardingRequest(
  app: Hono<ApiWorkerEnvironment>,
  token: string,
  path: string,
  init: { body?: string; headers?: Record<string, string>; method: string },
) {
  return app.request(
    `/api/v1/onboarding${path}`,
    {
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      method: init.method,
    },
    env(),
  );
}

/** Requested bits of the reporting policy, as the durable-progress case reads them. */
interface ReportingRequestedBody {
  categories: { diagnostics: { requested: boolean }; usage: { requested: boolean } };
}

/** Wire shape of the onboarding progress document this suite asserts against. */
interface OnboardingProgressBody {
  completed_at: string | null;
  status: string;
  step: string;
  workspace_name: string | null;
  workspace_named: boolean;
}

/**
 * Reads a JSON response body as an onboarding progress record.
 *
 * @param response - Onboarding response.
 * @returns The parsed progress payload.
 */
async function progressOf(response: Response): Promise<OnboardingProgressBody> {
  const body: OnboardingProgressBody = await response.json();
  return body;
}

/**
 * Reads the canonical shared Workspace row for the isolated installation.
 *
 * @returns The shared Workspace name and id, or undefined when none exists.
 */
async function sharedWorkspace(): Promise<{ id: string; name: string } | undefined> {
  const result = await systemPoolFor(env()).query<{ id: string; name: string }>(
    "SELECT id, name FROM organizations WHERE is_shared",
  );
  return result.rows[0];
}

/**
 * Runs the full first-run flow and returns the bearer token plus its identity.
 *
 * The first authenticated request performs installation finalization, which is
 * where the chosen Workspace name reaches the canonical Workspace, so the
 * harness resolves that request before returning.
 *
 * @returns The owner's app and bearer token.
 */
async function bootstrapOwner(): Promise<{ app: Hono<ApiWorkerEnvironment>; token: string }> {
  const app = appWith({});
  const signUpResponse = await signUp(app, {
    email: owner.email,
    name: owner.name,
    password: owner.password,
    workspace_name: owner.workspaceName,
  });
  expect(signUpResponse.status).toBe(200);
  const subject = await signedUpSubject(signUpResponse);
  const ownerApp = appWith({
    [subject]: { email: owner.email, name: owner.name, subject },
  });
  const progress = await onboardingRequest(ownerApp, subject, "", { method: "GET" });
  expect(progress.status).toBe(200);
  return { app: ownerApp, token: subject };
}

describe("first-run bootstrap through the auth surface", () => {
  it("applies the chosen Workspace name to the single canonical Workspace and resumes onboarding", async () => {
    const { app, token } = await bootstrapOwner();

    // The setup name is durable installation data, not an auth user field, so
    // it must not leak into the Better Auth record.
    const authUser = await systemPoolFor(env()).query<{ name: string }>(
      `SELECT name FROM "user" WHERE email = $1`,
      [owner.email],
    );
    expect(authUser.rows).toEqual([{ name: owner.name }]);

    const workspace = await sharedWorkspace();
    expect(workspace?.name).toBe(owner.workspaceName);
    const ownerCount = await systemPoolFor(env()).query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users WHERE installation_owner",
    );
    expect(ownerCount.rows[0]?.count).toBe("1");

    const progress = await onboardingRequest(app, token, "", { method: "GET" });
    expect(progress.status).toBe(200);
    expect(await progressOf(progress)).toMatchObject({
      completed_at: null,
      status: "in_progress",
      workspace_name: owner.workspaceName,
      workspace_named: true,
    });
  });

  it("keeps the derived default when the form omits the Workspace name", async () => {
    const app = appWith({});
    const signUpResponse = await signUp(app, {
      email: owner.email,
      name: owner.name,
      password: owner.password,
    });
    expect(signUpResponse.status).toBe(200);
    const subject = await signedUpSubject(signUpResponse);
    const resumed = appWith({ [subject]: { email: owner.email, name: owner.name, subject } });

    const progress = await progressOf(
      await onboardingRequest(resumed, subject, "", { method: "GET" }),
    );
    expect(progress).toMatchObject({
      status: "in_progress",
      workspace_name: `${owner.name}'s workspace`,
      workspace_named: false,
    });
  });

  it("rejects an invalid Workspace name before creating an account", async () => {
    const app = appWith({});
    const blank = await signUp(app, {
      email: owner.email,
      name: owner.name,
      password: owner.password,
      workspace_name: "   ",
    });
    expect(blank.status).toBe(400);
    const control = await signUp(app, {
      email: owner.email,
      name: owner.name,
      password: owner.password,
      workspace_name: "Acme\u0000Studio",
    });
    expect(control.status).toBe(400);

    const accounts = await systemPoolFor(env()).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "user"`,
    );
    expect(accounts.rows[0]?.count).toBe("0");
    expect(await sharedWorkspace()).toBeUndefined();
  });

  it("creates one account and one shared Workspace for concurrent first submissions", async () => {
    const app = appWith({});
    const responses = await Promise.all([
      signUp(app, {
        email: owner.email,
        name: owner.name,
        password: owner.password,
        workspace_name: "First Choice",
      }),
      signUp(app, {
        email: "second-owner@onboarding.test",
        name: "Second Owner",
        password: owner.password,
        workspace_name: "Second Choice",
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);

    const winner = responses.find((response) => response.status === 200)!;
    const subject = await signedUpSubject(winner);
    const created = await systemPoolFor(env()).query<{ email: string }>(
      `SELECT email FROM "user" WHERE id = $1`,
      [subject],
    );
    const accounts = await systemPoolFor(env()).query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "user"`,
    );
    expect(accounts.rows[0]?.count).toBe("1");

    // Whichever submission won owns the installation; exactly one shared
    // Workspace exists and it carries that submission's chosen name.
    const app2 = appWith({ [subject]: { email: created.rows[0]!.email, subject } });
    const progress = await progressOf(
      await onboardingRequest(app2, subject, "", { method: "GET" }),
    );
    expect(progress.status).toBe("in_progress");
    expect(["First Choice", "Second Choice"]).toContain(progress.workspace_name);
    expect((await sharedWorkspace())?.name).toBe(progress.workspace_name);
  });

  it("keeps public registration closed while optional onboarding is unfinished", async () => {
    const { app, token } = await bootstrapOwner();
    const status = await app.request("/api/auth/setup-status", { method: "GET" }, env());
    expect(await status.json()).toEqual({ initialized: true });

    const closed = await signUp(app, {
      email: "stranger@onboarding.test",
      name: "Stranger",
      password: owner.password,
    });
    expect(closed.status).toBe(403);
    await expect(closed.json()).resolves.toMatchObject({ code: "INVITATION_REQUIRED" });

    // The unfinished journey is still in progress, so the closure is not a
    // side effect of completion.
    expect(
      (await progressOf(await onboardingRequest(app, token, "", { method: "GET" }))).status,
    ).toBe("in_progress");
  });

  it("admits an invited member without onboarding progress", async () => {
    const { app, token } = await bootstrapOwner();
    const workspace = await sharedWorkspace();
    const inviteToken = crypto.randomUUID() + crypto.randomUUID();
    const invitedEmail = "invited-editor@onboarding.test";
    const internalOwner = await systemPoolFor(env()).query<{ id: string }>(
      `SELECT id FROM users WHERE installation_owner`,
    );
    await systemPoolFor(env()).query(
      `INSERT INTO workspace_invitations (org_id, email, role, invited_by, token_hash, expires_at)
       VALUES ($1, $2, 'editor', $3, $4, now() + interval '7 days')`,
      [workspace!.id, invitedEmail, internalOwner.rows[0]!.id, await sha256Hex(inviteToken)],
    );

    const invited = await signUp(
      app,
      { email: invitedEmail, name: "Invited Editor", password: owner.password },
      { "X-Invitation-Token": inviteToken },
    );
    expect(invited.status).toBe(200);
    const subject = await signedUpSubject(invited);
    const memberApp = appWith({
      [subject]: { email: invitedEmail, name: "Invited Editor", subject },
    });

    // Resolving the member's actor activates membership; onboarding is Owner
    // administration, so the member is refused rather than given a progress row.
    const denied = await onboardingRequest(memberApp, subject, "", { method: "GET" });
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "installation_owner_required" },
    });

    // The member's authenticated request did reach actor resolution: the
    // pending invitation became a membership.
    const membership = await systemPoolFor(env()).query<{ role: string }>(
      `SELECT om.role FROM org_members om
       JOIN users u ON u.id = om.user_id
       WHERE u.auth_user_id = $1 AND om.org_id = $2`,
      [subject, workspace!.id],
    );
    expect(membership.rows).toEqual([{ role: "editor" }]);

    // No onboarding progress exists for the invited member's installation
    // beyond the Owner's single record.
    const progressRows = await systemPoolFor(env()).query<{ count: string }>(
      "SELECT count(*)::text AS count FROM installation_onboarding",
    );
    expect(progressRows.rows[0]?.count).toBe("1");

    // The Owner's own journey is unaffected by the member's arrival.
    expect(
      (await progressOf(await onboardingRequest(app, token, "", { method: "GET" }))).status,
    ).toBe("in_progress");
  });
});

describe("onboarding save and completion", () => {
  it("saves and audits the chosen name, replaying an identical retry", async () => {
    const { app, token } = await bootstrapOwner();
    const key = crypto.randomUUID();
    const save = (name: string) =>
      onboardingRequest(app, token, "", {
        body: JSON.stringify({ workspace_name: name }),
        headers: { "Idempotency-Key": key },
        method: "PATCH",
      });

    const saved = await save("Renamed Studio");
    expect(saved.status).toBe(200);
    expect(await progressOf(saved)).toMatchObject({
      status: "in_progress",
      workspace_name: "Renamed Studio",
      workspace_named: true,
    });
    expect((await sharedWorkspace())?.name).toBe("Renamed Studio");

    const replayed = await onboardingRequest(app, token, "", {
      body: JSON.stringify({ workspace_name: "Renamed Studio" }),
      headers: { "Idempotency-Key": key },
      method: "PATCH",
    });
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");

    const audit = await systemPoolFor(env()).query<{ after_state: { name: string } }>(
      `SELECT after_state FROM workspace_audit_entries
       WHERE action = 'workspace.renamed'
       ORDER BY created_at DESC`,
    );
    expect(audit.rows).toEqual([{ after_state: { name: "Renamed Studio" } }]);
  });

  it("completes idempotently and refuses to rewrite a name changed afterwards", async () => {
    const { app, token } = await bootstrapOwner();
    const complete = (key: string) =>
      onboardingRequest(app, token, "/complete", {
        headers: { "Idempotency-Key": key },
        method: "POST",
      });

    const completed = await complete(crypto.randomUUID());
    expect(completed.status).toBe(200);
    const completedBody = await progressOf(completed);
    expect(completedBody.status).toBe("completed");
    expect(completedBody.completed_at).not.toBeNull();

    const retried = await complete(crypto.randomUUID());
    expect(retried.status).toBe(200);
    expect((await progressOf(retried)).completed_at).toBe(completedBody.completed_at);

    const workspace = await sharedWorkspace();
    const renamed = await app.request(
      `/api/v1/workspaces/${workspace!.id}`,
      {
        body: JSON.stringify({ name: "Settings Rename" }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        method: "PATCH",
      },
      env(),
    );
    expect(renamed.status).toBe(200);

    // Finalization is terminal: onboarding cannot clobber the Settings rename.
    const refused = await onboardingRequest(app, token, "", {
      body: JSON.stringify({ workspace_name: "Onboarding Rename" }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "PATCH",
    });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "onboarding_complete" },
    });

    expect((await sharedWorkspace())?.name).toBe("Settings Rename");
    expect(
      (await progressOf(await onboardingRequest(app, token, "", { method: "GET" }))).workspace_name,
    ).toBe("Settings Rename");
    // Completion itself stays idempotent after the rename.
    expect((await progressOf(await complete(crypto.randomUUID()))).status).toBe("completed");
  });

  it("rejects unknown fields and a blank name without touching the Workspace", async () => {
    const { app, token } = await bootstrapOwner();
    const unknown = await onboardingRequest(app, token, "", {
      body: JSON.stringify({ name: "Sneaky" }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "PATCH",
    });
    expect(unknown.status).toBe(400);

    const blank = await onboardingRequest(app, token, "", {
      body: JSON.stringify({ workspace_name: "   " }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "PATCH",
    });
    expect(blank.status).toBe(400);

    const missingKey = await onboardingRequest(app, token, "", {
      body: JSON.stringify({ workspace_name: "No Key" }),
      method: "PATCH",
    });
    expect(missingKey.status).toBe(400);

    expect((await sharedWorkspace())?.name).toBe(owner.workspaceName);
  });

  it("serializes concurrent saves so the stored name matches the audited name", async () => {
    const { app, token } = await bootstrapOwner();
    const save = (name: string, key: string) =>
      onboardingRequest(app, token, "", {
        body: JSON.stringify({ workspace_name: name }),
        headers: { "Idempotency-Key": key },
        method: "PATCH",
      });
    const responses = await Promise.all([
      save("Concurrent A", crypto.randomUUID()),
      save("Concurrent B", crypto.randomUUID()),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const stored = (await sharedWorkspace())?.name;
    expect(["Concurrent A", "Concurrent B"]).toContain(stored);

    // Each accepted rename is audited once, so the trail explains how the
    // stored name came about instead of recording only one of two writes.
    const audit = await systemPoolFor(env()).query<{ after_state: { name: string } }>(
      `SELECT after_state FROM workspace_audit_entries
       WHERE action = 'workspace.renamed'
       ORDER BY created_at, id`,
    );
    const audited = audit.rows.map((row) => row.after_state.name);
    expect(audited.sort()).toEqual(["Concurrent A", "Concurrent B"]);
    expect(audited).toContain(stored);

    const progress = await progressOf(await onboardingRequest(app, token, "", { method: "GET" }));
    expect(progress.workspace_name).toBe(stored);
  });

  it("moves onboarding authority with ownership transfer", async () => {
    const { app, token } = await bootstrapOwner();
    const workspace = await sharedWorkspace();
    const successorEmail = "successor@onboarding.test";
    const successorSubject = "successor-subject";
    await systemPoolFor(env()).query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Successor', $2, TRUE)`,
      [successorSubject, successorEmail],
    );
    const successorId = "10000000-0000-4000-8000-000000009901";
    await systemPoolFor(env()).query(
      `INSERT INTO users (id, auth_user_id, email, display_name)
       VALUES ($1, $2, $3, 'Successor')`,
      [successorId, successorSubject, successorEmail],
    );
    await systemPoolFor(env()).query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [workspace!.id, successorId],
    );
    await systemPoolFor(env()).query(
      "UPDATE users SET installation_owner = FALSE WHERE installation_owner",
    );
    await systemPoolFor(env()).query("UPDATE users SET installation_owner = TRUE WHERE id = $1", [
      successorId,
    ]);

    const successorApp = appWith({
      [successorSubject]: { email: successorEmail, name: "Successor", subject: successorSubject },
    });
    const successorProgress = await onboardingRequest(successorApp, successorSubject, "", {
      method: "GET",
    });
    expect(successorProgress.status).toBe(200);
    expect((await progressOf(successorProgress)).status).toBe("in_progress");

    // The previous Owner keeps Workspace Admin authority but loses the
    // installation-level onboarding authority.
    const formerOwner = await onboardingRequest(app, token, "", {
      body: JSON.stringify({ workspace_name: "Former Owner Rename" }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "PATCH",
    });
    expect(formerOwner.status).toBe(403);
    expect((await sharedWorkspace())?.name).toBe(owner.workspaceName);
  });

  it("reports an upgraded installation as not applicable instead of resuming setup", async () => {
    // Simulate an installation provisioned before onboarding existed: owner,
    // Workspace, and membership exist, but no bootstrap or progress record.
    const subject = "legacy-owner-subject";
    const legacyEmail = "legacy-owner@onboarding.test";
    await systemPoolFor(env()).query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Legacy Owner', $2, TRUE)`,
      [subject, legacyEmail],
    );
    const legacyId = "10000000-0000-4000-8000-000000009902";
    const workspaceId = "20000000-0000-4000-8000-000000009902";
    await systemPoolFor(env()).query(
      `INSERT INTO users (id, auth_user_id, email, display_name, installation_owner)
       VALUES ($1, $2, $3, 'Legacy Owner', TRUE)`,
      [legacyId, subject, legacyEmail],
    );
    await systemPoolFor(env()).query(
      `INSERT INTO organizations (id, name, slug, is_shared)
       VALUES ($1, 'Legacy Workspace', 'legacy-workspace', TRUE)`,
      [workspaceId],
    );
    await systemPoolFor(env()).query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [workspaceId, legacyId],
    );

    const app = appWith({ [subject]: { email: legacyEmail, name: "Legacy Owner", subject } });
    const progress = await onboardingRequest(app, subject, "", { method: "GET" });
    expect(progress.status).toBe(200);
    expect(await progressOf(progress)).toMatchObject({
      completed_at: null,
      status: "not_applicable",
      workspace_name: "Legacy Workspace",
      workspace_named: false,
    });

    // An upgrade is never pushed through setup: no completion, no rename.
    const completed = await onboardingRequest(app, subject, "/complete", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "POST",
    });
    expect(completed.status).toBe(409);
    const saved = await onboardingRequest(app, subject, "", {
      body: JSON.stringify({ workspace_name: "Upgrade Rename" }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "PATCH",
    });
    expect(saved.status).toBe(409);
    expect((await sharedWorkspace())?.name).toBe("Legacy Workspace");
  });

  it("requires authentication for every onboarding route", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/onboarding"],
      ["PATCH", "/api/v1/onboarding"],
      ["POST", "/api/v1/onboarding/complete"],
    ] as const) {
      const response = await appWith({}).request(
        path,
        {
          ...(method === "GET" ? {} : { body: JSON.stringify({ workspace_name: "No Auth" }) }),
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          method,
        },
        env(),
      );
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("durable setup progress", () => {
  /**
   * The optional screen the Owner reached is its own fact. A restart after
   * skipping or after opting in must resume at the same screen, and neither
   * consent nor attribution may stand in for it.
   */
  it("remembers the reached optional screen across a restart after a skip", async () => {
    const { app, token } = await bootstrapOwner();
    const read = async () => progressOf(await onboardingRequest(app, token, "", { method: "GET" }));

    expect((await read()).step).toBe("improvement");

    const advanced = await onboardingRequest(app, token, "", {
      body: JSON.stringify({ step: "ready" }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "PATCH",
    });
    expect(advanced.status).toBe(200);
    expect(await progressOf(advanced)).toMatchObject({
      step: "ready",
      workspace_name: owner.workspaceName,
    });

    // A later authenticated read — the shape a browser restart performs — still
    // reports the reached screen, with both categories untouched.
    expect((await read()).step).toBe("ready");
    const reporting = await app.request(
      "/api/v1/installation/reporting",
      { headers: { Authorization: `Bearer ${token}` } },
      env(),
    );
    const policy: ReportingRequestedBody = await reporting.json();
    expect(policy.categories.usage.requested).toBe(false);
    expect(policy.categories.diagnostics.requested).toBe(false);
  });

  it("never moves the recorded screen backwards", async () => {
    const { app, token } = await bootstrapOwner();
    const save = (step: string) =>
      onboardingRequest(app, token, "", {
        body: JSON.stringify({ step }),
        headers: { "Idempotency-Key": crypto.randomUUID() },
        method: "PATCH",
      });

    expect(await progressOf(await save("ready"))).toMatchObject({ step: "ready" });
    // A late write from an older tab cannot rewind the journey.
    expect(await progressOf(await save("improvement"))).toMatchObject({ step: "ready" });
  });

  it("saves a name and a screen together in one write", async () => {
    const { app, token } = await bootstrapOwner();
    const saved = await onboardingRequest(app, token, "", {
      body: JSON.stringify({ step: "ready", workspace_name: "Renamed Studio" }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "PATCH",
    });

    expect(saved.status).toBe(200);
    expect(await progressOf(saved)).toMatchObject({
      step: "ready",
      workspace_name: "Renamed Studio",
    });
    expect((await sharedWorkspace())?.name).toBe("Renamed Studio");
  });

  it("refuses an unknown field, an invalid step, and an empty body", async () => {
    const { app, token } = await bootstrapOwner();
    const patch = (body: unknown) =>
      onboardingRequest(app, token, "", {
        body: JSON.stringify(body),
        headers: { "Idempotency-Key": crypto.randomUUID() },
        method: "PATCH",
      });

    expect((await patch({ step: "finish" })).status).toBe(400);
    expect((await patch({ tracker: true })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
  });

  it("refuses screen progress on an upgraded installation", async () => {
    const subject = "legacy-owner-step-subject";
    const legacyEmail = "legacy-step@onboarding.test";
    await systemPoolFor(env()).query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Legacy', $2, TRUE)`,
      [subject, legacyEmail],
    );
    await systemPoolFor(env()).query(
      `INSERT INTO users (id, auth_user_id, email, display_name, installation_owner)
       VALUES ($1, $2, $3, 'Legacy', TRUE)`,
      ["10000000-0000-4000-8000-000000009911", subject, legacyEmail],
    );
    await systemPoolFor(env()).query(
      `INSERT INTO organizations (id, name, slug, is_shared)
       VALUES ($1, 'Legacy Workspace', 'legacy-workspace-step', TRUE)`,
      ["20000000-0000-4000-8000-000000009911"],
    );
    await systemPoolFor(env()).query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')",
      ["20000000-0000-4000-8000-000000009911", "10000000-0000-4000-8000-000000009911"],
    );

    const app = appWith({ [subject]: { email: legacyEmail, name: "Legacy", subject } });
    const saved = await onboardingRequest(app, subject, "", {
      body: JSON.stringify({ step: "ready" }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "PATCH",
    });
    expect(saved.status).toBe(409);
    await expect(saved.json()).resolves.toMatchObject({
      error: { code: "onboarding_not_applicable" },
    });
  });
});

describe("recoverable setup-name handoff", () => {
  /**
   * A sign-up whose chosen name never reached the bootstrap row — the account was
   * created but the follow-up write never ran — must still apply the name from
   * durable pre-account intent. Registration stays closed throughout.
   */
  it("applies a name recorded only as pre-account intent", async () => {
    const app = appWith({});
    const signUpResponse = await signUp(app, {
      email: owner.email,
      name: owner.name,
      password: owner.password,
      workspace_name: owner.workspaceName,
    });
    expect(signUpResponse.status).toBe(200);
    const subject = await signedUpSubject(signUpResponse);

    // Simulate the lost follow-up: the account exists, the bootstrap row does
    // not, and only the intent the sign-up wrote before creating the account
    // remains.
    await systemPoolFor(env()).query("DELETE FROM installation_bootstrap");
    const intent = await systemPoolFor(env()).query<{ workspace_name: string | null }>(
      "SELECT workspace_name FROM installation_bootstrap_intent WHERE lower(email) = lower($1)",
      [owner.email],
    );
    expect(intent.rows[0]?.workspace_name).toBe(owner.workspaceName);

    const ownerApp = appWith({
      [subject]: { email: owner.email, name: owner.name, subject },
    });
    const progress = await onboardingRequest(ownerApp, subject, "", { method: "GET" });
    expect(progress.status).toBe(200);
    expect(await progressOf(progress)).toMatchObject({
      status: "in_progress",
      workspace_name: owner.workspaceName,
      workspace_named: true,
    });
    expect((await sharedWorkspace())?.name).toBe(owner.workspaceName);

    // Recovery promoted the intent into the durable bootstrap row rather than
    // leaving the name only in the handoff table.
    const bootstrap = await systemPoolFor(env()).query<{ workspace_name: string | null }>(
      "SELECT workspace_name FROM installation_bootstrap WHERE auth_user_id = $1",
      [subject],
    );
    expect(bootstrap.rows[0]?.workspace_name).toBe(owner.workspaceName);

    // Registration is still closed: the recovery never reopened sign-up.
    const closed = await signUp(app, {
      email: "another-owner@onboarding.test",
      name: "Another",
      password: owner.password,
      workspace_name: "Another Studio",
    });
    expect(closed.status).toBe(403);
  });

  /**
   * A rejected sign-up proves nothing was written, so its intent must not become
   * a permanent name for an address that never signed up.
   */
  it("discards the intent when the account was definitively not created", async () => {
    const app = appWith({});
    const rejected = await signUp(app, {
      email: "rejected@onboarding.test",
      name: "Rejected",
      password: "x",
      workspace_name: "Never Created",
    });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.status).toBeLessThan(500);

    const intent = await systemPoolFor(env()).query(
      "SELECT 1 FROM installation_bootstrap_intent WHERE lower(email) = lower($1)",
      ["rejected@onboarding.test"],
    );
    expect(intent.rows).toHaveLength(0);
  });

  /**
   * An installation that never entered the setup form must not be handed an
   * `in_progress` journey when an Owner reaches the slow provisioning path with a
   * changed profile — the bootstrap record is the durable provenance.
   */
  it("never manufactures onboarding for a slow-path upgraded Owner", async () => {
    const subject = "upgraded-slow-path-subject";
    const email = "upgraded-slow@onboarding.test";
    await systemPoolFor(env()).query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Old Name', $2, TRUE)`,
      [subject, email],
    );
    await systemPoolFor(env()).query(
      `INSERT INTO users (id, auth_user_id, email, display_name, installation_owner)
       VALUES ($1, $2, $3, 'Stale Name', TRUE)`,
      ["10000000-0000-4000-8000-000000009921", subject, email],
    );
    await systemPoolFor(env()).query(
      `INSERT INTO organizations (id, name, slug, is_shared)
       VALUES ($1, 'Upgraded Workspace', 'upgraded-slow-path', TRUE)`,
      ["20000000-0000-4000-8000-000000009921"],
    );
    await systemPoolFor(env()).query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')",
      ["20000000-0000-4000-8000-000000009921", "10000000-0000-4000-8000-000000009921"],
    );

    // The profile differs from the stored display name, so actor resolution
    // misses the fast path and runs provisioning.
    const app = appWith({ [subject]: { email, name: "Changed Name", subject } });
    const progress = await onboardingRequest(app, subject, "", { method: "GET" });

    expect(progress.status).toBe(200);
    expect(await progressOf(progress)).toMatchObject({
      status: "not_applicable",
      workspace_name: "Upgraded Workspace",
    });
    const rows = await systemPoolFor(env()).query(
      "SELECT 1 FROM installation_onboarding WHERE org_id = $1",
      ["20000000-0000-4000-8000-000000009921"],
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("onboarding completion and save ordering", () => {
  /**
   * A save ordered after completion must refuse, so a Settings rename committed
   * between the stale read and the write can never be overwritten.
   */
  it("refuses a save that is ordered after completion", async () => {
    const { app, token } = await bootstrapOwner();
    const workspace = await sharedWorkspace();
    const rename = (name: string) =>
      app.request(
        `/api/v1/workspaces/${workspace!.id}`,
        {
          body: JSON.stringify({ name }),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          method: "PATCH",
        },
        env(),
      );

    // Completion first, then a Settings rename, then a late onboarding save —
    // the interleaving that previously depended on transaction timing.
    const completed = await onboardingRequest(app, token, "/complete", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "POST",
    });
    expect(completed.status).toBe(200);
    expect((await rename("Settings Canonical")).status).toBe(200);

    const late = await onboardingRequest(app, token, "", {
      body: JSON.stringify({ step: "ready", workspace_name: "Stale Onboarding Name" }),
      headers: { "Idempotency-Key": crypto.randomUUID() },
      method: "PATCH",
    });
    expect(late.status).toBe(409);
    expect((await sharedWorkspace())?.name).toBe("Settings Canonical");
  });

  /**
   * Completion must not be lost to a concurrent save: both take the onboarding
   * row lock, so the terminal state always lands and the name stays canonical.
   */
  it("serializes a concurrent save against completion", async () => {
    const { app, token } = await bootstrapOwner();
    const [saved, completed] = await Promise.all([
      onboardingRequest(app, token, "", {
        body: JSON.stringify({ step: "ready", workspace_name: "Concurrent Name" }),
        headers: { "Idempotency-Key": crypto.randomUUID() },
        method: "PATCH",
      }),
      onboardingRequest(app, token, "/complete", {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        method: "POST",
      }),
    ]);

    // Both orders are legal: a save that commits first is accepted, and one that
    // commits second is refused. Either way completion is terminal.
    expect([200, 409]).toContain(saved.status);
    expect(completed.status).toBe(200);
    const progress = await progressOf(await onboardingRequest(app, token, "", { method: "GET" }));
    expect(progress.status).toBe("completed");
    expect(progress.completed_at).not.toBeNull();
  });
});
