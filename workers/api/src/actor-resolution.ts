import { Effect } from "effect";
import type { JwtIdentity, SessionClaims } from "@meltiply/auth";
import type { EffectTransactionClient } from "@meltiply/database";
import { isWorkspaceRole, type DatabaseError, type WorkspaceRole } from "@meltiply/domain";

import { auditActorFrom, recordWorkspaceAuditEffect } from "./audit";
import { CoreApiError } from "./core-types";
import { RFC4122_UUID_PATTERN } from "./crypto";
import type { ApiWorkerEnv } from "./env";
import { requireSeatCapacityEffect } from "./seats";

/**
 * Fully resolved request actor: the authenticated Better Auth subject bound to
 * the internal user row, the installation ownership flag, and an authoritative
 * membership in the single shared Workspace.
 *
 * `userId` is the internal `users.id` UUID; `authUserId` is the Better Auth
 * `"user".id` subject. `role` is read from `org_members` on every request, so a
 * role change applies to the member's next request without reissuing the JWT.
 * `claims` carries the same facts in the `SessionClaims` shape consumed by
 * tenant transactions (`sub` = auth subject, `org_id` = shared workspace UUID,
 * `org_role` = role).
 */
export interface ResolvedActor {
  authUserId: string;
  claims: SessionClaims;
  displayName: string | null;
  email: string;
  isInstallationOwner: boolean;
  role: WorkspaceRole;
  userId: string;
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
}

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

/**
 * Narrows a verified Better Auth JWT identity to the fields the actor resolver
 * needs, rejecting malformed payloads instead of trusting them.
 *
 * The JWKS verifier already guarantees signature, issuer, and audience; this
 * structural check fails closed when a verified token still lacks a usable
 * subject or email (e.g. a non-identity token minted under the same key).
 *
 * @param identity - Verified JWT identity produced by the bearer verifier.
 * @returns The auth subject id, email, display name, and verification state.
 * @throws {CoreApiError} 401 when the identity is structurally invalid.
 */
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
    // Callers that already validated the live session set this explicitly.
    emailVerified: identity.emailVerified !== false,
    name: identity.name ?? null,
  };
}

/**
 * Binds the Better Auth subject to the internal `users` row, provisioning it on
 * first sign-in and rejecting email collisions.
 *
 * Runs inside the caller's system transaction so user creation and workspace
 * provisioning commit atomically. An existing row is refreshed when the auth
 * profile changed. A different internal user already owning the email is an
 * identity conflict — email alone never attaches a new auth subject.
 *
 * @param client - Active system EffectTransactionClient.
 * @param identity - Verified auth subject id, email, and display name.
 * @returns Effect resolving to the internal user row.
 */
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
    // ON CONFLICT ... DO UPDATE with a no-change WHERE returns zero rows when the
    // stored profile already matches; read the row back in that case.
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

/**
 * Claims Installation Ownership for the first bootstrapped account and ensures
 * the installation has exactly one shared Workspace.
 *
 * The partial unique index on `users.installation_owner` arbitrates concurrent
 * first sign-ins; the conditional update is a no-op once any owner exists, so
 * an invited account can never claim ownership. The shared Workspace insert is
 * idempotent through `one_shared_workspace`. The Owner always holds the Admin
 * membership in that Workspace.
 *
 * @param client - Active system EffectTransactionClient.
 * @param user - Internal user row being resolved.
 * @returns Effect resolving void after ownership and workspace rows exist.
 */
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

    const label = (user.display_name?.trim() || user.email.split("@")[0] || "Meltiply").slice(
      0,
      180,
    );
    yield* client.query(
      `INSERT INTO organizations (name, slug, is_shared)
       SELECT $1, $2, TRUE
       WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE is_shared)
       ON CONFLICT DO NOTHING`,
      [`${label}'s workspace`, `workspace-${user.id.replaceAll("-", "")}`],
    );

    yield* client.query(
      `INSERT INTO org_members (org_id, user_id, role)
       SELECT o.id, $1, 'admin'
       FROM organizations o
       JOIN users u ON u.id = $1
       WHERE o.is_shared AND u.installation_owner
       ON CONFLICT (org_id, user_id) DO UPDATE
         SET role = 'admin', updated_at = now()`,
      [user.id],
    );
    yield* client.query(
      `INSERT INTO usage_reconciliation_state (org_id)
       SELECT id FROM organizations WHERE is_shared
       ON CONFLICT (org_id) DO NOTHING`,
    );
  });
}

/**
 * Accepts the caller's oldest pending invitation for their verified email.
 *
 * Invitation acceptance is automatic after email verification: the invitee
 * signs in normally and the next authenticated request becomes a membership.
 * Existing members are left untouched but the invitation is consumed. The
 * function locks the invitation and Workspace row so concurrent requests and
 * seat checks serialize.
 *
 * @param client - Active system EffectTransactionClient.
 * @param user - Internal user row (email must be verified by the caller).
 * @param requestId - Request identifier recorded on the Audit entry.
 * @returns Effect resolving whether an invitation was consumed.
 */
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

/**
 * Resolves the shared Workspace the actor belongs to and the authoritative
 * membership role.
 *
 * With `requestedWorkspaceId` (a validated `x-workspace-id` UUID) the workspace
 * must be the shared Workspace and the caller must belong to it; without it the
 * shared Workspace is selected directly. Returns null when the caller has no
 * membership.
 *
 * @param client - Active system EffectTransactionClient.
 * @param userId - Internal `users.id` UUID.
 * @param requestedWorkspaceId - Optional internal organization UUID selection.
 * @returns Effect resolving to the workspace row plus membership role, or null.
 */
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

/**
 * Resolves the authenticated request actor from a verified Better Auth JWT identity.
 *
 * The bearer JWT is verified upstream by the app middleware; this resolver binds
 * the verified subject to the internal user, claims first-boot installation
 * ownership, consumes a matching pending invitation after email verification,
 * then resolves the shared Workspace. Role changes are visible on the next
 * request because the role is read from `org_members` here rather than trusted
 * from JWT claims.
 *
 * @param env - Worker environment bindings.
 * @param identity - Verified JWT identity (subject, email, optional name).
 * @param request - Incoming HTTP request (optional x-workspace-id header).
 * @returns The ResolvedActor for the request.
 * @throws {CoreApiError} 401 invalid identity, 400 malformed workspace id,
 *   403 suspended account or missing workspace membership, 409 email conflict.
 */
export async function resolveActor(
  env: ApiWorkerEnv,
  identity: JwtIdentity,
  request: Request,
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

  // Exception: dynamic import avoids loading pg in workerd unit test isolates
  const { withSystemTransactionEffect } = await import("./database");
  const requestId = request.headers.get("x-request-id")?.trim() || "request-unavailable";
  return Effect.runPromise(
    withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
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
        const resolvedRole = isWorkspaceRole(workspace.role) ? workspace.role : "viewer";
        // The Owner must remain Admin while owning the installation.
        const role = isInstallationOwner ? "admin" : resolvedRole;
        if (isInstallationOwner && resolvedRole !== "admin") {
          yield* client.query(
            `UPDATE org_members SET role = 'admin', updated_at = now()
             WHERE org_id = $1 AND user_id = $2`,
            [workspace.id, user.id],
          );
        }
        return {
          authUserId: verified.authUserId,
          claims: {
            organizationId: workspace.id,
            organizationRole: role,
            subject: verified.authUserId,
            userId: user.id,
          },
          displayName: user.display_name,
          email: user.email,
          isInstallationOwner,
          role,
          userId: user.id,
          workspace: {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
          },
        } satisfies ResolvedActor;
      }),
    ),
  );
}
