// Durable media processing for one Asset (issue #284).
//
// This module is the internal implementation behind the Asset queue processor.
// It extends the existing Asset lifecycle; it is not a second upload path. The
// outer processor owns the `async_job_events` lease, so every phase here is
// safe to abandon and re-enter: durability comes from committed state, never
// from an in-memory hold between invocations.
//
// Ordering contract (issue #284 decisions 8/10/13/14):
//   1. verify the staged source identity (ETag + checksum pinned at finalize),
//   2. reserve capacity for the protected original and commit its inventory
//      row BEFORE copying it there, then verify the copy and settle that row,
//   3. reserve output capacity against resident bytes plus live upload
//      reservations under the org lock, and commit the deterministic staging
//      inventory row BEFORE any external write,
//   4. run the native FFmpeg/libvips engine through two single-object grants: a
//      read on the protected original and a create-only write on an inventoried
//      staging-processing key,
//   5. re-read the produced object, compare real size/MIME and prove a stored
//      content digest (reported sha256, else the PUT-recorded ETag) against
//      the engine's decoded verdict, then reserve capacity for the protected
//      rendition key BEFORE copying it there,
//   6. commit the rendition reference, and only then retire staging.
//
// Capacity-before-copy is the load-bearing ordering rule, applied twice. Each
// protected copy is a new physical object that exists alongside the object it
// was copied from, so reserving only for the destination would charge one
// key's worth of headroom for two keys' worth of bytes, and two concurrent
// attempts would each see the same headroom and both copy. Every protected key
// is therefore inventoried and reserved, with its writer hold, in the same
// locked transaction that measured headroom — before the external copy runs.
//
// Frozen-byte invariant: the engine's capability can only ever write the
// staging-processing key, never a publish-ready key, and only as a create-only
// write whose `If-None-Match: *` is part of the SigV4 signature. A delayed
// duplicate or lost-lease job holding a leaked URL is therefore rejected by
// object storage itself, not merely by database state.
//
// Crash recovery is deterministic because every key is a pure function of
// (organization, asset, profile):
//   - staging row with no recorded digest -> unverified bytes: delete and
//     recompute;
//   - staging row with a recorded digest  -> adopt the object and promote it,
//     or finish an already-promoted ready key;
//   - pending protected row (`writing`, no bytes) -> the copy it owns is still
//     charged: adopt the row, re-read the destination, and finish from there
//     rather than reserving the same key a second time;
//   - ready row committed                 -> verify and finish cleanup.
// Accounting settles exactly once because leaving 'writing' is the single
// charge-once point, and a staging row stays charged until its external delete
// is acknowledged. A copy whose outcome is never observed stays charged as a
// pending row rather than becoming untracked bytes.
import { Effect, Result } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  ASSET_UPLOAD_POLICY,
  assetOrphanGraceSeconds,
  type DatabaseError,
  COMMUNITY_LIMITS,
  mediaUploadMaximum,
} from "@meltiply/domain";
import { readyObjectKey, type ObjectStore } from "@meltiply/storage";
import {
  PROCESSOR_CAPABILITY_TTL_SECONDS,
  NativeProcessorError,
  invokeNativeProcessorEffect,
  processorJobUrlsEffect,
  type NativeProcessorProfile,
} from "./native-processor";
import { settleDeletedObjects } from "./assets";

import { withSystemTransactionEffect } from "./database";
import {
  classifyJobError,
  RetryableJobError,
  TerminalJobError,
  type AutomationJobError,
} from "./effect/index";
import type { AutomationEnv } from "./env";
// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * Still-image rendition profile. `allowed_content_types` is ordered by
 * publishing preference and the engine honours that order ahead of byte size:
 * JPEG first because every publishing Platform accepts it for opaque stills
 * (the engine never flattens an alpha source into JPEG); PNG second because it
 * is the only publishable format that keeps real transparency; WebP last
 * because it preserves animation but Instagram and Threads cannot take it, so
 * it may only ever win for an animated source where it is the sole candidate.
 * Without this ordering a smallest-bytes selection could hand back a WebP
 * still that is structurally unpublishable on Instagram.
 *
 * The 4096 bound matches the widest documented Platform acceptance (TikTok
 * rejects anything above 4096) and never upscales a smaller source.
 */
const imageProfile: NativeProcessorProfile = {
  allowed_content_types: ["image/jpeg", "image/png", "image/webp"],
  effort: 4,
  kind: "image",
  max_duration_seconds: null,
  max_height: 4096,
  max_width: 4096,
  name: "image_auto_4096_long_edge",
  quality: 82,
};

/**
 * Video rendition profile. Every publishing Platform accepts `video/mp4`, and
 * normalizing MOV/QuickTime into MP4 with H.264 video and AAC audio is what
 * makes a QuickTime upload deliverable at all.
 *
 * `max_duration_seconds` is deliberately null: the engine must never drop frames
 * to fit a Platform limit. Duration is a publication-time validation concern
 * (`packages/providers/src/validator.ts`), not a processing concern, because
 * shortening is a silent content edit.
 */
const videoProfile: NativeProcessorProfile = {
  allowed_content_types: ["video/mp4"],
  effort: 4,
  kind: "video",
  max_duration_seconds: null,
  max_height: 1080,
  max_width: 1920,
  name: "video_h264_aac_1920x1080",
  quality: 23,
};

/**
 * Orphan grace period applied when a permanently failed Asset has no Post
 * attachment retaining it, matching the API's upload-finalization policy so a
 * failed upload and a failed processing run age out on the same seven-day
 * clock (issue #284 decision 11).
 *
 * Derived from the canonical `assetOrphanGraceSeconds` rather than restated, so
 * this module, the API's upload finalization, and the lifecycle maintenance
 * pass cannot drift into three different grace periods for one policy.
 */
const orphanGraceDays = assetOrphanGraceSeconds / (24 * 60 * 60);

/**
 * Wall-clock budget requested for one engine job. It sits below the
 * capability lifetime the native-processor adapter mints, so a job can never
 * outlive the two URLs it was granted, and the engine's own 540s ceiling
 * clamps it further.
 */
const processorJobDeadlineSeconds = PROCESSOR_CAPABILITY_TTL_SECONDS - 60;

/**
 * Window during which a superseded processing staging row must stay
 * inventoried and charged, taken straight from the adapter's capability
 * lifetime so the two can never drift apart.
 *
 * A late engine PUT can still recreate the bytes it was granted, so that row is
 * only eligible for deletion once its persisted hold has passed. The deadline
 * is written before the capability is minted rather than derived at sweep time,
 * so a crashed, retried, or delayed attempt can never shorten it.
 */
const processorCapabilityTtlSeconds = PROCESSOR_CAPABILITY_TTL_SECONDS;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface AssetProcessingRow extends Record<string, unknown> {
  asset_type: string;
  brand_profile_id: string;
  file_size: number | string | null;
  id: string;
  mime_type: string | null;
  org_id: string;
  source_etag: string | null;
  source_sha256: string | null;
  status: string;
}

interface ObjectRow extends Record<string, unknown> {
  bytes: number | string | null;
  content_type: string | null;
  duration_sec: number | string | null;
  etag: string | null;
  height: number | null;
  id: string;
  r2_key: string;
  reserved_bytes: number | string | null;
  sha256: string | null;
  status: string;
  width: number | null;
}

/** Protected source bytes the engine is allowed to read. */
interface ProcessingSource {
  bytes: number;
  contentType: string;
  key: string;
  objectId: string;
}

/** Durable per-profile bookkeeping committed before any external write. */
interface ProfileReservation {
  /** Bytes currently charged against the workspace Entitlement. */
  charged: number;
  objectId: string;
  profile: string;
  /** Protected destination the rendition occupies once promoted. */
  readyKey: string;
  renditionId: string;
  /** Inventoried staging key the engine writes; never publish-ready. */
  stagingKey: string;
  /**
   * Persisted deadline until which a writer could still recreate this row's
   * bytes, as recorded by the same transaction that created the reservation.
   * The output capability is minted to expire no later than this instant, so a
   * grant can never outlive the hold that keeps the bytes accounted for.
   */
  writeHoldUntil: number;
}

/**
 * Verified facts about a produced rendition, as recorded durably before any
 * promotion. Reconstructing this from a stored row is what lets an interrupted
 * run be adopted instead of recomputed.
 */
interface ProcessedOutput {
  bytes: number;
  contentType: string;
  durationSeconds: number | null;
  /** Stored object's ETag (a content-derived digest on R2) read back after write. */
  etag: string | null;
  height: number | null;
  sha256: string | null;
  width: number | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes a failed or thrown value to Error so the module's internal failure
 * channel stays typed as Error while `classifyJobError` at the boundary can
 * still read a meaningful `name`.
 *
 * @param cause - Value thrown or failed by a leaf adapter.
 * @returns The cause unchanged when already an Error, else a wrapped Error.
 */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Maps a native-processor adapter failure onto the job error taxonomy on its
 * declared retry semantics.
 *
 * The adapter deliberately answers retryable for transport and engine-busy
 * outcomes and non-retryable for `invalid_request`, `unsupported_media`,
 * `corrupt_media`, and similar verdicts. `classifyJobError` alone cannot see
 * this — it would treat every unrecognized Error as retryable and redeliver a
 * permanently-corrupt upload forever — so the boundary is drawn here.
 *
 * @param cause - Failure raised by the native-processor adapter.
 * @returns `TerminalJobError` for non-retryable verdicts, `RetryableJobError`
 *   otherwise, with the adapter's code and actionable message preserved.
 */
function asJobError(cause: unknown): RetryableJobError | TerminalJobError {
  if (cause instanceof NativeProcessorError) {
    return cause.retryable
      ? new RetryableJobError({ cause: cause.code, message: cause.message })
      : new TerminalJobError({ code: cause.code, message: cause.message });
  }
  return new RetryableJobError({
    cause: cause instanceof Error ? cause.name : "processor_error",
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

/**
 * Reads a BIGINT/INT column as a JS number.
 *
 * Storage accounting is compared against byte ceilings far below
 * `Number.MAX_SAFE_INTEGER`, so parsing at this boundary is safe and avoids
 * depending on a driver-specific bigint cast.
 *
 * @param value - Raw column value (bigint, number, or numeric string).
 * @returns The value as a non-negative integer, or 0 when null or unusable.
 */
function bytesOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Maps an Asset row onto the single processing profile it requires.
 *
 * One profile per Asset rather than one per Platform keeps rendition identity
 * deterministic while still producing an object every supported Platform can
 * accept, because the profile's allowed output types are the intersection of
 * the Platform capabilities. A Platform that needs a narrower type is handled at
 * publication validation rather than by multiplying stored copies.
 *
 * @param asset - Asset row being processed.
 * @returns The single profile required for this Asset.
 * @throws {TerminalJobError} When the Asset type cannot be processed at all.
 */
function profileForAsset(asset: AssetProcessingRow): NativeProcessorProfile {
  if (asset.asset_type === "video") return videoProfile;
  if (asset.asset_type === "image") return imageProfile;
  throw new TerminalJobError({
    code: "unsupported_asset_type",
    message: `Media of type "${asset.asset_type}" cannot be processed.`,
  });
}

/**
 * Builds the inventoried key the engine writes before promotion.
 *
 * The `staging/` prefix keeps the bucket lifecycle backstop covering a crashed
 * attempt, and the shape makes the key structurally undeliverable: the
 * provider-media signer requires segment 2 to be the Asset id, which a staging
 * key never satisfies.
 *
 * @param organizationId - Owning organization UUID.
 * @param assetId - Asset UUID.
 * @param profile - Rendition profile name.
 * @returns `staging/<orgId>/<assetId>/processing-<profile>`.
 */
function processingStagingKey(organizationId: string, assetId: string, profile: string): string {
  return `staging/${readyObjectKey(organizationId, assetId, `processing-${profile}`)}`;
}

/**
 * Builds the protected publish-ready key a rendition occupies once committed.
 *
 * Determinism is what makes replay adoptable and duplicate delivery harmless:
 * two attempts for the same (asset, profile) resolve to one key, so a second
 * attempt can never create a second retained copy.
 *
 * @param organizationId - Owning organization UUID.
 * @param assetId - Asset UUID.
 * @param profile - Rendition profile name.
 * @returns `<orgId>/<assetId>/rendition-<profile>`.
 */
function renditionReadyKey(organizationId: string, assetId: string, profile: string): string {
  return readyObjectKey(organizationId, assetId, `rendition-${profile}`);
}

/**
 * Re-reads an object's real metadata and checks it against the expected
 * identity.
 *
 * Row metadata is never treated as proof that bytes exist: every external object
 * is confirmed with a live HEAD before it is trusted, inventoried, or promoted.
 *
 * @param objectStore - Object store to read from.
 * @param key - Object key to verify.
 * @param expected - Byte length and content type the object must present.
 * @returns The verified live metadata.
 * @throws {TerminalJobError} When the object is absent or its identity differs.
 */
function verifyObject(
  objectStore: ObjectStore,
  key: string,
  expected: { bytes: number; contentType: string },
): Effect.Effect<
  { etag: string | null; sha256: string | null },
  RetryableJobError | TerminalJobError
> {
  return Effect.gen(function* () {
    const live = yield* Effect.tryPromise({
      catch: () =>
        new RetryableJobError({
          cause: "head_failed",
          message: "Object storage did not answer the verification read.",
        }),
      try: () => objectStore.head(key),
    });
    if (!live) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "stored_object_missing",
          message: "The stored media could not be found. Upload the file again.",
        }),
      );
    }
    if (live.size !== expected.bytes) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "stored_object_mismatch",
          message: "The stored media no longer matches the verified size. Upload the file again.",
        }),
      );
    }
    if (live.contentType?.toLowerCase() !== expected.contentType.toLowerCase()) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "stored_object_mismatch",
          message:
            "The stored media no longer matches the verified media type. Upload the file again.",
        }),
      );
    }
    return { etag: live.etag ?? null, sha256: live.sha256 ?? null };
  });
}

/**
 * Deletes an object and reports whether the key is now believed absent.
 *
 * A failed delete is deliberately not fatal: the caller either verifies the
 * object again or lets the maintenance sweep reclaim it, and treating a delete
 * failure as fatal would strand otherwise-committed work.
 *
 * @param objectStore - Object store to delete from.
 * @param key - Object key to remove.
 * @returns Effect resolving to true when the key is absent or was deleted.
 */
function deleteObject(objectStore: ObjectStore, key: string): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const present = yield* Effect.match(
      Effect.tryPromise({ catch: asError, try: () => objectStore.head(key) }),
      { onFailure: () => true, onSuccess: (object) => object !== null },
    );
    if (!present) return true;
    return yield* Effect.match(
      Effect.tryPromise({ catch: asError, try: () => objectStore.delete(key) }),
      { onFailure: () => false, onSuccess: () => true },
    );
  });
}

// ---------------------------------------------------------------------------
// Phase 1 + 2: source verification and conditional promotion
// ---------------------------------------------------------------------------

/**
 * Authoritative charged-bytes formula for one organization, as a single
 * parameterless subquery pair so every reservation site sums identically.
 *
 * Both halves are required. `asset_objects` holds every inventoried byte and
 * every reservation already transferred onto a row; `asset_quota_reservations`
 * holds bytes an upload session has promised but has not finalized into an
 * object row yet. A pending upload is capacity this workspace already holds a
 * promise on, so a reservation that ignored it would grant the same bytes
 * twice — once to the in-flight upload and once to the processing run — and
 * the over-subscription would only surface after reconciliation corrected the
 * counter. This is the same `storage_bytes + active_reservation_bytes` pair the
 * API's upload cap uses, so both sides refuse work at the same boundary.
 */
const chargedCapacitySql = `SELECT
         (SELECT COALESCE(SUM(GREATEST(COALESCE(object.bytes, 0),
                                     COALESCE(object.reserved_bytes, 0))), 0)
            FROM asset_objects AS object
           WHERE object.org_id = $1
             AND object.status <> 'deleted') AS resident_bytes,
         (SELECT COALESCE(SUM(reservation.bytes), 0)
            FROM asset_quota_reservations AS reservation
           WHERE reservation.org_id = $1
             AND reservation.state = 'reserved') AS reserved_bytes`;

/**
 * Workspace capacity measured while the organization row is locked.
 *
 * `ceiling` may be `null` for an unbounded resource policy, so the caller compares
 * against `charged` rather than pre-computing headroom: an unlimited workspace
 * must still refuse a reservation of zero bytes.
 */
interface CapacityWindow {
  /** Bytes currently charged to the workspace, or `null` when unlimited. */
  ceiling: number | null;
  charged: number;
}

/**
 * Locks the organization row and returns its authoritative charged total and
 * Entitlement ceiling.
 *
 * Holding `FOR UPDATE` across the charge sum and the caller's insert is what
 * makes a reservation exclusive: concurrent processing runs and concurrent
 * upload sessions serialize here, so neither can observe headroom the other is
 * about to consume. The locked owner must still exist before capacity is granted.
 *
 * @param client - Transaction client, already scoped to the system role.
 * @param organizationId - Organization whose capacity is being measured.
 * @returns The charged total and the ceiling, or a terminal failure when the
 *   workspace no longer exists.
 * @throws {TerminalJobError} When the organization row is gone, or when the
 *   owner or charge read fails; a failed read cannot be treated as
 *   headroom, so it must stop the attempt rather than grant capacity.
 */
function lockCapacityWindow(
  client: EffectTransactionClient,
  organizationId: string,
): Effect.Effect<CapacityWindow, TerminalJobError> {
  return Effect.gen(function* () {
    // A failed read is not headroom: the attempt stops rather than granting
    // capacity it could not measure.
    const capacityReadFailed = () =>
      new TerminalJobError({
        code: "capacity_read_failed",
        message: "This workspace's storage usage could not be confirmed. Try again.",
      });
    const organization = yield* client
      .query<{ id: string }>(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [organizationId],
      )
      .pipe(Effect.mapError(capacityReadFailed));
    if (!organization.rows[0]) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "organization_missing",
          message: "The owning workspace is no longer available.",
        }),
      );
    }
    const charged = yield* client
      .query<{
        reserved_bytes: string;
        resident_bytes: string;
      }>(chargedCapacitySql, [organizationId])
      .pipe(Effect.mapError(capacityReadFailed));
    const row = charged.rows[0];
    return {
      ceiling: COMMUNITY_LIMITS.max_storage_bytes,
      charged: bytesOf(row?.resident_bytes) + bytesOf(row?.reserved_bytes),
    } satisfies CapacityWindow;
  });
}

/**
 * Reserves the capacity for one new physical object before it is copied.
 *
 * A conditional copy into a protected key creates a second physical object
 * while the source it copies from is still present, so the workspace is
 * momentarily charged for both. Reserving only for the destination would let
 * two concurrent promotions each observe the same headroom and both copy,
 * oversubscribing the Entitlement by the size of every in-flight source.
 * This function therefore writes the destination's inventory row — with its
 * reservation and its writer hold — in the same locked transaction that
 * measured headroom, and the caller performs the external copy only after this
 * has committed.
 *
 * The row is `writing` with `bytes IS NULL` until the copy is observed and
 * verified. That is the "copy in flight" checkpoint: a crash between the copy
 * and the commit leaves a charged, accounted row that the next attempt adopts
 * instead of reserving the same key twice, and a copy whose outcome is unknown
 * is still charged rather than becoming untracked bytes.
 *
 * `profile` is deliberately `null` for a rendition destination. The
 * `idx_asset_objects_live_rendition_profile` index admits one live row per
 * (asset, profile), and the profile's own staging row still holds that slot
 * while this copy is pending; the profile is stamped on the row only when the
 * staging row leaves `writing` in the committing transaction.
 *
 * @param env - Automation worker environment bindings.
 * @param asset - Asset whose protected key is being reserved.
 * @param destination - Deterministic key, kind, optional profile, and the
 *   exact byte count the copy can produce. A copy cannot grow its source, so
 *   the measured size is a bound, not an estimate.
 * @returns The inventory row id owning the pending copy. Adoption of a row a
 *   previous attempt left pending is indistinguishable to the caller: both the
 *   fresh insert and the re-armed existing row return the same id, and both are
 *   charged before the copy runs.
 * @throws {TerminalJobError} When the workspace has no headroom for the copy,
 *   or when the Asset is no longer being processed.
 */
function reserveProtectedCopy(
  env: AutomationEnv,
  asset: AssetProcessingRow,
  destination: {
    key: string;
    kind: "original" | "rendition";
    /**
     * Bytes to release from an existing pending row in the SAME transaction
     * that reserves this destination, because that row's content is provably
     * settled and can never grow again. Null when nothing is being released.
     *
     * This is what lets a verified staging output settle onto its real size
     * before its protected copy is charged. Both bytes are physically on the
     * bucket at once, so the honest demand for the copy is only the destination
     * itself, not the destination plus a reservation the staging key can no
     * longer use.
     */
    releaseFrom?: {
      /** Verified real byte count to settle onto the row. */
      bytes: number;
      /** Reservation the row must still be holding for the settle to apply. */
      expectedReservedBytes: number;
      objectId: string;
    } | null;
    /**
     * A ready original row to supersede in the same transaction, so its copy
     * onto this destination is never blocked by the one-live-original index.
     * The hold is set to `now() + holdSeconds` — long enough that the legacy
     * grant written at upload-finalization cannot outlive the row's record of
     * the bytes it could still write.
     */
    supersede?: {
      holdSeconds: number;
      objectId: string;
    } | null;
    profile: string | null;
    reservedBytes: number;
  },
): Effect.Effect<{ objectId: string }, Error> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      // The Asset row lock serializes promotion against a concurrent deletion
      // claim and re-checks that this attempt is still the one that owns the
      // work. Without it a retry racing a reclaim could reserve capacity for an
      // Asset that is already gone.
      const current = yield* client.query<{ status: string }>(
        `SELECT status FROM assets WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [asset.id, asset.org_id],
      );
      if (current.rows[0]?.status !== "processing") {
        return yield* Effect.fail(
          new RetryableJobError({
            cause: "asset_no_longer_processing",
            message:
              "This upload is no longer being processed; the attempt will re-check and stop.",
          }),
        );
      }
      const window = yield* lockCapacityWindow(client, asset.org_id);
      // A `releaseFrom` row is a source this same attempt already verified and
      // can no longer grow: the engine's create-only grant wrote the staging
      // bytes and nothing can reopen them, so the row's reservation can be
      // exchanged for its real bytes in the same locked transaction that
      // measures and spends the destination's capacity. Settling it here is
      // what makes the copy's honest cost `2 * B` (staging real bytes plus the
      // protected copy) rather than `reservation + B`.
      // The exchange only drops the surplus reservation: `recordVerifiedOutput`
      // already wrote the measured `bytes`, so `bytes = measured` is the guard
      // that proves the content is what was verified, and
      // `reserved_bytes IS NOT DISTINCT FROM $3` leaves a row a concurrent
      // attempt re-armed alone rather than charged against a reservation this
      // attempt does not recognize. A row that fails those guards is not a
      // permission to double-charge, so it is adopted or refused below.
      let releasedBytes = 0;
      if (destination.releaseFrom) {
        const released = yield* client.query<{ id: string }>(
          `UPDATE asset_objects
           SET reserved_bytes = NULL, updated_at = now()
           WHERE id = $1
             AND status = 'writing'
             AND bytes = $2
             AND reserved_bytes IS NOT DISTINCT FROM $3
           RETURNING id`,
          [
            destination.releaseFrom.objectId,
            destination.releaseFrom.bytes,
            destination.releaseFrom.expectedReservedBytes,
          ],
        );
        if (!released.rows[0]) {
          // A previous attempt that already exchanged this reservation leaves
          // the measured bytes in place with `reserved_bytes` NULL. That is
          // adopted — the workspace is already charged the accurate amount —
          // rather than failing, because retrying can never make the guarded
          // update match again. Any other state is a genuine conflict and must
          // not silently charge both a reservation and real bytes.
          const sourceRow = (yield* client.query<{
            bytes: number | string | null;
            reserved_bytes: number | string | null;
            status: string;
          }>(
            `SELECT bytes, reserved_bytes, status
               FROM asset_objects WHERE id = $1`,
            [destination.releaseFrom.objectId],
          )).rows[0];
          const alreadySettled =
            sourceRow?.status === "writing" &&
            sourceRow.reserved_bytes === null &&
            bytesOf(sourceRow.bytes) === destination.releaseFrom.bytes;
          if (!alreadySettled) {
            return yield* Effect.fail(
              new TerminalJobError({
                code: "output_reservation_conflict",
                message:
                  "The staged output's reservation changed underneath this attempt. Try again.",
              }),
            );
          }
        } else {
          // Only the surplus is freed: the row still physically holds `bytes`,
          // so `expectedReservedBytes - bytes` is what moves from reserved to
          // real. Freeing the whole reservation would undercharge the copy by
          // exactly the bytes the staging object still carries.
          releasedBytes =
            destination.releaseFrom.expectedReservedBytes - destination.releaseFrom.bytes;
        }
      }
      // A legacy original being promoted onto this destination is superseded
      // here, inside the same locked transaction as the insert. The one-live
      // -original index would otherwise reject the canonical row while a legacy
      // 'ready' row still holds the (asset_id) slot, and superseding first lets
      // the pending-insert below create the destination without that conflict.
      // The superseded row keeps `bytes` but gains a write hold long enough to
      // outlive any public grant the legacy key was ever minted.
      if (destination.supersede) {
        const superseded = yield* client.query<{ id: string }>(
          `UPDATE asset_objects
           SET status = 'superseded',
               write_hold_until = GREATEST(
                 COALESCE(write_hold_until, now()),
                 now() + make_interval(secs => $2)
               ),
               updated_at = now()
           WHERE id = $1 AND status = 'ready'
           RETURNING id`,
          [destination.supersede.objectId, destination.supersede.holdSeconds],
        );
        if (!superseded.rows[0]) {
          return yield* Effect.fail(
            new TerminalJobError({
              code: "promotion_source_changed",
              message: "The stored original changed underneath this attempt. Try again.",
            }),
          );
        }
      }
      const pending = yield* client.query<{
        id: string;
        reserved_bytes: number | string | null;
      }>(
        `SELECT id, reserved_bytes
         FROM asset_objects
         WHERE asset_id = $1 AND r2_key = $2 AND status = 'writing'`,
        [asset.id, destination.key],
      );
      const existing = pending.rows[0];
      if (!existing) {
        // A copy of `reservedBytes` fits only when the workspace has that much
        // headroom left. `releasedBytes` is subtracted because it was charged
        // to this Asset's own staging row and is being exchanged for real bytes
        // in this same transaction, so the workspace is never charged twice for
        // the same physical bytes. Settling the staging reservation to `B`
        // frees `S - B`, so the copy needs only `B` more than what is already
        // free above the settled bytes: headroom >= 2 * output suffices, and
        // below that the attempt is refused rather than oversubscribing.
        const headroom =
          window.ceiling === null
            ? destination.reservedBytes
            : Math.max(0, window.ceiling - (window.charged - releasedBytes));
        if (headroom < destination.reservedBytes) {
          return yield* Effect.fail(
            new TerminalJobError({
              code: "storage_limit_reached",
              message:
                "Optimizing this file needs storage space that is not available. Remove other media and try again.",
            }),
          );
        }
        yield* client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, profile, r2_key,
              reserved_bytes, content_type, status, write_hold_until)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'writing',
                   now() + make_interval(secs => $9))
           ON CONFLICT DO NOTHING`,
          [
            asset.org_id,
            asset.id,
            asset.brand_profile_id,
            destination.kind,
            destination.profile,
            destination.key,
            destination.reservedBytes,
            asset.mime_type,
            processorCapabilityTtlSeconds,
          ],
        );
      }
      // The hold is (re-)armed here rather than trusted from a previous attempt.
      // A copy whose outcome is unknown can still land late, so the row that
      // owns the destination must not become reclaimable until this attempt's
      // own window has closed.
      const held = yield* client.query<{ id: string; write_hold_until: Date }>(
        `UPDATE asset_objects
         SET write_hold_until = GREATEST(
               COALESCE(write_hold_until, now()),
               now() + make_interval(secs => $2)
             ),
             updated_at = now()
         WHERE asset_id = $1 AND r2_key = $3 AND status = 'writing'
         RETURNING id, write_hold_until`,
        [asset.id, processorCapabilityTtlSeconds, destination.key],
      );
      const row = held.rows[0];
      if (!row) {
        return yield* Effect.fail(
          new Error("the reserved protected object could not be inventoried"),
        );
      }
      return { objectId: row.id };
    }),
  ).pipe(Effect.mapError(asError));
}

/**
 * Settles a pending protected copy once its destination has been observed.
 *
 * This is the single charge-once settle point for the destination: leaving
 * `writing` moves the row from its reservation onto the measured bytes in one
 * guarded update, so a replay cannot charge the same key twice and a crash
 * between the copy and here is recovered by `reserveProtectedCopy` adopting the
 * same row.
 *
 * The row is stamped with its profile here rather than at reservation time,
 * because the staging row still owns the live (asset, profile) slot until it
 * leaves `writing` in the same committing transaction.
 *
 * @param env - Automation worker environment bindings.
 * @param objectId - Inventory row owning the pending copy.
 * @param measured - The destination's real size, ETag, digest and media type,
 *   read back from storage rather than trusted from the copy's return value.
 * @param profile - Profile to stamp on the settled row, when it is a rendition.
 * @returns Effect resolving once the destination row is `ready`.
 * @throws {Error} When the pending row is no longer `writing`, which means a
 *   concurrent attempt already settled it.
 */
function settleProtectedCopy(
  env: AutomationEnv,
  objectId: string,
  measured: {
    bytes: number;
    contentType: string;
    etag: string | null;
    sha256: string | null;
  },
  profile: string | null,
): Effect.Effect<void, Error> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      const settled = yield* client.query<{ id: string }>(
        `UPDATE asset_objects
         SET status = 'ready',
             bytes = $2,
             reserved_bytes = NULL,
             etag = $3,
             sha256 = $4,
             content_type = $5,
             profile = COALESCE(profile, $6),
             updated_at = now()
         WHERE id = $1 AND status = 'writing'
         RETURNING id`,
        [objectId, measured.bytes, measured.etag, measured.sha256, measured.contentType, profile],
      );
      if (!settled.rows[0]) {
        return yield* Effect.fail(new Error("the pending protected copy was already settled"));
      }
    }),
  ).pipe(Effect.mapError(asError));
}

/**
 * Resolves a verified source, conditionally promoting writable staging or
 * migrated originals to the protected key. Pinned ETags/checksums prevent
 * source substitution; create-only copies allow crash recovery without overwrite.
 * Reserve inventory capacity and writer holds before copying, then settle
 * verified bytes. Promotion alone never approves publication: native decoding
 * must validate a rendition or explicitly accept a compatible original.
 */
function resolveSource(
  env: AutomationEnv,
  objectStore: ObjectStore,
  asset: AssetProcessingRow,
): Effect.Effect<ProcessingSource, Error> {
  return Effect.gen(function* () {
    const originalKey = readyObjectKey(asset.org_id, asset.id, "original");
    // Migrated originals may have no upload session; read them before staging.
    const committedOriginal = yield* withSystemTransactionEffect(env, (client) =>
      client
        .query<ObjectRow>(
          `SELECT id, r2_key, bytes, reserved_bytes, etag, sha256,
                  content_type, status
           FROM asset_objects
           WHERE asset_id = $1 AND kind = 'original' AND status = 'ready'
           ORDER BY created_at DESC
           LIMIT 1`,
          [asset.id],
        )
        .pipe(Effect.map((result) => result.rows[0])),
    ).pipe(Effect.mapError(asError));
    const staged = yield* withSystemTransactionEffect(env, (client) =>
      client
        .query<ObjectRow>(
          `SELECT id, r2_key, bytes, reserved_bytes, etag, sha256,
                  content_type, status
           FROM asset_objects
           WHERE asset_id = $1 AND kind = 'staging'
           ORDER BY created_at DESC
           LIMIT 1`,
          [asset.id],
        )
        .pipe(Effect.map((result) => result.rows[0])),
    ).pipe(Effect.mapError(asError));

    // Reverify canonical originals on replay; a missing digest is not a mismatch.
    if (committedOriginal && committedOriginal.r2_key === originalKey) {
      const expectedBytes = bytesOf(committedOriginal.bytes);
      const contentType = committedOriginal.content_type ?? staged?.content_type ?? asset.mime_type;
      if (expectedBytes === 0 || !contentType) {
        return yield* Effect.fail(
          new TerminalJobError({
            code: "promoted_source_missing",
            message: "The stored original for this upload is missing. Upload the file again.",
          }),
        );
      }
      const verified = yield* verifyObject(objectStore, originalKey, {
        bytes: expectedBytes,
        contentType,
      });
      const pinnedSha = staged?.sha256 ?? asset.source_sha256;
      if (pinnedSha && verified.sha256 && pinnedSha !== verified.sha256) {
        return yield* Effect.fail(
          new TerminalJobError({
            code: "source_checksum_changed",
            message:
              "The stored media's checksum changed after verification. Upload the file again.",
          }),
        );
      }
      return {
        bytes: expectedBytes,
        contentType,
        key: committedOriginal.r2_key,
        objectId: committedOriginal.id,
      };
    }

    // Prefer finalized staging, then migrated originals, then held crash remnants.
    const stagedBytes = bytesOf(staged?.bytes) || bytesOf(staged?.reserved_bytes);
    const stagedUsable =
      staged !== undefined &&
      (staged.status === "writing" || staged.status === "ready") &&
      stagedBytes > 0 &&
      staged.content_type !== null;
    const supersededSource = yield* withSystemTransactionEffect(env, (client) =>
      client
        .query<ObjectRow>(
          `SELECT id, r2_key, bytes, reserved_bytes, etag, sha256,
                  content_type, status
           FROM asset_objects
           WHERE asset_id = $1 AND kind = 'original' AND status = 'superseded'
             AND write_hold_until > now()
           ORDER BY created_at DESC
           LIMIT 1`,
          [asset.id],
        )
        .pipe(Effect.map((result) => result.rows[0])),
    ).pipe(Effect.mapError(asError));
    const sourceRow = stagedUsable ? staged : (committedOriginal ?? supersededSource);
    const sourceBytes = bytesOf(sourceRow?.bytes) || bytesOf(sourceRow?.reserved_bytes);
    if (!sourceRow || sourceBytes === 0 || !sourceRow.content_type) {
      return yield* Effect.fail(
        new TerminalJobError({
          code:
            staged === undefined || bytesOf(staged.bytes) + bytesOf(staged.reserved_bytes) === 0
              ? "staged_upload_unverified"
              : "promoted_source_missing",
          message: "The uploaded file is missing or was never verified. Upload the file again.",
        }),
      );
    }

    // Reverify live bytes before promotion, not just their inventory record.
    const sourceVerified = yield* verifyObject(objectStore, sourceRow.r2_key, {
      bytes: sourceBytes,
      contentType: sourceRow.content_type,
    });
    const pinnedSourceSha = sourceRow.sha256 ?? staged?.sha256 ?? asset.source_sha256;
    if (pinnedSourceSha && sourceVerified.sha256 && pinnedSourceSha !== sourceVerified.sha256) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "source_checksum_changed",
          message:
            "The uploaded file's checksum changed after verification. Upload the file again.",
        }),
      );
    }

    // Reserve the second object's full size before copying. Supersede migrated
    // originals under the same lock to satisfy the one-live-original index;
    // their writer hold covers every previously issued upload grant.
    const reserved = yield* reserveProtectedCopy(env, asset, {
      key: originalKey,
      kind: "original",
      profile: null,
      reservedBytes: sourceBytes,
      ...(committedOriginal && committedOriginal.r2_key !== originalKey
        ? {
            supersede: {
              holdSeconds:
                ASSET_UPLOAD_POLICY.sessionTtlSeconds + ASSET_UPLOAD_POLICY.signedUrlTtlSeconds,
              objectId: committedOriginal.id,
            },
          }
        : {}),
    });

    // Bound, never detached: R2ObjectStore.copyObject reads `this.bucket`, so a
    // bare method reference would throw at call time instead of failing as the
    // unsupported-storage case it actually is.
    const copy = objectStore.copyObject?.bind(objectStore);
    if (!copy) {
      return yield* Effect.fail(
        new RetryableJobError({
          cause: "copy_unsupported",
          message: "Object storage cannot promote the uploaded file.",
        }),
      );
    }

    const promoted =
      (yield* Effect.tryPromise({
        catch: asError,
        try: () =>
          copy(sourceRow.r2_key, originalKey, {
            // Guarded non-null above; the closure boundary hides that from the
            // type checker, so the invariant is restated rather than widened.
            contentType: sourceRow.content_type ?? undefined,
            ifDestinationAbsent: true,
            ifSourceEtagMatches: sourceRow.etag ?? asset.source_etag ?? undefined,
          }),
      })) ??
      (yield* Effect.tryPromise({
        catch: asError,
        try: () => objectStore.head(originalKey),
      }));
    if (!promoted) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "source_identity_changed",
          message:
            "The uploaded file no longer matches the bytes that were verified. Upload the file again.",
        }),
      );
    }
    const verified = yield* verifyObject(objectStore, originalKey, {
      bytes: sourceBytes,
      contentType: sourceRow.content_type,
    });
    // The checksum pinned at finalization is compared whenever object storage
    // exposes a digest for the promoted object. This is the last point at
    // which a mutated upload can be caught.
    if (pinnedSourceSha && verified.sha256 && pinnedSourceSha !== verified.sha256) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "source_checksum_changed",
          message:
            "The uploaded file's checksum changed after verification. Upload the file again.",
        }),
      );
    }

    // The destination row reserved before the copy is settled in place. Its
    // `bytes IS NULL` -> real-bytes transition under `status = 'writing'` is
    // the charge-once point for this key, and because the row already existed
    // a replay after a crash between copy and settle re-settles the same row
    // instead of inserting a second inventory entry for the same key.
    //
    // This row may have been left pending by a previous attempt whose copy
    // already landed, so the destination is read back (`promoted` above falls
    // through to a HEAD whenever the create-only copy declines) rather than
    // assumed to be fresh.
    yield* settleProtectedCopy(
      env,
      reserved.objectId,
      {
        bytes: sourceBytes,
        contentType: sourceRow.content_type,
        etag: promoted.etag ?? verified.etag,
        sha256: pinnedSourceSha ?? verified.sha256,
      },
      null,
    );
    yield* withSystemTransactionEffect(env, (client) =>
      client.query(
        `UPDATE assets
         SET promoted_at = COALESCE(promoted_at, now()), updated_at = now()
         WHERE id = $1`,
        [asset.id],
      ),
    ).pipe(Effect.mapError(asError));

    // No `asset_renditions` row is written here. The original is verified and
    // protected at this point, but it has not been decoded: approval as a
    // publishable rendition belongs to the engine's `original_compatible`
    // verdict (or to a committed optimized output). Inserting a ready
    // rendition reference at promotion time would make a corrupt or truncated
    // upload readable through the API's ready-media query before anything ever
    // inspected the media.
    const objectId = reserved.objectId;

    return {
      bytes: sourceBytes,
      contentType: sourceRow.content_type,
      key: originalKey,
      objectId,
    } satisfies ProcessingSource;
  });
}

// ---------------------------------------------------------------------------
// Phase 3: capacity reservation and durable inventory
// ---------------------------------------------------------------------------

/**
 * Reserves real output capacity and commits the deterministic inventory rows a
 * rendition needs, before any external write.
 *
 * The organization's row is locked for the whole check, which is what stops
 * concurrent processing and concurrent uploads from oversubscribing the
 * Entitlement between them. The charged total is the one
 * `chargedCapacitySql` computes and the API's upload cap uses: inventoried
 * bytes plus every live `asset_quota_reservations` promise. A pending upload
 * is capacity the workspace already holds a claim on, so a reservation that
 * omitted it would grant the same bytes twice — once to the in-flight upload
 * and once to this compute — and the over-subscription would only surface
 * after reconciliation corrected the counter.
 *
 * Per inventoried row the charge is `GREATEST(bytes, reserved_bytes)`, never
 * their sum: one physical key cannot hold its old and replacement bytes at
 * once, so an interrupted attempt that recorded measured output while still
 * holding its planned reservation is charged the larger of the two exactly
 * once. This is the same expression `settleDeletedObjects` releases through, so
 * a charge is never created at one magnitude and released at another.
 *
 * Reservation size is the per-media upload ceiling, capped by the remaining
 * Entitlement headroom. Reserving the ceiling guarantees the compute cannot
 * fail for capacity once started — normalization can legitimately produce a
 * larger object than an opaque source — and capping at headroom keeps a large
 * upload from being refused outright when a smaller reservation would still let
 * the engine produce a compliant object.
 *
 * This reservation covers the engine's own staging write only. The protected
 * copy of that output is a second physical object and is reserved separately,
 * by `reserveProtectedCopy`, immediately before it is copied — never folded
 * into this single-key reservation.
 *
 * @param env - Automation worker environment bindings.
 * @param asset - Asset row being processed.
 * @param profile - The single profile required for this Asset.
 * @returns The reservation for this Asset's single profile.
 * @throws {TerminalJobError} When no output capacity can be reserved.
 */
function reserveOutputs(
  env: AutomationEnv,
  asset: AssetProcessingRow,
  profile: NativeProcessorProfile,
): Effect.Effect<ProfileReservation, Error> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      const window = yield* lockCapacityWindow(client, asset.org_id);
      const { ceiling, charged } = window;
      // The reservation covers the per-file upload ceiling for this media
      // type — not the uploaded size — because normalization can legitimately
      // produce larger bytes (an opaque PNG becoming the required JPEG). The
      // engine is told the same ceiling, so a real output can never be
      // rejected for want of an honest reservation.
      const fileCeiling = mediaUploadMaximum(asset.mime_type);
      if (fileCeiling === null) {
        return yield* Effect.fail(
          new TerminalJobError({
            code: "declared_media_type_unsupported",
            message: "The uploaded file's media type cannot be processed.",
          }),
        );
      }
      // The staging key is deterministic per (org, asset, profile), so a
      // retried or redelivered attempt lands on the row a previous attempt
      // already reserved. That row's reservation is charged against the
      // workspace right now, so this attempt must adopt it instead of asking
      // for headroom for the same bytes a second time: demanding it would
      // refuse an Asset whose own reservation already fills the remaining
      // capacity, which is precisely the interrupted-at-full-quota case. The
      // adopted reservation keeps its original plan capacity — the same value
      // the engine was already told it may write — and is not recomputed from
      // capacity that has since moved.
      const stagingKey = processingStagingKey(asset.org_id, asset.id, profile.name);
      const adopted = yield* client.query<{
        bytes: number | string | null;
        reserved_bytes: number | string | null;
      }>(
        `SELECT bytes, reserved_bytes
         FROM asset_objects
         WHERE asset_id = $1 AND r2_key = $2 AND status = 'writing'`,
        [asset.id, stagingKey],
      );
      const adoptedReservation = adopted.rows[0];
      const reusesReservation = adoptedReservation !== undefined;
      const headroom = ceiling === null ? fileCeiling : Math.max(0, ceiling - charged);
      // Three adoption cases in a world where a reservation can shrink onto
      // real bytes (`releaseFrom`) and then be re-armed (`clearStagingForRetry`):
      //   - bytes already recorded: the output exists and is charged at its real
      //     size, so no new headroom is asked for — the row only needs to be
      //     promoted or verified.
      //   - reserved_bytes still held: adopt the reservation already charged to
      //     this workspace rather than demanding the same bytes twice.
      //   - neither: a settled-then-cleared leftover; it must re-arm the planned
      //     reservation against current headroom like a fresh reservation.
      const adoptedBytes = bytesOf(adoptedReservation?.bytes);
      const adoptedReserved = bytesOf(adoptedReservation?.reserved_bytes);
      const needsReservation = !reusesReservation || (adoptedBytes < 1 && adoptedReserved < 1);
      const reservationBytes =
        adoptedBytes > 0
          ? adoptedBytes
          : adoptedReserved > 0
            ? adoptedReserved
            : Math.min(fileCeiling, headroom);
      // Only a reservation that is a new demand on headroom can be refused for
      // want of room. Adopted bytes and adopted reservations are already
      // charged to this workspace, so they are never re-refused.
      if (needsReservation && reservationBytes < 1) {
        return yield* Effect.fail(
          new TerminalJobError({
            code: "storage_limit_reached",
            message:
              "Optimizing this file needs storage space that is not available. Remove other media and try again.",
          }),
        );
      }

      // The write hold is persisted BEFORE the capability is minted, so the row
      // that owns this key already carries the deadline until which a late
      // engine PUT could recreate its bytes. A retried attempt extends it
      // rather than inheriting a shorter one from a previous attempt, so an
      // adopted reservation and a freshly taken one are indistinguishable to
      // every later stage.
      if (!reusesReservation) {
        yield* client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, profile, r2_key,
              reserved_bytes, content_type, status, write_hold_until)
           VALUES ($1, $2, $3, 'rendition', $4, $5, $6, NULL, 'writing',
                   now() + make_interval(secs => $7))
           ON CONFLICT DO NOTHING`,
          [
            asset.org_id,
            asset.id,
            asset.brand_profile_id,
            profile.name,
            stagingKey,
            reservationBytes,
            processorCapabilityTtlSeconds,
          ],
        );
      }
      const object = yield* client.query<ObjectRow>(
        `SELECT id, r2_key, bytes, reserved_bytes, etag, sha256,
                content_type, status
         FROM asset_objects
         WHERE asset_id = $1 AND r2_key = $2`,
        [asset.id, stagingKey],
      );
      const objectRow = object.rows[0];
      if (!objectRow) {
        return yield* Effect.fail(
          new Error("the reserved rendition object could not be inventoried"),
        );
      }
      if (objectRow.status !== "writing") {
        // A row that already left 'writing' means a previous attempt settled
        // this reservation and committed its rendition. That commit is adopted
        // on the next delivery through the ready-rendition lookup, so the stale
        // row is dropped here rather than being charged a second time.
        yield* client.query(`DELETE FROM asset_objects WHERE id = $1 AND status <> 'writing'`, [
          objectRow.id,
        ]);
        return yield* Effect.fail(
          new RetryableJobError({
            cause: "reservation_already_settled",
            message: "A previous processing attempt already settled this reservation.",
          }),
        );
      }

      // A retried attempt mints a fresh capability, so it must also extend the
      // row's write hold. Inheriting a previous attempt's shorter deadline
      // would let the sweep delete bytes the new grant can still write. The
      // resulting deadline is read back, because the capability minted after
      // this transaction must expire no later than the hold that was persisted.
      const held = yield* client.query<{ write_hold_until: Date }>(
        `UPDATE asset_objects
         SET write_hold_until = GREATEST(
               COALESCE(write_hold_until, now()),
               now() + make_interval(secs => $2)
             ),
             reserved_bytes = CASE
               WHEN bytes IS NULL AND reserved_bytes IS NULL THEN $3
               ELSE reserved_bytes
             END,
             updated_at = now()
         WHERE id = $1 AND status = 'writing'
         RETURNING write_hold_until`,
        [objectRow.id, processorCapabilityTtlSeconds, reservationBytes],
      );
      const rendition = yield* client.query<{ id: string }>(
        `INSERT INTO asset_renditions
           (org_id, asset_id, brand_profile_id, profile, status)
         VALUES ($1, $2, $3, $4, 'processing')
         ON CONFLICT (asset_id, profile) DO NOTHING
         RETURNING id`,
        [asset.org_id, asset.id, asset.brand_profile_id, profile.name],
      );
      const renditionId =
        rendition.rows[0]?.id ??
        (yield* client.query<{ id: string }>(
          `SELECT id FROM asset_renditions WHERE asset_id = $1 AND profile = $2`,
          [asset.id, profile.name],
        )).rows[0]?.id;
      if (!renditionId) {
        return yield* Effect.fail(new Error("the rendition row could not be inventoried"));
      }
      const hold = held.rows[0]?.write_hold_until;
      if (!(hold instanceof Date)) {
        return yield* Effect.fail(
          new Error("the reserved rendition's write hold could not be read"),
        );
      }
      return {
        // The same authoritative rule the workspace total uses: a row that
        // already recorded measured output while still holding its reservation
        // stays charged at the full reserved maximum, because the write can
        // still be retried up to that bound. A row with neither field falls
        // back to the plan reservation just taken.
        charged:
          Math.max(bytesOf(objectRow.bytes), bytesOf(objectRow.reserved_bytes)) || reservationBytes,
        objectId: objectRow.id,
        profile: profile.name,
        readyKey: renditionReadyKey(asset.org_id, asset.id, profile.name),
        renditionId,
        stagingKey,
        writeHoldUntil: hold.getTime(),
      } satisfies ProfileReservation;
    }),
  ).pipe(Effect.mapError(asError));
}

// ---------------------------------------------------------------------------
// Phase 4-6: native compute, verification, promotion, commit
// ---------------------------------------------------------------------------

/**
 * Recovers a verified output left by an interrupted attempt, or clears the
 * staging key so the attempt can be recomputed.
 *
 * A staging row that already carries bytes was written by an engine run that
 * fully decoded and verified the media, and its digests were recorded before
 * any promotion, so the object can be re-verified — size, media type, and the
 * recorded sha256 or PUT-response ETag — and promoted without paying for the
 * compute again. A staging row with no recorded bytes may hold output from
 * an attempt that died before its digest was written; nothing durable says
 * what those bytes are, so they are deleted rather than trusted.
 *
 * @param env - Automation worker environment bindings.
 * @param objectStore - Object store holding the staging key.
 * @param reservation - Reserved inventory for this profile.
 * @returns The recoverable verified output, or null when it must be recomputed.
 */
function adoptInterruptedOutput(
  env: AutomationEnv,
  objectStore: ObjectStore,
  asset: AssetProcessingRow,
  reservation: ProfileReservation,
): Effect.Effect<ProcessedOutput | null, Error> {
  return Effect.gen(function* () {
    const row = yield* withSystemTransactionEffect(env, (client) =>
      client
        .query<ObjectRow>(
          `SELECT id, r2_key, bytes, reserved_bytes, etag, sha256,
                  content_type, status, width, height, duration_sec
           FROM asset_objects
           WHERE id = $1`,
          [reservation.objectId],
        )
        .pipe(Effect.map((result) => result.rows[0])),
    ).pipe(Effect.mapError(asError));
    const bytes = bytesOf(row?.bytes);
    if (!row || row.status !== "writing" || bytes === 0 || !row.content_type) {
      const rearmed = yield* clearStagingForRetry(env, objectStore, asset, reservation);
      // The re-arm is applied to the shared reservation so the capability the
      // engine receives (`maximum_output_bytes`, `writeHoldUntil`) is the one
      // actually re-armed, not the stale reservation read before this retry.
      reservation.charged = rearmed.reservedBytes;
      reservation.writeHoldUntil = rearmed.writeHoldUntil;
      return null;
    }
    const recorded: ProcessedOutput = {
      bytes,
      contentType: row.content_type,
      durationSeconds: row.duration_sec === null ? null : Number(row.duration_sec),
      etag: row.etag,
      height: row.height,
      sha256: row.sha256,
      width: row.width,
    };
    const live = yield* Effect.tryPromise({
      catch: asError,
      try: () => objectStore.head(reservation.stagingKey),
    });
    if (
      !live ||
      live.size !== recorded.bytes ||
      live.contentType?.toLowerCase() !== recorded.contentType.toLowerCase() ||
      (recorded.sha256 !== null && live.sha256 !== null && live.sha256 !== recorded.sha256) ||
      (recorded.etag !== null && live.etag !== recorded.etag)
    ) {
      const rearmed = yield* clearStagingForRetry(env, objectStore, asset, reservation);
      reservation.charged = rearmed.reservedBytes;
      reservation.writeHoldUntil = rearmed.writeHoldUntil;
      return null;
    }
    return recorded;
  });
}

/**
 * Removes output that cannot be verified against anything durable and returns
 * the attempt to a fully reserved state so it can be recomputed.
 *
 * The engine's output capability is create-only, so a rerun can only write this
 * key when it is genuinely absent. A failed delete therefore has to surface as
 * a retry rather than as an engine precondition failure, which would otherwise
 * turn a transient storage fault into a permanently failed Asset.
 *
 * The reservation is re-armed to the media ceiling under the organization lock
 * BEFORE the object is deleted and BEFORE the measured facts are cleared.
 * After `releaseFrom` the row can be holding only its real bytes
 * (`reserved_bytes` NULL), yet a stale create-only grant can still write this
 * key up to the media ceiling until its hold lapses. Clearing the facts to NULL
 * first would let that late write land against a row that accounts for nothing
 * — untracked bytes. Re-arming first means whatever the grant can write is
 * already charged. A headroom failure leaves the measured facts and the object
 * in place and surfaces a retryable error: the workspace is full, and a retry
 * is the only honest answer because clearing and re-checking exposes the hole.
 *
 * The reset clears only the measured facts, never the re-armed reservation:
 * the row keeps charging the media ceiling while the stale grant is live, and
 * only the acknowledged delete lets the later settle drop it to real bytes.
 *
 * @param env - Automation worker environment bindings.
 * @param objectStore - Object store holding the staging key.
 * @param asset - Asset row being processed, for the media ceiling.
 * @param reservation - Reserved inventory for this profile.
 * @returns The re-armed reservation facts (`reservedBytes`, `writeHoldUntil`)
 *   once the key is confirmed absent, or a retryable failure when the key could
 *   not be cleared or the re-arm could not be afforded.
 */
function clearStagingForRetry(
  env: AutomationEnv,
  objectStore: ObjectStore,
  asset: AssetProcessingRow,
  reservation: ProfileReservation,
): Effect.Effect<{ reservedBytes: number; writeHoldUntil: number }, Error> {
  return Effect.gen(function* () {
    const fileCeiling = mediaUploadMaximum(asset.mime_type);
    if (fileCeiling === null) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "declared_media_type_unsupported",
          message: "The uploaded file's media type cannot be processed.",
        }),
      );
    }
    // Re-arm is needed only when this row's reservation was already exchanged
    // for real bytes (`releaseFrom` set `reserved_bytes` NULL): a stale
    // create-only grant can still write this key up to the media ceiling until
    // its hold lapses, but the row would then charge only the settled bytes.
    // A row still holding its reservation charges exactly what any live grant
    // can write, so it is adopted as-is and only its hold is read back.
    const rearmed = yield* withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        const window = yield* lockCapacityWindow(client, asset.org_id);
        const current = yield* client.query<{
          bytes: number | string | null;
          reserved_bytes: number | string | null;
          write_hold_until: Date | null;
        }>(
          `SELECT bytes, reserved_bytes, write_hold_until
           FROM asset_objects
           WHERE id = $1 AND status = 'writing' FOR UPDATE`,
          [reservation.objectId],
        );
        const row = current.rows[0];
        if (!row) {
          return yield* Effect.fail(
            new RetryableJobError({
              cause: "reservation_state_changed",
              message:
                "The processing reservation changed underneath this attempt; the attempt will retry.",
            }),
          );
        }
        const existingHold =
          row.write_hold_until instanceof Date ? row.write_hold_until.getTime() : null;
        if (row.reserved_bytes !== null) {
          // Still-reserved row: the charge already equals what a live grant can
          // write. A null hold means the row predates hold tracking; the caller
          // only needs it to bound the next mint, so the reservation value is
          // what carries forward here.
          return {
            reservedBytes: bytesOf(row.reserved_bytes),
            writeHoldUntil: existingHold ?? Date.now(),
          };
        }
        // Room for the re-arm is measured against what this row is already
        // charged (its real bytes once the reservation was exchanged), so the
        // re-arm only asks for the delta the ceiling adds. If that room does
        // not exist the object and its recorded facts are left in place —
        // deleting anyway would let the stale grant write up to the ceiling
        // against a row that no longer accounts for it.
        const rowCharge = Math.max(bytesOf(row.bytes), bytesOf(row.reserved_bytes));
        const roomForReservation =
          window.ceiling === null ? fileCeiling : window.ceiling - (window.charged - rowCharge);
        if (roomForReservation < fileCeiling) {
          return yield* Effect.fail(
            new RetryableJobError({
              cause: "capacity_rearm_unavailable",
              message:
                "This workspace does not have room to re-arm the processing reservation; the attempt will retry.",
            }),
          );
        }
        const armed = yield* client.query<{ write_hold_until: Date }>(
          `UPDATE asset_objects
           SET reserved_bytes = $2,
               write_hold_until = GREATEST(
                 COALESCE(write_hold_until, now()),
                 now() + make_interval(secs => $3)
               ),
               updated_at = now()
           WHERE id = $1 AND status = 'writing'
           RETURNING write_hold_until`,
          [reservation.objectId, fileCeiling, processorCapabilityTtlSeconds],
        );
        const hold = armed.rows[0]?.write_hold_until;
        if (!(hold instanceof Date)) {
          return yield* Effect.fail(
            new RetryableJobError({
              cause: "reservation_state_changed",
              message:
                "The processing reservation changed underneath this attempt; the attempt will retry.",
            }),
          );
        }
        return { reservedBytes: fileCeiling, writeHoldUntil: hold.getTime() };
      }),
    ).pipe(Effect.mapError(asError));
    if (!(yield* deleteObject(objectStore, reservation.stagingKey))) {
      return yield* Effect.fail(
        new RetryableJobError({
          cause: "staging_output_stuck",
          message:
            "An interrupted processing attempt left a file that could not be cleared; the job will retry.",
        }),
      );
    }
    yield* withSystemTransactionEffect(env, (client) =>
      client.query(
        `UPDATE asset_objects
         SET bytes = NULL, etag = NULL, sha256 = NULL, content_type = NULL,
             width = NULL, height = NULL, duration_sec = NULL, updated_at = now()
         WHERE id = $1 AND status = 'writing'`,
        [reservation.objectId],
      ),
    ).pipe(Effect.mapError(asError));
    return rearmed;
  });
}

/**
 * Produces one verified rendition through the native engine and commits it.
 *
 * The engine receives two single-object capabilities: a read grant on the
 * protected original and a create-only write grant on the inventoried
 * staging-processing key. The create-only grant carries a signed
 * `If-None-Match: *`, so a delayed duplicate job holding a leaked URL is
 * rejected by object storage itself rather than by database state.
 *
 * The produced object is re-read and compared against the engine's own decoded
 * verdict before it is promoted, and the promotion is itself a conditional
 * copy, so a publish-ready key is never overwritten either.
 *
 * @param env - Automation worker environment bindings.
 * @param objectStore - Object store used for cleanup, verification, and promotion.
 * @param asset - Asset row being processed.
 * @param source - Protected source bytes.
 * @param reservation - Reserved inventory for this profile.
 * @param profile - Requested processing profile.
 * @returns Effect resolving when the rendition is committed or accepted as the
 *   already-compliant original.
 */
function produceRendition(
  env: AutomationEnv,
  objectStore: ObjectStore,
  asset: AssetProcessingRow,
  source: ProcessingSource,
  reservation: ProfileReservation,
  profile: NativeProcessorProfile,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    let output = yield* adoptInterruptedOutput(env, objectStore, asset, reservation);

    if (!output) {
      // URL minting and container invocation live in the native-processor
      // adapter so there is exactly one definition of the job capability shape;
      // this module only decides which two keys that capability may touch. The
      // output capability is create-only and never points at a publish-ready
      // key, which is what makes the frozen-byte guarantee structural.
      // The output capability is bounded by the deadline already persisted for
      // this row, never by a fresh fixed TTL: the signer clamps the grant to
      // the absolute instant the reservation transaction recorded, so a paused
      // or retried mint can never outlive the window in which the row's bytes
      // stay inventoried and charged.
      //
      // The deadline is genuinely reachable: reserving, minting, and invoking
      // are separated by real awaits, so the check below turns an unaccounted
      // write into a typed retry rather than a job launched on a dead grant.
      if (reservation.writeHoldUntil <= Date.now()) {
        return yield* Effect.fail(
          new RetryableJobError({
            cause: "write_hold_elapsed",
            message:
              "The processing window elapsed before the job started; the attempt will retry.",
          }),
        );
      }
      const urls = yield* processorJobUrlsEffect(env, {
        inputKey: source.key,
        outputExpiresAt: new Date(reservation.writeHoldUntil),
        outputKey: reservation.stagingKey,
        // The input capability only reads already-protected bytes, so it keeps
        // the adapter's normal lifetime; only the write grant is held to the row.
      }).pipe(Effect.mapError(asJobError));
      // Signing is async, so the hold may have elapsed while the URLs were
      // being minted; launching anyway would hand the engine a dead write
      // grant. The check re-reads the clock after both signs, before invoke.
      if (reservation.writeHoldUntil <= Date.now()) {
        return yield* Effect.fail(
          new RetryableJobError({
            cause: "write_hold_elapsed",
            message:
              "The processing window elapsed while capabilities were being minted; the attempt will retry.",
          }),
        );
      }
      // The job id is a pure function of (workspace, asset, profile) rather
      // than of the Outbox event, so a redelivery under a different event id
      // still replays the engine's recorded verdict instead of producing a
      // second object.
      const verdict = yield* invokeNativeProcessorEffect(env, {
        asset_id: asset.id,
        deadline_seconds: processorJobDeadlineSeconds,
        declared_content_type: source.contentType,
        expected_checksum: asset.source_sha256,
        expected_size: source.bytes,
        input_url: urls.input_url,
        job_id: `asset-media:${asset.org_id}:${asset.id}:${profile.name}`,
        maximum_output_bytes: reservation.charged,
        output_url: urls.output_url,
        profile,
      }).pipe(Effect.mapError(asJobError));

      if (verdict.result === "original_compatible") {
        // An explicit verified no-benefit verdict, produced only after the
        // engine fully decoded the original and confirmed it already satisfies
        // the profile. The protected original becomes the rendition reference
        // and no second copy of the bytes is stored or charged. This is never a
        // fallback after a failed optimization.
        yield* commitOriginalAccepted(env, asset, reservation, source.objectId, verdict.media);
        return;
      }
      const producedOutput = verdict.output;
      if (!producedOutput) {
        return yield* Effect.fail(
          new Error("the processor reported an optimized result without an output"),
        );
      }
      output = yield* verifyProducedOutput(objectStore, reservation, {
        media: verdict.media,
        output: producedOutput,
      });
      // The digest is recorded before anything is promoted, so a crash from
      // here on is recoverable by adoption instead of by recomputation.
      yield* recordVerifiedOutput(env, reservation, output);
    }

    yield* promoteAndCommit(env, objectStore, asset, reservation, output);
  });
}

/**
 * Compares the object the engine wrote against the engine's decoded verdict.
 *
 * Nothing here trusts metadata echo: the object is read back from storage and
 * its real size, content type, and content digest are compared with what the
 * engine measured. Because a replayed verdict can describe bytes that are no
 * longer stored, at least one stored-object digest must equal the verdict's:
 * the reported sha256 when storage carries one, else the PUT-recorded ETag.
 * An output with no provable stored identity fails terminally rather than
 * being promoted on the claim alone.
 *
 * @param objectStore - Object store holding the produced object.
 * @param reservation - Reserved inventory for this profile.
 * @param verdict - Engine verdict carrying the measured output facts.
 * @returns The verified output facts to record durably.
 */
function verifyProducedOutput(
  objectStore: ObjectStore,
  reservation: ProfileReservation,
  verdict: {
    media: {
      duration_seconds: number | null;
      height: number | null;
      width: number | null;
    };
    output: {
      bytes: number;
      content_type: string;
      etag: string | null;
      sha256: string;
    };
  },
): Effect.Effect<ProcessedOutput, Error> {
  return Effect.gen(function* () {
    const live = yield* Effect.tryPromise({
      catch: asError,
      try: () => objectStore.head(reservation.stagingKey),
    });
    if (!live) {
      return yield* Effect.fail(
        new RetryableJobError({
          cause: "output_missing",
          message: "The processed file was not written; the job will retry.",
        }),
      );
    }
    if (live.size !== verdict.output.bytes) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "output_size_mismatch",
          message: "The processed file did not match the size the processor reported.",
        }),
      );
    }
    if (live.contentType?.toLowerCase() !== verdict.output.content_type.toLowerCase()) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "output_type_mismatch",
          message: "The processed file did not match the media type the processor reported.",
        }),
      );
    }
    // Object storage only reports a checksum when the write carried one, so the
    // digest is compared only when both sides actually hold one. A stored
    // sha256 that disagrees with the verdict is terminal regardless of ETag.
    if (verdict.output.sha256 && live.sha256 && verdict.output.sha256 !== live.sha256) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "output_checksum_mismatch",
          message: "The processed file did not match the checksum the processor reported.",
        }),
      );
    }
    // Size and media type are not content proof: a replayed verdict can name
    // bytes that are no longer (or never were) the stored object. Some digest
    // of the STORED object must therefore equal what the verdict recorded —
    // the reported sha256 when storage carries one, otherwise the PUT
    // response's ETag (the content-derived digest R2 computes for every
    // single-part write, and what the verdict's own `output.etag` recorded).
    // No comparable digest means the bytes cannot be proven and the output is
    // refused rather than promoted on a claim alone.
    const digestProven =
      verdict.output.sha256 === live.sha256 ||
      (verdict.output.etag !== null && verdict.output.etag === live.etag);
    if (!digestProven) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "output_checksum_mismatch",
          message:
            "The stored output's digest could not be proven to match the processor's report.",
        }),
      );
    }
    return {
      bytes: live.size,
      contentType: verdict.output.content_type,
      durationSeconds: verdict.media.duration_seconds,
      // The stored object's own ETag, not the verdict's claim: it is the
      // content-derived digest available when a write carried no checksum, and
      // adoption re-proves content from either recorded digest.
      etag: live.etag,
      height: verdict.media.height,
      sha256: verdict.output.sha256,
      width: verdict.media.width,
    };
  });
}

/**
 * Records the verified output identity on its inventory row while the row is
 * still `writing`.
 *
 * The row stays charged on its reservation until it leaves `writing`; recording
 * the digests first is what makes an interrupted run adoptable instead of
 * forcing the compute to run again. `etag` is recorded alongside `sha256`
 * because it is the stored digest available when a write carried no checksum:
 * adoption can then re-prove content from either one.
 *
 * @param env - Automation worker environment bindings.
 * @param reservation - Reserved inventory for this profile.
 * @param output - Verified output facts.
 * @returns Effect resolving once the digests are durable.
 */
function recordVerifiedOutput(
  env: AutomationEnv,
  reservation: ProfileReservation,
  output: ProcessedOutput,
): Effect.Effect<void, Error> {
  return withSystemTransactionEffect(env, (client) =>
    client.query(
      `UPDATE asset_objects
       SET bytes = $2, sha256 = $3, content_type = $4,
           width = $5, height = $6, duration_sec = $7, etag = $8,
           updated_at = now()
       WHERE id = $1 AND status = 'writing'`,
      [
        reservation.objectId,
        output.bytes,
        output.sha256,
        output.contentType,
        output.width,
        output.height,
        output.durationSeconds,
        output.etag,
      ],
    ),
  ).pipe(Effect.mapError(asError));
}

/**
 * Failure evidence written onto a demoted `profile='original'` rendition when
 * the committed verdict succeeded. Migration 009 uses the same code and
 * message for a demoted row on an Asset whose processing already committed
 * 'ready', so the row reads identically wherever it was settled.
 */
const demotedOriginalSuperseded = {
  code: "original_superseded",
  message: "The committed optimized rendition superseded this unverified original reference.",
} as const;

/**
 * Settles the unverified `profile='original'` reference migration 007 demoted,
 * inside the same transaction that commits the Asset's own verdict.
 *
 * Verdicts are written only to the reserved profile's rendition row, so a
 * demoted 'original' row (`status='processing'` AND `object_id IS NULL` — the
 * exact shape 007 produced) would otherwise stay 'processing' forever: its
 * Asset's processing has finished, so nothing writes it again. That stranded
 * row permanently excludes the Asset from the orphan sweep and its Brand
 * Profile from the purge, which both refuse any live rendition, so the
 * Asset's bytes are never reclaimed.
 *
 * The terminal status is 'failed' — the CHECK's only non-publishable state
 * that no lifecycle pass reads as reclamation: 'ready' would require and
 * advertise a reference object, and 'deleting'/'deleted' would claim a
 * reclamation the deletion path itself performs. On a permanent processing
 * failure the caller passes the Asset's own verdict evidence (matching
 * migration 009's terminal-failure release); on success it passes
 * `demotedOriginalSuperseded`, because the original was verified and the
 * 'original' slot is simply retired — the committed profile row holds the
 * publishable reference.
 *
 * The WHERE clause is guarded on the exact demoted shape, so a re-run is a
 * no-op and a non-demoted 'original' row written by any other path is never
 * touched.
 *
 * @param client - Transaction client of the enclosing verdict commit.
 * @param asset - Asset whose demoted original reference is settled.
 * @param failure - Code and message recorded on the row.
 * @returns Effect resolving once the guarded update ran.
 */
function settleDemotedOriginalRendition(
  client: EffectTransactionClient,
  asset: AssetProcessingRow,
  failure: { code: string; message: string },
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `UPDATE asset_renditions
       SET status = 'failed', failure_code = $2, failure_message = $3,
           failure_at = now(), updated_at = now()
       WHERE asset_id = $1
         AND profile = 'original'
         AND status = 'processing'
         AND object_id IS NULL`,
      [asset.id, failure.code, failure.message],
    )
    .pipe(Effect.map(() => undefined));
}

/**
 * Transitions the Asset to `ready` inside the enclosing verdict-commit
 * transaction, carrying the committed rendition's recorded facts onto the
 * Asset summary every consumer reads.
 *
 * Shared by every success path (promotion, original-acceptance, and committed-
 * rendition adoption) so the 'processing' -> 'ready' verdict can never drift:
 * the same failure-field cleanup and the same `status = 'processing'` guard
 * apply wherever the verdict came from. The guard makes the write idempotent —
 * a redelivery whose verdict already committed leaves the row untouched.
 *
 * @param client - Transaction client of the enclosing verdict commit.
 * @param asset - Asset being marked ready.
 * @param media - Verified facts recorded for the rendition being adopted:
 *   width/height in pixels and duration in (fractional) seconds, any of which
 *   may be null when the engine did not measure them.
 * @returns Effect resolving once the guarded update ran.
 */
function markAssetReady(
  client: EffectTransactionClient,
  asset: AssetProcessingRow,
  media: {
    durationSeconds: number | null;
    height: number | null;
    width: number | null;
  },
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `UPDATE assets
       SET status = 'ready',
           width = $2, height = $3, duration_sec = $4,
           failure_code = NULL, failure_message = NULL,
           failure_retryable = NULL, failure_at = NULL,
           updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [asset.id, media.width, media.height, media.durationSeconds],
    )
    .pipe(Effect.map(() => undefined));
}

/**
 * Promotes a verified output to its publish-ready key and commits every
 * durable reference in one transaction, including the terminal settle of the
 * demoted `profile='original'` reference migration 007 left for this verdict
 * (`settleDemotedOriginalRendition`).
 *
 * Promotion is a conditional copy guarded by the staging object's ETag, so a
 * ready key is created only once and never overwritten. Both transient copies
 * stay charged while both physically exist; the staging row is only released
 * after its external delete is acknowledged.
 *
 * @param env - Automation worker environment bindings.
 * @param objectStore - Object store used for promotion and cleanup.
 * @param asset - Asset row being processed.
 * @param reservation - Reserved inventory for this profile.
 * @param output - Verified output facts.
 * @returns Effect resolving once the rendition is committed.
 */
function promoteAndCommit(
  env: AutomationEnv,
  objectStore: ObjectStore,
  asset: AssetProcessingRow,
  reservation: ProfileReservation,
  output: ProcessedOutput,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const copy = objectStore.copyObject?.bind(objectStore);
    if (!copy) {
      return yield* Effect.fail(
        new RetryableJobError({
          cause: "copy_unsupported",
          message: "Object storage cannot promote the processed file.",
        }),
      );
    }
    const staged = yield* Effect.tryPromise({
      catch: asError,
      try: () => objectStore.head(reservation.stagingKey),
    });
    if (!staged || staged.size !== output.bytes) {
      return yield* Effect.fail(
        new RetryableJobError({
          cause: "staging_output_missing",
          message: "The processed file is no longer in storage; the job will retry.",
        }),
      );
    }
    // The protected copy is a SECOND physical object: the staging output is
    // still present and still charged while it exists, and the source Asset's
    // own original is charged too. Reserving only for this destination would
    // let two concurrent promotions each observe the same headroom and both copy,
    // oversubscribing the Entitlement by the size of the bytes already in
    // flight. `output.bytes` is an exact bound rather than an estimate, because a
    // conditional copy cannot produce more bytes than the object it copies from.
    //
    // `profile` is null here on purpose: the staging row still occupies the live
    // (asset, profile) slot under `idx_asset_objects_live_rendition_profile` until
    // it leaves `writing` below, so stamping it now would violate that index.
    const readyReservation = yield* reserveProtectedCopy(env, asset, {
      key: reservation.readyKey,
      kind: "rendition",
      // The verified staging output cannot grow — its create-only grant is
      // still live but `If-None-Match: *` refuses a second write — so its
      // reservation is exchanged for its real bytes in the same transaction
      // that reserves this destination. That keeps the copy's honest cost at
      // `2 * output.bytes` (both physical copies) rather than
      // `reservation + output.bytes`, which is what would refuse a valid output
      // whenever the workspace headroom sat below the profile maximum.
      // headroom >= 2 * output.bytes always suffices; below that, the attempt
      // is refused rather than oversubscribing.
      releaseFrom: {
        bytes: output.bytes,
        expectedReservedBytes: reservation.charged,
        objectId: reservation.objectId,
      },
      profile: null,
      reservedBytes: output.bytes,
    });

    const promoted =
      (yield* Effect.tryPromise({
        catch: asError,
        try: () =>
          copy(reservation.stagingKey, reservation.readyKey, {
            contentType: output.contentType,
            ifDestinationAbsent: true,
            ifSourceEtagMatches: staged.etag ?? undefined,
          }),
      })) ??
      // A null result means the guarded copy declined: either the destination
      // already exists (a previous attempt promoted it) or the source ETag no
      // longer matches. Both are resolved by verifying the destination itself.
      (yield* Effect.tryPromise({
        catch: asError,
        try: () => objectStore.head(reservation.readyKey),
      }));
    if (!promoted) {
      return yield* Effect.fail(
        new RetryableJobError({
          cause: "promotion_failed",
          message: "The processed file could not be promoted; the job will retry.",
        }),
      );
    }
    const ready = yield* verifyObject(objectStore, reservation.readyKey, {
      bytes: output.bytes,
      contentType: output.contentType,
    });

    yield* withSystemTransactionEffect(env, (client) =>
      Effect.gen(function* () {
        yield* client.query(`SELECT id FROM assets WHERE id = $1 FOR UPDATE`, [asset.id]);
        // Leaving `writing` is the charge-once settle point: the staging object
        // moves from its reservation onto its real bytes and stays charged
        // until its delete below is acknowledged.
        yield* client.query(
          `UPDATE asset_objects
           SET status = 'superseded', reserved_bytes = NULL,
               etag = $2, updated_at = now()
           WHERE id = $1 AND status = 'writing' AND bytes IS NOT NULL`,
          [reservation.objectId, ready.etag],
        );
        // The destination row reserved before the copy is settled in place, not
        // inserted fresh: it already owns the key, so re-settling it after a
        // crash between copy and commit charges this key exactly once. Order
        // matters — the staging row leaves `writing` above first, freeing the
        // live (asset, profile) slot that stamping `profile` below claims.
        const readyObject = yield* client.query<{ id: string }>(
          `UPDATE asset_objects
           SET status = 'ready',
               bytes = $2,
               reserved_bytes = NULL,
               profile = COALESCE(profile, $3),
               etag = $4,
               sha256 = $5,
               content_type = $6,
               width = $7,
               height = $8,
               duration_sec = $9,
               updated_at = now()
           WHERE id = $1 AND status = 'writing'
           RETURNING id`,
          [
            readyReservation.objectId,
            output.bytes,
            reservation.profile,
            ready.etag,
            output.sha256,
            output.contentType,
            output.width,
            output.height,
            output.durationSeconds,
          ],
        );
        const readyObjectId = readyObject.rows[0]?.id;
        if (!readyObjectId) {
          return yield* Effect.fail(new Error("the promoted rendition could not be inventoried"));
        }
        yield* client.query(
          `UPDATE asset_renditions
           SET status = 'ready', object_id = $2,
               failure_code = NULL, failure_message = NULL, failure_at = NULL,
               updated_at = now()
           WHERE id = $1`,
          [reservation.renditionId, readyObjectId],
        );
        // The demoted 'original' reference settles with this verdict in the
        // same transaction, so a re-queued Asset never leaves a 'processing'
        // rendition blocking the orphan sweep after its verdict committed.
        yield* settleDemotedOriginalRendition(client, asset, demotedOriginalSuperseded);
        yield* markAssetReady(client, asset, output);
      }),
    ).pipe(Effect.mapError(asError));
    // The promoted staging copy is NOT deleted here. The engine's create-only
    // capability is still valid, so deleting now would let that grant recreate
    // bytes the row has stopped tracking. The row stays 'superseded', inventoried
    // and charged, until releaseStaleProcessingStaging observes that the
    // persisted write hold has passed.
  });
}

/**
 * Accepts a verified, already-compliant original as this profile's rendition.
 *
 * No second copy of the bytes is produced, so nothing new is stored. The
 * reservation row still cannot be deleted outright: the output capability
 * minted for the job stays valid until its persisted hold, so the row is
 * superseded and the charge is released when the sweep reclaims it.
 *
 * The engine's decoded facts are written to the ORIGINAL OBJECT row as well as
 * the Asset. This is the only place a `ready` reference can point at an object
 * the engine never measured, so it is also the only place those facts can
 * arrive: consumers read geometry, duration and media type off the object,
 * and an object left with NULL facts would publish as "unknown" against
 * Platforms that cap any of them. The write happens in the same transaction
 * that marks the reference `ready`, before it, so no consumer can observe the
 * reference without the facts.
 *
 * The Asset still becomes ready, because a no-benefit verdict means the
 * original is a verified rendition for this profile rather than an unprocessed
 * substitute. The same transaction settles the demoted `profile='original'`
 * reference migration 007 left for this verdict
 * (`settleDemotedOriginalRendition`).
 *
 * @param env - Automation worker environment bindings.
 * @param asset - Asset row being processed.
 * @param reservation - Reserved inventory being released.
 * @param originalObjectId - Inventory row of the protected original.
 * @param media - Verified media facts measured by the engine, including the
 *   media type the decode actually produced.
 * @returns Effect resolving once the acceptance is durable.
 */
function commitOriginalAccepted(
  env: AutomationEnv,
  asset: AssetProcessingRow,
  reservation: ProfileReservation,
  originalObjectId: string,
  media: {
    content_type: string;
    duration_seconds: number | null;
    height: number | null;
    width: number | null;
  },
): Effect.Effect<void, Error> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      yield* client.query(`SELECT id FROM assets WHERE id = $1 FOR UPDATE`, [asset.id]);
      // The reservation row is superseded rather than deleted outright: the
      // create-only output capability minted for this job stays valid until
      // its persisted hold, so the row keeps tracking the key until the sweep
      // reclaims it after the hold lapses. Deleting it now could let a late PUT
      // recreate bytes nothing accounts for.
      yield* client.query(
        `UPDATE asset_objects
         SET status = 'superseded', updated_at = now()
         WHERE id = $1 AND status = 'writing'`,
        [reservation.objectId],
      );
      // The engine's decoded facts are recorded on the ORIGINAL OBJECT, not only
      // on the Asset. Consumers resolve a publishable candidate by joining the
      // ready rendition reference to its `asset_objects` row and reading
      // `duration_sec`, `width`, `height` and `content_type` from the OBJECT —
      // the Asset columns are only the coarse summary. A no-benefit video whose
      // object row still carried NULL duration would therefore be handed to a
      // duration-limited Platform as "unknown" and rejected, even though the
      // engine had measured it exactly.
      //
      // This runs before the rendition reference becomes `ready` so a candidate
      // can never be read against a half-populated object row, and it is
      // guarded on the object still being `ready`, which is the invariant
      // promotion already established.
      yield* client.query(
        `UPDATE asset_objects
         SET width = $2, height = $3, duration_sec = $4, content_type = $5,
             updated_at = now()
         WHERE id = $1 AND status = 'ready'`,
        [originalObjectId, media.width, media.height, media.duration_seconds, media.content_type],
      );
      yield* client.query(
        `UPDATE asset_renditions
         SET status = 'ready', object_id = $2,
             failure_code = NULL, failure_message = NULL, failure_at = NULL,
             updated_at = now()
         WHERE id = $1`,
        [reservation.renditionId, originalObjectId],
      );
      // The demoted 'original' reference settles with this verdict in the same
      // transaction, so a re-queued Asset never leaves a 'processing' rendition
      // blocking the orphan sweep after its verdict committed.
      yield* settleDemotedOriginalRendition(client, asset, demotedOriginalSuperseded);
      yield* markAssetReady(client, asset, {
        durationSeconds: media.duration_seconds,
        height: media.height,
        width: media.width,
      });
    }),
  ).pipe(Effect.mapError(asError));
}

/**
 * Retires the upload-writable staging object once every required rendition
 * reference is committed.
 *
 * This runs last on purpose: issue #284 decision 10 requires a valid output to
 * be referenced before superseded source bytes are dropped, so a crash here
 * leaves protected, deliverable media plus reclaimable staging rather than a
 * dangling reference to deleted bytes.
 *
 * The delete is deferred, not immediate, for the same reason as the processing
 * output: the signed upload grant that wrote this key stays valid for its
 * remaining lifetime and could otherwise recreate the bytes after the row
 * stopped tracking them. The row stays `superseded` and charged until
 * `releaseStaleProcessingStaging` confirms the writer window has closed.
 *
 * @param env - Automation worker environment bindings.
 * @param assetId - Asset whose staging object is retired.
 * @returns Effect resolving once staging is queued for deferred reclaim.
 */
function retireStaging(env: AutomationEnv, assetId: string): Effect.Effect<void, Error> {
  return withSystemTransactionEffect(env, (client) =>
    client.query(
      `UPDATE asset_objects
       SET status = 'superseded',
           -- The row's own recorded grant deadline is the last instant a
           -- staging writer can fire: every minted upload URL was persisted
           -- there under the session lock before it was exposed, and a
           -- confirmed multipart complete already closed the hold to now().
           -- The fallback bound of session expiry plus one signed-URL
           -- lifetime applies only when no deadline was ever recorded —
           -- rows that predate per-grant recording — so a deliberately
           -- closed hold is never revived by it.
           write_hold_until = GREATEST(
             COALESCE(
               write_hold_until,
               COALESCE((
                 SELECT MAX(session.expires_at)
                 FROM asset_upload_sessions AS session
                 WHERE session.asset_id = $1
               ), now())
                 + make_interval(secs => $2)
             ),
             now()
           ),
           updated_at = now()
       WHERE asset_id = $1 AND kind = 'staging'
         AND status IN ('writing', 'ready')`,
      [assetId, ASSET_UPLOAD_POLICY.signedUrlTtlSeconds],
    ),
  ).pipe(Effect.mapError(asError));
}

/**
 * Marks the Asset permanently failed and hands the reservation's writer window
 * to the sweep.
 *
 * The protected original is deliberately left in place and left charged: a
 * failed Asset still holds real, creator-visible bytes, and those bytes are what
 * the ownership-aware orphan sweep reclaims once the grace period lapses. Only
 * capacity reserved for compute is given back — and even that waits for the
 * minted output capability's persisted hold, because a terminal failure does
 * not prove the engine never wrote.
 *
 * Every pending reserved row the Asset owns is superseded, including rows this
 * attempt has no handle on. A protected copy reserved before a crash leaves a
 * `writing` row with neither bytes nor a committed reference, and nothing else
 * would ever release it: `reclaimStaleWritingObjects` only considers rows that
 * recorded bytes, and `releaseStaleProcessingStaging` only considers rows that
 * already left `writing`.
 *
 * The demoted `profile='original'` reference migration 007 left for this
 * verdict inherits the Asset's failure evidence in the same transaction
 * (`settleDemotedOriginalRendition`), so a re-queued Asset never leaves a
 * 'processing' rendition blocking the orphan sweep after failing.
 *
 * @param env - Automation worker environment bindings.
 * @param asset - Asset row being failed.
 * @param reservation - Reservation to release, when one was taken.
 * @param cause - Terminal error carrying the actionable creator-facing reason.
 * @returns Effect resolving once the failure is durable.
 */
function markAssetFailed(
  env: AutomationEnv,
  asset: AssetProcessingRow,
  reservation: ProfileReservation | undefined,
  cause: TerminalJobError,
): Effect.Effect<void, Error> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      yield* client.query(`SELECT id FROM assets WHERE id = $1 FOR UPDATE`, [asset.id]);
      if (reservation) {
        // The reservation row is superseded, not deleted: a terminal failure
        // does not prove the engine never wrote, and the minted output
        // capability stays valid until its persisted hold regardless — so the
        // row keeps tracking the key until the sweep reclaims it after the
        // hold lapses. Deleting it now could let a late PUT recreate bytes
        // nothing accounts for.
        yield* client.query(
          `UPDATE asset_objects
           SET status = 'superseded', updated_at = now()
           WHERE id = $1 AND status = 'writing'`,
          [reservation.objectId],
        );
        yield* client.query(
          `UPDATE asset_renditions
           SET status = 'failed', failure_code = $2, failure_message = $3,
               failure_at = now(), updated_at = now()
           WHERE id = $1 AND status = 'processing'`,
          [reservation.renditionId, cause.code, cause.message],
        );
      }
      // Every pending reserved row this Asset owns is superseded, including rows
      // this attempt holds no handle on. A protected copy reserved before a
      // crash leaves a `writing` row with neither bytes nor a committed
      // reference, and nothing else would ever release it:
      // `reclaimStaleWritingObjects` only considers rows that recorded bytes, and
      // `releaseStaleProcessingStaging` only considers rows that already left
      // `writing`. Such a row would hold its reservation forever.
      //
      // This runs outside the `reservation` guard because a source-phase
      // terminal failure (a corrupt or mutated original) happens before any
      // profile reservation exists, yet can still have reserved a protected
      // original immediately before the copy it abandoned.
      //
      // `reserved_bytes IS NOT NULL` limits this to pending copies. A settled
      // row has already cleared its reservation and keeps charging its real
      // bytes, which the ownership-aware orphan sweep reclaims on its own
      // schedule — including the protected original of a failed Asset, which
      // remains creator-visible media.
      yield* client.query(
        `UPDATE asset_objects
         SET status = 'superseded', updated_at = now()
         WHERE asset_id = $1
           AND status = 'writing'
           AND reserved_bytes IS NOT NULL`,
        [asset.id],
      );
      // The demoted 'original' reference inherits the Asset's terminal failure
      // evidence in the same transaction, matching migration 009's release, so
      // a re-queued Asset never leaves a 'processing' rendition blocking the
      // orphan sweep after its verdict committed.
      yield* settleDemotedOriginalRendition(client, asset, {
        code: cause.code,
        message: cause.message,
      });
      yield* client.query(
        `UPDATE assets
         SET status = 'failed',
             failure_code = $2,
             failure_message = $3,
             failure_retryable = false,
             failure_at = now(),
             -- Issue #284 decision 11: an unretained permanent failure ages out
             -- exactly like retained-ready media, so the seven-day orphan clock
             -- starts here. A saved draft's attachment is the only thing that
             -- exempts the row (decision 12), and COALESCE keeps an earlier
             -- armed deadline from drifting later across repeated attempts.
             orphaned_at = CASE
               WHEN EXISTS (
                 SELECT 1 FROM post_attachments WHERE asset_id = $1
               ) THEN NULL
               ELSE COALESCE(orphaned_at, now())
             END,
             orphan_delete_after = CASE
               WHEN EXISTS (
                 SELECT 1 FROM post_attachments WHERE asset_id = $1
               ) THEN NULL
               ELSE COALESCE(orphan_delete_after, now() + make_interval(days => $4))
             END,
             updated_at = now()
         WHERE id = $1 AND status = 'processing'`,
        [asset.id, cause.code, cause.message, orphanGraceDays],
      );
    }),
  ).pipe(Effect.mapError(asError));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Processes one Asset's media end to end: verify, promote, reserve, run the
 * native engine, verify the produced object, promote it, commit, then retire
 * staging.
 *
 * The caller owns the `async_job_events` lease; this function owns the durable
 * processing state. A returned `"skipped"` means the Asset was not in
 * `processing` (already finished, deleted, or claimed for reclamation) and
 * nothing was changed. A returned `"processed"` means the required profile is
 * committed and ready and the Asset row itself has converged to `ready` —
 * including a re-queued Asset whose committed rendition was adopted — or the
 * Asset is durably and actionably failed. A failure on the typed channel
 * means the work should be retried or rejected, never that raw unprocessed
 * bytes were published.
 *
 * Every terminal (non-retryable) failure is recorded on the Asset before it is
 * re-raised, at every phase — source resolution included, not just production.
 * An unrecorded terminal error is indistinguishable from a lost worker: the
 * Asset stays `processing` with no creator-visible reason, its pending
 * reservations are never released, and the queue redelivers a failure that can
 * never succeed until the message exhausts its attempts.
 *
 * @param env - Automation worker environment bindings.
 * @param objectStore - Object store holding the Asset's bytes.
 * @param assetId - Asset to process.
 * @param organizationId - Owning organization from the Outbox message.
 * @returns `"processed"` when the Asset reached a terminal lifecycle state, or
 *   `"skipped"` when processing no longer applies.
 */
export function processAssetMedia(
  env: AutomationEnv,
  objectStore: ObjectStore,
  assetId: string,
  organizationId: string,
): Effect.Effect<"processed" | "skipped", AutomationJobError> {
  return Effect.gen(function* () {
    const asset = yield* withSystemTransactionEffect(env, (client) =>
      client
        .query<AssetProcessingRow>(
          `SELECT id, org_id, brand_profile_id, asset_type, status,
                  file_size, mime_type, source_etag, source_sha256
           FROM assets
           WHERE id = $1 AND org_id = $2`,
          [assetId, organizationId],
        )
        .pipe(
          Effect.flatMap((result) => {
            const row = result.rows[0];
            if (!row) {
              return Effect.fail(
                new TerminalJobError({
                  code: "asset_missing",
                  message: "The media is no longer available.",
                }),
              );
            }
            return Effect.succeed(row);
          }),
        ),
    );
    if (asset.status !== "processing") return "skipped" as const;
    if (!asset.mime_type) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "declared_media_type_missing",
          message: "The uploaded file has no recorded media type.",
        }),
      );
    }
    const profile = profileForAsset(asset);
    // A permanent source failure is recorded durably here for the same reason
    // production failures are: an unrecorded terminal error leaves the Asset in
    // `processing` with no reason shown and no reclaimable reservation, so the
    // queue retries a failure that can never succeed and the creator sees
    // nothing. `markAssetFailed` with no reservation still supersedes any
    // pending protected copy `resolveSource` may have reserved before failing.
    const resolved = yield* Effect.result(resolveSource(env, objectStore, asset));
    if (Result.isFailure(resolved)) {
      if (resolved.failure instanceof TerminalJobError) {
        yield* markAssetFailed(env, asset, undefined, resolved.failure);
      }
      return yield* Effect.fail(resolved.failure);
    }
    const source = resolved.success;

    // Adoption: a previous attempt already committed this exact rendition. The
    // row is re-verified against the live object rather than trusted, because a
    // committed reference to vanished bytes is exactly the failure this
    // cutover exists to prevent.
    const committed = yield* withSystemTransactionEffect(env, (client) =>
      client
        .query<ObjectRow>(
          `SELECT object.id, object.r2_key, object.bytes, object.reserved_bytes,
                  object.etag, object.sha256, object.content_type, object.status,
                  object.width, object.height, object.duration_sec
           FROM asset_renditions AS rendition
           JOIN asset_objects AS object
             ON object.id = rendition.object_id AND object.status = 'ready'
           WHERE rendition.asset_id = $1 AND rendition.profile = $2`,
          [asset.id, profile.name],
        )
        .pipe(Effect.map((result) => result.rows[0])),
    ).pipe(Effect.mapError(asError));
    if (committed) {
      yield* verifyObject(objectStore, committed.r2_key, {
        bytes: bytesOf(committed.bytes),
        contentType: committed.content_type ?? asset.mime_type,
      });
      // The adopted verdict still has to land on the Asset: migration 007
      // re-queues 'ready' Assets into 'processing' for re-verification, and
      // without this commit the Asset would stay 'processing' forever — the
      // maintenance rearmer would keep re-arming it and the orphan sweep
      // (which excludes processing Assets) could never reclaim it. The same
      // transaction settles the demoted 'original' reference, mirroring the
      // other verdict-commit paths.
      yield* withSystemTransactionEffect(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(`SELECT id FROM assets WHERE id = $1 FOR UPDATE`, [asset.id]);
          yield* settleDemotedOriginalRendition(client, asset, demotedOriginalSuperseded);
          yield* markAssetReady(client, asset, {
            durationSeconds:
              committed.duration_sec === null ? null : Number(committed.duration_sec),
            height: committed.height,
            width: committed.width,
          });
        }),
      ).pipe(Effect.mapError(asError));
      yield* retireStaging(env, asset.id);
      return "processed" as const;
    }

    // Reserving and producing are staged separately so a permanent reservation
    // failure (no Entitlement headroom) is recorded on the Asset with no
    // reservation to release, while a permanent production failure releases the
    // reservation it actually took.
    const reserved = yield* Effect.result(reserveOutputs(env, asset, profile));
    if (Result.isFailure(reserved)) {
      if (reserved.failure instanceof TerminalJobError) {
        yield* markAssetFailed(env, asset, undefined, reserved.failure);
      }
      return yield* Effect.fail(reserved.failure);
    }
    const produced = yield* Effect.result(
      produceRendition(env, objectStore, asset, source, reserved.success, profile),
    );
    if (Result.isFailure(produced)) {
      // A permanent failure is recorded durably here so the creator sees an
      // actionable reason and the reservation is released; the caller only has
      // to decide the delivery outcome.
      if (produced.failure instanceof TerminalJobError) {
        yield* markAssetFailed(env, asset, reserved.success, produced.failure);
      }
      return yield* Effect.fail(produced.failure);
    }
    yield* retireStaging(env, asset.id);
    return "processed" as const;
  }).pipe(Effect.mapError((cause) => classifyJobError(cause)));
}

/**
 * Reclaims staging copies and superseded original objects whose writer grant
 * can no longer recreate them.
 *
 * Both staging namespaces (the upload-writable source object and the
 * engine-writable processing output) and legacy originals superseded during
 * migrated-original promotion are retained as `superseded`, inventoried and
 * charged rows after their content is superseded. The signed grant that wrote
 * them stays valid for a bounded window and could recreate the bytes if they
 * were deleted first. This sweep deletes them only once that window has
 * demonstrably closed, and for superseded originals, only after successful
 * promotion produced a verified canonical original and no active rendition or
 * processing run references the superseded bytes.
 *
 * Publish-ready objects are never touched here.
 *
 * @param env - Automation worker environment bindings.
 * @param objectStore - Object store holding the staging and superseded objects.
 * @param bound - Maximum number of rows to reclaim per sweep.
 * @returns Effect resolving to the number of rows released.
 */
export function releaseStaleProcessingStaging(
  env: AutomationEnv,
  objectStore: ObjectStore,
  bound: number,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    // Claim the expired-hold staging and superseded rows first: the
    // superseded->deleting transition is the single point that takes ownership,
    // and a row that already says 'deleting' is an earlier sweep's unfinished
    // delete being retried idempotently (the bucket delete is at-least-once safe).
    const stale = yield* withSystemTransactionEffect(env, (client) =>
      client
        .query<{ id: string; r2_key: string }>(
          `UPDATE asset_objects
           SET status = 'deleting', updated_at = now()
           WHERE id IN (
             SELECT object.id
             FROM asset_objects AS object
             WHERE object.kind IN ('staging', 'rendition', 'original')
               AND object.status IN ('superseded', 'deleting')
               AND (object.write_hold_until IS NULL OR object.write_hold_until <= now())
               AND (
                 object.kind <> 'original'
                 OR (
                   EXISTS (
                     SELECT 1
                     FROM asset_objects AS live
                     WHERE live.asset_id = object.asset_id
                       AND live.kind = 'original'
                       AND live.status = 'ready'
                   )
                   AND NOT EXISTS (
                     SELECT 1
                     FROM assets AS asset
                     WHERE asset.id = object.asset_id
                       AND asset.status = 'processing'
                   )
                   AND NOT EXISTS (
                     SELECT 1
                     FROM asset_renditions AS rendition
                     WHERE rendition.object_id = object.id
                   )
                 )
               )
             ORDER BY object.write_hold_until NULLS FIRST, object.updated_at, object.id
             LIMIT $1
           )
           RETURNING id, r2_key`,
          [bound],
        )
        .pipe(Effect.map((result) => result.rows)),
    ).pipe(Effect.mapError(asError));
    const removed: { id: string }[] = [];
    for (const row of stale) {
      // A failed bucket delete leaves the row 'deleting' so the next sweep
      // retries the same object; only confirmed removals are settled below.
      if (yield* deleteObject(objectStore, row.r2_key)) {
        removed.push({ id: row.id });
      }
    }
    // settleDeletedObjects owns the 'deleting'->'deleted' transition and the
    // matching usage_records decrement, so a charge is released exactly once
    // through the same routine every other reclamation path uses.
    const settled = yield* settleDeletedObjects(env, removed).pipe(Effect.mapError(asError));
    return settled.deleted_objects;
  });
}
