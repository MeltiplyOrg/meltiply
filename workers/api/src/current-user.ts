import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { isoDateTime } from "@meltiply/domain";

import { withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";

type UserProfile = components["schemas"]["UserProfile"];

interface CurrentUserRow extends Record<string, unknown> {
  avatar_url: string | null;
  created_at: Date | string;
  display_name: string | null;
  email: string;
  id: string;
  organization_id: string;
  organization_name: string;
  organization_plan: string;
  organization_slug: string;
  role: string;
  updated_at: Date | string;
}

/**
 * Loads the user profile and active workspace details for the authenticated actor.
 *
 * Executes within a tenant-scoped database transaction configured with the actor's
 * verified claims, joining `users`, `org_members`, and `organizations` while verifying
 * that the workspace matches the one resolved by `public.auth_active_org_id()`.
 * The internal user is bound exclusively through `users.auth_user_id` — the Better
 * Auth subject — so no other identity column can attach a session to an account.
 *
 * @param env - Worker environment bindings containing database connection and Hyperdrive config.
 * @param claims - Verified actor claims identifying the auth subject and resolved workspace.
 * @returns The user profile schema representation with active workspace details, or `null` if the user or membership is not found.
 */
export async function loadCurrentUser(
  env: ApiWorkerEnv,
  claims: SessionClaims,
): Promise<UserProfile | null> {
  return Effect.runPromise(
    withTenantTransactionEffect(env, claims, (client) =>
      client
        .query<CurrentUserRow>(
          `SELECT
             u.id,
             u.email,
             u.display_name,
             u.avatar_url,
             u.created_at,
             u.updated_at,
             o.id AS organization_id,
             o.name AS organization_name,
             o.slug AS organization_slug,
             o.plan AS organization_plan,
             om.role
           FROM users u
           JOIN org_members om ON om.user_id = u.id
           JOIN organizations o ON o.id = om.org_id
           WHERE u.auth_user_id = $1
             AND o.id = public.auth_active_org_id()
           LIMIT 1`,
          [claims.subject],
        )
        .pipe(
          Effect.map((result) => {
            const row = result.rows[0];
            if (!row) return null;
            return {
              active_organization: {
                id: row.organization_id,
                name: row.organization_name,
                plan: row.organization_plan,
                role: row.role,
                slug: row.organization_slug,
              },
              avatar_url: row.avatar_url,
              created_at: isoDateTime(row.created_at),
              display_name: row.display_name,
              email: row.email,
              id: row.id,
              updated_at: isoDateTime(row.updated_at),
            } satisfies UserProfile;
          }),
        ),
    ),
  );
}
