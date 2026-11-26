import { Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";

export function lockOrganizationEffect(
  client: EffectTransactionClient,
  organizationId: string,
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `INSERT INTO organization_locks (org_id)
       VALUES ($1)
       ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id`,
      [organizationId],
    )
    .pipe(Effect.asVoid);
}

export function lockActiveOrganizationEffect(
  client: EffectTransactionClient,
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `INSERT INTO organization_locks (org_id)
       VALUES (public.auth_active_org_id())
       ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id`,
    )
    .pipe(Effect.asVoid);
}
