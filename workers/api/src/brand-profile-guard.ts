import { Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";

import { CoreApiError } from "./core-types";

/**
 * Asserts that a Brand Profile exists in the addressed workspace and is active.
 *
 * Shared precondition for every mutation that attaches data to a Brand
 * Profile: asset creation, distribution creation, OAuth connection
 * persistence, and inbox replies. The workspace id is an explicit parameter
 * rather than `public.auth_active_org_id()` because callers such as OAuth
 * connection persistence run inside system transactions where the tenant GUC
 * is unset; tenant-transaction callers pass the resolved active organization.
 *
 * @param client - Active Effect transaction client (tenant or system scope).
 * @param organizationId - Workspace UUID that must own the profile.
 * @param brandProfileId - Brand Profile UUID being attached to.
 * @returns Effect resolving void when the profile is active.
 * @throws {CoreApiError} 404 `brand_profile_not_found` when the profile is
 *   missing or belongs to another workspace; 409 `brand_profile_deleted`
 *   when it is soft-deleted and awaiting purge.
 */
export function requireActiveBrandProfileEffect(
  client: EffectTransactionClient,
  organizationId: string,
  brandProfileId: string,
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return client
    .query<{ deleted_at: Date | string | null }>(
      `SELECT deleted_at
       FROM brand_profiles
       WHERE id = $1 AND org_id = $2`,
      [brandProfileId, organizationId],
    )
    .pipe(
      Effect.flatMap((result) => {
        const row = result.rows[0];
        if (!row) {
          return Effect.fail(
            new CoreApiError(404, "brand_profile_not_found", "The brand profile was not found."),
          );
        }
        if (row.deleted_at !== null) {
          return Effect.fail(
            new CoreApiError(
              409,
              "brand_profile_deleted",
              "The brand profile is deleted and cannot accept new data.",
            ),
          );
        }
        return Effect.void;
      }),
    );
}

/**
 * SQL predicate fragment restricting a brand-owned row to an active Brand
 * Profile.
 *
 * Read queries must exclude data owned by soft-deleted profiles: RLS lets
 * workspace admins see deleted profile rows, so policy alone cannot enforce
 * "soft-deleted profiles are unavailable to normal data queries". The
 * predicate is an EXISTS subquery so the same rule composes into list,
 * calendar, analytics, and inbox statements without join fan-out.
 *
 * @param brandProfileColumn - Qualified column reference carrying the row's
 *   brand_profile_id, e.g. `"d.brand_profile_id"`.
 * @returns SQL boolean expression suitable for a WHERE clause.
 */
export function activeBrandProfilePredicate(brandProfileColumn: string): string {
  return `EXISTS (
      SELECT 1
      FROM brand_profiles bp
      WHERE bp.id = ${brandProfileColumn}
        AND bp.deleted_at IS NULL
    )`;
}
