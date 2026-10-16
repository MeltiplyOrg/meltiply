import { Effect } from "effect";
import type { DatabaseError } from "@meltiply/domain";
import type { EffectTransactionClient } from "@meltiply/database";

/**
 * Acquires a transaction-scoped exclusive lock on an organization using an Effect transaction client.
 *
 * Provides Hyperdrive-safe mutation serialization (for plan updates, quota increments, and billing
 * sessions) by taking a row lock on `organization_locks` instead of connection-bound advisory locks.
 *
 * @param client - Active EffectTransactionClient.
 * @param organizationId - UUID of the organization to lock.
 * @returns Effect resolving when the lock row is updated.
 */
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

/**
 * Acquires a transaction-scoped exclusive lock on the active tenant organization using an Effect transaction client.
 *
 * Resolves the tenant through `public.auth_active_org_id()`, which reads the verified
 * actor claims installed by `withTenantTransactionEffect`.
 *
 * @param client - Active EffectTransactionClient.
 * @returns Effect resolving when the active organization lock row is updated.
 */
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
