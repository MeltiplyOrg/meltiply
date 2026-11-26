import { Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";

import { CoreApiError } from "./core-types";

export function inactiveBrandProfileError(
  row: { deleted_at: Date | string | null } | undefined,
): CoreApiError | null {
  if (!row) {
    return new CoreApiError(404, "brand_profile_not_found", "The brand profile was not found.");
  }
  if (row.deleted_at !== null) {
    return new CoreApiError(
      409,
      "brand_profile_deleted",
      "The brand profile is deleted and cannot accept new data.",
    );
  }
  return null;
}

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
        const rejection = inactiveBrandProfileError(result.rows[0]);
        return rejection ? Effect.fail(rejection) : Effect.void;
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
