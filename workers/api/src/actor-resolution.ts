import { Effect } from "effect";
import type { JwtIdentity } from "@meltiply/auth";
import type { EffectTransactionClient } from "@meltiply/database";
import { isWorkspaceRole, RFC4122_UUID_PATTERN, type DatabaseError } from "@meltiply/domain";

import type { ResolvedActor } from "./actor-types";
import { CoreApiError } from "./api-errors";
import { auditActorFrom, recordWorkspaceAuditEffect } from "./audit";
import { normalizeWorkspaceRole } from "./authorization";
import { lazyWithSystemTransactionEffect } from "./database-module";
import type { ApiWorkerEnv } from "./env";
import { requireSeatCapacityEffect } from "./seats";

export type { ResolvedActor } from "./actor-types";

interface InternalUserRow extends Record<string, unknown> {
  auth_user_id: string;
  display_name: string | null;
  email: string;
  id: string;
  installation_owner: boolean;
  suspended_at: Date | string | null;
}

interface WorkspaceRow extends Record<string, unknown> {
  id: string;
  name: string;
  role: string;
  slug: string;
}

interface InvitationRow extends Record<string, unknown> {
  accepted_at: Date | string | null;
  email: string;
  expires_at: Date | string;
  id: string;
  org_id: string;
  revoked_at: Date | string | null;
  role: string;
}

function verifiedIdentity(identity: JwtIdentity): {
  authUserId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
} {
  const authUserId = identity.subject?.trim();
  const email = identity.email?.trim();
  if (!authUserId || !email) {
    throw new CoreApiError(401, "authentication_required", "Authentication is required.");
  }
  return {
    authUserId,
    email,
    emailVerified: identity.emailVerified !== false,
    name: identity.name ?? null,
  };
}

function ensureInternalUser(
  client: EffectTransactionClient,
  identity: { authUserId: string; email: string; name: string | null },
): Effect.Effect<InternalUserRow, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const collision = yield* client.query<{ id: string }>(
      `SELECT id FROM users
       WHERE lower(email) = lower($1)
         AND (auth_user_id IS NULL OR auth_user_id <> $2)
       LIMIT 1`,
      [identity.email, identity.authUserId],
    );
    if (collision.rows.length > 0) {
      return yield* Effect.fail(
        new CoreApiError(
          409,
          "identity_conflict",
          "The account email is already registered to a different identity.",
        ),
      );
    }
    const upserted = yield* client.query<InternalUserRow>(
      `INSERT INTO users (auth_user_id, email, display_name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (auth_user_id) DO UPDATE
         SET email = EXCLUDED.email,
             display_name = EXCLUDED.display_name,
             avatar_url = EXCLUDED.avatar_url,
             updated_at = now()
         WHERE users.email IS DISTINCT FROM EXCLUDED.email
            OR users.display_name IS DISTINCT FROM EXCLUDED.display_name
            OR users.avatar_url IS DISTINCT FROM EXCLUDED.avatar_url
       RETURNING id, auth_user_id, email, display_name, installation_owner, suspended_at`,
      [identity.authUserId, identity.email, identity.name?.trim() || null, null],
    );
    const row = upserted.rows[0];
    if (row) return row;
    const existing = yield* client.query<InternalUserRow>(
      `SELECT id, auth_user_id, email, display_name, installation_owner, suspended_at
       FROM users WHERE auth_user_id = $1 LIMIT 1`,
      [identity.authUserId],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) {
      return yield* Effect.fail(
        new CoreApiError(
          500,
          "internal_error",
          "The authenticated identity could not be resolved.",
        ),
      );
    }
    return existingRow;
  });
}

function bootstrapWorkspaceName(
  client: EffectTransactionClient,
  user: InternalUserRow,
): Effect.Effect<string | null, DatabaseError> {
  return Effect.gen(function* () {
    const recorded = yield* client.query<{ workspace_name: string | null }>(
      `SELECT workspace_name FROM installation_bootstrap WHERE auth_user_id = $1`,
      [user.auth_user_id],
    );
    if (recorded.rows.length > 0) return recorded.rows[0]?.workspace_name ?? null;
    const recovered = yield* client.query<{ workspace_name: string | null }>(
      `UPDATE installation_bootstrap_intent
       SET auth_user_id = $2
       WHERE lower(email) = lower($1) AND auth_user_id IS NULL
       RETURNING workspace_name`,
      [user.email, user.auth_user_id],
    );
    const intent = recovered.rows[0];
    if (!intent) return null;
    yield* client.query(
      `INSERT INTO installation_bootstrap (auth_user_id, workspace_name)
       VALUES ($1, $2)
       ON CONFLICT (auth_user_id) DO NOTHING`,
      [user.auth_user_id, intent.workspace_name],
    );
    return intent.workspace_name;
  });
}

function ensureInstallation(
  client: EffectTransactionClient,
  user: InternalUserRow,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    yield* client.query(
      `UPDATE users
       SET installation_owner = TRUE, updated_at = now()
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM users WHERE installation_owner)`,
      [user.id],
    );

    const chosenName = yield* bootstrapWorkspaceName(client, user);
    const label = (user.display_name?.trim() || user.email.split("@")[0] || "Meltiply").slice(
      0,
      180,
    );
    yield* client.query(
      `INSERT INTO organizations (name, slug, is_shared)
       SELECT $1, $2, TRUE
       WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE is_shared)
       ON CONFLICT DO NOTHING`,
      [chosenName ?? `${label}'s workspace`, `workspace-${user.id.replaceAll("-", "")}`],
    );
    yield* client.query(
      `UPDATE organizations o
       SET name = $1, updated_at = now()
       WHERE o.is_shared
         AND $1::text IS NOT NULL
         AND o.name IS DISTINCT FROM $1
         AND NOT EXISTS (SELECT 1 FROM installation_onboarding ob WHERE ob.org_id = o.id)`,
      [chosenName],
    );

    yield* client.query(
      `INSERT INTO org_members (org_id, user_id, role)
       SELECT o.id, $1, 'admin'
       FROM organizations o
       JOIN users u ON u.id = $1
       WHERE o.is_shared AND u.installation_owner
       ON CONFLICT (org_id, user_id) DO UPDATE
         SET role = 'admin', updated_at = now()
       WHERE org_members.role IS DISTINCT FROM 'admin'`,
      [user.id],
    );
    yield* client.query(
      `INSERT INTO usage_reconciliation_state (org_id)
       SELECT id FROM organizations WHERE is_shared
       ON CONFLICT (org_id) DO NOTHING`,
    );
    yield* client.query(
      `INSERT INTO installation_onboarding (org_id, workspace_name, workspace_named)
       SELECT o.id, $2::text, $2::text IS NOT NULL
       FROM organizations o
       JOIN users u ON u.id = $1 AND u.installation_owner
       WHERE o.is_shared
         AND EXISTS (
           SELECT 1 FROM installation_bootstrap b WHERE b.auth_user_id = u.auth_user_id
         )
       ON CONFLICT (org_id) DO UPDATE
         SET workspace_name = COALESCE(installation_onboarding.workspace_name, EXCLUDED.workspace_name),
             workspace_named = installation_onboarding.workspace_named OR EXCLUDED.workspace_named,
             updated_at = now()`,
      [user.id, chosenName],
    );
  });
}

function acceptPendingInvitationEffect(
  client: EffectTransactionClient,
  user: InternalUserRow,
  requestId: string,
): Effect.Effect<boolean, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const pending = yield* client.query<InvitationRow>(
      `SELECT id, org_id, email, role, expires_at, accepted_at, revoked_at
       FROM workspace_invitations
       WHERE lower(email) = lower($1)
         AND accepted_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE`,
      [user.email],
    );
    const invitation = pending.rows[0];
    if (!invitation) return false;
    if (!isWorkspaceRole(invitation.role)) {
      return yield* Effect.fail(
        new CoreApiError(409, "invalid_state", "The invitation carries an unsupported role."),
      );
    }
    yield* client.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [
      invitation.org_id,
    ]);
    yield* requireSeatCapacityEffect(client, invitation.org_id);
    const membership = yield* client.query<{ role: string }>(
      `INSERT INTO org_members (org_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO NOTHING
       RETURNING role`,
      [invitation.org_id, user.id, invitation.role],
    );
    yield* client.query(
      `UPDATE workspace_invitations
       SET accepted_at = now(), updated_at = now()
       WHERE id = $1 AND accepted_at IS NULL`,
      [invitation.id],
    );
    yield* recordWorkspaceAuditEffect(client, {
      action: "invitation.accepted",
      actor: auditActorFrom(user),
      after: {
        email: invitation.email,
        role: membership.rows[0]?.role ?? invitation.role,
      },
      orgId: invitation.org_id,
      requestId,
      targetId: invitation.id,
      targetType: "invitation",
    });
    return true;
  });
}

function resolveWorkspace(
  client: EffectTransactionClient,
  userId: string,
  requestedWorkspaceId: string | undefined,
): Effect.Effect<WorkspaceRow | null, DatabaseError> {
  return client
    .query<WorkspaceRow>(
      `SELECT o.id, o.name, o.slug, om.role
       FROM org_members om
       JOIN organizations o ON o.id = om.org_id
       WHERE om.user_id = $1
         AND o.is_shared
         AND ($2::uuid IS NULL OR o.id = $2)
       LIMIT 1`,
      [userId, requestedWorkspaceId ?? null],
    )
    .pipe(Effect.map((result) => result.rows[0] ?? null));
}

function resolvedActor(user: InternalUserRow, workspace: WorkspaceRow): ResolvedActor {
  const role = user.installation_owner ? "admin" : normalizeWorkspaceRole(workspace.role);
  return {
    authUserId: user.auth_user_id,
    claims: {
      organizationId: workspace.id,
      organizationRole: role,
      subject: user.auth_user_id,
      userId: user.id,
    },
    displayName: user.display_name,
    email: user.email,
    isInstallationOwner: user.installation_owner,
    role,
    userId: user.id,
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
  };
}

export async function resolveActor(
  env: ApiWorkerEnv,
  identity: JwtIdentity,
  request: Request,
  requestId: string,
): Promise<ResolvedActor> {
  const verified = verifiedIdentity(identity);

  const requested = request.headers.get("x-workspace-id")?.trim();
  if (requested && !RFC4122_UUID_PATTERN.test(requested)) {
    throw new CoreApiError(
      400,
      "invalid_request",
      "The x-workspace-id header must be a workspace UUID.",
    );
  }

  return Effect.runPromise(
    lazyWithSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        const existing = yield* client.query<
          InternalUserRow & {
            workspace_id: string;
            workspace_name: string;
            workspace_slug: string;
            workspace_role: string;
          }
        >(
          `SELECT u.id, u.auth_user_id, u.email, u.display_name,
                  u.installation_owner, u.suspended_at,
                  o.id AS workspace_id, o.name AS workspace_name,
                  o.slug AS workspace_slug, membership.role AS workspace_role
           FROM users u
           JOIN org_members membership ON membership.user_id = u.id
           JOIN organizations o ON o.id = membership.org_id AND o.is_shared
           WHERE u.auth_user_id = $1 AND u.email = $2
             AND u.display_name IS NOT DISTINCT FROM $3::text
             AND ($4::uuid IS NULL OR o.id = $4)
             AND (NOT u.installation_owner OR membership.role = 'admin')
           LIMIT 1`,
          [verified.authUserId, verified.email, verified.name?.trim() || null, requested || null],
        );
        const current = existing.rows[0];
        if (current) {
          if (current.suspended_at !== null) {
            return yield* Effect.fail(
              new CoreApiError(403, "account_suspended", "This account is suspended."),
            );
          }
          return resolvedActor(current, {
            id: current.workspace_id,
            name: current.workspace_name,
            slug: current.workspace_slug,
            role: current.workspace_role,
          });
        }
        const user = yield* ensureInternalUser(client, verified);
        if (user.suspended_at !== null) {
          return yield* Effect.fail(
            new CoreApiError(403, "account_suspended", "This account is suspended."),
          );
        }
        yield* ensureInstallation(client, user);
        let workspace = yield* resolveWorkspace(client, user.id, requested || undefined);
        if (!workspace && verified.emailVerified) {
          yield* acceptPendingInvitationEffect(client, user, requestId);
          workspace = yield* resolveWorkspace(client, user.id, requested || undefined);
        }
        const owner = yield* client.query<{ installation_owner: boolean }>(
          "SELECT installation_owner FROM users WHERE id = $1",
          [user.id],
        );
        const isInstallationOwner = owner.rows[0]?.installation_owner === true;
        if (!workspace) {
          return yield* Effect.fail(
            new CoreApiError(
              403,
              requested ? "workspace_forbidden" : "workspace_membership_required",
              requested
                ? "The selected workspace is not accessible to this account."
                : "A Workspace membership is required.",
            ),
          );
        }
        const resolvedRole = normalizeWorkspaceRole(workspace.role);
        if (isInstallationOwner && resolvedRole !== "admin") {
          yield* client.query(
            `UPDATE org_members SET role = 'admin', updated_at = now()
             WHERE org_id = $1 AND user_id = $2`,
            [workspace.id, user.id],
          );
        }
        return resolvedActor({ ...user, installation_owner: isInstallationOwner }, workspace);
      }),
    ),
  );
}
