import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import type { JwtIdentity } from "@meltiply/auth";

import type { ApiWorkerEnv } from "../src/env";
import type * as BetterAuthModule from "../src/better-auth";

/**
 * Narrows a parsed auth request body to the password field.
 *
 * @param value - Parsed JSON body.
 * @returns The supplied password, or undefined for an invalid body.
 */
function passwordFrom(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    "password" in value &&
    typeof value.password === "string"
  ) {
    return value.password;
  }
  return undefined;
}

const reauthGate = vi.hoisted(() => ({
  hold: false,
  release: undefined as (() => void) | undefined,
  started: undefined as (() => void) | undefined,
}));

vi.mock("../src/better-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof BetterAuthModule>();
  return {
    ...actual,
    betterAuthFor: async () => ({
      handler: async (request: Request) => {
        const password = passwordFrom(await request.json());
        if (reauthGate.hold) {
          const gate = new Promise<void>((resolve) => {
            reauthGate.release = resolve;
          });
          reauthGate.started?.();
          await gate;
        }
        return password === "MeltiplyLocal1!"
          ? Response.json({ token: `reauth-${crypto.randomUUID()}` })
          : new Response(JSON.stringify({ message: "invalid credentials" }), {
              headers: { "Content-Type": "application/json" },
              status: 401,
            });
      },
    }),
  };
});

import { createApiApp } from "../src/app";
import { systemPoolFor } from "../src/database";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}

const env = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  APP_URL: "http://localhost:3000",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

const sharedWorkspaceId = "20000000-0000-4000-8000-000000000005";
const ownerId = "10000000-0000-4000-8000-000000000001";
const adminId = "10000000-0000-4000-8000-000000000002";
const editorId = "10000000-0000-4000-8000-000000000003";
const idempotencyPrefix = "ownership-transfer-test-";

const identities: Record<string, JwtIdentity> = {
  admin: {
    email: "beta@meltiply.local",
    emailVerified: true,
    name: "Beta Admin",
    subject: "auth_user_local_beta",
  },
  owner: {
    email: "alpha@meltiply.local",
    emailVerified: true,
    name: "Alpha Creator",
    subject: "auth_user_local_alpha",
  },
};

const app = createApiApp({
  verifyJwtToken: async (_env, token) => identities[token]!,
});

/**
 * Sends one authenticated request through the real API app.
 *
 * @param path - API path.
 * @param init - Request method, body, and headers.
 * @param as - Identity key performing the request.
 * @returns The HTTP response.
 */
function request(
  path: string,
  init: { body?: string; headers?: Record<string, string>; method: string },
  as: keyof typeof identities,
) {
  return app.request(
    path,
    {
      body: init.body,
      headers: {
        Authorization: `Bearer ${as}`,
        ...init.headers,
      },
      method: init.method,
    },
    env,
  );
}

/**
 * Narrows an installation response body to its owner id.
 *
 * @param value - Parsed JSON body.
 * @returns The installation owner user id.
 * @throws Error when the payload does not carry a string owner id.
 */
function installationOwnerId(value: unknown): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "installation_owner_user_id" in value &&
    typeof value.installation_owner_user_id === "string"
  ) {
    return value.installation_owner_user_id;
  }
  throw new Error("Installation response must include installation_owner_user_id");
}

/**
 * Reads the installation owner id from an installation response.
 *
 * @param response - Installation response.
 * @returns The owner user id.
 */
async function ownerIdFrom(response: Response): Promise<string> {
  return installationOwnerId(await response.json());
}

afterAll(async () => {
  await systemPoolFor(env).query("DELETE FROM auth_rate_limits WHERE action = 'sign-in'");
  await systemPoolFor(env).query(
    "UPDATE users SET installation_owner = FALSE WHERE installation_owner AND id <> $1",
    [ownerId],
  );
  await systemPoolFor(env).query(
    "UPDATE users SET installation_owner = TRUE, updated_at = now() WHERE id = $1",
    [ownerId],
  );
  await systemPoolFor(env).query(
    `DELETE FROM idempotency_keys
     WHERE org_id = $1 AND operation = 'installation.ownership.transfer'
       AND idempotency_key LIKE $2`,
    [sharedWorkspaceId, `${idempotencyPrefix}%`],
  );
  await systemPoolFor(env).end();
});

interface AuditEntry {
  action: string;
  after: { owner_user_id: string } | null;
  before: { owner_user_id: string } | null;
  target_id: string;
}

/**
 * Narrows an audit response to its entries.
 *
 * @param value - Parsed JSON body.
 * @returns The Audit entries.
 * @throws Error when the payload does not carry an entries array.
 */
function auditEntries(value: unknown): AuditEntry[] {
  if (
    value !== null &&
    typeof value === "object" &&
    "entries" in value &&
    Array.isArray(value.entries)
  ) {
    return value.entries;
  }
  throw new Error("Audit response must include an entries array");
}

describe("installation ownership transfer", () => {
  it("requires reauthentication, transfers between active admins, and audits both directions", async () => {
    const requestIds: string[] = [];
    const transfer = async (
      as: keyof typeof identities,
      targetUserId: string,
      password: string,
    ) => {
      const response = await request(
        "/api/v1/installation/ownership-transfer",
        {
          body: JSON.stringify({ password, target_user_id: targetUserId }),
          headers: { "Idempotency-Key": `${idempotencyPrefix}${crypto.randomUUID()}` },
          method: "POST",
        },
        as,
      );
      const requestId = response.headers.get("X-Request-ID");
      if (requestId) requestIds.push(requestId);
      return response;
    };

    try {
      const wrongPassword = await transfer("owner", adminId, "not-the-password");
      expect(wrongPassword.status).toBe(401);

      const invalidTarget = await transfer("owner", editorId, "MeltiplyLocal1!");
      expect(invalidTarget.status).toBe(409);

      const toAdmin = await transfer("owner", adminId, "MeltiplyLocal1!");
      expect(toAdmin.status).toBe(200);
      expect(await ownerIdFrom(toAdmin.clone())).toBe(adminId);

      const adminInstallation = await request("/api/v1/installation", { method: "GET" }, "admin");
      expect(adminInstallation.status).toBe(200);
      expect(await ownerIdFrom(adminInstallation)).toBe(adminId);

      const audit = await request(
        `/api/v1/workspaces/${sharedWorkspaceId}/audit`,
        { method: "GET" },
        "admin",
      );
      expect(audit.status).toBe(200);
      const auditBody = auditEntries(await audit.json());
      expect(
        auditBody.find(
          (entry) =>
            entry.action === "installation.ownership_transferred" && entry.target_id === adminId,
        ),
      ).toMatchObject({
        after: { owner_user_id: adminId },
        before: { owner_user_id: ownerId },
      });

      const toOwner = await transfer("admin", ownerId, "MeltiplyLocal1!");
      expect(toOwner.status).toBe(200);
      expect(await ownerIdFrom(toOwner.clone())).toBe(ownerId);

      const ownerInstallation = await request("/api/v1/installation", { method: "GET" }, "owner");
      expect(ownerInstallation.status).toBe(200);
      expect(await ownerIdFrom(ownerInstallation)).toBe(ownerId);
    } finally {
      await systemPoolFor(env).query(
        "UPDATE users SET installation_owner = FALSE WHERE installation_owner AND id <> $1",
        [ownerId],
      );
      await systemPoolFor(env).query(
        "UPDATE users SET installation_owner = TRUE, updated_at = now() WHERE id = $1",
        [ownerId],
      );
      if (requestIds.length > 0) {
        await systemPoolFor(env).query(
          "DELETE FROM workspace_audit_entries WHERE request_id = ANY($1::text[])",
          [requestIds],
        );
      }
    }
  });

  it("rejects a transfer whose owner authority changed during reauthentication", async () => {
    const gammaId = "10000000-0000-4000-8000-000000000003";
    const keyPrefix = "stale-ownership-transfer-test-";
    let firstRequestId: string | null = null;

    await systemPoolFor(env).query(
      `UPDATE org_members SET role = 'admin', updated_at = now()
       WHERE org_id = $1 AND user_id = $2`,
      [sharedWorkspaceId, gammaId],
    );
    reauthGate.hold = true;
    try {
      const staleStarted = new Promise<void>((resolve) => {
        reauthGate.started = resolve;
      });
      const stale = request(
        "/api/v1/installation/ownership-transfer",
        {
          body: JSON.stringify({ password: "MeltiplyLocal1!", target_user_id: gammaId }),
          headers: { "Idempotency-Key": `${keyPrefix}stale` },
          method: "POST",
        },
        "owner",
      );
      await staleStarted;
      // Only the stale request is held; later sign-ins (the first transfer)
      // must proceed normally.
      reauthGate.hold = false;

      // The first transfer completes while the stale request is waiting in
      // reauthentication. Releasing it must not let the former Owner transfer
      // ownership a second time.
      const first = await request(
        "/api/v1/installation/ownership-transfer",
        {
          body: JSON.stringify({ password: "MeltiplyLocal1!", target_user_id: adminId }),
          headers: { "Idempotency-Key": `${keyPrefix}first` },
          method: "POST",
        },
        "owner",
      );
      expect(first.status).toBe(200);
      firstRequestId = first.headers.get("X-Request-ID");

      reauthGate.release?.();
      const staleResponse = await stale;
      expect(staleResponse.status).toBe(403);
      await expect(staleResponse.json()).resolves.toMatchObject({
        error: { code: "installation_owner_required" },
      });
    } finally {
      reauthGate.hold = false;
      reauthGate.release = undefined;
      reauthGate.started = undefined;
      await systemPoolFor(env).query(
        "UPDATE users SET installation_owner = FALSE WHERE installation_owner AND id <> $1",
        [ownerId],
      );
      await systemPoolFor(env).query(
        "UPDATE users SET installation_owner = TRUE, updated_at = now() WHERE id = $1",
        [ownerId],
      );
      await systemPoolFor(env).query(
        `UPDATE org_members SET role = 'editor', updated_at = now()
         WHERE org_id = $1 AND user_id = $2`,
        [sharedWorkspaceId, gammaId],
      );
      await systemPoolFor(env).query(
        `DELETE FROM idempotency_keys
         WHERE org_id = $1 AND operation = 'installation.ownership.transfer'
           AND idempotency_key LIKE $2`,
        [sharedWorkspaceId, `${keyPrefix}%`],
      );
      if (firstRequestId) {
        await systemPoolFor(env).query(
          "DELETE FROM workspace_audit_entries WHERE request_id = $1",
          [firstRequestId],
        );
      }
    }
  });
});
