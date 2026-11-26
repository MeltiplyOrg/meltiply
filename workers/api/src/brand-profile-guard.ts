import { Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";

import { CoreApiError } from "./core-types";

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

export function activeBrandProfilePredicate(brandProfileColumn: string): string {
  return `EXISTS (
      SELECT 1
      FROM brand_profiles bp
      WHERE bp.id = ${brandProfileColumn}
        AND bp.deleted_at IS NULL
    )`;
}
