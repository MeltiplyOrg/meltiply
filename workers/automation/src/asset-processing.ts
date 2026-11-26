import { Effect, Result } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import {
  ASSET_UPLOAD_POLICY,
  assetOrphanGraceSeconds,
  type DatabaseError,
  COMMUNITY_LIMITS,
  errorMessage,
  mediaUploadMaximum,
} from "@meltiply/domain";
import { readyObjectKey, type ObjectStore } from "@meltiply/storage";
import {
  PROCESSOR_CAPABILITY_TTL_SECONDS,
  PROCESSOR_CONTAINER_TIMEOUT_MS,
  NativeProcessorError,
  invokeNativeProcessorEffect,
  processorJobUrlsEffect,
  type NativeProcessorProfile,
} from "./native-processor";
import { deleteObjectsAndSettleEffect, deleteStorageObjectEffect } from "./object-cleanup";

import { withSystemTransactionEffect } from "./database";
import {
  classifyJobError,
  RetryableJobError,
  TerminalJobError,
  type AutomationJobError,
} from "./effect/index";
import type { AutomationEnv } from "./env";
import { toError as asError } from "./errors";

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

const orphanGraceDays = assetOrphanGraceSeconds / (24 * 60 * 60);

const processorJobDeadlineSeconds = PROCESSOR_CONTAINER_TIMEOUT_MS / 1_000 - 60;

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

interface ProcessingSource {
  bytes: number;
  contentType: string;
  key: string;
  objectId: string;
}

interface ProfileReservation {
  readonly charged: number;
  readonly objectId: string;
  readonly profile: string;
  readonly readyKey: string;
  readonly renditionId: string;
  readonly stagingKey: string;
  readonly writeHoldUntil: number;
}

interface ProcessedOutput {
  bytes: number;
  contentType: string;
  durationSeconds: number | null;
  etag: string | null;
  height: number | null;
  sha256: string | null;
  width: number | null;
}

function asJobError(cause: unknown): RetryableJobError | TerminalJobError {
  if (cause instanceof NativeProcessorError) {
    return cause.retryable
      ? new RetryableJobError({ cause: cause.code, message: cause.message })
      : new TerminalJobError({ code: cause.code, message: cause.message });
  }
  return new RetryableJobError({
    cause: cause instanceof Error ? cause.name : "processor_error",
    message: errorMessage(cause, String(cause)),
  });
}

function bytesOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function profileForAsset(
  asset: AssetProcessingRow,
): Effect.Effect<NativeProcessorProfile, TerminalJobError> {
  if (asset.asset_type === "video") return Effect.succeed(videoProfile);
  if (asset.asset_type === "image") return Effect.succeed(imageProfile);
  return Effect.fail(
    new TerminalJobError({
      code: "unsupported_asset_type",
      message: `Media of type "${asset.asset_type}" cannot be processed.`,
    }),
  );
}

function processingStagingKey(organizationId: string, assetId: string, profile: string): string {
  return `staging/${readyObjectKey(organizationId, assetId, `processing-${profile}`)}`;
}

function renditionReadyKey(organizationId: string, assetId: string, profile: string): string {
  return readyObjectKey(organizationId, assetId, `rendition-${profile}`);
}

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

function deleteObject(objectStore: ObjectStore, key: string): Effect.Effect<boolean, never> {
  return Effect.match(deleteStorageObjectEffect(objectStore, key, { checkBeforeDelete: true }), {
    onFailure: () => false,
    onSuccess: () => true,
  });
}

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

interface CapacityWindow {
  ceiling: number | null;
  charged: number;
}

function lockCapacityWindow(
  client: EffectTransactionClient,
  organizationId: string,
): Effect.Effect<CapacityWindow, TerminalJobError> {
  return Effect.gen(function* () {
    const capacityReadFailed = () =>
      new TerminalJobError({
        code: "capacity_read_failed",
        message: "This workspace's storage usage could not be confirmed. Try again.",
      });
    const organization = yield* client
      .query<{ id: string }>(`SELECT id FROM organizations WHERE id = $1 FOR UPDATE`, [
        organizationId,
      ])
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

function reserveProtectedCopy(
  env: AutomationEnv,
  asset: AssetProcessingRow,
  destination: {
    key: string;
    kind: "original" | "rendition";
    releaseFrom?: {
      bytes: number;
      expectedReservedBytes: number;
      objectId: string;
    } | null;
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
          releasedBytes =
            destination.releaseFrom.expectedReservedBytes - destination.releaseFrom.bytes;
        }
      }
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
            PROCESSOR_CAPABILITY_TTL_SECONDS,
          ],
        );
      }
      const held = yield* client.query<{ id: string; write_hold_until: Date }>(
        `UPDATE asset_objects
         SET write_hold_until = GREATEST(
               COALESCE(write_hold_until, now()),
               now() + make_interval(secs => $2)
             ),
             updated_at = now()
         WHERE asset_id = $1 AND r2_key = $3 AND status = 'writing'
         RETURNING id, write_hold_until`,
        [asset.id, PROCESSOR_CAPABILITY_TTL_SECONDS, destination.key],
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

function resolveSource(
  env: AutomationEnv,
  objectStore: ObjectStore,
  asset: AssetProcessingRow,
): Effect.Effect<ProcessingSource, Error> {
  return Effect.gen(function* () {
    const originalKey = readyObjectKey(asset.org_id, asset.id, "original");
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
    if (pinnedSourceSha && verified.sha256 && pinnedSourceSha !== verified.sha256) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "source_checksum_changed",
          message:
            "The uploaded file's checksum changed after verification. Upload the file again.",
        }),
      );
    }

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

    const objectId = reserved.objectId;

    return {
      bytes: sourceBytes,
      contentType: sourceRow.content_type,
      key: originalKey,
      objectId,
    } satisfies ProcessingSource;
  });
}

function reserveOutputs(
  env: AutomationEnv,
  asset: AssetProcessingRow,
  profile: NativeProcessorProfile,
): Effect.Effect<ProfileReservation, Error> {
  return withSystemTransactionEffect(env, (client) =>
    Effect.gen(function* () {
      const window = yield* lockCapacityWindow(client, asset.org_id);
      const { ceiling, charged } = window;
      const fileCeiling = mediaUploadMaximum(asset.mime_type);
      if (fileCeiling === null) {
        return yield* Effect.fail(
          new TerminalJobError({
            code: "declared_media_type_unsupported",
            message: "The uploaded file's media type cannot be processed.",
          }),
        );
      }
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
      const adoptedBytes = bytesOf(adoptedReservation?.bytes);
      const adoptedReserved = bytesOf(adoptedReservation?.reserved_bytes);
      const needsReservation = !reusesReservation || (adoptedBytes < 1 && adoptedReserved < 1);
      const reservationBytes =
        adoptedBytes > 0
          ? adoptedBytes
          : adoptedReserved > 0
            ? adoptedReserved
            : Math.min(fileCeiling, headroom);
      if (needsReservation && reservationBytes < 1) {
        return yield* Effect.fail(
          new TerminalJobError({
            code: "storage_limit_reached",
            message:
              "Optimizing this file needs storage space that is not available. Remove other media and try again.",
          }),
        );
      }

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
            PROCESSOR_CAPABILITY_TTL_SECONDS,
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
        return yield* Effect.fail(
          new RetryableJobError({
            cause: "reservation_already_settled",
            message: "A previous processing attempt already settled this reservation.",
          }),
        );
      }

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
        [objectRow.id, PROCESSOR_CAPABILITY_TTL_SECONDS, reservationBytes],
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

function adoptInterruptedOutput(
  env: AutomationEnv,
  objectStore: ObjectStore,
  asset: AssetProcessingRow,
  reservation: ProfileReservation,
): Effect.Effect<
  | { readonly output: ProcessedOutput; readonly reservation: ProfileReservation }
  | { readonly output: null; readonly reservation: ProfileReservation },
  Error
> {
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
      return {
        output: null,
        reservation: {
          ...reservation,
          charged: rearmed.reservedBytes,
          writeHoldUntil: rearmed.writeHoldUntil,
        },
      };
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
      return {
        output: null,
        reservation: {
          ...reservation,
          charged: rearmed.reservedBytes,
          writeHoldUntil: rearmed.writeHoldUntil,
        },
      };
    }
    return { output: recorded, reservation };
  });
}

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
          return {
            reservedBytes: bytesOf(row.reserved_bytes),
            writeHoldUntil: existingHold ?? Date.now(),
          };
        }
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
          [reservation.objectId, fileCeiling, PROCESSOR_CAPABILITY_TTL_SECONDS],
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

function produceRendition(
  env: AutomationEnv,
  objectStore: ObjectStore,
  asset: AssetProcessingRow,
  source: ProcessingSource,
  initialReservation: ProfileReservation,
  profile: NativeProcessorProfile,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    let reservation = initialReservation;
    const adopted = yield* adoptInterruptedOutput(env, objectStore, asset, reservation);
    reservation = adopted.reservation;
    let output = adopted.output;

    if (!output) {
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
      }).pipe(Effect.mapError(asJobError));
      if (reservation.writeHoldUntil <= Date.now()) {
        return yield* Effect.fail(
          new RetryableJobError({
            cause: "write_hold_elapsed",
            message:
              "The processing window elapsed while capabilities were being minted; the attempt will retry.",
          }),
        );
      }
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
      yield* recordVerifiedOutput(env, reservation, output);
    }

    yield* promoteAndCommit(env, objectStore, asset, reservation, output);
  });
}

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
    if (verdict.output.sha256 && live.sha256 && verdict.output.sha256 !== live.sha256) {
      return yield* Effect.fail(
        new TerminalJobError({
          code: "output_checksum_mismatch",
          message: "The processed file did not match the checksum the processor reported.",
        }),
      );
    }
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
      etag: live.etag,
      height: verdict.media.height,
      sha256: verdict.output.sha256,
      width: verdict.media.width,
    };
  });
}

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

const demotedOriginalSuperseded = {
  code: "original_superseded",
  message: "The committed optimized rendition superseded this unverified original reference.",
} as const;

function settleDemotedOriginalRendition(
  client: EffectTransactionClient,
  assetId: string,
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
      [assetId, failure.code, failure.message],
    )
    .pipe(Effect.asVoid);
}

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
    const readyReservation = yield* reserveProtectedCopy(env, asset, {
      key: reservation.readyKey,
      kind: "rendition",
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
        yield* client.query(
          `UPDATE asset_objects
           SET status = 'superseded', reserved_bytes = NULL,
               etag = $2, updated_at = now()
           WHERE id = $1 AND status = 'writing' AND bytes IS NOT NULL`,
          [reservation.objectId, ready.etag],
        );
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
        yield* settleDemotedOriginalRendition(client, asset.id, demotedOriginalSuperseded);
        yield* markAssetReady(client, asset, output);
      }),
    ).pipe(Effect.mapError(asError));
  });
}

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
      yield* client.query(
        `UPDATE asset_objects
         SET status = 'superseded', updated_at = now()
         WHERE id = $1 AND status = 'writing'`,
        [reservation.objectId],
      );
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
      yield* settleDemotedOriginalRendition(client, asset.id, demotedOriginalSuperseded);
      yield* markAssetReady(client, asset, {
        durationSeconds: media.duration_seconds,
        height: media.height,
        width: media.width,
      });
    }),
  ).pipe(Effect.mapError(asError));
}

function retireStaging(env: AutomationEnv, assetId: string): Effect.Effect<void, Error> {
  return withSystemTransactionEffect(env, (client) =>
    client.query(
      `UPDATE asset_objects
       SET status = 'superseded',
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

export function failAssetInTransaction(
  client: EffectTransactionClient,
  assetId: string,
  reservation: Pick<ProfileReservation, "objectId" | "renditionId"> | undefined,
  failure: { code: string; message: string },
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    yield* client.query(`SELECT id FROM assets WHERE id = $1 FOR UPDATE`, [assetId]);
    if (reservation) {
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
        [reservation.renditionId, failure.code, failure.message],
      );
    } else {
      yield* client.query(
        `UPDATE asset_renditions
         SET status = 'failed', failure_code = $2, failure_message = $3,
             failure_at = now(), updated_at = now()
         WHERE asset_id = $1 AND status = 'processing'`,
        [assetId, failure.code, failure.message],
      );
    }
    yield* client.query(
      `UPDATE asset_objects
       SET status = 'superseded', updated_at = now()
       WHERE asset_id = $1
         AND status = 'writing'
         AND reserved_bytes IS NOT NULL`,
      [assetId],
    );
    yield* settleDemotedOriginalRendition(client, assetId, failure);
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
      [assetId, failure.code, failure.message, orphanGraceDays],
    );
  });
}

function markAssetFailed(
  env: AutomationEnv,
  asset: AssetProcessingRow,
  reservation: ProfileReservation | undefined,
  cause: TerminalJobError,
): Effect.Effect<void, Error> {
  return withSystemTransactionEffect(env, (client) =>
    failAssetInTransaction(client, asset.id, reservation, {
      code: cause.code,
      message: cause.message,
    }),
  ).pipe(Effect.mapError(asError));
}

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
    const profile = yield* profileForAsset(asset);
    const resolved = yield* Effect.result(resolveSource(env, objectStore, asset));
    if (Result.isFailure(resolved)) {
      if (resolved.failure instanceof TerminalJobError) {
        yield* markAssetFailed(env, asset, undefined, resolved.failure);
      }
      return yield* Effect.fail(resolved.failure);
    }
    const source = resolved.success;

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
      yield* withSystemTransactionEffect(env, (client) =>
        Effect.gen(function* () {
          yield* client.query(`SELECT id FROM assets WHERE id = $1 FOR UPDATE`, [asset.id]);
          yield* settleDemotedOriginalRendition(client, asset.id, demotedOriginalSuperseded);
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
      if (produced.failure instanceof TerminalJobError) {
        yield* markAssetFailed(env, asset, reserved.success, produced.failure);
      }
      return yield* Effect.fail(produced.failure);
    }
    yield* retireStaging(env, asset.id);
    return "processed" as const;
  }).pipe(Effect.mapError((cause) => classifyJobError(cause)));
}

export function releaseStaleProcessingStaging(
  env: AutomationEnv,
  objectStore: ObjectStore,
  bound: number,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
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
    const cleanup = yield* deleteObjectsAndSettleEffect(env, objectStore, stale, {
      checkBeforeDelete: true,
    }).pipe(Effect.mapError(asError));
    return cleanup.deletedObjects;
  });
}
