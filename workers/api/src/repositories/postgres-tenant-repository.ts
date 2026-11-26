import type { EffectTransactionClient } from "@meltiply/database";
import { Effect } from "effect";

import { requireActiveBrandProfileEffect } from "../brand-profile-guard";
import { activeOrganizationIdEffect, withTenantTransactionEffect } from "../database";
import { clientIdempotencyLedger } from "../idempotency";
import { lockOrganizationEffect } from "../organization-lock";
import type { TenantRepositoryProvider, TenantTransaction } from "./tenant-repository";

function postgresTenantTransaction(client: EffectTransactionClient): TenantTransaction {
  return {
    ...clientIdempotencyLedger(client),
    activeOrganizationId: () => activeOrganizationIdEffect(client),
    activeRole: () =>
      client
        .query<{ role: string | null }>("SELECT public.auth_active_org_role() AS role")
        .pipe(Effect.map((result) => result.rows[0]?.role ?? null)),
    lockOrganization: (organizationId) => lockOrganizationEffect(client, organizationId),
    requireActiveBrandProfile: (organizationId, brandProfileId) =>
      requireActiveBrandProfileEffect(client, organizationId, brandProfileId),
    timezoneExists: (timezone) =>
      client
        .query<{ valid: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS valid",
          [timezone],
        )
        .pipe(Effect.map((result) => result.rows[0]?.valid === true)),
  };
}

export function postgresTenantRepository<Queries extends object>(
  queries: (client: EffectTransactionClient) => Queries,
): TenantRepositoryProvider<TenantTransaction & Queries> {
  return (env) => ({
    transaction: (session, work) =>
      withTenantTransactionEffect(env, session, (client) =>
        work({ ...postgresTenantTransaction(client), ...queries(client) }),
      ),
  });
}
