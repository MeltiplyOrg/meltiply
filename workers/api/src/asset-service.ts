import { Effect, Layer, Option } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import {
  AccessDenied,
  ASSET_UPLOAD_POLICY,
  AssetPolicyError,
  assetOrphanGraceSeconds,
  type DatabaseError,
  type DomainError,
  isoDateTime,
  COMMUNITY_LIMITS,
  uploadLayout,
  validateUpload,
} from "@meltiply/domain";
import {
  stagingObjectKey,
  StorageService,
  type EffectMultipartUpload,
  type ObjectMetadata,
  type StorageServiceShape,
} from "@meltiply/storage";

import {
  mapAsset,
  type AssetApiService,
  type AssetRow,
  type AssetServiceError,
} from "./asset-types";
import {
  activeBrandProfilePredicate,
  requireActiveBrandProfileEffect,
} from "./brand-profile-guard";
import { CoreApiError } from "./core-types";
import {
  activeOrganizationIdEffect,
  withSystemTransactionEffect,
  withTenantTransactionEffect,
  type EffectTransactionClient,
} from "./database";
import {
  createStorageServiceLiveFromEnv,
  StorageConfigurationError,
} from "./effect/services/storage";
import type { ApiWorkerEnv } from "./env";
import {
  completeIdempotencyEffect,
  hashIdempotencyRequestEffect,
  reserveIdempotencyEffect,
} from "./idempotency";
import { lockActiveOrganizationEffect } from "./organization-lock";
import { isoPeriodKey } from "./time";

type Schemas = components["schemas"];
type Asset = Schemas["Asset"];
type CompletedPart = Schemas["CompletedPart"];
type UploadSession = Schemas["UploadSession"];

interface UploadSessionRow extends Record<string, unknown> {
  asset_id: string;
  content_type: string;
  expires_at: Date | string;
  file_size: number | string;
  id: string;
  max_parallel_parts: number | null;
  multipart_upload_id: string | null;
  object_key: string;
  org_id: string;
  part_count: number | null;
  part_size: number | string | null;
  status: UploadSession["status"];
  strategy: UploadSession["strategy"];
}

interface OrganizationUsageRow extends Record<string, unknown> {
  active_reservation_bytes: number | string;
  active_reservations: number | string;
  id: string;
  storage_bytes: number | string;
  uploads: number | string;
  user_id: string;
}

interface UploadPartRow extends Record<string, unknown> {
  etag: string;
  part_number: number;
  size: number | string;
}

export interface AssetServiceOptions {
  now?: () => Date;
  randomUUID?: () => string;
  storageService?: StorageServiceShape;
  storageServiceLayer?: Layer.Layer<StorageService, never, never>;
}

const assetColumns = `
  id, org_id, brand_profile_id, uploaded_by, asset_type, title, duration_sec,
  file_size, mime_type, width, height, original_filename, status, failure_code,
  failure_message, failure_retryable, failure_at, created_at, updated_at
`;

/**
 * Elapsed grace period before a completed upload with no retained attachment
 * becomes eligible for reclamation.
 *
 * The deadline itself is persisted by this worker (upload finalization and
 * last-detachment), so the automation sweep never re-derives the policy from a
 * request timestamp; this constant only starts the clock.
 */
const orphanGraceDays = assetOrphanGraceSeconds / (24 * 60 * 60);

/**
 * Maps a database upload session row to the public `UploadSession` schema object.
 *
 * @param row - Database row from `asset_upload_sessions` table.
 * @param singleUpload - Optional signed single upload descriptor.
 * @returns Formatted `UploadSession` schema representation.
 */
function mapUploadSession(
  row: UploadSessionRow,
  singleUpload: UploadSession["single_upload"] = null,
): UploadSession {
  return {
    asset_id: row.asset_id,
    content_type: row.content_type,
    expires_at: isoDateTime(row.expires_at),
    file_size: Number(row.file_size),
    id: row.id,
    multipart:
      row.strategy === "multipart"
        ? {
            max_parallel_parts: row.max_parallel_parts!,
            part_count: row.part_count!,
            part_size: Number(row.part_size),
          }
        : null,
    single_upload: singleUpload,
    status: row.status,
    strategy: row.strategy,
  };
}

/**
 * Translates domain `AssetPolicyError` into corresponding HTTP `CoreApiError`.
 *
 * Maps `payload_too_large` to 413, `unsupported_media_type` to 415, and others to 400.
 *
 * @param cause - Error thrown during upload validation.
 * @throws {CoreApiError} Always throws.
 */
function policyError(cause: unknown): never {
  if (!(cause instanceof AssetPolicyError)) throw cause;
  const status =
    cause.code === "payload_too_large" ? 413 : cause.code === "unsupported_media_type" ? 415 : 400;
  throw new CoreApiError(status, cause.code, cause.message);
}

/**
 * Validates that a required text field is non-empty and does not exceed maximum character length.
 *
 * @param value - Candidate input string.
 * @param field - Field name for error message.
 * @param maximum - Maximum allowed length.
 * @returns Normalized trimmed string.
 * @throws {CoreApiError} 400 `validation_error` if empty or too long.
 */
function requiredText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new CoreApiError(
      400,
      "validation_error",
      `${field} must contain between 1 and ${maximum} characters.`,
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Session expiry — shared logic
// ---------------------------------------------------------------------------

const SESSION_EXPIRY_FAILURE_CODE = "upload_session_expired";
const SESSION_EXPIRY_FAILURE_MESSAGE = "The upload session expired before completion.";

/**
 * Expires an individual overdue upload session via Effect, handing its staged
 * bytes to the maintenance sweep.
 *
 * Transitions the upload session to `'expired'`, moves the reserved bytes out of
 * `asset_quota_reservations` and onto the staged `asset_objects` row in the same
 * statement, and marks that row `'deleting'`. Every signed grant the session
 * issued was clamped to the session's own `expires_at`, so once the session is
 * overdue no writer capability survives and the hold can close immediately —
 * this is the `writersClosed` path of `markStagedObjectDeletingEffect`.
 *
 * Transferring rather than simply releasing matters: the staged object can
 * physically exist, and releasing its reservation while the bytes are still in
 * the bucket would understate live storage and let a concurrent upload
 * oversubscribe Entitlements. The bytes stay charged on the inventoried row
 * until the sweep's external delete completes and flips it to `'deleted'`.
 *
 * The Asset fails with that same actionable reason whether or not a Post still
 * retains it — a draft whose attachment never finished uploading must show why
 * — and only the seven-day orphan clock is conditional, so an abandoned upload
 * is reclaimed after the grace period while a draft's failed attachment
 * survives.
 *
 * @param client - Active PostgreSQL EffectTransactionClient scoped to the tenant.
 * @param sessionId - Unique identifier of the upload session to expire.
 * @param assetId - Unique identifier of the associated asset to fail.
 * @returns Effect resolving when database updates complete or failing with DatabaseError.
 */
function expireSingleSessionEffect(
  client: EffectTransactionClient,
  sessionId: string,
  assetId: string,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    yield* client.query(
      `UPDATE asset_upload_sessions
       SET status = 'expired', updated_at = now()
       WHERE id = $1`,
      [sessionId],
    );
    // Hand the reserved bytes to the staged object before releasing the
    // reservation, so an object that physically exists is never momentarily
    // unaccounted and cannot let a concurrent upload oversubscribe.
    yield* releaseReservationToStagingEffect(client, sessionId, assetId);
    yield* markStagedObjectDeletingEffect(client, assetId, {
      writersClosed: true,
    });
    yield* client.query(
      `UPDATE assets
       SET status = 'failed',
           failure_code = $2,
           failure_message = $3,
           failure_retryable = true,
           failure_at = now(),
           -- The failure is creator-actionable whether or not a Post retains
           -- the Asset; only the reclaim clock is conditional on that
           -- retention, so a saved draft's attachment reports why its upload
           -- never finished instead of remaining an unexplained pending
           -- upload forever.
           orphaned_at = CASE
             WHEN EXISTS (
               SELECT 1 FROM post_attachments WHERE asset_id = $1
             ) THEN NULL
             ELSE now()
           END,
           orphan_delete_after = CASE
             WHEN EXISTS (
               SELECT 1 FROM post_attachments WHERE asset_id = $1
             ) THEN NULL
             ELSE now() + make_interval(days => $4)
           END,
           updated_at = now()
       WHERE id = $1
         AND status IN ('pending_upload', 'uploading')`,
      [assetId, SESSION_EXPIRY_FAILURE_CODE, SESSION_EXPIRY_FAILURE_MESSAGE, orphanGraceDays],
    );
  });
}

/**
 * Hands every live staging object of an asset to the maintenance sweep, holding
 * it until the last possible write against the staging key has expired.
 *
 * A signed staging PUT stays usable for the whole grant window, so deleting the
 * object at abort time would leave a live grant able to recreate real bytes
 * behind the cleanup. `write_hold_until` records that deadline in a dedicated
 * column rather than overloading `updated_at`: `updated_at` is the audit
 * timestamp that promotion and settlement keep rewriting, so a reclaim hold
 * stored there would be silently erased by the next UPDATE. In its own nullable
 * column the hold can only be cleared by the sweep that is actually respecting
 * it, and the hold is never extended by an unrelated row touch.
 *
 * The hold bound is the object's own recorded writer deadline, not the
 * session's 24-hour expiry: every minted upload capability is clamped to a
 * deadline that was persisted on this row under the session lock before the
 * URL was exposed, so the column already names the last instant a writer can
 * fire. `writersClosed` is set only when the caller confirmed to object
 * storage that no grant remains — a completed or aborted multipart upload's
 * dead `uploadId`, or a session past expiry — in which case the hold closes
 * immediately and the sweep may reclaim without waiting out a grant window.
 * Anything else (a single PUT whose URL stays live, a multipart abort that
 * could not be confirmed, a failed completion) keeps the recorded deadline.
 * Rows written before per-grant recording carry the conservative
 * session-expiry hold the write-hold migration backfilled, which this
 * function simply preserves.
 *
 * Marking never gates on the current hold: a row already inside its window is
 * still handed to the sweep so the claim — not the delete — waits out the
 * hold. The bytes are only *marked* here: removing them from the bucket
 * happens outside the request transaction, and the durable `asset_objects`
 * row is what makes that removal replayable and accounting-exactly-once.
 *
 * @param client - Active PostgreSQL EffectTransactionClient.
 * @param assetId - Asset whose staged object should be reclaimed.
 * @param options - `writersClosed` confirms no signed capability can still write the key.
 * @returns Effect resolving when the object rows are marked `'deleting'` with the writer-window hold.
 */
function markStagedObjectDeletingEffect(
  client: EffectTransactionClient,
  assetId: string,
  options: { writersClosed: boolean },
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `UPDATE asset_objects
       SET status = 'deleting',
           -- Confirmed dead writers close the hold now; anything ambiguous
           -- keeps the recorded grant deadline (PostgreSQL's GREATEST ignores
           -- the NULL of an object that never recorded one).
           write_hold_until = CASE
             WHEN $2 THEN now()
             ELSE GREATEST(write_hold_until, now())
           END,
           updated_at = now()
       WHERE asset_id = $1
         AND kind = 'staging'
         AND status IN ('writing', 'ready')`,
      [assetId, options.writersClosed],
    )
    .pipe(Effect.asVoid);
}

/**
 * Hands an upload session's reserved bytes to its staging object row and then
 * releases the reservation, so reclaiming the staged object can never leave
 * those bytes unaccounted.
 *
 * While an upload is in flight the bytes live only in
 * `asset_quota_reservations`. Releasing that reservation while the staged
 * object still physically exists — which is what abort and expiry do — would
 * make the workspace appear to have freed storage it is still occupying, so a
 * concurrent upload could pass the limit check and oversubscribe Entitlements.
 * Moving the bytes onto `reserved_bytes` first hands the accounting to the
 * single inventoried row the maintenance sweep already settles, keeping the
 * bytes charged continuously from reservation, through the reclaim hold, until
 * the external delete completes and the sweep releases them exactly once.
 *
 * Transfer and release are one statement, so there is no instant in which the
 * bytes are charged by neither source nor by both. The transfer is guarded on
 * `bytes IS NULL`, so an object that already settled its verified size never
 * picks up a second charge on top of it, and the size is read from the
 * reservation itself rather than from a caller-supplied value.
 *
 * @param client - Active PostgreSQL EffectTransactionClient.
 * @param sessionId - Session whose reservation is handed over; its own staged object is the only possible recipient.
 * @param assetId - Asset owning that session's staging object.
 * @returns Effect resolving when the bytes are inventoried and the reservation released.
 */
function releaseReservationToStagingEffect(
  client: EffectTransactionClient,
  sessionId: string,
  assetId: string,
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `WITH reservation AS (
         SELECT bytes
         FROM asset_quota_reservations
         WHERE session_id = $1 AND state = 'reserved'
       ), transferred AS (
         UPDATE asset_objects
         SET reserved_bytes = COALESCE(reserved_bytes, (SELECT bytes FROM reservation)),
             updated_at = now()
         WHERE asset_id = $2
           AND kind = 'staging'
           AND status IN ('writing', 'deleting')
           AND bytes IS NULL
       )
       UPDATE asset_quota_reservations
       SET state = 'released', released_at = now()
       WHERE session_id = $1 AND state = 'reserved'`,
      [sessionId, assetId],
    )
    .pipe(Effect.asVoid);
}

/**
 * Durably records the planned deadline of a staging write capability on the
 * inventoried object, inside the same transaction that locked the session.
 *
 * `write_hold_until` is the sweep's only evidence of how long a signed PUT can
 * still recreate this key, so the deadline must be durable *before* the URL
 * that carries it is exposed: recording happens here, the session transaction
 * commits, and only then does the caller sign with `expiresAt` equal to the
 * recorded instant. Because abort/complete and this path both take the session
 * row lock, whichever commits first decides: a mint that commits first is
 * covered by the hold the abort then retains; an abort that commits first is
 * observed by the locked revalidation and no URL is minted behind it.
 *
 * `GREATEST` never shortens an earlier deadline: a re-sign may only extend the
 * window while the session stays active, never claw back a capability that was
 * already issued. A missing or already-settled staging row means there is
 * nothing left to write into — the caller must treat a zero row count as "no
 * grant may be minted".
 *
 * @param client - Active PostgreSQL EffectTransactionClient holding the session lock.
 * @param assetId - Asset whose staging object carries the hold.
 * @param objectKey - The session's own staging key, so a retired staging row from an earlier session on the same asset can never suppress or absorb the record.
 * @param deadline - Planned expiry instant of the capability about to be signed.
 * @returns Effect resolving to true when the deadline was recorded, false when no live staging row exists.
 */
function recordStagingWriteDeadlineEffect(
  client: EffectTransactionClient,
  assetId: string,
  objectKey: string,
  deadline: Date,
): Effect.Effect<boolean, DatabaseError> {
  return client
    .query(
      `UPDATE asset_objects
       SET write_hold_until = GREATEST(write_hold_until, $3::timestamptz),
           updated_at = now()
       WHERE asset_id = $1
         AND kind = 'staging'
         AND r2_key = $2
         AND status <> 'deleted'`,
      [assetId, objectKey, deadline],
    )
    .pipe(Effect.map((result) => result.rowCount === 1));
}

/**
 * Locks active organization and retrieves current usage metrics and quota reservations via Effect.
 *
 * Enforces serial execution within the tenant via `lockActiveOrganizationEffect`, so
 * two concurrent upload-session creations cannot both observe the same headroom and
 * oversubscribe the storage limit. Overdue sessions are swept and expired in the same
 * transaction before the numbers are read, which also keeps an abandoned session
 * from holding its reservation against the workspace that just released it and
 * gives the swept Asset its actionable failure — only its seven-day reclaim
 * clock depends on whether a Post still retains it.
 *
 * `storage_bytes` is derived from the authoritative object inventory
 * (`asset_objects`) rather than the period counter, and deliberately separates the
 * two sources so a caller adds each exactly once:
 * - `storage_bytes` — capacity that is really committed. Every inventoried row that
 *   is not `'deleted'` contributes
 *   `GREATEST(COALESCE(bytes, 0), COALESCE(reserved_bytes, 0))`, so verified
 *   originals, renditions and thumbnails, an in-flight write's reservation, and a
 *   reclaiming row's held capacity are all charged by one rule. A single physical
 *   key can never hold its old and replacement bytes at the same instant, so the
 *   row's charge is the larger of the two — never their sum. An interrupted output
 *   that already recorded its measured bytes while still holding its full planned
 *   reservation therefore stays charged at that maximum until promotion or
 *   settlement releases it exactly once. Deriving this from the inventory is what
 *   stops a monthly rollover or a lag in `usage_records` from making resident
 *   stored bytes disappear from accounting.
 * - `active_reservation_bytes` — bytes held by upload sessions that have not yet
 *   produced an inventoried object. This is the one charge kept separate, because
 *   those bytes belong to no inventory row yet.
 *
 * There is exactly one charge per byte at every instant. While an upload is in
 * flight the bytes live only in `asset_quota_reservations` and the staging row
 * carries neither field. When a session is aborted, expires, or fails
 * verification, the reservation is transferred onto that row's `reserved_bytes`
 * in the same statement that releases it, so the handover is atomic and those
 * bytes are never charged by neither source nor by both. The transfer is guarded
 * on `bytes IS NULL`, so a row that already settled its verified size is charged
 * once by its own bytes and never picks up a second charge.
 *
 * @param client - Active PostgreSQL EffectTransactionClient scoped to the tenant.
 * @param periodKey - ISO usage month (e.g. `2026-03`), used for the period-scoped upload counter.
 * @param currentInstant - Reference timestamp for expiry comparison (defaults to now).
 * @returns Effect resolving to aggregated organization usage, or failing with AccessDenied/DatabaseError.
 */
function organizationUsageEffect(
  client: EffectTransactionClient,
  periodKey: string,
  currentInstant: Date = new Date(),
): Effect.Effect<OrganizationUsageRow, AccessDenied | DatabaseError> {
  return Effect.gen(function* () {
    yield* lockActiveOrganizationEffect(client);
    yield* client.query(
      `WITH due AS (
         SELECT id
         FROM asset_upload_sessions
         WHERE org_id = public.auth_active_org_id()
           AND (
             status IN ('created', 'uploading')
             OR (
               status = 'aborted'
               AND id IN (
                 SELECT session_id
                 FROM asset_quota_reservations
                 WHERE org_id = public.auth_active_org_id()
                   AND state = 'reserved'
               )
             )
           )
           AND expires_at <= $1::timestamptz
       ), expired AS (
         UPDATE asset_upload_sessions AS session
         SET status = 'expired', updated_at = now()
         FROM due
         WHERE session.id = due.id
         RETURNING session.id, session.asset_id, session.expires_at
       ), staged AS (
         /* Mark the reclaim and hand the session's reserved bytes to the staged
            object in one statement, so an object that physically exists is never
            momentarily unaccounted and cannot let a concurrent upload
            oversubscribe. The transfer is guarded on bytes IS NULL so a settled
            object is never charged twice. */
         UPDATE asset_objects AS object
         SET status = 'deleting',
             -- Every grant this session issued was clamped to its expires_at,
             -- so an expired session has no surviving writer; the existing
             -- hold is kept as the bound for objects whose recorded deadline
             -- (or conservative migrated hold) already covers it.
             write_hold_until = GREATEST(
               object.write_hold_until, expired.expires_at, now()
             ),
             reserved_bytes = CASE
               WHEN object.bytes IS NULL
               THEN COALESCE(object.reserved_bytes, reservation.bytes)
               ELSE object.reserved_bytes
             END,
             updated_at = now()
         FROM expired
         JOIN asset_quota_reservations AS reservation
           ON reservation.session_id = expired.id
          AND reservation.state = 'reserved'
         WHERE object.asset_id = expired.asset_id
           AND object.kind = 'staging'
           AND object.status IN ('writing', 'ready')
       ), released AS (
         /* Only after the bytes are inventoried above; both run in this single
            statement so there is no window charged by neither source. */
         UPDATE asset_quota_reservations AS reservation
         SET state = 'released', released_at = now()
         FROM expired
         WHERE reservation.session_id = expired.id
           AND reservation.state = 'reserved'
       )
      UPDATE assets AS asset
      SET status = 'failed',
          failure_code = $2,
          failure_message = $3,
          failure_retryable = true,
          failure_at = now(),
          -- Retention decides the reclaim clock only. The failure itself is
          -- what the creator sees, so it is recorded even for an Asset a
          -- saved draft still holds.
          orphaned_at = CASE
            WHEN EXISTS (
              SELECT 1 FROM post_attachments WHERE asset_id = asset.id
            ) THEN NULL
            ELSE now()
          END,
          orphan_delete_after = CASE
            WHEN EXISTS (
              SELECT 1 FROM post_attachments WHERE asset_id = asset.id
            ) THEN NULL
            ELSE now() + make_interval(days => $4)
          END,
          updated_at = now()
      FROM expired
      WHERE asset.id = expired.asset_id
        AND asset.status IN ('pending_upload', 'uploading')`,
      [
        currentInstant,
        SESSION_EXPIRY_FAILURE_CODE,
        SESSION_EXPIRY_FAILURE_MESSAGE,
        orphanGraceDays,
      ],
    );
    const result = yield* client.query<OrganizationUsageRow>(
      `SELECT
         o.id,
         public.auth_active_user_id() AS user_id,
         COALESCE(u.uploads, 0) AS uploads,
         COALESCE(resident.resident_bytes, 0) AS storage_bytes,
         COALESCE(r.reservation_count, 0) AS active_reservations,
         COALESCE(r.reservation_bytes, 0) AS active_reservation_bytes
       FROM organizations o
       LEFT JOIN usage_records u
         ON u.org_id = o.id AND u.period = $1
       LEFT JOIN LATERAL (
         -- One inventory rule for every row that is not durably removed.
         -- Verified originals, renditions and thumbnails charge their real
         -- bytes; an in-flight write charges the reservation it still holds;
         -- and a row claimed for deletion keeps charging either way, because its
         -- bytes survive in the bucket until the external delete completes and
         -- so survive a period rollover that resets the usage_records counter.
         -- GREATEST, not a sum: one physical key cannot hold its old and its
         -- replacement bytes simultaneously, so a row that recorded measured
         -- output while still holding the planned reservation is charged the
         -- larger of the two exactly once.
         SELECT COALESCE(
                  SUM(
                    GREATEST(
                      COALESCE(object.bytes, 0),
                      COALESCE(object.reserved_bytes, 0)
                    )
                  ),
                  0
                ) AS resident_bytes
         FROM asset_objects AS object
         WHERE object.org_id = o.id
           AND object.status <> 'deleted'
       ) resident ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS reservation_count, COALESCE(SUM(bytes), 0) AS reservation_bytes
         FROM asset_quota_reservations
         WHERE org_id = o.id AND state = 'reserved'
       ) r ON TRUE
       WHERE o.id = public.auth_active_org_id()`,
      [periodKey],
    );
    const row = result.rows[0];
    if (!row) {
      return yield* Effect.fail(
        new AccessDenied("The authenticated identity is not an active organization member."),
      );
    }
    if (!row.user_id) {
      return yield* Effect.fail(
        new AccessDenied("The authenticated user has not been synchronized."),
      );
    }
    return row;
  });
}
/**
 * Retrieves a single asset database record scoped to the active tenant organization via Effect.
 *
 * Enforces tenant isolation via `public.auth_active_org_id()`. Excludes soft-deleted
 * assets unless `includeDeleted` is explicitly true, optionally acquires a row lock,
 * and when `requireActiveProfile` is set also excludes assets whose Brand Profile is
 * soft-deleted so deleted-profile data leaves normal views immediately.
 *
 * @param client - Active PostgreSQL EffectTransactionClient scoped to the tenant.
 * @param assetId - Unique identifier of the target asset.
 * @param options - `lock` appends `FOR UPDATE`; `includeDeleted` matches
 *   `status = 'deleted'` rows; `requireActiveProfile` adds the active Brand
 *   Profile predicate for public reads and mutations.
 * @returns Effect resolving to the asset row or failing with 404 CoreApiError / DatabaseError.
 */
function getAssetRowEffect(
  client: EffectTransactionClient,
  assetId: string,
  options: {
    includeDeleted?: boolean;
    lock?: boolean;
    requireActiveProfile?: boolean;
  } = {},
): Effect.Effect<AssetRow, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const result = yield* client.query<AssetRow>(
      `SELECT ${assetColumns}
       FROM assets
       WHERE id = $1
         AND org_id = public.auth_active_org_id()
         ${options.includeDeleted ? "" : "AND status != 'deleted'"}
         ${options.requireActiveProfile ? `AND ${activeBrandProfilePredicate("assets.brand_profile_id")}` : ""}
      ${options.lock ? "FOR UPDATE" : ""}`,
      [assetId],
    );
    const row = result.rows[0];
    if (!row) {
      return yield* Effect.fail(new CoreApiError(404, "not_found", "The asset was not found."));
    }
    return row;
  });
}

/**
 * Resolves a fully materialized image or video asset within a tenant transaction via Effect.
 *
 * Downloads preserve the protected original; previews require a ready normalized
 * full rendition so accepted camera codecs can play in the browser. Neither path
 * signs upload-writable staging or thumbnails. A verified original referenced by
 * a ready rendition remains eligible without creating or charging another copy.
 *
 * @param env - Worker environment bindings for database and storage access.
 * @param session - Authenticated user session claims providing tenant context.
 * @param assetId - Unique identifier of the target media asset.
 * @param download - Selects the original rather than a browser-compatible rendition.
 * @returns The tenant asset and selected protected object key; unfinished media fails with 409.
 */
function getReadyMediaAssetRowEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  assetId: string,
  download: boolean,
): Effect.Effect<AssetRow & { protected_key: string }, CoreApiError | DatabaseError | DomainError> {
  return withTenantTransactionEffect(env, session, (client) =>
    Effect.gen(function* () {
      const asset = yield* getAssetRowEffect(client, assetId, {
        requireActiveProfile: true,
      });
      const selected = yield* client.query<{ r2_key: string }>(
        `SELECT objects.r2_key
         FROM asset_objects AS objects
         WHERE objects.asset_id = $1 AND objects.status = 'ready'
           AND (
             ($2 AND objects.kind = 'original')
             OR (
               NOT $2
               AND objects.kind IN ('original', 'rendition')
               AND EXISTS (
                 SELECT 1 FROM asset_renditions AS renditions
                 WHERE renditions.object_id = objects.id
                   AND renditions.asset_id = objects.asset_id
                   AND renditions.org_id = objects.org_id
                   AND renditions.brand_profile_id = objects.brand_profile_id
                   AND renditions.status = 'ready'
               )
               AND objects.content_type IN ('image/jpeg', 'image/png', 'image/webp', 'video/mp4')
             )
           )
         ORDER BY objects.bytes ASC, objects.id
         LIMIT 1`,
        [assetId, download],
      );
      const protectedKey = selected.rows[0]?.r2_key;
      if (
        asset.status !== "ready" ||
        (asset.asset_type !== "image" && asset.asset_type !== "video") ||
        !asset.mime_type ||
        !protectedKey
      ) {
        return yield* Effect.fail(
          new CoreApiError(409, "invalid_state", "Only ready media assets can be accessed."),
        );
      }
      return { ...asset, protected_key: protectedKey };
    }),
  );
}

/**
 * Retrieves an upload session record scoped to the active tenant organization via Effect.
 *
 * Enforces RLS via `public.auth_active_org_id()`, optionally locking the row
 * for upload finalization or state mutation.
 *
 * @param client - Active PostgreSQL EffectTransactionClient scoped to the tenant.
 * @param sessionId - Unique identifier of the upload session.
 * @param lock - Whether to acquire a `FOR UPDATE` row lock.
 * @returns Effect resolving to the upload session row or failing with 404 CoreApiError / DatabaseError.
 */
function getSessionRowEffect(
  client: EffectTransactionClient,
  sessionId: string,
  lock = false,
): Effect.Effect<UploadSessionRow, CoreApiError | DatabaseError> {
  return Effect.gen(function* () {
    const result = yield* client.query<UploadSessionRow>(
      `SELECT
         id, org_id, asset_id, strategy, status, content_type, file_size,
         object_key, multipart_upload_id, part_size, part_count,
         max_parallel_parts, expires_at
       FROM asset_upload_sessions
       WHERE id = $1 AND org_id = public.auth_active_org_id()
       ${lock ? "FOR UPDATE" : ""}`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) {
      return yield* Effect.fail(
        new CoreApiError(404, "not_found", "The upload session was not found."),
      );
    }
    return row;
  });
}

/**
 * Asserts that an upload session is neither expired nor in a terminal state.
 *
 * Validates that current timestamp has not exceeded `expires_at` and that session
 * status is either `'created'` or `'uploading'`.
 *
 * @param row - Upload session database record to inspect.
 * @param now - Current timestamp against which to verify session expiration.
 * @throws {CoreApiError} 409 `upload_session_expired` if the session deadline has elapsed.
 * @throws {CoreApiError} 409 `invalid_state` if session status is not active.
 */
function ensureActiveSession(row: UploadSessionRow, now: Date): void {
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    throw new CoreApiError(409, "upload_session_expired", "The upload session has expired.");
  }
  if (!["created", "uploading"].includes(row.status)) {
    throw new CoreApiError(409, "invalid_state", `The upload session is ${row.status}.`);
  }
}

/**
 * Computes the expiration timestamp for a presigned upload or download URL.
 *
 * Returns the earlier of the upload session's expiration timestamp or current
 * time plus the configured signed URL TTL (900s), ensuring presigned URLs never
 * outlive their parent upload session.
 *
 * @param now - Current reference timestamp.
 * @param sessionExpiry - Expiration date of the upload session.
 * @returns Expiration date for the presigned URL.
 */
function signedExpiry(now: Date, sessionExpiry: Date): Date {
  return new Date(
    Math.min(
      sessionExpiry.getTime(),
      now.getTime() + ASSET_UPLOAD_POLICY.signedUrlTtlSeconds * 1_000,
    ),
  );
}

/**
 * Calculates the expected byte size for a specific multipart upload chunk.
 *
 * Returns the uniform `part_size` for intermediate chunks, or the remaining byte
 * remainder for the final part number (`part_count`).
 *
 * @param row - Upload session database record containing file and part sizing.
 * @param partNumber - 1-based index of the target multipart chunk.
 * @returns Expected size in bytes for the specified part.
 */
function partSize(row: UploadSessionRow, partNumber: number): number {
  const configured = Number(row.part_size);
  return partNumber === row.part_count
    ? Number(row.file_size) - configured * (row.part_count - 1)
    : configured;
}

/**
 * Validates and normalizes the list of completed parts for multipart upload finalization.
 *
 * Enforces that single uploads provide no part array, and that multipart uploads
 * supply contiguous, 1-indexed parts matching `row.part_count` with valid ETag strings.
 *
 * @param row - Upload session configuration row.
 * @param parts - Optional candidate list of completed part descriptors.
 * @returns Sorted array of validated completed parts.
 * @throws {CoreApiError} 400 `validation_error` if parts are supplied for a single upload.
 * @throws {CoreApiError} 422 `invalid_part_list` if part count is wrong or parts are non-contiguous/malformed.
 */
function validateCompletedParts(
  row: UploadSessionRow,
  parts: CompletedPart[] | undefined,
): CompletedPart[] {
  if (row.strategy === "single") {
    if (parts && parts.length > 0) {
      throw new CoreApiError(
        400,
        "validation_error",
        "Single uploads cannot include multipart parts.",
      );
    }
    return [];
  }
  if (!parts || parts.length !== row.part_count) {
    throw new CoreApiError(
      422,
      "invalid_part_list",
      `Exactly ${row.part_count} completed parts are required.`,
    );
  }
  const sorted = [...parts].sort((left, right) => left.part_number - right.part_number);
  for (let index = 0; index < sorted.length; index += 1) {
    const part = sorted[index]!;
    if (
      part.part_number !== index + 1 ||
      !part.etag.trim() ||
      part.etag.length > 1_024 ||
      /[\u0000-\u001f\u007f]/.test(part.etag)
    ) {
      throw new CoreApiError(
        422,
        "invalid_part_list",
        "Multipart parts must be unique, contiguous, and contain safe ETags.",
      );
    }
  }
  return sorted;
}

/**
 * Transitions an asset and upload session to non-retryable failure upon verification failure via Effect.
 *
 * Marks asset status as `'failed'` with `failure_retryable = false`, completes the
 * upload session record, releases reserved storage quota, and hands the staged
 * object to the maintenance sweep. A size or content-type mismatch means the
 * bytes that landed are not the approved media, so they must be reclaimed
 * instead of staying charged as resident storage. The failure itself is
 * recorded whether or not a Post retains the Asset — a draft's attachment
 * must say why it was rejected — while only the seven-day orphan clock waits
 * on that retention.
 *
 * @param client - Active PostgreSQL EffectTransactionClient.
 * @param row - Upload session row whose asset failed verification.
 * @param code - Machine-readable error code (e.g. `'metadata_mismatch'`).
 * @param message - Human-readable explanation of the mismatch.
 * @returns Effect resolving when database updates complete or failing with DatabaseError.
 */
function failMetadataMismatchEffect(
  client: EffectTransactionClient,
  row: UploadSessionRow,
  code: string,
  message: string,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    yield* client.query(
      `UPDATE assets
       SET status = 'failed',
           failure_code = $2,
           failure_message = $3,
           failure_retryable = false,
           failure_at = now(),
           orphaned_at = CASE
             WHEN EXISTS (
               SELECT 1 FROM post_attachments WHERE asset_id = $1
             ) THEN NULL
             ELSE now()
           END,
           orphan_delete_after = CASE
             WHEN EXISTS (
               SELECT 1 FROM post_attachments WHERE asset_id = $1
             ) THEN NULL
             ELSE now() + make_interval(days => $4)
           END,
           updated_at = now()
       WHERE id = $1
         AND status NOT IN ('deleting', 'deleted')`,
      [row.asset_id, code, message, orphanGraceDays],
    );
    yield* client.query(
      `UPDATE asset_upload_sessions
       SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [row.id],
    );
    // The landed bytes are not the approved media, so they are handed to the
    // sweep rather than dropped: transferring the reservation first keeps them
    // charged until the external delete actually completes. A multipart
    // session reached this point only after its `complete` succeeded, so its
    // uploadId is dead and the hold can close now; a single upload's issued
    // PUT URL stays live and the recorded grant deadline must stand.
    yield* releaseReservationToStagingEffect(client, row.id, row.asset_id);
    yield* markStagedObjectDeletingEffect(client, row.asset_id, {
      writersClosed: row.strategy === "multipart",
    });
  });
}

/**
 * Validates uploaded R2 object metadata against registered session parameters via Effect.
 *
 * Compares actual object byte size and Content-Type against `row.file_size` and
 * `row.content_type`. If a mismatch is detected, triggers `failMetadataMismatchEffect`.
 *
 * @param client - Active PostgreSQL EffectTransactionClient.
 * @param row - Upload session row defining expected dimensions.
 * @param metadata - Object metadata retrieved from storage, or null if missing.
 * @returns Effect resolving to `null` if valid, or a `CoreApiError` (415 or 422) if invalid.
 */
function verifyMetadataEffect(
  client: EffectTransactionClient,
  row: UploadSessionRow,
  metadata: ObjectMetadata | null,
): Effect.Effect<CoreApiError | null, DatabaseError> {
  return Effect.gen(function* () {
    if (!metadata) {
      return new CoreApiError(422, "missing_object", "The uploaded object was not found.");
    }
    if (metadata.size !== Number(row.file_size)) {
      yield* failMetadataMismatchEffect(
        client,
        row,
        "metadata_mismatch",
        "The uploaded object size does not match the reserved size.",
      );
      return new CoreApiError(
        422,
        "metadata_mismatch",
        "The uploaded object size does not match the reserved size.",
      );
    }
    if (metadata.contentType?.toLowerCase() !== row.content_type.toLowerCase()) {
      yield* failMetadataMismatchEffect(
        client,
        row,
        "metadata_mismatch",
        "The uploaded object type does not match the approved type.",
      );
      return new CoreApiError(
        415,
        "metadata_mismatch",
        "The uploaded object type does not match the approved type.",
      );
    }
    return null;
  });
}

/**
 * Instantiates the core asset management service with R2 storage and signer integration.
 *
 * Manages the tenant- and Brand-Profile-scoped upload lifecycle: single and multipart
 * R2 uploads written only to staging keys, quota reservation against the authoritative
 * object inventory, real size/content-type verification at finalization, presigned
 * upload/preview/download URL signing, and durable reclamation hand-off on abort, expiry,
 * or verification failure. There is no library surface: assets exist only as internal
 * infrastructure for the composer's uploads. Uses contextual storage first, then an
 * injected Effect layer or live environment composition.
 *
 * @param options - Configuration options allowing injection of clocks, UUID generators, or mock storage.
 * @returns Configured `AssetApiService` implementation instance.
 */
export function createAssetApiService(options: AssetServiceOptions = {}): AssetApiService {
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const optionsStorageLayer =
    options.storageServiceLayer ??
    (options.storageService ? Layer.succeed(StorageService, options.storageService) : undefined);

  /**
   * Dispatches an Effect program requiring StorageService, using contextual storage or options fallback.
   *
   * If StorageService is already present in the Effect context (e.g. provided at route boundary
   * or test harness), executes directly. Otherwise provides the options layer or live environment layer.
   * Missing API bindings become the public 503 error; configured operation failures retain
   * their typed cause so each workflow can apply its existing failure semantics.
   *
   * @param env - Worker environment bindings.
   * @param program - Effect program consuming StorageService.
   * @returns Effect with StorageService dependency satisfied.
   */
  function withStorage<A, E>(
    env: ApiWorkerEnv,
    program: Effect.Effect<A, E, StorageService>,
  ): Effect.Effect<A, E | CoreApiError, never> {
    return Effect.serviceOption(StorageService).pipe(
      Effect.flatMap((maybeStorage) => {
        if (Option.isSome(maybeStorage)) {
          return Effect.provideService(program, StorageService, maybeStorage.value);
        }
        const layer = optionsStorageLayer ?? createStorageServiceLiveFromEnv(env);
        return program.pipe(Effect.provide(layer));
      }),
      Effect.catch((cause) =>
        Effect.fail(
          cause instanceof StorageConfigurationError
            ? new CoreApiError(503, "service_unavailable", "Asset storage is unavailable.")
            : cause,
        ),
      ),
    );
  }

  /**
   * Signs a ready tenant-scoped media asset for inline preview or forced download.
   *
   * Resolves a browser-compatible protected rendition for preview and preserves
   * original bytes/filename for downloads. Both use the fixed signed URL TTL.
   *
   * @param env - Worker environment bindings used for tenant asset lookup.
   * @param session - Authenticated session that scopes the asset lookup.
   * @param assetId - Unique identifier of the ready media asset.
   * @param download - Whether to force browser download instead of inline rendering.
   * @returns Effect resolving to the signed URL plus its ISO expiry timestamp.
   */
  function signReadyMediaAssetUrlEffect(
    env: ApiWorkerEnv,
    session: SessionClaims,
    assetId: string,
    download: boolean,
  ) {
    return Effect.gen(function* () {
      const row = yield* getReadyMediaAssetRowEffect(env, session, assetId, download);
      const current = now();
      const expiresAt = new Date(
        current.getTime() + ASSET_UPLOAD_POLICY.signedUrlTtlSeconds * 1_000,
      );
      const storage = yield* StorageService;
      const url = yield* storage.signDownload({
        ...(download ? { downloadFilename: row.original_filename ?? row.title } : {}),
        expiresInSeconds: ASSET_UPLOAD_POLICY.signedUrlTtlSeconds,
        key: row.protected_key,
      });
      return {
        expires_at: expiresAt.toISOString(),
        url,
      };
    });
  }

  /**
   * Plans a fresh single-PUT grant for an active session inside the session's
   * own transaction.
   *
   * The session row is re-read under `FOR UPDATE`, which is what serializes
   * minting against abort and completion: whichever transaction commits first
   * decides, so a grant is either recorded before an abort retains its hold or
   * never minted because the locked read already sees the terminal status. The
   * planned deadline is persisted on the staging row's `write_hold_until`
   * before this transaction ends, so every URL the caller exposes afterwards
   * has its writer window durably inventoried — the sweep can never reclaim
   * underneath a live grant.
   *
   * @param client - Active PostgreSQL EffectTransactionClient owning the session row lock.
   * @param sessionId - Upload session to plan a grant for.
   * @param current - Reference timestamp; the planned deadline is `signedExpiry(current, expires_at)`.
   * @returns The locked row plus the deadline to sign with; `grantDeadline` is null when the session mints no single-PUT grant.
   */
  function planSingleUploadGrantEffect(
    client: EffectTransactionClient,
    sessionId: string,
    current: Date,
  ): Effect.Effect<{ grantDeadline: Date | null; row: UploadSessionRow }, AssetServiceError> {
    return Effect.gen(function* () {
      const row = yield* getSessionRowEffect(client, sessionId, true);
      if (
        row.strategy !== "single" ||
        !["created", "uploading"].includes(row.status) ||
        new Date(row.expires_at).getTime() <= current.getTime()
      ) {
        return { grantDeadline: null, row };
      }
      const grantDeadline = signedExpiry(current, new Date(row.expires_at));
      const recorded = yield* recordStagingWriteDeadlineEffect(
        client,
        row.asset_id,
        row.object_key,
        grantDeadline,
      );
      // No live staging row means no inventoried key can carry the grant, so
      // no deadline is handed out and nothing is minted; the locked session
      // row is still returned so the response reflects the latest state.
      return { grantDeadline: recorded ? grantDeadline : null, row };
    });
  }

  /**
   * Materializes an asset and upload session into an API response via Effect,
   * signing a single-PUT URL only for a deadline already persisted.
   *
   * The grant deadline must come from `planSingleUploadGrantEffect` — recorded
   * on the staging row under the session lock before this runs — and the signer
   * is given that absolute deadline rather than a relative TTL computed before
   * an async sign. A paused or delayed signature therefore clamps to the
   * persisted hold instead of outliving it; a deadline that already elapsed
   * (e.g. a session that expired between planning and signing) mints no URL.
   *
   * @param asset - Domain asset entity.
   * @param row - Upload session database record used for the response shape.
   * @param grantDeadline - Persisted grant deadline from the planning transaction; null mints no URL.
   * @returns Effect resolving to formatted API upload session response.
   */
  function materializeUploadEffect(
    asset: Asset,
    row: UploadSessionRow,
    grantDeadline: Date | null,
  ): Effect.Effect<Schemas["UploadSessionResponse"], AssetServiceError, StorageService> {
    return Effect.gen(function* () {
      let singleUpload: UploadSession["single_upload"] = null;
      if (grantDeadline !== null && grantDeadline.getTime() > now().getTime()) {
        const storage = yield* StorageService;
        const url = yield* storage.signUpload({
          contentLength: Number(row.file_size),
          contentType: row.content_type,
          expiresAt: grantDeadline,
          expiresInSeconds: ASSET_UPLOAD_POLICY.signedUrlTtlSeconds,
          key: row.object_key,
        });
        singleUpload = {
          expires_at: grantDeadline.toISOString(),
          headers: { "Content-Type": row.content_type },
          method: "PUT",
          url,
        };
      }
      return {
        asset,
        upload_session: mapUploadSession(row, singleUpload),
      };
    });
  }
  const service: AssetApiService = {
    /**
     * Retrieves an individual asset by ID for the authenticated organization via Effect.
     *
     * Ensures tenant isolation via `public.auth_active_org_id()` and converts the
     * database record to the domain `Asset` schema. Assets whose Brand Profile is
     * soft-deleted resolve as not found so deleted-profile data leaves normal views.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param assetId - Unique identifier of the requested asset.
     * @returns Effect resolving to the domain `Asset` entity or failing with 404 CoreApiError.
     */
    getAsset(env, session, assetId) {
      return withTenantTransactionEffect(env, session, (client) =>
        Effect.gen(function* () {
          const row = yield* getAssetRowEffect(client, assetId, {
            requireActiveProfile: true,
          });
          return mapAsset(row);
        }),
      );
    },

    /**
     * Initiates a single-part or multipart upload session for image/video media via Effect.
     *
     * Validates upload parameters against mime policy, reserves upload quota,
     * provisions R2 multipart upload state if file size exceeds threshold (100MB),
     * and returns the initialized upload session with signed URL for single uploads.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param input - Upload session parameters (asset_type, brand_profile_id, filename, file_size, content_type, etc.).
     * @param idempotencyKey - Client-provided idempotency key.
     * @param _requestId - Optional request tracking identifier.
     * @returns Effect resolving to object containing the created or replayed asset and upload session metadata.
     */
    createUploadSession(env, session, input, idempotencyKey, _requestId) {
      return withStorage(
        env,
        Effect.gen(function* () {
          const normalized = yield* Effect.try({
            try: () => {
              let validated: ReturnType<typeof validateUpload>;
              try {
                validated = validateUpload({
                  assetType: input.asset_type,
                  contentType: input.content_type,
                  fileSize: input.file_size,
                  filename: input.filename,
                });
              } catch (cause) {
                policyError(cause);
              }
              return {
                ...validated!,
                title: requiredText(input.title, "title", 200),
              };
            },
            catch: (cause) => cause as CoreApiError,
          });
          const layout = uploadLayout(normalized.fileSize);
          const requestHash = yield* hashIdempotencyRequestEffect(JSON.stringify(normalized));
          let nativeUpload: EffectMultipartUpload | undefined;
          let preparedAssetId: string | undefined;
          let preparedSessionId: string | undefined;
          let preparedObjectKey: string | undefined;

          if (layout.strategy === "multipart") {
            const organization = yield* withTenantTransactionEffect(env, session, (client) =>
              activeOrganizationIdEffect(client),
            );
            // The identifiers and therefore the staging key must exist before
            // R2 sees the multipart upload: the key encodes both, so they
            // cannot be minted later inside the database transaction. They are
            // reused verbatim below, so a rejected quota check never leaves an
            // orphaned multipart upload bound to a key no row references.
            preparedAssetId = randomUUID();
            preparedSessionId = randomUUID();
            preparedObjectKey = stagingObjectKey(
              organization,
              preparedAssetId,
              preparedSessionId,
              normalized.filename,
            );
            const storage = yield* StorageService;
            nativeUpload = yield* storage.createMultipartUpload(
              preparedObjectKey,
              normalized.contentType,
            );
          }

          const runSession = Effect.gen(function* () {
            const created = yield* withTenantTransactionEffect(env, session, (client) =>
              Effect.gen(function* () {
                const current = now();
                const usage = yield* organizationUsageEffect(
                  client,
                  isoPeriodKey(current),
                  current,
                );
                const replay = yield* reserveIdempotencyEffect(
                  client,
                  usage.id,
                  "createUploadSession",
                  idempotencyKey,
                  requestHash,
                );
                if (replay) {
                  const sessionId = (replay.response_body as { session_id?: string }).session_id;
                  if (!sessionId) {
                    return yield* Effect.fail(
                      new CoreApiError(
                        409,
                        "idempotency_in_progress",
                        "The upload session replay is incomplete.",
                      ),
                    );
                  }
                  const plan = yield* planSingleUploadGrantEffect(client, sessionId, current);
                  const assetRow = yield* getAssetRowEffect(client, plan.row.asset_id);
                  return {
                    asset: mapAsset(assetRow),
                    grantDeadline: plan.grantDeadline,
                    replayed: true,
                    row: plan.row,
                  };
                }
                yield* requireActiveBrandProfileEffect(client, usage.id, input.brand_profile_id);
                const limits = COMMUNITY_LIMITS;
                if (
                  limits.max_uploads !== null &&
                  Number(usage.uploads) + Number(usage.active_reservations) >= limits.max_uploads
                ) {
                  return yield* Effect.fail(
                    new CoreApiError(
                      422,
                      "quota_exceeded",
                      "The monthly upload limit has been reached.",
                    ),
                  );
                }
                if (
                  limits.max_storage_bytes !== null &&
                  Number(usage.storage_bytes) +
                    Number(usage.active_reservation_bytes) +
                    normalized.fileSize >
                    limits.max_storage_bytes
                ) {
                  return yield* Effect.fail(
                    new CoreApiError(
                      422,
                      "quota_exceeded",
                      "The workspace storage limit would be exceeded.",
                    ),
                  );
                }

                const assetId = preparedAssetId ?? randomUUID();
                const sessionId = preparedSessionId ?? randomUUID();
                // Uploads are only ever writable in the staging namespace; the
                // protected ready key is minted later, once processing promotes
                // verified bytes, so a still-valid grant cannot mutate them.
                const key =
                  preparedObjectKey ??
                  stagingObjectKey(usage.id, assetId, sessionId, normalized.filename);
                const uploader = usage.user_id;
                const assetResult = yield* client.query<AssetRow>(
                  `INSERT INTO assets
                       (id, org_id, brand_profile_id, uploaded_by, asset_type,
                        title, original_filename, status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_upload')
                     RETURNING ${assetColumns}`,
                  [
                    assetId,
                    usage.id,
                    input.brand_profile_id,
                    uploader,
                    normalized.assetType,
                    normalized.title,
                    normalized.filename,
                  ],
                );
                // The staging row is the durable per-object inventory, not a
                // second reservation: `asset_quota_reservations` already
                // holds these bytes for the lifetime of the upload, and the
                // authoritative usage formula charges a `writing` object's
                // `reserved_bytes`. Recording the size here too would count
                // the same bytes twice and let the storage limit be met only
                // after reconciliation corrected it. The row therefore starts
                // with neither `bytes` nor `reserved_bytes` — nothing is
                // resident until the object is verified at finalization,
                // which is the single settle point that charges real bytes.
                yield* client.query(
                  `INSERT INTO asset_objects
                       (org_id, asset_id, brand_profile_id, kind, r2_key,
                        content_type, status)
                     VALUES ($1, $2, $3, 'staging', $4, $5, 'writing')`,
                  [usage.id, assetId, input.brand_profile_id, key, normalized.contentType],
                );
                const expiresAt = new Date(
                  current.getTime() + ASSET_UPLOAD_POLICY.sessionTtlSeconds * 1_000,
                );
                yield* client.query<UploadSessionRow>(
                  `INSERT INTO asset_upload_sessions
                       (id, org_id, asset_id, uploaded_by, strategy, status,
                        content_type, file_size, object_key, multipart_upload_id,
                        part_size, part_count, max_parallel_parts, expires_at)
                     VALUES
                       ($1, $2, $3, $4, $5, 'created', $6, $7, $8, $9, $10, $11, $12, $13)
                     RETURNING
                       id, org_id, asset_id, strategy, status, content_type,
                       file_size, object_key, multipart_upload_id, part_size,
                       part_count, max_parallel_parts, expires_at`,
                  [
                    sessionId,
                    usage.id,
                    assetId,
                    uploader,
                    layout.strategy,
                    normalized.contentType,
                    normalized.fileSize,
                    key,
                    nativeUpload?.uploadId ?? null,
                    layout.strategy === "multipart" ? layout.partSize : null,
                    layout.strategy === "multipart" ? layout.partCount : null,
                    layout.strategy === "multipart" ? layout.maxParallelParts : null,
                    expiresAt,
                  ],
                );
                yield* client.query(
                  `INSERT INTO asset_quota_reservations
                       (session_id, org_id, bytes)
                     VALUES ($1, $2, $3)`,
                  [sessionId, usage.id, normalized.fileSize],
                );
                yield* completeIdempotencyEffect(
                  client,
                  usage.id,
                  "createUploadSession",
                  idempotencyKey,
                  201,
                  { session_id: sessionId },
                );
                const plan = yield* planSingleUploadGrantEffect(client, sessionId, current);
                return {
                  asset: mapAsset(assetResult.rows[0]!),
                  grantDeadline: plan.grantDeadline,
                  replayed: false,
                  row: plan.row,
                };
              }),
            );
            if (created.replayed && nativeUpload) {
              yield* nativeUpload.abort().pipe(Effect.catch(() => Effect.void));
              nativeUpload = undefined;
            }
            const uploadSessionResponse = yield* materializeUploadEffect(
              created.asset,
              created.row,
              created.grantDeadline,
            );
            return {
              replayed: created.replayed,
              value: uploadSessionResponse,
            };
          });

          return yield* runSession.pipe(
            Effect.catch((err) => {
              if (nativeUpload) {
                return nativeUpload.abort().pipe(
                  Effect.catch(() => Effect.void),
                  Effect.flatMap(() => Effect.fail(err)),
                );
              }
              return Effect.fail(err);
            }),
            Effect.onInterrupt(() => {
              if (nativeUpload) {
                return nativeUpload.abort().pipe(Effect.catch(() => Effect.void));
              }
              return Effect.void;
            }),
          );
        }),
      );
    },

    /**
     * Retrieves status and progress details of an existing upload session via Effect.
     *
     * Automatically sweeps and marks the session as expired if its deadline has passed.
     * Includes list of successfully uploaded parts and signs fresh single upload URLs if applicable.
     * Sessions whose asset sits under a soft-deleted Brand Profile resolve as not found.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param sessionId - Unique identifier of the upload session.
     * @returns Effect resolving to upload session detail response including asset metadata and uploaded parts.
     * @throws {CoreApiError} 404 `not_found` if the session is unknown or its asset's Brand Profile is deleted.
     */
    getUploadSession(env, session, sessionId) {
      return withStorage(
        env,
        Effect.gen(function* () {
          const result = yield* withTenantTransactionEffect(env, session, (client) =>
            Effect.gen(function* () {
              const row = yield* getSessionRowEffect(client, sessionId, true);
              const current = now();
              if (
                ["created", "uploading"].includes(row.status) &&
                new Date(row.expires_at).getTime() <= current.getTime()
              ) {
                row.status = "expired";
                yield* expireSingleSessionEffect(client, row.id, row.asset_id);
              }
              // Re-read under the held lock so a mint decision uses the
              // committed state rather than a snapshot taken before a
              // concurrent abort could land; the planned deadline is
              // persisted on the staging row inside this transaction.
              const plan = yield* planSingleUploadGrantEffect(client, row.id, current);
              const parts = yield* client.query<UploadPartRow>(
                `SELECT part_number, etag, size
                   FROM asset_upload_parts
                   WHERE session_id = $1
                   ORDER BY part_number`,
                [row.id],
              );
              const assetRow = yield* getAssetRowEffect(client, plan.row.asset_id, {
                requireActiveProfile: true,
              });
              return {
                asset: mapAsset(assetRow),
                grantDeadline: plan.grantDeadline,
                parts: parts.rows,
                row: plan.row,
              };
            }),
          );
          const materialized = yield* materializeUploadEffect(
            result.asset,
            result.row,
            result.grantDeadline,
          );
          return {
            ...materialized,
            uploaded_parts: result.parts.map((part) => ({
              etag: part.etag,
              part_number: part.part_number,
              size: Number(part.size),
            })),
          };
        }),
      );
    },

    /**
     * Generates presigned PUT URLs for uploading specified chunks of a multipart session via Effect.
     *
     * Validates that requested part numbers fall within valid range `[1, part_count]`,
     * transitions session to `'uploading'`, and generates S3-compatible presigned URLs.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param sessionId - Target multipart upload session ID.
     * @param input - Object containing array of integer `part_numbers` to sign.
     * @param idempotencyKey - Client-provided idempotency key.
     * @returns Effect resolving to array of signed part upload URLs with headers and expiration timestamps.
     */
    createUploadPartUrls(env, session, sessionId, input, idempotencyKey) {
      return withStorage(
        env,
        Effect.gen(function* () {
          const requested = [...input.part_numbers].sort((left, right) => left - right);
          if (
            requested.length < 1 ||
            requested.length > ASSET_UPLOAD_POLICY.maxPartUrlBatch ||
            new Set(requested).size !== requested.length
          ) {
            return yield* Effect.fail(
              new CoreApiError(
                400,
                "validation_error",
                `part_numbers must contain 1 to ${ASSET_UPLOAD_POLICY.maxPartUrlBatch} unique values.`,
              ),
            );
          }
          const requestHash = yield* hashIdempotencyRequestEffect(
            JSON.stringify({ part_numbers: requested, session_id: sessionId }),
          );
          const planned = yield* withTenantTransactionEffect(env, session, (client) =>
            Effect.gen(function* () {
              const upload = yield* getSessionRowEffect(client, sessionId, true);
              const current = now();
              yield* Effect.try({
                try: () => ensureActiveSession(upload, current),
                catch: (cause) => cause as CoreApiError,
              });
              if (
                upload.strategy !== "multipart" ||
                !upload.multipart_upload_id ||
                requested.some(
                  (partNumber) =>
                    !Number.isInteger(partNumber) ||
                    partNumber < 1 ||
                    partNumber > upload.part_count!,
                )
              ) {
                return yield* Effect.fail(
                  new CoreApiError(
                    422,
                    "invalid_part_list",
                    "The requested parts are not valid for this multipart session.",
                  ),
                );
              }
              const replay = yield* reserveIdempotencyEffect(
                client,
                upload.org_id,
                "createUploadPartUrls",
                idempotencyKey,
                requestHash,
              );
              if (!replay) {
                yield* client.query(
                  `UPDATE asset_upload_sessions
                   SET status = 'uploading', updated_at = now()
                   WHERE id = $1`,
                  [upload.id],
                );
                yield* client.query(
                  `UPDATE assets
                   SET status = 'uploading', updated_at = now()
                   WHERE id = $1 AND status = 'pending_upload'`,
                  [upload.asset_id],
                );
                yield* completeIdempotencyEffect(
                  client,
                  upload.org_id,
                  "createUploadPartUrls",
                  idempotencyKey,
                  200,
                  { session_id: upload.id },
                );
              }
              // The deadline the part grants will be signed against is
              // persisted on the staging row before this transaction commits
              // — and therefore before any URL leaves this worker — so a
              // paused or delayed sign can never outlive the hold the sweep
              // respects. A missing staging row means nothing inventoried
              // can carry the write, so no capability may be minted.
              const grantDeadline = signedExpiry(current, new Date(upload.expires_at));
              const recorded = yield* recordStagingWriteDeadlineEffect(
                client,
                upload.asset_id,
                upload.object_key,
                grantDeadline,
              );
              if (!recorded) {
                return yield* Effect.fail(
                  new CoreApiError(
                    409,
                    "invalid_state",
                    "The upload staging object is no longer writable.",
                  ),
                );
              }
              return { grantDeadline, row: upload };
            }),
          );
          const row = planned.row;
          const expiresAt = planned.grantDeadline;
          const signer = yield* StorageService;
          const parts = yield* Effect.all(
            requested.map((partNumber) =>
              Effect.gen(function* () {
                const url = yield* signer.signMultipartPart({
                  contentLength: partSize(row, partNumber),
                  contentType: row.content_type,
                  expiresAt,
                  expiresInSeconds: ASSET_UPLOAD_POLICY.signedUrlTtlSeconds,
                  key: row.object_key,
                  partNumber,
                  uploadId: row.multipart_upload_id!,
                });
                return {
                  expires_at: expiresAt.toISOString(),
                  headers: { "Content-Type": row.content_type },
                  method: "PUT" as const,
                  part_number: partNumber,
                  url,
                };
              }),
            ),
          );
          return { parts };
        }),
      );
    },

    /**
     * Finalizes an upload session via Effect, verifying storage contents and transitioning asset to processing.
     *
     * Verifies completed parts for multipart uploads or object presence for single uploads,
     * validates stored byte length and MIME type, commits usage records, transitions asset
     * status to `'processing'`, and emits an `asset.processing.requested` outbox event.
     * Missing storage configuration returns 503 service_unavailable; configured R2
     * finalization failures return 502 storage_unavailable. Both release reservations.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param sessionId - Upload session ID being finalized.
     * @param input - List of completed multipart parts with ETags (empty for single uploads).
     * @param idempotencyKey - Client-provided idempotency key.
     * @param requestId - Optional request ID for outbox event tracing.
     * @returns Effect resolving to object containing the `Asset` entity and replay status.
     */
    completeUploadSession(env, session, sessionId, input, idempotencyKey, requestId) {
      return withStorage(
        env,
        Effect.gen(function* () {
          const requestHash = yield* hashIdempotencyRequestEffect(
            JSON.stringify({
              parts: input.parts
                ? [...input.parts].sort((left, right) => left.part_number - right.part_number)
                : [],
              session_id: sessionId,
            }),
          );
          const preparation = yield* withTenantTransactionEffect(env, session, (client) =>
            Effect.gen(function* () {
              const row = yield* getSessionRowEffect(client, sessionId, true);
              const replay = yield* reserveIdempotencyEffect(
                client,
                row.org_id,
                "completeUploadSession",
                idempotencyKey,
                requestHash,
              );
              if (replay) {
                const response = replay.response_body as {
                  asset_id?: string;
                  error?: { code: string; message: string; status: number };
                };
                if (response.error) {
                  return {
                    asset: null,
                    error: new CoreApiError(
                      response.error.status,
                      response.error.code,
                      response.error.message,
                    ),
                    replayed: true as const,
                  };
                }
                const assetRow = yield* getAssetRowEffect(
                  client,
                  response.asset_id ?? row.asset_id,
                );
                return {
                  asset: mapAsset(assetRow),
                  error: null,
                  replayed: true as const,
                };
              }
              const completionTime = now();
              const asset = yield* getAssetRowEffect(client, row.asset_id, {
                lock: true,
                requireActiveProfile: true,
              });
              if (asset.status === "deleting" || asset.status === "deleted") {
                return yield* Effect.fail(
                  new CoreApiError(409, "invalid_state", "The asset is being deleted."),
                );
              }
              yield* Effect.try({
                try: () => ensureActiveSession(row, completionTime),
                catch: (cause) => cause as CoreApiError,
              });
              const parts = yield* Effect.try({
                try: () => validateCompletedParts(row, input.parts),
                catch: (cause) => cause as CoreApiError,
              });
              yield* client.query(
                `UPDATE asset_upload_sessions
                 SET status = 'completing', updated_at = now()
                 WHERE id = $1`,
                [row.id],
              );
              return {
                completionTime,
                parts,
                replayed: false as const,
                row,
              };
            }),
          );
          if (preparation.replayed) {
            if (preparation.error) {
              return yield* Effect.fail(preparation.error);
            }
            return { replayed: true, value: preparation.asset };
          }

          const storage = yield* StorageService;

          const storageOperation =
            preparation.row.strategy === "multipart"
              ? storage
                  .resumeMultipartUpload(
                    preparation.row.object_key,
                    preparation.row.multipart_upload_id!,
                  )
                  .pipe(
                    Effect.flatMap((upload) =>
                      upload.complete(
                        preparation.parts.map((part) => ({
                          etag: part.etag,
                          partNumber: part.part_number,
                        })),
                      ),
                    ),
                  )
              : storage.head(preparation.row.object_key);

          const metadata = yield* storageOperation.pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                const storageError =
                  cause instanceof CoreApiError
                    ? cause
                    : cause instanceof StorageConfigurationError
                      ? new CoreApiError(
                          503,
                          "service_unavailable",
                          "Asset storage is unavailable.",
                        )
                      : new CoreApiError(
                          502,
                          "storage_unavailable",
                          "The uploaded object could not be finalized.",
                        );
                yield* withTenantTransactionEffect(env, session, (client) =>
                  Effect.gen(function* () {
                    const row = yield* getSessionRowEffect(client, sessionId, true);
                    yield* client.query(
                      `UPDATE asset_upload_sessions
                     SET status = 'aborted', aborted_at = now(), updated_at = now()
                     WHERE id = $1`,
                      [row.id],
                    );
                    // The object may or may not have landed (a completed
                    // multipart whose subsequent HEAD failed, for example), so
                    // the reserved bytes are transferred to the staged object
                    // and held rather than released: an object that physically
                    // exists must stay charged until the sweep deletes it.
                    yield* releaseReservationToStagingEffect(client, row.id, row.asset_id);
                    // The storage outcome is ambiguous — a multipart complete
                    // could have committed server-side or a single PUT could
                    // still hold a live URL — so the recorded grant deadline
                    // stays in force rather than closing the hold early.
                    yield* markStagedObjectDeletingEffect(client, row.asset_id, {
                      writersClosed: false,
                    });
                    yield* client.query(
                      `UPDATE assets
                     SET status = 'failed',
                         failure_code = $2,
                         failure_message = $3,
                         failure_retryable = true,
                         failure_at = now(),
                         updated_at = now()
                     WHERE id = $1
                       AND status NOT IN ('deleting', 'deleted')`,
                      [row.asset_id, storageError.code, storageError.message],
                    );
                    yield* completeIdempotencyEffect(
                      client,
                      row.org_id,
                      "completeUploadSession",
                      idempotencyKey,
                      storageError.status,
                      {
                        asset_id: row.asset_id,
                        error: {
                          code: storageError.code,
                          message: storageError.message,
                          status: storageError.status,
                        },
                      },
                    );
                  }),
                );
                return yield* Effect.fail(storageError);
              }),
            ),
          );

          const outcome = yield* withTenantTransactionEffect(env, session, (client) =>
            Effect.gen(function* () {
              const row = yield* getSessionRowEffect(client, sessionId, true);
              const metadataError = yield* verifyMetadataEffect(client, row, metadata);
              if (metadataError) {
                if (metadataError.code === "missing_object") {
                  yield* client.query(
                    `UPDATE asset_upload_sessions
                     SET status = 'uploading', updated_at = now()
                     WHERE id = $1`,
                    [row.id],
                  );
                } else {
                  yield* completeIdempotencyEffect(
                    client,
                    row.org_id,
                    "completeUploadSession",
                    idempotencyKey,
                    metadataError.status,
                    {
                      asset_id: row.asset_id,
                      error: {
                        code: metadataError.code,
                        message: metadataError.message,
                        status: metadataError.status,
                      },
                    },
                  );
                }
                return {
                  asset: null,
                  error: metadataError,
                  replayed: false,
                  retryable: metadataError.code === "missing_object",
                };
              }
              const assetResult = yield* client.query<AssetRow>(
                `UPDATE assets
                 SET status = 'processing',
                     file_size = $2,
                     mime_type = $3,
                     source_etag = $4,
                     source_sha256 = $5,
                     finalized_at = now(),
                     orphaned_at = CASE
                       WHEN EXISTS (
                         SELECT 1 FROM post_attachments WHERE asset_id = $1
                       ) THEN NULL
                       ELSE now()
                     END,
                     orphan_delete_after = CASE
                       WHEN EXISTS (
                         SELECT 1 FROM post_attachments WHERE asset_id = $1
                       ) THEN NULL
                       ELSE now() + make_interval(days => $6)
                     END,
                     failure_code = NULL,
                     failure_message = NULL,
                     failure_retryable = NULL,
                     failure_at = NULL,
                     updated_at = now()
                 WHERE id = $1
                   AND status NOT IN ('deleting', 'deleted')
                 RETURNING ${assetColumns}`,
                [
                  row.asset_id,
                  metadata!.size,
                  metadata!.contentType,
                  metadata!.etag,
                  metadata!.sha256 ?? null,
                  orphanGraceDays,
                ],
              );
              if (assetResult.rowCount !== 1) {
                const deletionError = new CoreApiError(
                  409,
                  "invalid_state",
                  "The asset is being deleted.",
                );
                yield* client.query(
                  `UPDATE asset_upload_sessions
                   SET status = 'aborted', aborted_at = now(), updated_at = now()
                   WHERE id = $1`,
                  [row.id],
                );
                // The verified object exists but the asset was claimed for
                // deletion concurrently, so its bytes are transferred to the
                // staged row and released from the sweep that deletes it —
                // never simply dropped, which would understate live storage.
                yield* releaseReservationToStagingEffect(client, row.id, row.asset_id);
                yield* completeIdempotencyEffect(
                  client,
                  row.org_id,
                  "completeUploadSession",
                  idempotencyKey,
                  deletionError.status,
                  {
                    asset_id: row.asset_id,
                    error: {
                      code: deletionError.code,
                      message: deletionError.message,
                      status: deletionError.status,
                    },
                  },
                );
                return {
                  asset: null,
                  error: deletionError,
                  replayed: false,
                  retryable: false,
                };
              }
              // The staging row is the single settle point that turns reserved
              // intent into charged bytes, and it is the verified source of
              // truth for promotion: its ETag and version pin which bytes may
              // become the protected original, so a still-valid upload grant
              // cannot swap the source afterwards. `status` moves to 'ready'
              // because the bytes are now real and resident, which is what the
              // authoritative usage formula charges; the upload reservation is
              // committed below and stops counting, so the same bytes are
              // never charged twice.
              const stagedObject = yield* client.query(
                `UPDATE asset_objects
                 SET bytes = $1,
                     etag = $2,
                     version = $3,
                     sha256 = $4,
                     content_type = $5,
                     status = 'ready',
                     -- A confirmed multipart complete kills the uploadId, so no
                     -- part grant can write again and the writer hold closes
                     -- immediately. A single PUT URL stays live for its
                     -- recorded window, so its hold is left untouched.
                     write_hold_until = CASE
                       WHEN $7 THEN now()
                       ELSE write_hold_until
                     END,
                     updated_at = now()
                 WHERE asset_id = $6
                   AND kind = 'staging'
                   AND status = 'writing'
                   AND bytes IS NULL
                 RETURNING id`,
                [
                  metadata!.size,
                  metadata!.etag,
                  metadata!.version ?? null,
                  metadata!.sha256 ?? null,
                  metadata!.contentType,
                  row.asset_id,
                  row.strategy === "multipart",
                ],
              );
              if (stagedObject.rowCount !== 1) {
                return {
                  asset: null,
                  error: new CoreApiError(
                    422,
                    "missing_object",
                    "The staged upload record is no longer reclaimable.",
                  ),
                  replayed: false,
                  retryable: false,
                };
              }
              const parts = preparation.parts;
              if (row.strategy === "multipart") {
                yield* client.query(
                  `INSERT INTO asset_upload_parts
                     (session_id, org_id, part_number, etag, size)
                   SELECT $1, $2, input.part_number, input.etag, input.size
                   FROM unnest(
                     $3::integer[],
                     $4::text[],
                     $5::bigint[]
                   ) AS input(part_number, etag, size)
                   ON CONFLICT (session_id, part_number) DO UPDATE
                   SET etag = EXCLUDED.etag, size = EXCLUDED.size`,
                  [
                    row.id,
                    row.org_id,
                    parts.map((part) => part.part_number),
                    parts.map((part) => part.etag),
                    parts.map((part) => partSize(row, part.part_number)),
                  ],
                );
              }
              yield* client.query(
                `UPDATE asset_upload_sessions
                 SET status = 'completed', completed_at = now(), updated_at = now()
                 WHERE id = $1`,
                [row.id],
              );
              yield* client.query(
                `UPDATE asset_quota_reservations
                 SET state = 'committed', committed_at = now()
                 WHERE session_id = $1 AND state = 'reserved'`,
                [row.id],
              );
              yield* client.query(
                `INSERT INTO usage_records
                   (org_id, period, uploads, storage_bytes)
                 VALUES ($1, $2, 1, $3)
                 ON CONFLICT (org_id, period) DO UPDATE
                 SET uploads = usage_records.uploads + 1,
                     storage_bytes = usage_records.storage_bytes + EXCLUDED.storage_bytes,
                     updated_at = now()`,
                [row.org_id, isoPeriodKey(preparation.completionTime), metadata!.size],
              );
              yield* client.query(
                `INSERT INTO outbox_events
                   (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
                 VALUES ($1, 'asset.processing.requested', 'asset', $2, $3, $4)
                 ON CONFLICT (org_id, topic, dedupe_key) DO NOTHING`,
                [
                  row.org_id,
                  row.asset_id,
                  row.id,
                  {
                    asset_id: row.asset_id,
                    ...(requestId ? { request_id: requestId } : {}),
                    session_id: row.id,
                  },
                ],
              );
              yield* completeIdempotencyEffect(
                client,
                row.org_id,
                "completeUploadSession",
                idempotencyKey,
                202,
                { asset_id: row.asset_id },
              );
              return {
                asset: mapAsset(assetResult.rows[0]!),
                error: null,
                replayed: false,
                retryable: false,
              };
            }),
          );
          if (outcome.retryable) {
            yield* withSystemTransactionEffect(env, (client) =>
              client.query(
                `DELETE FROM idempotency_keys
               WHERE org_id = $1
                 AND operation = 'completeUploadSession'
                 AND idempotency_key = $2`,
                [preparation.row.org_id, idempotencyKey],
              ),
            );
          }
          if (outcome.error) {
            return yield* Effect.fail(outcome.error);
          }
          return { replayed: outcome.replayed, value: outcome.asset };
        }),
      );
    },

    /**
     * Cancels an in-progress upload session via Effect, releasing reserved quotas and cleaning storage.
     *
     * Aborts R2 multipart uploads or deletes a partially written single object,
     * marks the session `'aborted'`, transfers the quota reservation onto any
     * landed staging object, and moves that `asset_objects` row to `'deleting'`.
     * The writer hold afterwards depends on what the external cleanup proved:
     * a confirmed multipart abort ends every part grant at once, so
     * `write_hold_until` closes immediately; a single PUT cannot revoke an
     * already-signed URL, and an abort whose outcome is unknown cannot prove
     * the uploadId dead, so both keep the last grant deadline minted and
     * recorded under the session lock — the real writer window rather than
     * the 24-hour session expiry. Marking the row durably is what makes the
     * cleanup replayable: the sweep reclaims the bytes and releases their
     * accounting exactly once even if this worker dies between committing and
     * issuing the remote delete, so a cancelled upload cannot leak storage.
     * The reservation is transferred rather than dropped, so a staged object
     * that physically exists stays charged until it is actually deleted and
     * cannot let a concurrent upload oversubscribe Entitlements. Cancelling is
     * not a deletion: no delete claim is taken, the Asset fails as retryable
     * with the reason its upload ended whether or not a Post retains it, and
     * only an unretained Asset starts the seven-day orphan clock. Remote cleanup
     * is best-effort so infrastructure failures cannot strand quota or logical
     * cancellation.
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param sessionId - Upload session ID to cancel.
     * @param idempotencyKey - Client-provided idempotency key.
     * @returns Effect resolving to object indicating whether the operation was replayed.
     */
    abortUploadSession(env, session, sessionId, idempotencyKey) {
      return withStorage(
        env,
        Effect.gen(function* () {
          const requestHash = yield* hashIdempotencyRequestEffect(sessionId);
          const preparation = yield* withTenantTransactionEffect(env, session, (client) =>
            Effect.gen(function* () {
              const row = yield* getSessionRowEffect(client, sessionId, true);
              const replay = yield* reserveIdempotencyEffect(
                client,
                row.org_id,
                "abortUploadSession",
                idempotencyKey,
                requestHash,
              );
              if (replay) return { replayed: true as const };
              if (row.status === "completed" || row.status === "completing") {
                return yield* Effect.fail(
                  new CoreApiError(409, "invalid_state", "A completed upload cannot be aborted."),
                );
              }
              if (row.status === "aborted") {
                yield* completeIdempotencyEffect(
                  client,
                  row.org_id,
                  "abortUploadSession",
                  idempotencyKey,
                  204,
                  null,
                );
                return { replayed: true as const };
              }
              // The Asset row is locked but never claimed: cancelling an
              // upload must not move a saved Post's attachment into
              // 'deleting', whose reclamation the stuck-job sweep can arm
              // for a deletion nobody asked for. The lock still serializes
              // against a concurrent completion, which is what decides this
              // session's fate.
              yield* getAssetRowEffect(client, row.asset_id, { lock: true });
              return { replayed: false as const, row };
            }),
          );
          if (preparation.replayed) return { replayed: true };

          const storage = yield* StorageService;
          let writersClosed = false;
          if (preparation.row.strategy === "multipart" && preparation.row.multipart_upload_id) {
            writersClosed = yield* storage
              .resumeMultipartUpload(
                preparation.row.object_key,
                preparation.row.multipart_upload_id,
              )
              .pipe(
                Effect.flatMap((upload) => upload.abort()),
                Effect.as(true),
                // A missing signer stays a hard configuration failure while
                // every other abort failure is ambiguous: the uploadId may
                // still accept parts, so the recorded grant deadline must
                // stand and the sweep retains the charge until it lapses.
                Effect.catch((cause) =>
                  cause instanceof StorageConfigurationError
                    ? Effect.fail(cause)
                    : Effect.succeed(false),
                ),
              );
          } else {
            // A single PUT URL cannot be revoked by deleting the object: the
            // grant stays live for its signed window either way, so the
            // recorded deadline is retained regardless of this call's outcome.
            yield* storage
              .delete(preparation.row.object_key)
              .pipe(
                Effect.catch((cause) =>
                  cause instanceof StorageConfigurationError ? Effect.fail(cause) : Effect.void,
                ),
              );
          }

          return yield* withTenantTransactionEffect(env, session, (client) =>
            Effect.gen(function* () {
              const row = yield* getSessionRowEffect(client, sessionId, true);
              if (row.status !== "aborted") {
                yield* client.query(
                  `UPDATE asset_upload_sessions
                   SET status = 'aborted', aborted_at = now(), updated_at = now()
                   WHERE id = $1`,
                  [row.id],
                );
                // Hand the session's reserved bytes to the staged object and
                // release the reservation in one statement. Releasing first
                // would briefly unaccount bytes that physically exist, letting a
                // concurrent upload pass the limit check and oversubscribe.
                yield* releaseReservationToStagingEffect(client, row.id, row.asset_id);
                // Bytes already landed under the staging key (a cancelled
                // single upload, or a multipart whose parts were already
                // committed) are handed to the maintenance sweep by durable
                // state, so a crash between this commit and the remote delete
                // cannot strand them. A confirmed multipart abort kills every
                // part grant at once, so the writer hold closes now and the
                // staged bytes reclaim without waiting out a grant window. A
                // single PUT is different: cancelling cannot revoke a URL
                // that was already signed, so the recorded grant deadline
                // stands — as it does for a multipart abort whose outcome
                // could not be confirmed. The accounting release happens in
                // the sweep exactly once, on the deleting→deleted transition.
                yield* markStagedObjectDeletingEffect(client, row.asset_id, {
                  writersClosed,
                });
                // Cancelling ends the upload, not the Asset a creator may
                // still own: it becomes durably failed with the reason,
                // whether or not a Post retains it, and only an unretained
                // Asset starts the seven-day orphan clock. What the sweep
                // reclaims is the abandoned upload's staged bytes, which were
                // handed over above.
                yield* client.query(
                  `UPDATE assets
                   SET status = 'failed',
                       failure_code = 'upload_aborted',
                       failure_message = 'The upload was cancelled.',
                       failure_retryable = true,
                       failure_at = now(),
                       orphaned_at = CASE
                         WHEN EXISTS (
                           SELECT 1
                             FROM post_attachments
                            WHERE asset_id = $1
                         ) THEN NULL
                         ELSE now()
                       END,
                       orphan_delete_after = CASE
                         WHEN EXISTS (
                           SELECT 1
                             FROM post_attachments
                            WHERE asset_id = $1
                         ) THEN NULL
                         ELSE now() + make_interval(days => $2)
                       END,
                       updated_at = now()
                   WHERE id = $1
                     AND status IN ('pending_upload', 'uploading')`,
                  [row.asset_id, orphanGraceDays],
                );
              }
              yield* completeIdempotencyEffect(
                client,
                row.org_id,
                "abortUploadSession",
                idempotencyKey,
                204,
                null,
              );
              return { replayed: false };
            }),
          );
        }),
      );
    },

    /**
     * Generates a presigned GET URL for downloading ready media assets with Content-Disposition via Effect.
     *
     * Delegates the common ready-media validation and signing path while selecting
     * the asset's original filename to force browser download.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param assetId - Unique identifier of the ready media asset.
     * @returns Effect resolving to presigned download URL and expiration timestamp.
     */
    getAssetDownloadUrl(env, session, assetId) {
      return withStorage(env, signReadyMediaAssetUrlEffect(env, session, assetId, true));
    },

    /**
     * Generates a presigned GET URL for inline browser previewing of ready media assets via Effect.
     *
     * Delegates the common ready-media validation and signing path without a
     * content-disposition filename, preserving inline browser rendering.
     *
     * @param env - Worker environment bindings.
     * @param session - Authenticated user session claims.
     * @param assetId - Unique identifier of the ready media asset.
     * @returns Effect resolving to presigned preview URL and expiration timestamp.
     */
    getAssetPreviewUrl(env, session, assetId) {
      return withStorage(env, signReadyMediaAssetUrlEffect(env, session, assetId, false));
    },
  };
  return service;
}
