import { createHash } from "node:crypto";

import { Effect } from "effect";
import type { JwtIdentity } from "@meltiply/auth";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { ApiWorkerEnv } from "../src/env";
import { createApiApp } from "../src/app";
import { systemPoolFor } from "../src/database";
import { createMailServiceTest, type MailMessage } from "../src/mail";

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
  FRONTEND_URL: "http://localhost:3000",
  TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

const sharedWorkspaceId = "20000000-0000-4000-8000-000000000005";
const ownerId = "10000000-0000-4000-8000-000000000001";
const adminId = "10000000-0000-4000-8000-000000000002";
const editorId = "10000000-0000-4000-8000-000000000003";
const seededProfileId = "c0000000-0000-4000-8000-000000000001";
const unknownId = "00000000-0000-4000-8000-000000000999";
const inviteeSubject = "auth_user_permission_matrix_invitee";
const inviteeEmail = "permission-matrix-invitee@meltiply.local";

const identities: Record<string, JwtIdentity> = {
  admin: {
    email: "beta@meltiply.local",
    emailVerified: true,
    name: "Beta Admin",
    subject: "auth_user_local_beta",
  },
  editor: {
    email: "gamma@meltiply.local",
    emailVerified: true,
    name: "Gamma Editor",
    subject: "auth_user_local_gamma",
  },
  invitee: {
    email: inviteeEmail,
    emailVerified: true,
    name: "Invitee",
    subject: inviteeSubject,
  },
  owner: {
    email: "alpha@meltiply.local",
    emailVerified: true,
    name: "Alpha Creator",
    subject: "auth_user_local_alpha",
  },
  viewer: {
    email: "delta@meltiply.local",
    emailVerified: true,
    name: "Delta Viewer",
    subject: "auth_user_local_delta",
  },
};

const mailed: MailMessage[] = [];
const app = createApiApp({
  verifyJwtToken: async (_env, token) => identities[token]!,
  workspaceLifecycle: {
    mailServiceLayer: createMailServiceTest({
      send: (message) =>
        Effect.sync(() => {
          mailed.push(message);
          return { submissionId: "permission-matrix" };
        }),
    }),
  },
});

/**
 * Sends one authenticated request through the real API app.
 *
 * @param path - API path.
 * @param init - Request method, body, and headers.
 * @param as - Identity key, or undefined for an unauthenticated request.
 * @returns The HTTP response.
 */
function request(
  path: string,
  init: { body?: string; headers?: Record<string, string>; method: string },
  as?: keyof typeof identities,
) {
  return app.request(
    path,
    {
      body: init.body,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        ...init.headers,
      },
      method: init.method,
    },
    env,
  );
}

/**
 * Reads the machine error code from an error envelope.
 *
 * @param value - Parsed JSON response.
 * @returns The error code, when present.
 */
function errorCode(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    value.error !== null &&
    typeof value.error === "object" &&
    "code" in value.error &&
    typeof value.error.code === "string"
  ) {
    return value.error.code;
  }
  return undefined;
}

/**
 * Reads the Seat count from an installation response.
 *
 * @param value - Parsed JSON response.
 * @returns The number of Seats in use.
 * @throws Error when the payload does not carry a numeric `seats_used`.
 */
function seatsUsedFrom(value: unknown): number {
  if (
    value !== null &&
    typeof value === "object" &&
    "seats_used" in value &&
    typeof value.seats_used === "number"
  ) {
    return value.seats_used;
  }
  throw new Error("Installation response must include a numeric seats_used");
}

/**
 * Reads Audit entries from an audit response.
 *
 * @param value - Parsed JSON response.
 * @returns The Audit entries.
 * @throws Error when the payload does not carry an entries array.
 */
function auditEntriesFrom(value: unknown): { action: string; target_id: string }[] {
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

/**
 * Reads a string `id` from a decoded response object.
 *
 * @param value - Parsed JSON response.
 * @returns The `id` string.
 * @throws Error when the payload does not carry a string id.
 */
function idFrom(value: unknown): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return value.id;
  }
  throw new Error("Response must include a string id");
}

/**
 * Reads the member user id from an invitation acceptance response.
 *
 * @param value - Parsed JSON response.
 * @returns The internal member user id.
 * @throws Error when the payload does not carry the nested id.
 */
function memberUserIdFrom(value: unknown): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "member" in value &&
    value.member !== null &&
    typeof value.member === "object" &&
    "user_id" in value.member &&
    typeof value.member.user_id === "string"
  ) {
    return value.member.user_id;
  }
  throw new Error("Acceptance response must include member.user_id");
}

/**
 * Creates a unique temporary Brand Profile through the admin API.
 *
 * @param as - Identity performing the create.
 * @returns The created profile id and name.
 */
async function createTemporaryProfile(as: "admin" | "owner") {
  const name = `permission-profile-${crypto.randomUUID().slice(0, 8)}`;
  const response = await request(
    "/api/v1/brand-profiles",
    {
      body: JSON.stringify({ color: "#1d4ed8", name }),
      headers: { "Idempotency-Key": `permission-profile-${name}` },
      method: "POST",
    },
    as,
  );
  expect(response.status).toBe(201);
  return { id: idFrom(await response.json()) };
}

beforeAll(async () => {
  // A manually rerun suite shares the local database with earlier attempts;
  // clear rate-limit buckets so repeat runs observe authorization, not 429s.
  await systemPoolFor(env).query("DELETE FROM auth_rate_limits");
});

afterAll(async () => {
  await systemPoolFor(env).query(
    `DELETE FROM brand_profiles WHERE name LIKE 'permission-profile-%'`,
  );
  await systemPoolFor(env).query(`DELETE FROM posts WHERE title LIKE 'Permission%'`);
  await systemPoolFor(env).query(
    `DELETE FROM workspace_invitations WHERE email LIKE 'permission-%@meltiply.local'`,
  );
  await systemPoolFor(env).query('DELETE FROM "user" WHERE id = $1', [inviteeSubject]);
  await systemPoolFor(env).query("DELETE FROM users WHERE auth_user_id = $1", [inviteeSubject]);
  await systemPoolFor(env).end();
});

describe("role permission matrix", () => {
  it("requires authentication before tenant work", async () => {
    const response = await request("/api/v1/posts", { method: "GET" });
    expect(response.status).toBe(401);
    expect(errorCode(await response.json())).toBe("authentication_required");
  });

  it.each([
    ["owner", "owner"],
    ["admin", "admin"],
    ["editor", "editor"],
    ["viewer", "viewer"],
  ] as const)("allows %s read access to every content surface", async (_label, as) => {
    const start = encodeURIComponent("2026-01-01T00:00:00.000Z");
    const end = encodeURIComponent("2026-01-31T00:00:00.000Z");
    for (const path of [
      "/api/v1/posts",
      "/api/v1/platforms",
      "/api/v1/brand-profiles",
      `/api/v1/calendar?start=${start}&end=${end}`,
      `/api/v1/analytics?start=${start}&end=${end}`,
      "/api/v1/inbox",
    ]) {
      const response = await request(path, { method: "GET" }, as);
      expect(response.status, `${as} ${path}`).toBe(200);
    }
  });

  it("denies every Viewer mutation with a stable forbidden code", async () => {
    const mutations = [
      {
        body: JSON.stringify({ brand_profile_id: seededProfileId }),
        method: "POST",
        path: "/api/v1/posts",
      },
      {
        body: JSON.stringify({ brand_profile_id: seededProfileId }),
        method: "PATCH",
        path: `/api/v1/posts/${unknownId}`,
      },
      { method: "DELETE", path: `/api/v1/posts/${unknownId}` },
      {
        body: JSON.stringify({ color: "#1d4ed8", name: "viewer-forbidden" }),
        method: "POST",
        path: "/api/v1/brand-profiles",
      },
      { method: "DELETE", path: `/api/v1/brand-profiles/${seededProfileId}` },
      {
        method: "GET",
        path: `/api/v1/platforms/tiktok/connect?brand_profile_id=${seededProfileId}`,
      },
      { method: "DELETE", path: `/api/v1/platforms/${unknownId}` },
      {
        body: JSON.stringify({ account_id: unknownId }),
        method: "POST",
        path: `/api/v1/oauth-selections/${unknownId}/confirm`,
      },
      {
        body: JSON.stringify({ email: "viewer-invite@example.test", role: "editor" }),
        method: "POST",
        path: `/api/v1/workspaces/${sharedWorkspaceId}/invitations`,
      },
      {
        body: JSON.stringify({ role: "editor" }),
        method: "PATCH",
        path: `/api/v1/workspaces/${sharedWorkspaceId}/members/${editorId}`,
      },
      { method: "DELETE", path: `/api/v1/workspaces/${sharedWorkspaceId}/members/${editorId}` },
      { method: "GET", path: `/api/v1/workspaces/${sharedWorkspaceId}/audit` },
      { method: "GET", path: "/api/v1/installation" },
      {
        body: JSON.stringify({ reason: "nope" }),
        method: "POST",
        path: `/api/v1/installation/members/${editorId}/suspend`,
      },
    ] as const;
    for (const mutation of mutations) {
      const response = await request(
        mutation.path,
        {
          body: "body" in mutation ? mutation.body : undefined,
          headers: { "Idempotency-Key": `viewer-denied-${mutation.method}-${mutation.path}` },
          method: mutation.method,
        },
        "viewer",
      );
      expect(response.status, `${mutation.method} ${mutation.path}`).toBe(403);
      const body = await response.json();
      expect([
        "forbidden_role",
        "forbidden_role_assignment",
        "workspace_admin_required",
        "installation_owner_required",
      ]).toContain(errorCode(body));
    }
  });

  it("lets an Editor write content but not configure or administer", async () => {
    const created = await request(
      "/api/v1/posts",
      {
        body: JSON.stringify({
          brand_profile_id: seededProfileId,
          default_text: "Permission editor draft",
          title: `Permission editor ${crypto.randomUUID().slice(0, 8)}`,
        }),
        headers: { "Idempotency-Key": `permission-editor-post-${crypto.randomUUID()}` },
        method: "POST",
      },
      "editor",
    );
    expect(created.status).toBe(201);
    const postId = idFrom(await created.json());
    const deleted = await request(
      `/api/v1/posts/${postId}`,
      {
        body: JSON.stringify({ brand_profile_id: seededProfileId }),
        headers: { "Idempotency-Key": `permission-editor-delete-${postId}` },
        method: "DELETE",
      },
      "editor",
    );
    expect(deleted.status).toBe(200);

    const forbidden = [
      {
        body: JSON.stringify({ color: "#1d4ed8", name: "editor-forbidden" }),
        method: "POST",
        path: "/api/v1/brand-profiles",
      },
      {
        method: "GET",
        path: `/api/v1/platforms/tiktok/connect?brand_profile_id=${seededProfileId}`,
      },
      { method: "DELETE", path: `/api/v1/platforms/${unknownId}` },
      {
        body: JSON.stringify({ email: "editor-invite@example.test", role: "viewer" }),
        method: "POST",
        path: `/api/v1/workspaces/${sharedWorkspaceId}/invitations`,
      },
      { method: "GET", path: `/api/v1/workspaces/${sharedWorkspaceId}/audit` },
      { method: "GET", path: "/api/v1/installation" },
    ] as const;
    for (const mutation of forbidden) {
      const response = await request(
        mutation.path,
        {
          body: "body" in mutation ? mutation.body : undefined,
          headers: { "Idempotency-Key": `editor-denied-${mutation.method}-${mutation.path}` },
          method: mutation.method,
        },
        "editor",
      );
      expect(response.status, `${mutation.method} ${mutation.path}`).toBe(403);
    }
  });

  it("lets an Admin manage Editors and configuration but not Admins or installation lifecycle", async () => {
    const profile = await createTemporaryProfile("admin");
    expect(
      (
        await request(
          `/api/v1/brand-profiles/${profile.id}`,
          {
            headers: { "Idempotency-Key": `permission-admin-profile-delete-${profile.id}` },
            method: "DELETE",
          },
          "admin",
        )
      ).status,
    ).toBe(200);

    const inviteEmail = `permission-admin-invite-${crypto.randomUUID().slice(0, 8)}@meltiply.local`;
    const invited = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/invitations`,
      {
        body: JSON.stringify({ email: inviteEmail, role: "editor" }),
        headers: { "Idempotency-Key": `permission-admin-invite-${inviteEmail}` },
        method: "POST",
      },
      "admin",
    );
    expect(invited.status).toBe(201);
    const invitationId = idFrom(await invited.json());
    expect(
      (
        await request(
          `/api/v1/workspaces/${sharedWorkspaceId}/invitations`,
          { method: "GET" },
          "admin",
        )
      ).status,
    ).toBe(200);
    const resent = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/invitations/${invitationId}/resend`,
      {
        headers: { "Idempotency-Key": `permission-admin-resend-${invitationId}` },
        method: "POST",
      },
      "admin",
    );
    expect(resent.status).toBe(200);
    expect(await resent.json()).toMatchObject({ id: invitationId, status: "pending" });
    expect(mailed.filter((entry) => entry.to === inviteEmail)).toHaveLength(2);
    expect(
      (
        await request(
          `/api/v1/workspaces/${sharedWorkspaceId}/invitations/${invitationId}`,
          {
            headers: { "Idempotency-Key": `permission-admin-revoke-${invitationId}` },
            method: "DELETE",
          },
          "admin",
        )
      ).status,
    ).toBe(204);

    const demote = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/members/${editorId}`,
      {
        body: JSON.stringify({ role: "viewer" }),
        headers: { "Idempotency-Key": `permission-admin-demote-${editorId}` },
        method: "PATCH",
      },
      "admin",
    );
    expect(demote.status).toBe(200);
    await systemPoolFor(env).query(
      `UPDATE org_members SET role = 'editor' WHERE org_id = $1 AND user_id = $2`,
      [sharedWorkspaceId, editorId],
    );

    expect(
      (await request(`/api/v1/workspaces/${sharedWorkspaceId}/members`, { method: "GET" }, "admin"))
        .status,
    ).toBe(200);
    expect(
      (await request(`/api/v1/workspaces/${sharedWorkspaceId}/audit`, { method: "GET" }, "admin"))
        .status,
    ).toBe(200);
    expect((await request("/api/v1/installation", { method: "GET" }, "admin")).status).toBe(200);

    const forbidden = [
      {
        body: JSON.stringify({ email: "admin-cannot-invite-admin@example.test", role: "admin" }),
        method: "POST",
        path: `/api/v1/workspaces/${sharedWorkspaceId}/invitations`,
      },
      {
        body: JSON.stringify({ role: "editor" }),
        method: "PATCH",
        path: `/api/v1/workspaces/${sharedWorkspaceId}/members/${adminId}`,
      },
      {
        body: JSON.stringify({ role: "viewer" }),
        method: "PATCH",
        path: `/api/v1/workspaces/${sharedWorkspaceId}/members/${ownerId}`,
      },
      {
        body: JSON.stringify({ reason: "nope" }),
        method: "POST",
        path: `/api/v1/installation/members/${editorId}/suspend`,
      },
      { method: "POST", path: `/api/v1/installation/members/${editorId}/reactivate` },
      {
        body: JSON.stringify({ confirm_email: "gamma@meltiply.local" }),
        method: "DELETE",
        path: `/api/v1/installation/members/${editorId}`,
      },
      {
        body: JSON.stringify({ password: "wrong", target_user_id: editorId }),
        method: "POST",
        path: "/api/v1/installation/ownership-transfer",
      },
    ] as const;
    for (const mutation of forbidden) {
      const response = await request(
        mutation.path,
        {
          body: "body" in mutation ? mutation.body : undefined,
          headers: { "Idempotency-Key": `admin-denied-${mutation.method}-${mutation.path}` },
          method: mutation.method,
        },
        "admin",
      );
      expect(response.status, `${mutation.method} ${mutation.path}`).toBe(403);
    }
  });

  it("lets the Owner administer installation lifecycle while protecting their own account", async () => {
    expect((await request("/api/v1/installation", { method: "GET" }, "owner")).status).toBe(200);
    expect(
      (await request(`/api/v1/workspaces/${sharedWorkspaceId}/members`, { method: "GET" }, "owner"))
        .status,
    ).toBe(200);
    expect(
      (await request(`/api/v1/workspaces/${sharedWorkspaceId}/audit`, { method: "GET" }, "owner"))
        .status,
    ).toBe(200);

    const profile = await createTemporaryProfile("owner");
    expect(
      (
        await request(
          `/api/v1/brand-profiles/${profile.id}`,
          {
            headers: { "Idempotency-Key": `permission-owner-profile-delete-${profile.id}` },
            method: "DELETE",
          },
          "owner",
        )
      ).status,
    ).toBe(200);

    for (const mutation of [
      {
        body: JSON.stringify({ reason: "self" }),
        method: "POST",
        path: `/api/v1/installation/members/${ownerId}/suspend`,
      },
      {
        body: JSON.stringify({ confirm_email: "alpha@meltiply.local" }),
        method: "DELETE",
        path: `/api/v1/installation/members/${ownerId}`,
      },
    ] as const) {
      const response = await request(
        mutation.path,
        {
          body: mutation.body,
          headers: { "Idempotency-Key": `owner-self-${mutation.method}-${mutation.path}` },
          method: mutation.method,
        },
        "owner",
      );
      expect(response.status).toBe(409);
      expect(errorCode(await response.json())).toBe("owner_self_removal");
    }

    const selfTransfer = await request(
      "/api/v1/installation/ownership-transfer",
      {
        body: JSON.stringify({ password: "wrong", target_user_id: ownerId }),
        headers: { "Idempotency-Key": "owner-self-transfer" },
        method: "POST",
      },
      "owner",
    );
    expect(selfTransfer.status).toBe(409);
    expect(errorCode(await selfTransfer.json())).toBe("owner_transfer_invalid");
  });

  it("previews invitations and rejects used, expired, revoked, and mismatched tokens", async () => {
    const invitationId = crypto.randomUUID();
    const token = `permission-preview-${crypto.randomUUID().replaceAll("-", "")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const previewPath = `/api/v1/workspace-invitations/${token}`;
    await systemPoolFor(env).query(
      `DELETE FROM workspace_invitations
       WHERE org_id = $1 AND lower(email) = 'gamma@meltiply.local'
         AND accepted_at IS NULL AND revoked_at IS NULL`,
      [sharedWorkspaceId],
    );
    await systemPoolFor(env).query(
      `INSERT INTO workspace_invitations
         (id, org_id, email, role, invited_by, token_hash, expires_at)
       VALUES ($1, $2, 'gamma@meltiply.local', 'viewer', $3, $4, now() + interval '1 day')`,
      [invitationId, sharedWorkspaceId, ownerId, tokenHash],
    );
    try {
      const pending = await request(previewPath, { method: "GET" });
      expect(pending.status).toBe(200);
      await expect(pending.json()).resolves.toMatchObject({
        email: "gamma@meltiply.local",
        role: "viewer",
        status: "pending",
        workspace_name: expect.any(String),
      });

      expect((await request("/api/v1/workspace-invitations/short", { method: "GET" })).status).toBe(
        400,
      );
      expect(
        (await request(`/api/v1/workspace-invitations/${"x".repeat(32)}`, { method: "GET" }))
          .status,
      ).toBe(404);

      const mismatch = await request(`${previewPath}/accept`, { method: "POST" }, "admin");
      expect(mismatch.status).toBe(403);
      expect(errorCode(await mismatch.json())).toBe("invitation_email_mismatch");

      await systemPoolFor(env).query(
        `UPDATE workspace_invitations SET expires_at = now() - interval '1 day' WHERE id = $1`,
        [invitationId],
      );
      await expect((await request(previewPath, { method: "GET" })).json()).resolves.toMatchObject({
        status: "expired",
      });
      const expired = await request(`${previewPath}/accept`, { method: "POST" }, "editor");
      expect(expired.status).toBe(410);
      expect(errorCode(await expired.json())).toBe("invitation_expired");

      await systemPoolFor(env).query(
        `UPDATE workspace_invitations
         SET expires_at = now() + interval '1 day', revoked_at = now()
         WHERE id = $1`,
        [invitationId],
      );
      await expect((await request(previewPath, { method: "GET" })).json()).resolves.toMatchObject({
        status: "revoked",
      });
      const revoked = await request(`${previewPath}/accept`, { method: "POST" }, "editor");
      expect(revoked.status).toBe(410);
      expect(errorCode(await revoked.json())).toBe("invitation_revoked");

      await systemPoolFor(env).query(
        `UPDATE workspace_invitations SET revoked_at = NULL WHERE id = $1`,
        [invitationId],
      );
      const accepted = await request(`${previewPath}/accept`, { method: "POST" }, "editor");
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toMatchObject({
        member: { user_id: editorId },
      });
      await expect((await request(previewPath, { method: "GET" })).json()).resolves.toMatchObject({
        status: "accepted",
      });
      const replay = await request(`${previewPath}/accept`, { method: "POST" }, "editor");
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        member: { user_id: editorId },
      });
    } finally {
      await systemPoolFor(env).query("DELETE FROM workspace_invitations WHERE id = $1", [
        invitationId,
      ]);
    }
  });

  it("suspends, blocks, reactivates, and hard-deletes an invited account", async () => {
    const seatsUsed = async () => {
      const response = await request("/api/v1/installation", { method: "GET" }, "owner");
      expect(response.status).toBe(200);
      return seatsUsedFrom(await response.json());
    };
    const baselineSeats = await seatsUsed();
    await systemPoolFor(env).query(
      `INSERT INTO "user" (id, name, email, "emailVerified")
       VALUES ($1, 'Invitee', $2, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [inviteeSubject, inviteeEmail],
    );
    await systemPoolFor(env).query("DELETE FROM workspace_invitations WHERE email = $1", [
      inviteeEmail,
    ]);
    const invited = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/invitations`,
      {
        body: JSON.stringify({ email: inviteeEmail, role: "viewer" }),
        headers: {
          "Idempotency-Key": `permission-invitee-invite-${crypto.randomUUID()}`,
        },
        method: "POST",
      },
      "owner",
    );
    expect(invited.status).toBe(201);
    expect(await seatsUsed()).toBe(baselineSeats + 1);
    const invitationId = idFrom(await invited.json());
    const message = mailed.find((entry) => entry.to === inviteeEmail);
    expect(message).toBeDefined();
    const token = new URL(/Accept the invitation: (\S+)/.exec(message!.text)![1]!).searchParams.get(
      "token",
    )!;
    const accepted = await request(
      `/api/v1/workspace-invitations/${token}/accept`,
      { method: "POST" },
      "invitee",
    );
    expect(accepted.status).toBe(200);
    expect(await seatsUsed()).toBe(baselineSeats + 1);
    const memberId = memberUserIdFrom(await accepted.json());

    expect(
      (
        await request(
          `/api/v1/installation/members/${memberId}/suspend`,
          {
            body: JSON.stringify({ reason: "permission test" }),
            headers: { "Idempotency-Key": `permission-invitee-suspend-${memberId}` },
            method: "POST",
          },
          "owner",
        )
      ).status,
    ).toBe(200);
    expect(await seatsUsed()).toBe(baselineSeats);
    const blocked = await request("/api/v1/users/me", { method: "GET" }, "invitee");
    expect(blocked.status).toBe(403);
    expect(errorCode(await blocked.json())).toBe("account_suspended");

    expect(
      (
        await request(
          `/api/v1/installation/members/${memberId}/reactivate`,
          {
            headers: { "Idempotency-Key": `permission-invitee-reactivate-${memberId}` },
            method: "POST",
          },
          "owner",
        )
      ).status,
    ).toBe(200);
    expect(await seatsUsed()).toBe(baselineSeats + 1);
    expect((await request("/api/v1/users/me", { method: "GET" }, "invitee")).status).toBe(200);

    expect(
      (
        await request(
          `/api/v1/installation/members/${memberId}`,
          {
            body: JSON.stringify({ confirm_email: inviteeEmail }),
            headers: { "Idempotency-Key": `permission-invitee-delete-${memberId}` },
            method: "DELETE",
          },
          "owner",
        )
      ).status,
    ).toBe(204);
    expect(await seatsUsed()).toBe(baselineSeats);
    const audit = await request(
      `/api/v1/workspaces/${sharedWorkspaceId}/audit`,
      { method: "GET" },
      "owner",
    );
    expect(audit.status).toBe(200);
    const auditBody = auditEntriesFrom(await audit.json());
    expect(
      auditBody.filter((entry) => entry.target_id === memberId).map((entry) => entry.action),
    ).toEqual(
      expect.arrayContaining(["account.suspended", "account.reactivated", "account.deleted"]),
    );
    expect(
      (
        await systemPoolFor(env).query<{ count: string }>(
          "SELECT count(*)::text AS count FROM users WHERE auth_user_id = $1",
          [inviteeSubject],
        )
      ).rows[0]?.count,
    ).toBe("0");
    expect(invitationId).toBeTruthy();
  });
});
