import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import {
  isoDateTime,
  type DatabaseError,
  type ActiveOrganizationRequiredError,
} from "@meltiply/domain";
import type { components } from "@meltiply/contracts/schema";
import type { EffectTransactionClient } from "@meltiply/database";

import { CoreApiError, type IdempotentResult } from "./core-types";
import { withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import { withTenantIdempotentMutation } from "./idempotent-mutation";
import { lockOrganizationEffect } from "./organization-lock";

type Schemas = components["schemas"];
export type BrandProfile = Schemas["BrandProfile"];

interface BrandProfileRow extends Record<string, unknown> {
  color: string;
  created_at: Date | string;
  deleted_at: Date | string | null;
  description: string | null;
  id: string;
  name: string;
  org_id: string;
  purge_at: Date | string | null;
  updated_at: Date | string;
}

interface DisconnectableAccountRow extends Record<string, unknown> {
  access_token: string;
  brand_profile_id: string;
  id: string;
  platform: string;
}

export interface CreateBrandProfileInput {
  color: string;
  description?: string | null;
  name: string;
}

export interface UpdateBrandProfileInput {
  color?: string;
  description?: string | null;
  name?: string;
}

export type BrandProfileServiceError =
  | CoreApiError
  | ActiveOrganizationRequiredError
  | DatabaseError;

export interface BrandProfileApiService {
  listBrandProfiles(
    env: ApiWorkerEnv,
    session: SessionClaims,
  ): Effect.Effect<BrandProfile[], BrandProfileServiceError>;
  listDeletedBrandProfiles(
    env: ApiWorkerEnv,
    session: SessionClaims,
  ): Effect.Effect<BrandProfile[], BrandProfileServiceError>;
  getBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    profileId: string,
  ): Effect.Effect<BrandProfile, BrandProfileServiceError>;
  createBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    input: CreateBrandProfileInput,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<BrandProfile>, BrandProfileServiceError>;
  updateBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    profileId: string,
    input: UpdateBrandProfileInput,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<BrandProfile>, BrandProfileServiceError>;
  deleteBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    profileId: string,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<BrandProfile>, BrandProfileServiceError>;
  restoreBrandProfile(
    env: ApiWorkerEnv,
    session: SessionClaims,
    profileId: string,
    idempotencyKey: string,
  ): Effect.Effect<IdempotentResult<BrandProfile>, BrandProfileServiceError>;
}

function mapBrandProfile(row: BrandProfileRow): BrandProfile {
  return {
    color: row.color as BrandProfile["color"],
    created_at: isoDateTime(row.created_at),
    deleted_at: row.deleted_at === null ? null : isoDateTime(row.deleted_at),
    description: row.description,
    id: row.id,
    name: row.name,
    org_id: row.org_id,
    purge_at: row.purge_at === null ? null : isoDateTime(row.purge_at),
    updated_at: isoDateTime(row.updated_at),
  };
}

function requireWorkspaceAdminEffect(
  client: EffectTransactionClient,
): Effect.Effect<void, CoreApiError | DatabaseError> {
  return client
    .query<{
      role: string | null;
    }>("SELECT public.auth_active_org_role() AS role")
    .pipe(
      Effect.flatMap((result) =>
        result.rows[0]?.role === "admin"
          ? Effect.void
          : Effect.fail(
              new CoreApiError(
                403,
                "workspace_admin_required",
                "The workspace admin role is required.",
              ),
            ),
      ),
    );
}

function isUniqueViolation(error: DatabaseError): boolean {
  const cause = error.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

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
    yield* client.query(
      `INSERT INTO outbox_events
         (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
       VALUES ($1, 'channel.revocation.requested', 'platform_account', $2, $3, $4)
       ON CONFLICT (org_id, topic, dedupe_key) DO NOTHING`,
      [
        organizationId,
        account.id,
        `channel-revocation:${account.id}`,
        {
          access_token: account.access_token,
          brand_profile_id: account.brand_profile_id,
          platform: account.platform,
          platform_account_id: account.id,
          version: 1,
        },
      ],
    );
  });
}

export function createBrandProfileService(): BrandProfileApiService {
  return {
    listBrandProfiles(env, session) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.map(
          client.query<BrandProfileRow>(
            `SELECT id, org_id, name, description, color, deleted_at, purge_at,
                    created_at, updated_at
             FROM brand_profiles
             WHERE org_id = public.auth_active_org_id()
               AND deleted_at IS NULL
             ORDER BY name ASC, id ASC`,
          ),
          (result) => result.rows.map(mapBrandProfile),
        ),
      );
    },

    listDeletedBrandProfiles(env, session) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          yield* requireWorkspaceAdminEffect(client);
          const result = yield* client.query<BrandProfileRow>(
            `SELECT id, org_id, name, description, color, deleted_at, purge_at,
                    created_at, updated_at
             FROM brand_profiles
             WHERE org_id = public.auth_active_org_id()
               AND deleted_at IS NOT NULL
             ORDER BY deleted_at DESC, id ASC`,
          );
          return result.rows.map(mapBrandProfile);
        }),
      );
    },

    getBrandProfile(env, session, profileId) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const result = yield* client.query<BrandProfileRow>(
            `SELECT id, org_id, name, description, color, deleted_at, purge_at,
                    created_at, updated_at
             FROM brand_profiles
             WHERE id = $1
               AND org_id = public.auth_active_org_id()`,
            [profileId],
          );
          const row = result.rows[0];
          if (!row) {
            return yield* Effect.fail(
              new CoreApiError(404, "not_found", "The brand profile was not found."),
            );
          }
          return mapBrandProfile(row);
        }),
      );
    },

    createBrandProfile(env, session, input, idempotencyKey) {
      return withTenantIdempotentMutation<BrandProfile, BrandProfileServiceError>(
        env,
        session,
        "brand-profile.create",
        idempotencyKey,
        JSON.stringify({
          color: input.color,
          description: input.description ?? null,
          name: input.name,
        }),
        201,
        (client, organizationId) =>
          Effect.gen(function* () {
            yield* requireWorkspaceAdminEffect(client);
            const inserted = yield* client
              .query<BrandProfileRow>(
                `INSERT INTO brand_profiles (org_id, name, description, color)
                 VALUES ($1, $2, $3, $4)
                 RETURNING id, org_id, name, description, color, deleted_at, purge_at,
                           created_at, updated_at`,
                [organizationId, input.name, input.description ?? null, input.color],
              )
              .pipe(
                Effect.catchIf(isUniqueViolation, () =>
                  Effect.fail(
                    new CoreApiError(
                      409,
                      "invalid_state",
                      "A brand profile with this name already exists.",
                    ),
                  ),
                ),
              );
            return mapBrandProfile(inserted.rows[0]!);
          }),
      );
    },

    updateBrandProfile(env, session, profileId, input, idempotencyKey) {
      return withTenantIdempotentMutation<BrandProfile, BrandProfileServiceError>(
        env,
        session,
        "brand-profile.update",
        idempotencyKey,
        JSON.stringify({
          color: input.color ?? null,
          description: input.description ?? null,
          has_description: input.description !== undefined,
          name: input.name ?? null,
          profile_id: profileId,
        }),
        200,
        (client, organizationId) =>
          Effect.gen(function* () {
            yield* requireWorkspaceAdminEffect(client);
            const updated = yield* client
              .query<BrandProfileRow>(
                `UPDATE brand_profiles
                 SET name = COALESCE($3, name),
                     color = COALESCE($4, color),
                     description = CASE WHEN $5 THEN $6 ELSE description END,
                     updated_at = now()
                 WHERE id = $1
                   AND org_id = $2
                   AND deleted_at IS NULL
                 RETURNING id, org_id, name, description, color, deleted_at, purge_at,
                           created_at, updated_at`,
                [
                  profileId,
                  organizationId,
                  input.name ?? null,
                  input.color ?? null,
                  input.description !== undefined,
                  input.description ?? null,
                ],
              )
              .pipe(
                Effect.catchIf(isUniqueViolation, () =>
                  Effect.fail(
                    new CoreApiError(
                      409,
                      "invalid_state",
                      "A brand profile with this name already exists.",
                    ),
                  ),
                ),
              );
            const row = updated.rows[0];
            if (!row) {
              return yield* Effect.fail(
                new CoreApiError(404, "not_found", "The brand profile was not found."),
              );
            }
            return mapBrandProfile(row);
          }),
      );
    },

    deleteBrandProfile(env, session, profileId, idempotencyKey) {
      return withTenantIdempotentMutation<BrandProfile, BrandProfileServiceError>(
        env,
        session,
        "brand-profile.delete",
        idempotencyKey,
        JSON.stringify({ profile_id: profileId }),
        200,
        (client, organizationId) =>
          Effect.gen(function* () {
            yield* requireWorkspaceAdminEffect(client);
            yield* lockOrganizationEffect(client, organizationId);
            const existing = yield* client.query<Pick<BrandProfileRow, "id">>(
              `SELECT id
               FROM brand_profiles
               WHERE id = $1 AND org_id = $2
               FOR UPDATE`,
              [profileId, organizationId],
            );
            if (!existing.rows[0]) {
              return yield* Effect.fail(
                new CoreApiError(404, "not_found", "The brand profile was not found."),
              );
            }
            const accounts = yield* client.query<DisconnectableAccountRow>(
              `SELECT id, brand_profile_id, platform, access_token
               FROM platform_accounts
               WHERE brand_profile_id = $1 AND org_id = $2`,
              [profileId, organizationId],
            );
            for (const account of accounts.rows) {
              yield* disconnectPlatformAccountEffect(client, organizationId, account);
            }
            const deleted = yield* client.query<BrandProfileRow>(
              `DELETE FROM brand_profiles
               WHERE id = $1 AND org_id = $2
               RETURNING id, org_id, name, description, color, deleted_at, purge_at,
                         created_at, updated_at`,
              [profileId, organizationId],
            );
            return mapBrandProfile(deleted.rows[0]!);
          }),
      );
    },

    restoreBrandProfile(env, session, profileId, idempotencyKey) {
      return withTenantIdempotentMutation<BrandProfile, BrandProfileServiceError>(
        env,
        session,
        "brand-profile.restore",
        idempotencyKey,
        JSON.stringify({ profile_id: profileId }),
        200,
        (client, organizationId) =>
          Effect.gen(function* () {
            yield* requireWorkspaceAdminEffect(client);
            const existing = yield* client.query<Pick<BrandProfileRow, "deleted_at" | "purge_at">>(
              `SELECT deleted_at, purge_at
               FROM brand_profiles
               WHERE id = $1 AND org_id = $2
               FOR UPDATE`,
              [profileId, organizationId],
            );
            const row = existing.rows[0];
            if (!row) {
              return yield* Effect.fail(
                new CoreApiError(404, "not_found", "The brand profile was not found."),
              );
            }
            if (row.deleted_at === null) {
              return yield* Effect.fail(
                new CoreApiError(409, "invalid_state", "The brand profile is not deleted."),
              );
            }
            if (row.purge_at !== null && new Date(row.purge_at).getTime() <= Date.now()) {
              return yield* Effect.fail(
                new CoreApiError(
                  409,
                  "invalid_state",
                  "The brand profile retention window has elapsed.",
                ),
              );
            }
            const updated = yield* client.query<BrandProfileRow>(
              `UPDATE brand_profiles
               SET deleted_at = NULL,
                   purge_at = NULL,
                   updated_at = now()
               WHERE id = $1 AND org_id = $2
               RETURNING id, org_id, name, description, color, deleted_at, purge_at,
                         created_at, updated_at`,
              [profileId, organizationId],
            );
            return mapBrandProfile(updated.rows[0]!);
          }),
      );
    },
  };
}
