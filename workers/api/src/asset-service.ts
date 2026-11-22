import { Effect, Layer, Option } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import {
  ActiveOrganizationRequiredError,
  ASSET_UPLOAD_POLICY,
  AssetPolicyError,
  assetOrphanGraceSeconds,
  type DatabaseError,
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
import { CoreApiError, toCoreApiErrorOrRethrow } from "./core-types";
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
  file_size, mime_type, width, height, status, failure_code,
  failure_message, failure_retryable, failure_at, created_at, updated_at
`;

const orphanGraceDays = assetOrphanGraceSeconds / (24 * 60 * 60);

const stillUploading = "status IN ('pending_upload', 'uploading')";
const notBeingDeleted = "status NOT IN ('deleting', 'deleted')";

function orphanClockAssignments(assetId: string, graceDays: string): string {
  const retained = `EXISTS (SELECT 1 FROM post_attachments WHERE asset_id = ${assetId})`;
  return `orphaned_at = CASE WHEN ${retained} THEN NULL ELSE now() END,
          orphan_delete_after = CASE
            WHEN ${retained} THEN NULL
            ELSE now() + make_interval(days => ${graceDays})
          END`;
}

function failAssetEffect(
  client: EffectTransactionClient,
  assetId: string,
  failure: { code: string; message: string; retryable: boolean },
  eligibleStatus: typeof stillUploading | typeof notBeingDeleted,
): Effect.Effect<boolean, DatabaseError> {
  return client
    .query(
      `UPDATE assets
       SET status = 'failed',
           failure_code = $2,
           failure_message = $3,
           failure_retryable = $4,
           failure_at = now(),
           ${orphanClockAssignments("$1", "$5")},
           updated_at = now()
       WHERE id = $1 AND ${eligibleStatus}`,
      [assetId, failure.code, failure.message, failure.retryable, orphanGraceDays],
    )
    .pipe(Effect.map((result) => result.rowCount === 1));
}

function markSessionAbortedEffect(
  client: EffectTransactionClient,
  sessionId: string,
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `UPDATE asset_upload_sessions
       SET status = 'aborted', aborted_at = now(), updated_at = now()
       WHERE id = $1`,
      [sessionId],
    )
    .pipe(Effect.asVoid);
}

function recordCompletionFailureEffect(
  client: EffectTransactionClient,
  row: UploadSessionRow,
  idempotencyKey: string,
  error: CoreApiError,
): Effect.Effect<void, DatabaseError> {
  return completeIdempotencyEffect(
    client,
    row.org_id,
    "completeUploadSession",
    idempotencyKey,
    error.status,
    {
      asset_id: row.asset_id,
      error: { code: error.code, message: error.message, status: error.status },
    },
  );
}

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

function policyError(cause: unknown): never {
  if (!(cause instanceof AssetPolicyError)) throw cause;
  const status =
    cause.code === "payload_too_large" ? 413 : cause.code === "unsupported_media_type" ? 415 : 400;
  throw new CoreApiError(status, cause.code, cause.message);
}

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

const SESSION_EXPIRY_FAILURE_CODE = "upload_session_expired";
const SESSION_EXPIRY_FAILURE_MESSAGE = "The upload session expired before completion.";

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
    yield* releaseReservationToStagingEffect(client, sessionId, assetId);
    yield* markStagedObjectDeletingEffect(client, assetId, {
      writersClosed: true,
    });
    yield* failAssetEffect(
      client,
      assetId,
      {
        code: SESSION_EXPIRY_FAILURE_CODE,
        message: SESSION_EXPIRY_FAILURE_MESSAGE,
        retryable: true,
      },
      stillUploading,
    );
  });
}

function markStagedObjectDeletingEffect(
  client: EffectTransactionClient,
  assetId: string,
  options: { writersClosed: boolean },
): Effect.Effect<void, DatabaseError> {
  return client
    .query(
      `UPDATE asset_objects
       SET status = 'deleting',
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

function organizationUsageEffect(
  client: EffectTransactionClient,
  periodKey: string,
  currentInstant: Date = new Date(),
): Effect.Effect<OrganizationUsageRow, ActiveOrganizationRequiredError | DatabaseError> {
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
         UPDATE asset_objects AS object
         SET status = 'deleting',
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
          ${orphanClockAssignments("asset.id", "$4")},
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
        new ActiveOrganizationRequiredError({
          message: "The authenticated identity is not an active organization member.",
        }),
      );
    }
    if (!row.user_id) {
      return yield* Effect.fail(
        new ActiveOrganizationRequiredError({
          message: "The authenticated user has not been synchronized.",
        }),
      );
    }
    return row;
  });
}
function getAssetRowEffect(
  client: EffectTransactionClient,
  assetId: string,
  options: {
    requireActiveProfile?: boolean;
  } = {},
): Effect.Effect<AssetRow, CoreApiError | DatabaseError> {
  const selectSql = options.requireActiveProfile
    ? `SELECT ${assetColumns}
       FROM assets
       WHERE id = $1
         AND org_id = public.auth_active_org_id()
         AND status != 'deleted'
         AND ${activeBrandProfilePredicate("assets.brand_profile_id")}`
    : `SELECT ${assetColumns}
       FROM assets
       WHERE id = $1
         AND org_id = public.auth_active_org_id()
         AND status != 'deleted'`;
  return Effect.gen(function* () {
    const result = yield* client.query<AssetRow>(selectSql, [assetId]);
    const row = result.rows[0];
    if (!row) {
      return yield* Effect.fail(new CoreApiError(404, "not_found", "The asset was not found."));
    }
    return row;
  });
}

function lockAssetStatusEffect(
  client: EffectTransactionClient,
  assetId: string,
  requireActiveProfile = false,
): Effect.Effect<AssetRow["status"], CoreApiError | DatabaseError> {
  const lockSql = requireActiveProfile
    ? `SELECT status FROM assets
       WHERE id = $1 AND org_id = public.auth_active_org_id() AND status != 'deleted'
         AND ${activeBrandProfilePredicate("assets.brand_profile_id")}
       FOR UPDATE`
    : `SELECT status FROM assets
       WHERE id = $1 AND org_id = public.auth_active_org_id() AND status != 'deleted'
       FOR UPDATE`;
  return Effect.gen(function* () {
    const result = yield* client.query<Pick<AssetRow, "status">>(lockSql, [assetId]);
    const row = result.rows[0];
    if (!row) {
      return yield* Effect.fail(new CoreApiError(404, "not_found", "The asset was not found."));
    }
    return row.status;
  });
}

function getReadyMediaAssetRowEffect(
  env: ApiWorkerEnv,
  session: SessionClaims,
  assetId: string,
  download: boolean,
): Effect.Effect<
  { title: string; original_filename: string | null; protected_key: string },
  CoreApiError | DatabaseError | ActiveOrganizationRequiredError
> {
  return withTenantTransactionEffect(env, session, (client) =>
    Effect.gen(function* () {
      const result = yield* client.query<
        Pick<AssetRow, "title" | "status" | "asset_type" | "mime_type"> & {
          original_filename: string | null;
        }
      >(
        `SELECT title, original_filename, status, asset_type, mime_type
         FROM assets
         WHERE id = $1 AND org_id = public.auth_active_org_id()
           AND status != 'deleted'
           AND ${activeBrandProfilePredicate("assets.brand_profile_id")}`,
        [assetId],
      );
      const asset = result.rows[0];
      if (!asset) {
        return yield* Effect.fail(new CoreApiError(404, "not_found", "The asset was not found."));
      }
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
      return {
        title: asset.title,
        original_filename: asset.original_filename,
        protected_key: protectedKey,
      };
    }),
  );
}

function getSessionRowEffect(
  client: EffectTransactionClient,
  sessionId: string,
  lock = false,
): Effect.Effect<UploadSessionRow, CoreApiError | DatabaseError> {
  const sessionSql = lock
    ? `SELECT
         id, org_id, asset_id, strategy, status, content_type, file_size,
         object_key, multipart_upload_id, part_size, part_count,
         max_parallel_parts, expires_at
       FROM asset_upload_sessions
       WHERE id = $1 AND org_id = public.auth_active_org_id()
       FOR UPDATE`
    : `SELECT
         id, org_id, asset_id, strategy, status, content_type, file_size,
         object_key, multipart_upload_id, part_size, part_count,
         max_parallel_parts, expires_at
       FROM asset_upload_sessions
       WHERE id = $1 AND org_id = public.auth_active_org_id()`;
  return Effect.gen(function* () {
    const result = yield* client.query<UploadSessionRow>(sessionSql, [sessionId]);
    const row = result.rows[0];
    if (!row) {
      return yield* Effect.fail(
        new CoreApiError(404, "not_found", "The upload session was not found."),
      );
    }
    return row;
  });
}

function ensureActiveSession(row: UploadSessionRow, now: Date): void {
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    throw new CoreApiError(409, "upload_session_expired", "The upload session has expired.");
  }
  if (!["created", "uploading"].includes(row.status)) {
    throw new CoreApiError(409, "invalid_state", `The upload session is ${row.status}.`);
  }
}

function signedExpiry(now: Date, sessionExpiry: Date): Date {
  return new Date(
    Math.min(
      sessionExpiry.getTime(),
      now.getTime() + ASSET_UPLOAD_POLICY.signedUrlTtlSeconds * 1_000,
    ),
  );
}

function partSize(row: UploadSessionRow, partNumber: number): number {
  const configured = Number(row.part_size);
  return partNumber === row.part_count
    ? Number(row.file_size) - configured * (row.part_count - 1)
    : configured;
}

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

function failMetadataMismatchEffect(
  client: EffectTransactionClient,
  row: UploadSessionRow,
  code: string,
  message: string,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    yield* failAssetEffect(
      client,
      row.asset_id,
      { code, message, retryable: false },
      notBeingDeleted,
    );
    yield* client.query(
      `UPDATE asset_upload_sessions
       SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1`,
      [row.id],
    );
    yield* releaseReservationToStagingEffect(client, row.id, row.asset_id);
    yield* markStagedObjectDeletingEffect(client, row.asset_id, {
      writersClosed: row.strategy === "multipart",
    });
  });
}

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

export function createAssetApiService(options: AssetServiceOptions = {}): AssetApiService {
  const now = options.now ?? (() => new Date());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const optionsStorageLayer =
    options.storageServiceLayer ??
    (options.storageService ? Layer.succeed(StorageService, options.storageService) : undefined);

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

  function planSingleUploadGrantEffect(
    client: EffectTransactionClient,
    sessionId: string,
    current: Date,
    lockedRow?: UploadSessionRow,
  ): Effect.Effect<{ grantDeadline: Date | null; row: UploadSessionRow }, AssetServiceError> {
    return Effect.gen(function* () {
      const row = lockedRow ?? (yield* getSessionRowEffect(client, sessionId, true));
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
      return { grantDeadline: recorded ? grantDeadline : null, row };
    });
  }

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
            catch: toCoreApiErrorOrRethrow,
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
                const sessionResult = yield* client.query<UploadSessionRow>(
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
                const plan = yield* planSingleUploadGrantEffect(
                  client,
                  sessionId,
                  current,
                  sessionResult.rows[0],
                );
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
              const plan = yield* planSingleUploadGrantEffect(client, row.id, current, row);
              const parts =
                row.strategy === "multipart"
                  ? (yield* client.query<UploadPartRow>(
                      `SELECT part_number, etag, size
                           FROM asset_upload_parts
                           WHERE session_id = $1
                           ORDER BY part_number`,
                      [row.id],
                    )).rows
                  : [];
              const assetRow = yield* getAssetRowEffect(client, plan.row.asset_id, {
                requireActiveProfile: true,
              });
              return {
                asset: mapAsset(assetRow),
                grantDeadline: plan.grantDeadline,
                parts,
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
                catch: toCoreApiErrorOrRethrow,
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
              const assetStatus = yield* lockAssetStatusEffect(client, row.asset_id, true);
              if (assetStatus === "deleting" || assetStatus === "deleted") {
                return yield* Effect.fail(
                  new CoreApiError(409, "invalid_state", "The asset is being deleted."),
                );
              }
              yield* Effect.try({
                try: () => ensureActiveSession(row, completionTime),
                catch: toCoreApiErrorOrRethrow,
              });
              const parts = yield* Effect.try({
                try: () => validateCompletedParts(row, input.parts),
                catch: toCoreApiErrorOrRethrow,
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
                    yield* markSessionAbortedEffect(client, row.id);
                    yield* releaseReservationToStagingEffect(client, row.id, row.asset_id);
                    yield* markStagedObjectDeletingEffect(client, row.asset_id, {
                      writersClosed: false,
                    });
                    yield* failAssetEffect(
                      client,
                      row.asset_id,
                      { code: storageError.code, message: storageError.message, retryable: true },
                      notBeingDeleted,
                    );
                    yield* recordCompletionFailureEffect(client, row, idempotencyKey, storageError);
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
                  yield* recordCompletionFailureEffect(client, row, idempotencyKey, metadataError);
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
                     ${orphanClockAssignments("$1", "$6")},
                     failure_code = NULL,
                     failure_message = NULL,
                     failure_retryable = NULL,
                     failure_at = NULL,
                     updated_at = now()
                 WHERE id = $1
                   AND ${notBeingDeleted}
                   AND EXISTS (
                     SELECT 1 FROM asset_objects
                      WHERE asset_id = $1
                        AND kind = 'staging'
                        AND status = 'writing'
                        AND bytes IS NULL
                   )
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
                const stagingLost = yield* failAssetEffect(
                  client,
                  row.asset_id,
                  {
                    code: "missing_object",
                    message: "The staged upload record is no longer reclaimable.",
                    retryable: false,
                  },
                  notBeingDeleted,
                );
                const terminalError = stagingLost
                  ? new CoreApiError(
                      422,
                      "missing_object",
                      "The staged upload record is no longer reclaimable.",
                    )
                  : new CoreApiError(409, "invalid_state", "The asset is being deleted.");
                yield* markSessionAbortedEffect(client, row.id);
                yield* releaseReservationToStagingEffect(client, row.id, row.asset_id);
                yield* recordCompletionFailureEffect(client, row, idempotencyKey, terminalError);
                return {
                  asset: null,
                  error: terminalError,
                  replayed: false,
                  retryable: false,
                };
              }
              yield* client.query(
                `UPDATE asset_objects
                 SET bytes = $1,
                     etag = $2,
                     version = $3,
                     sha256 = $4,
                     content_type = $5,
                     status = 'ready',
                     write_hold_until = CASE
                       WHEN $7 THEN now()
                       ELSE write_hold_until
                     END,
                     updated_at = now()
                 WHERE asset_id = $6
                   AND kind = 'staging'
                   AND status = 'writing'
                   AND bytes IS NULL`,
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
              yield* lockAssetStatusEffect(client, row.asset_id);
              yield* markSessionAbortedEffect(client, row.id);
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
                Effect.catch((cause) =>
                  cause instanceof StorageConfigurationError
                    ? Effect.fail(cause)
                    : Effect.succeed(false),
                ),
              );
          } else {
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
              yield* releaseReservationToStagingEffect(client, row.id, row.asset_id);
              yield* markStagedObjectDeletingEffect(client, row.asset_id, { writersClosed });
              yield* failAssetEffect(
                client,
                row.asset_id,
                {
                  code: "upload_aborted",
                  message: "The upload was cancelled.",
                  retryable: true,
                },
                stillUploading,
              );
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

    getAssetDownloadUrl(env, session, assetId) {
      return withStorage(env, signReadyMediaAssetUrlEffect(env, session, assetId, true));
    },

    getAssetPreviewUrl(env, session, assetId) {
      return withStorage(env, signReadyMediaAssetUrlEffect(env, session, assetId, false));
    },
  };
  return service;
}
