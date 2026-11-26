import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
import { Effect } from "effect";

import {
  channelRevocationEvent,
  mapBrandProfile,
  type BrandProfileRetention,
  type BrandProfileRow,
  type DisconnectableAccountRow,
} from "../brand-profile-rules";
import type { BrandProfileQueries } from "./brand-profile-repository";
import { postgresTenantRepository } from "./postgres-tenant-repository";

const brandProfileColumns = `id, org_id, name, description, color, deleted_at, purge_at,
                    created_at, updated_at`;

export function disconnectPlatformAccountEffect(
  client: EffectTransactionClient,
  organizationId: string,
  account: DisconnectableAccountRow,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    yield* client.query(
      `UPDATE distributions
       SET status = 'cancelled',
           error_message = 'Platform account disconnected before publication.',
           updated_at = now()
       WHERE platform_account_id = $1
         AND status IN ('scheduled', 'queued')`,
      [account.id],
    );
    yield* client.query("DELETE FROM platform_accounts WHERE id = $1", [account.id]);
    const event = channelRevocationEvent(account);
    yield* client.query(
      `INSERT INTO outbox_events
         (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
       VALUES ($1, 'channel.revocation.requested', 'platform_account', $2, $3, $4)
       ON CONFLICT (org_id, topic, dedupe_key) DO NOTHING`,
      [organizationId, account.id, event.dedupeKey, event.payload],
    );
  });
}

function brandProfileQueries(client: EffectTransactionClient): BrandProfileQueries {
  const selected = (sql: string, values?: readonly unknown[]) =>
    client
      .query<BrandProfileRow>(sql, values)
      .pipe(Effect.map((result) => result.rows.map(mapBrandProfile)));
  const written = (sql: string, values: readonly unknown[]) =>
    selected(sql, values).pipe(Effect.map((profiles) => profiles[0]!));
  return {
    activeBrandProfiles: () =>
      selected(`SELECT ${brandProfileColumns}
             FROM brand_profiles
             WHERE org_id = public.auth_active_org_id()
               AND deleted_at IS NULL
             ORDER BY name ASC, id ASC`),
    deletedBrandProfiles: () =>
      selected(`SELECT ${brandProfileColumns}
             FROM brand_profiles
             WHERE org_id = public.auth_active_org_id()
               AND deleted_at IS NOT NULL
             ORDER BY deleted_at DESC, id ASC`),
    brandProfile: (profileId) =>
      selected(
        `SELECT ${brandProfileColumns}
             FROM brand_profiles
             WHERE id = $1
               AND org_id = public.auth_active_org_id()`,
        [profileId],
      ).pipe(Effect.map((profiles) => profiles[0] ?? null)),
    insertBrandProfile: (organizationId, input) =>
      written(
        `INSERT INTO brand_profiles (org_id, name, description, color)
                 VALUES ($1, $2, $3, $4)
                 RETURNING ${brandProfileColumns}`,
        [organizationId, input.name, input.description ?? null, input.color],
      ),
    updateBrandProfile: (profileId, organizationId, input) =>
      selected(
        `UPDATE brand_profiles
                 SET name = COALESCE($3, name),
                     color = COALESCE($4, color),
                     description = CASE WHEN $5 THEN $6 ELSE description END,
                     updated_at = now()
                 WHERE id = $1
                   AND org_id = $2
                   AND deleted_at IS NULL
                 RETURNING ${brandProfileColumns}`,
        [
          profileId,
          organizationId,
          input.name ?? null,
          input.color ?? null,
          input.description !== undefined,
          input.description ?? null,
        ],
      ).pipe(Effect.map((profiles) => profiles[0] ?? null)),
    lockBrandProfileForDeletion: (profileId, organizationId) =>
      client
        .query(
          `SELECT id
               FROM brand_profiles
               WHERE id = $1 AND org_id = $2
               FOR UPDATE`,
          [profileId, organizationId],
        )
        .pipe(Effect.map((result) => result.rows.length > 0)),
    lockBrandProfileRetention: (profileId, organizationId) =>
      client
        .query<BrandProfileRetention>(
          `SELECT deleted_at, purge_at
               FROM brand_profiles
               WHERE id = $1 AND org_id = $2
               FOR UPDATE`,
          [profileId, organizationId],
        )
        .pipe(Effect.map((result) => result.rows[0] ?? null)),
    brandProfileChannels: (profileId, organizationId) =>
      client
        .query<DisconnectableAccountRow>(
          `SELECT id, brand_profile_id, platform, access_token
               FROM platform_accounts
               WHERE brand_profile_id = $1 AND org_id = $2`,
          [profileId, organizationId],
        )
        .pipe(Effect.map((result) => result.rows)),
    disconnectChannel: (organizationId, account) =>
      disconnectPlatformAccountEffect(client, organizationId, account),
    deleteBrandProfile: (profileId, organizationId) =>
      written(
        `DELETE FROM brand_profiles
               WHERE id = $1 AND org_id = $2
               RETURNING ${brandProfileColumns}`,
        [profileId, organizationId],
      ),
    restoreBrandProfile: (profileId, organizationId) =>
      written(
        `UPDATE brand_profiles
               SET deleted_at = NULL,
                   purge_at = NULL,
                   updated_at = now()
               WHERE id = $1 AND org_id = $2
               RETURNING ${brandProfileColumns}`,
        [profileId, organizationId],
      ),
  };
}

export const postgresBrandProfileRepository = postgresTenantRepository(brandProfileQueries);
