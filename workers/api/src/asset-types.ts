import type { Effect } from "effect";
import type { SessionClaims } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import { isoDateTime } from "@meltiply/domain";
import type {
  DatabaseError,
  DomainError,
  InvalidRequestError,
  NotFoundError,
  StorageUnavailableError,
} from "@meltiply/domain";

import type { CoreApiError } from "./core-types";
import type { ApiWorkerEnv } from "./env";

type Schemas = components["schemas"];

/** Shared media read projection; PostgreSQL numeric columns may arrive as strings. */
export interface AssetRow extends Record<string, unknown> {
  asset_type: Schemas["AssetType"];
  brand_profile_id: string;
  created_at: Date | string;
  duration_sec: number | string | null;
  failure_at: Date | string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_retryable: boolean | null;
  file_size: number | string | null;
  has_live_session?: boolean;
  height: number | string | null;
  id: string;
  mime_type: string | null;
  org_id: string;
  original_filename: string | null;
  status: Schemas["AssetStatus"];
  title: string;
  updated_at: Date | string;
  uploaded_by: string | null;
  width: number | string | null;
}

/** Converts PostgreSQL numeric values, preserving null for unmeasured media facts. */
function number(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Projects stored media for both Asset reads and ordered Post attachments.
 * Numeric strings become numbers and timestamps become ISO dates; incomplete
 * failures remain null. Signed URLs stay absent until a scoped storage request.
 */
export function mapAsset(row: AssetRow): Schemas["Asset"] {
  return {
    asset_type: row.asset_type,
    brand_profile_id: row.brand_profile_id,
    created_at: isoDateTime(row.created_at),
    download_url: null,
    duration_sec: number(row.duration_sec),
    failure:
      row.failure_code && row.failure_message && row.failure_at
        ? {
            code: row.failure_code,
            last_occurred_at: isoDateTime(row.failure_at),
            message: row.failure_message,
            retryable: row.failure_retryable ?? false,
          }
        : null,
    file_size: number(row.file_size),
    height: number(row.height),
    id: row.id,
    mime_type: row.mime_type,
    org_id: row.org_id,
    status: row.status,
    thumbnail_url: null,
    title: row.title,
    updated_at: isoDateTime(row.updated_at),
    uploaded_by: row.uploaded_by,
    width: number(row.width),
  };
}

/** Completed-upload result: the Asset's new lifecycle state plus replay status. */
interface AssetResult {
  replayed: boolean;
  value: Schemas["Asset"];
}

interface UploadSessionResult {
  replayed: boolean;
  value: Schemas["UploadSessionResponse"];
}

export type AssetServiceError =
  | CoreApiError
  | DomainError
  | DatabaseError
  | StorageUnavailableError
  | InvalidRequestError
  | NotFoundError;

/**
 * Effect-first application service interface managing tenant asset lifecycle, uploads, and presigned URLs.
 */
export interface AssetApiService {
  abortUploadSession(
    env: ApiWorkerEnv,
    session: SessionClaims,
    sessionId: string,
    idempotencyKey: string,
  ): Effect.Effect<{ replayed: boolean }, AssetServiceError>;
  completeUploadSession(
    env: ApiWorkerEnv,
    session: SessionClaims,
    sessionId: string,
    input: Schemas["CompleteUploadRequest"],
    idempotencyKey: string,
    requestId?: string,
  ): Effect.Effect<AssetResult, AssetServiceError>;
  createUploadPartUrls(
    env: ApiWorkerEnv,
    session: SessionClaims,
    sessionId: string,
    input: Schemas["CreateUploadPartsRequest"],
    idempotencyKey: string,
  ): Effect.Effect<Schemas["CreateUploadPartsResponse"], AssetServiceError>;
  createUploadSession(
    env: ApiWorkerEnv,
    session: SessionClaims,
    input: Schemas["CreateUploadSessionRequest"],
    idempotencyKey: string,
    requestId?: string,
  ): Effect.Effect<UploadSessionResult, AssetServiceError>;
  getAsset(
    env: ApiWorkerEnv,
    session: SessionClaims,
    assetId: string,
  ): Effect.Effect<Schemas["Asset"], AssetServiceError>;
  getAssetDownloadUrl(
    env: ApiWorkerEnv,
    session: SessionClaims,
    assetId: string,
  ): Effect.Effect<Schemas["SignedUrlResponse"], AssetServiceError>;
  getAssetPreviewUrl(
    env: ApiWorkerEnv,
    session: SessionClaims,
    assetId: string,
  ): Effect.Effect<Schemas["SignedUrlResponse"], AssetServiceError>;
  getUploadSession(
    env: ApiWorkerEnv,
    session: SessionClaims,
    sessionId: string,
  ): Effect.Effect<Schemas["UploadSessionDetailResponse"], AssetServiceError>;
}
