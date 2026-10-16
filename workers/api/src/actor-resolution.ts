import { Effect } from "effect";
import type { JwtIdentity, SessionClaims } from "@meltiply/auth";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";

import { CoreApiError } from "./core-types";
import { RFC4122_UUID_PATTERN } from "./crypto";
import type { ApiWorkerEnv } from "./env";

/**
 * Fully resolved request actor: the authenticated Better Auth subject bound to the
 * internal user row and an authoritative workspace membership.
 *
 * `userId` is the internal `users.id` UUID; `authUserId` is the Better Auth
 * `"user".id` subject. `workspace` is the internal `organizations` row the actor
 * operates in — either the personal workspace or the `x-workspace-id` selection
 * after server-side membership validation. `role` is the `org_members` role
 * (`admin` | `member`). `claims` carries the same facts in the `SessionClaims`
 * shape consumed by tenant transactions (`sub` = auth subject, `org_id` =
 * internal workspace UUID, `org_role` = role).
 */
export interface ResolvedActor {
  authUserId: string;
  claims: SessionClaims;
  role: "admin" | "member";
  userId: string;
  workspace: {
    id: string;
    isPersonal: boolean;
    name: string;
    slug: string;
  };
}

interface InternalUserRow extends Record<string, unknown> {
  auth_user_id: string;
  display_name: string | null;
  email: string;
  id: string;
}

interface WorkspaceRow extends Record<string, unknown> {
  id: string;
  is_personal: boolean;
  name: string;
  role: string;
  slug: string;
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
 * @returns The auth subject id, email, and display name.
 * @throws {CoreApiError} 401 when the identity is structurally invalid.
 */
function verifiedIdentity(identity: JwtIdentity): {
  authUserId: string;
  email: string;
  name: string | null;
} {
  const authUserId = identity.subject?.trim();
  const email = identity.email?.trim();
  if (!authUserId || !email) {
    throw new CoreApiError(401, "authentication_required", "Authentication is required.");
  }
  return { authUserId, email, name: identity.name ?? null };
}

/**
 * Binds the Better Auth subject to the internal `users` row, provisioning it on
 * first sign-in and rejecting email collisions.
 *
 * Runs inside the caller's system transaction so user creation and workspace
 * provisioning commit atomically. An existing row is refreshed when the auth
 * profile changed. A different internal user already owning the email is an
 * identity conflict — email alone never attaches a new auth subject.
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
       RETURNING id, auth_user_id, email, display_name`,
      [identity.authUserId, identity.email, identity.name?.trim() || null, null],
    );
    const row = upserted.rows[0];
    if (row) return row;
    // ON CONFLICT ... DO UPDATE with a no-change WHERE returns zero rows when the
    // stored profile already matches; read the row back in that case.
    const existing = yield* client.query<InternalUserRow>(
      `SELECT id, auth_user_id, email, display_name
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
 * Idempotently provisions the actor's personal workspace inside the caller's
 * transaction: the `organizations` row keyed by `personal_user_id`, the owner
 * `org_members` row with role `admin`, and the usage reconciliation row.
 * @param client - Active system EffectTransactionClient.
 * @param userId - Internal `users.id` UUID owning the personal workspace.
 * @param displayName - User display name or email used for the workspace label.
 * @param email - User email fallback for the workspace label.
 * @returns Effect resolving when the personal workspace rows exist.
 */
function ensurePersonalWorkspace(
  client: EffectTransactionClient,
  userId: string,
  displayName: string | null,
  email: string,
): Effect.Effect<void, DatabaseError> {
  const label = `${displayName?.trim() || email}'s workspace`;
  const slug = `personal-${userId.replaceAll("-", "")}`;
  return Effect.gen(function* () {
    yield* client.query(
      `INSERT INTO organizations (personal_user_id, name, slug)
       VALUES ($1, $2, $3)
       ON CONFLICT (personal_user_id) WHERE personal_user_id IS NOT NULL
       DO NOTHING`,
      [userId, label, slug],
    );
    yield* client.query(
      `INSERT INTO org_members (org_id, user_id, role)
       SELECT o.id, o.personal_user_id, 'admin'
       FROM organizations o
       WHERE o.personal_user_id = $1
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [userId],
    );
    yield* client.query(
      `INSERT INTO usage_reconciliation_state (org_id)
       SELECT o.id FROM organizations o
       WHERE o.personal_user_id = $1
       ON CONFLICT (org_id) DO NOTHING`,
      [userId],
    );
  });
}

/**
 * Resolves the workspace the actor operates in and the authoritative membership role.
 *
 * With `requestedWorkspaceId` (a validated `x-workspace-id` UUID) the workspace must
 * be one the internal user actively belongs to; otherwise the personal workspace is
 * selected. Returns null when the selection is inaccessible or no personal workspace
 * exists after provisioning.
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
      requestedWorkspaceId
        ? `SELECT o.id, o.name, o.slug, om.role,
                  (o.personal_user_id IS NOT NULL) AS is_personal
           FROM org_members om
           JOIN organizations o ON o.id = om.org_id
           WHERE om.user_id = $1 AND o.id = $2
           LIMIT 1`
        : `SELECT o.id, o.name, o.slug, om.role,
                  (o.personal_user_id IS NOT NULL) AS is_personal
           FROM org_members om
           JOIN organizations o ON o.id = om.org_id
           WHERE om.user_id = $1 AND o.personal_user_id = $1
           LIMIT 1`,
      requestedWorkspaceId ? [userId, requestedWorkspaceId] : [userId],
    )
    .pipe(Effect.map((result) => result.rows[0] ?? null));
}

/**
 * Resolves the authenticated request actor from a verified Better Auth JWT identity.
 *
 * The bearer JWT is verified upstream by the app middleware; this resolver binds
 * the verified subject to the internal user (provisioning it plus the personal
 * workspace atomically on first sign-in), then resolves the workspace: the
 * `x-workspace-id` selection when present — validated as a UUID and authorized
 * through `org_members` — or the personal workspace otherwise. The returned
 * `claims` are the only identity facts tenant transactions may consume.
 *
 * @param env - Worker environment bindings.
 * @param identity - Verified JWT identity (subject, email, optional name).
 * @param request - Incoming HTTP request (optional x-workspace-id header).
 * @returns The ResolvedActor for the request.
 * @throws {CoreApiError} 401 invalid identity, 400 malformed workspace id,
 *   403 inaccessible workspace selection, 409 email identity conflict.
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
  return Effect.runPromise(
    withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        const user = yield* ensureInternalUser(client, verified);
        yield* ensurePersonalWorkspace(client, user.id, user.display_name, user.email);
        const workspace = yield* resolveWorkspace(client, user.id, requested || undefined);
        if (!workspace) {
          return yield* Effect.fail(
            new CoreApiError(
              403,
              "workspace_forbidden",
              "The selected workspace is not accessible to this account.",
            ),
          );
        }
        const role = workspace.role === "admin" ? "admin" : "member";
        return {
          authUserId: verified.authUserId,
          claims: {
            organizationId: workspace.id,
            organizationRole: role,
            subject: verified.authUserId,
            userId: user.id,
          },
          role,
          userId: user.id,
          workspace: {
            id: workspace.id,
            isPersonal: workspace.is_personal,
            name: workspace.name,
            slug: workspace.slug,
          },
        } satisfies ResolvedActor;
      }),
    ),
  );
}
