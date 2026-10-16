import { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import { isoDateTime, type DatabaseError, type DomainError } from "@meltiply/domain";
import type { components } from "@meltiply/contracts/schema";
import type { EffectTransactionClient } from "@meltiply/database";

import { CoreApiError, type IdempotentResult } from "./core-types";
import { activeOrganizationIdEffect, withTenantTransactionEffect } from "./database";
import type { ApiWorkerEnv } from "./env";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  reserveIdempotencyEffect,
} from "./idempotency";
import { lockOrganizationEffect } from "./organization-lock";

type Schemas = components["schemas"];
export type BrandProfile = Schemas["BrandProfile"];

/** Row shape returned by brand_profiles queries inside tenant transactions. */
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

/** Account row consumed by the channel local-disconnect cutover. */
interface DisconnectableAccountRow extends Record<string, unknown> {
  access_token: string;
  brand_profile_id: string;
  id: string;
  platform: string;
}

/**
 * Input for creating a Brand Profile with an optional 280-character plain-text
 * description. Undefined and null both persist as no description on creation.
 */
export interface CreateBrandProfileInput {
  color: string;
  description?: string | null;
  name: string;
}

/**
 * Input for patching a Brand Profile. `description: null` clears the saved
 * summary, while omission preserves the current description.
 */
export interface UpdateBrandProfileInput {
  color?: string;
  description?: string | null;
  name?: string;
}

export type BrandProfileServiceError = CoreApiError | DomainError | DatabaseError;

/**
 * Effect-first application service managing the Brand Profile lifecycle.
 *
 * Brand Profiles are the mandatory ownership boundary for assets, platform
 * accounts, and distributions inside a workspace. Reads are member-scoped and
 * mutations are admin-only; both run inside tenant transactions so RLS stays
 * the second enforcement layer behind the explicit role check.
 */
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

/**
 * Maps a brand_profiles row to the contract BrandProfile shape.
 *
 * Lifecycle timestamps serialize as ISO-8601 or null, while the nullable
 * description stays explicit so clients can distinguish an absent summary.
 */
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

/**
 * Asserts the caller holds the workspace admin role inside a tenant transaction.
 *
 * Resolves the role through `public.auth_active_org_role()` (org_members) rather
 * than the session claim so a stale or downgraded claim cannot authorize a
 * management mutation; RLS policies on brand_profiles enforce the same rule.
 *
 * @param client - Active tenant-scoped Effect transaction client.
 * @returns Effect resolving void for admins.
 * @throws {CoreApiError} 403 `workspace_admin_required` for members or
 *   non-members (the role function returns NULL for both).
 */
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

/**
 * Detects a PostgreSQL unique-violation error wrapped in a DatabaseError.
 *
 * The unique (org_id, normalized_name) index is the authoritative name
 * reservation; a raced duplicate insert surfaces as SQLSTATE 23505 on the
 * wrapped pg error rather than a typed domain error.
 */
function isUniqueViolation(error: DatabaseError): boolean {
  const cause = error.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

/**
 * Runs one Brand Profile mutation under the shared idempotency protocol.
 *
 * Reserves the (org, operation, key) slot, replays the stored response on a
 * matching request hash, and records the produced profile before commit so a
 * retried request returns the original outcome. The request hash covers the
 * profile id and input so a reused key with a different payload fails 409.
 *
 * @param env - Worker environment bindings.
 * @param session - Authenticated session claims scoping the tenant transaction.
 * @param operation - Idempotency operation identifier (e.g. "brand-profile.create").
 * @param idempotencyKey - Client-provided Idempotency-Key header value.
 * @param requestPayload - Canonical request fields folded into the hash.
 * @param status - HTTP status recorded with the completed response.
 * @param run - Transactional program producing the Brand Profile response.
 * @returns Effect resolving to the fresh or replayed profile result.
 */
function idempotentProfileMutation(
  env: ApiWorkerEnv,
  session: SessionClaims,
  operation: string,
  idempotencyKey: string,
  requestPayload: string,
  status: number,
  run: (
    client: EffectTransactionClient,
    organizationId: string,
  ) => Effect.Effect<BrandProfile, BrandProfileServiceError>,
): Effect.Effect<IdempotentResult<BrandProfile>, BrandProfileServiceError> {
  return Effect.gen(function* () {
    const requestHash = yield* hashIdempotencyRequestEffect(requestPayload);
    return yield* withTenantTransactionEffect(env, session, (client) =>
      Effect.gen(function* () {
        const organizationId = yield* activeOrganizationIdEffect(client);
        const replay = yield* reserveIdempotencyEffect(
          client,
          organizationId,
          operation,
          idempotencyKey,
          requestHash,
        );
        if (replay) {
          return {
            replayed: true,
            value: replay.response_body as BrandProfile,
          };
        }
        const profile = yield* run(client, organizationId);
        yield* completeIdempotencyEffect(
          client,
          organizationId,
          operation,
          idempotencyKey,
          status,
          profile,
        );
        return { replayed: false, value: profile };
      }),
    );
  });
}

/**
 * Locally disconnects one platform account inside the caller's transaction.
 *
 * Shared by single-Channel disconnect and Brand Profile deletion: cancels the
 * account's scheduled/queued distributions, deletes the account row (which
 * frees the global (platform, platform_user_id) identity for reconnect), and
 * enqueues a durable `channel.revocation.requested` outbox event carrying the
 * still-encrypted access token so the automation worker can retry remote
 * provider revocation after the local row is gone. The outbox insert is
 * deduplicated on the account id so repeated deletes never double-enqueue.
 *
 * @param client - Active Effect transaction client.
 * @param organizationId - Workspace UUID owning the account.
 * @param account - Account row including its encrypted access token.
 * @returns Effect resolving void after the local cutover commits.
 */
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

/**
 * Factory creating the Brand Profile lifecycle service.
 *
 * @returns BrandProfileApiService bound to tenant transactions and the shared
 *   idempotency protocol.
 */
export function createBrandProfileService(): BrandProfileApiService {
  return {
    /**
     * Lists every active Brand Profile in the caller's workspace, including its
     * nullable Channels-board summary, ordered by name.
     *
     * RLS hides soft-deleted rows from members; the explicit predicate keeps
     * them out of the admin's normal list too — admins use
     * listDeletedBrandProfiles for the retention view.
     */
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

    /**
     * Lists soft-deleted Brand Profiles and their retained descriptions inside
     * the retention window.
     *
     * Admin-only: the explicit role check produces the contract 403 before RLS
     * would silently return an empty list for members.
     */
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

    /**
     * Returns one Brand Profile and its nullable description by id within the
     * caller's workspace.
     *
     * Members receive 404 for soft-deleted profiles because RLS hides the row;
     * admins resolve it so the deleted lifecycle state stays inspectable.
     */
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

    /**
     * Creates an active Brand Profile with a workspace-unique normalized name
     * and optional short description.
     *
     * The unconditional UNIQUE(org_id, normalized_name) index reserves names
     * of soft-deleted profiles too, so a duplicate surfaces as 409 whether the
     * conflicting profile is active or awaiting purge.
     */
    createBrandProfile(env, session, input, idempotencyKey) {
      return idempotentProfileMutation(
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

    /**
     * Renames, recolors, or changes the short description of an active Brand
     * Profile. An explicit null description clears it; omission preserves it.
     *
     * Soft-deleted profiles must be restored first: the UPDATE targets only
     * active rows so a deleted id resolves as 404 rather than mutating a
     * profile in its retention window.
     */
    updateBrandProfile(env, session, profileId, input, idempotencyKey) {
      return idempotentProfileMutation(
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

    /**
     * Permanently deletes a Brand Profile and all ownership-scoped data.
     *
     * The organization lock prevents a concurrent OAuth connection from attaching
     * during deletion. Accounts are locally disconnected first so their encrypted
     * tokens enter the revocation outbox; the final DELETE relies on cascading
     * foreign keys to remove the profile's assets and distributions atomically.
     */
    deleteBrandProfile(env, session, profileId, idempotencyKey) {
      return idempotentProfileMutation(
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
            const existing = yield* client.query<BrandProfileRow>(
              `SELECT id, org_id, name, description, color, deleted_at, purge_at,
                      created_at, updated_at
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

    /**
     * Restores a soft-deleted Brand Profile with its original description
     * inside the retention window.
     *
     * Clears deleted_at/purge_at so the profile and its retained assets and
     * distributions return to normal views. Channels stay disconnected and
     * cancelled distributions stay cancelled — restore never produces
     * unreviewed external side effects. Profiles past purge_at fail 409.
     */
    restoreBrandProfile(env, session, profileId, idempotencyKey) {
      return idempotentProfileMutation(
        env,
        session,
        "brand-profile.restore",
        idempotencyKey,
        JSON.stringify({ profile_id: profileId }),
        200,
        (client, organizationId) =>
          Effect.gen(function* () {
            yield* requireWorkspaceAdminEffect(client);
            const existing = yield* client.query<BrandProfileRow>(
              `SELECT id, org_id, name, description, color, deleted_at, purge_at,
                      created_at, updated_at
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
