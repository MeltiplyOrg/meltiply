import { integrationDatabaseUrl } from "../../../scripts/lib/integration-database";
import { createHash } from "node:crypto";

import type { JwtIdentity } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import type { Queryable } from "@meltiply/database";
import {
  ASSET_UPLOAD_POLICY,
  errorMessage,
  InvalidRequestError,
  COMMUNITY_LIMITS,
  mediaUploadMaximum,
  NotFoundError,
  StorageUnavailableError,
} from "@meltiply/domain";
import { ProviderRegistry } from "@meltiply/providers";
import {
  createStorageServiceTest,
  type MultipartUpload,
  type ObjectMetadata,
  type ObjectStore,
  R2SigV4Signer,
} from "@meltiply/storage";
import { Effect, Exit } from "effect";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type * as Domain from "@meltiply/domain";

vi.mock("@meltiply/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof Domain>()),
  COMMUNITY_LIMITS: {
    max_distributions: 30,
    max_platforms: 2,
    max_storage_bytes: 1024 * 1024 * 1024,
    max_uploads: 10,
  },
}));

import { createApiApp } from "../src/app";
import { createAssetApiService } from "../src/asset-service";
import { createCoreApiService } from "../src/core-service";
import { authenticatedPoolFor, systemPoolFor, withSystemTransactionEffect } from "../src/database";
import type { ApiWorkerEnv, ApiWorkerEnvironment } from "../src/env";
import { createPostApiService } from "../src/post-service";
import { createAssetJobProcessor } from "../../automation/src/assets";
import type { AutomationEnv } from "../../automation/src/env";
import type { NativeProcessorJob } from "../../automation/src/native-processor";
import type { OutboxMessage } from "../../automation/src/messages";

type Schemas = components["schemas"];
type Post = Schemas["Post"];

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;

const seededUserId = "10000000-0000-4000-8000-000000000001";

const storageCap = (() => {
  const cap = COMMUNITY_LIMITS.max_storage_bytes;
  if (cap === null || !Number.isFinite(cap) || cap <= 0) {
    throw new Error("The bounded-policy fixture requires a finite storage allowance.");
  }
  return cap;
})();

const probeBytes = 8192;

function mediaCeiling(contentType: string): number {
  const ceiling = mediaUploadMaximum(contentType);
  if (ceiling === null) {
    throw new Error(`${contentType} must declare an upload ceiling`);
  }
  return ceiling;
}

const imageCeilingBytes = mediaCeiling("image/png");

const apiEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString: integrationDatabaseUrl(process.env.MELTIPLY_DATABASE_TEST_URL, "system"),
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "upload-quota-test",
} satisfies ApiWorkerEnv;

const r2BucketName = "meltiply-quota-test";
const automationEnv = {
  DB_SYSTEM: apiEnv.DB_SYSTEM,
  ENVIRONMENT: "test",
  R2_ACCESS_KEY_ID: "quota-test-access-key",
  R2_ACCOUNT_ID: "quota-test-account",
  R2_BUCKET_NAME: r2BucketName,
  R2_SECRET_ACCESS_KEY: "quota-test-secret-key",
  VERSION: "upload-quota-test",
} satisfies AutomationEnv;

const capabilities = new ProviderRegistry()
  .capabilities()
  .map((capability) =>
    capability.platform === "threads" ? { ...capability, publish: true } : capability,
  );

const uploadSigner = new R2SigV4Signer({
  accessKeyId: "quota-test-access-key",
  accountId: "quota-test-account",
  bucket: r2BucketName,
  secretAccessKey: "quota-test-secret-key",
});

interface SignGate {
  entered: Promise<void>;
  release(): void;
}

let pausedSign: { notify(): void; wait: Promise<void> } | undefined;

function pauseNextUploadSign(): SignGate {
  if (pausedSign) {
    throw new Error("a deferred sign gate is already armed");
  }
  let notify!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  pausedSign = { notify, wait };
  return {
    entered,
    release: () => {
      pausedSign = undefined;
      resume();
    },
  };
}

async function gateUploadSign(): Promise<void> {
  const gate = pausedSign;
  pausedSign = undefined;
  if (gate) {
    gate.notify();
    await gate.wait;
  }
}

function signedUploadCall<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({
    catch: (cause) =>
      cause instanceof InvalidRequestError
        ? cause
        : new InvalidRequestError({
            message: errorMessage(cause, "Failed to sign an upload capability"),
          }),
    try: async () => {
      await gateUploadSign();
      return operation();
    },
  });
}

function platformDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function signedUrlDeadlineMs(url: string): number {
  const params = new URL(url).searchParams;
  const stamped = params.get("X-Amz-Date");
  const expires = params.get("X-Amz-Expires");
  if (!stamped || !expires) {
    throw new Error("the URL is not a SigV4-signed capability");
  }
  const iso = `${stamped.slice(0, 4)}-${stamped.slice(4, 6)}-${stamped.slice(
    6,
    8,
  )}T${stamped.slice(9, 11)}:${stamped.slice(11, 13)}:${stamped.slice(13, 15)}Z`;
  return Date.parse(iso) + Number(expires) * 1_000;
}

function signedGrantDeadlineMs(url: string, declaredExpiresAtMs: number): number {
  const deadline = signedUrlDeadlineMs(url);
  expect(deadline).toBeLessThanOrEqual(declaredExpiresAtMs);
  expect(deadline).toBeGreaterThan(declaredExpiresAtMs - 2_000);
  return deadline;
}

function bucketOperation<A>(
  operation: () => Promise<A>,
): Effect.Effect<A, StorageUnavailableError> {
  return Effect.tryPromise({
    catch: (cause) =>
      new StorageUnavailableError({
        message: errorMessage(cause, "The object storage operation could not be completed."),
      }),
    try: operation,
  });
}

const storageServiceLayer = createStorageServiceTest({
  createMultipartUpload: (key, contentType) =>
    Effect.sync(() => {
      const uploadId = `upload-${key}`;
      return {
        abort: () => bucketOperation(() => multipartUpload(key, uploadId).abort()),
        complete: (parts) =>
          bucketOperation(() => multipartUpload(key, uploadId, contentType).complete(parts)),
        uploadId,
        uploadPart: (partNumber, value) =>
          bucketOperation(() =>
            multipartUpload(key, uploadId, contentType).uploadPart(partNumber, value),
          ),
      };
    }),
  delete: (key) =>
    Effect.try({
      catch: () =>
        new StorageUnavailableError({
          message: "The stored object could not be removed.",
        }),
      try: () => {
        removeObject(key);
      },
    }),
  getMetadata: (key) =>
    Effect.suspend(() => {
      const metadata = metadataOf(key);
      return metadata
        ? Effect.succeed(metadata)
        : Effect.fail(new NotFoundError({ message: "The stored object is absent." }));
    }),
  head: (key) => Effect.sync(() => metadataOf(key)),
  readPrefix: (key, maximumBytes) =>
    Effect.sync(() => objects.get(key)?.bytes.subarray(0, maximumBytes) ?? null),
  readRange: (key, offset, maximumBytes) =>
    Effect.sync(() => {
      const bytes = objects.get(key)?.bytes;
      return bytes ? bytes.subarray(offset, offset + maximumBytes) : null;
    }),
  resumeMultipartUpload: (key, uploadId) =>
    Effect.sync(() => ({
      abort: () => bucketOperation(() => multipartUpload(key, uploadId).abort()),
      complete: (parts) => bucketOperation(() => multipartUpload(key, uploadId).complete(parts)),
      uploadId,
      uploadPart: (partNumber, value) =>
        bucketOperation(() => multipartUpload(key, uploadId).uploadPart(partNumber, value)),
    })),
  signDownload: ({ key }) => Effect.succeed(`https://objects.test/download/${key}`),
  signMultipartPart: (request) => signedUploadCall(() => uploadSigner.signMultipartPart(request)),
  signUpload: (request) => signedUploadCall(() => uploadSigner.signUpload(request)),
});

const assetService = createAssetApiService({ storageServiceLayer });
const coreService = createCoreApiService(capabilities);
const postService = createPostApiService(capabilities);

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

const objects = new Map<string, StoredObject>();
const deletedKeys: string[] = [];
const abortedUploads: string[] = [];
const deleteFailures = new Set<string>();
const abortFailures = new Set<string>();

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function etagOf(bytes: Uint8Array): string {
  return `"${bytes.length.toString(16)}-${digestOf(bytes).slice(0, 16)}"`;
}

function metadataOf(key: string): ObjectMetadata | null {
  const object = objects.get(key);
  if (!object) return null;
  return {
    contentType: object.contentType,
    etag: etagOf(object.bytes),
    key,
    sha256: digestOf(object.bytes),
    size: object.bytes.length,
    uploadedAt: new Date("2026-08-01T00:00:00.000Z"),
    version: "1",
  };
}

function putObject(key: string, bytes: Uint8Array, contentType: string): void {
  objects.set(key, { bytes, contentType });
}

function copyInBucket(
  sourceKey: string,
  destinationKey: string,
  options?: {
    contentType?: string;
    ifDestinationAbsent?: boolean;
    ifSourceEtagMatches?: string;
  },
): ObjectMetadata | null {
  const source = objects.get(sourceKey);
  if (!source) return null;
  if (
    options?.ifSourceEtagMatches !== undefined &&
    etagOf(source.bytes) !== options.ifSourceEtagMatches
  ) {
    return null;
  }
  if (options?.ifDestinationAbsent && objects.has(destinationKey)) return null;
  objects.set(destinationKey, {
    bytes: source.bytes,
    contentType: options?.contentType ?? source.contentType,
  });
  return metadataOf(destinationKey);
}

function removeObject(key: string): void {
  if (deleteFailures.has(key)) {
    throw new Error(`injected delete failure for ${key}`);
  }
  deletedKeys.push(key);
  objects.delete(key);
}

const multipartParts = new Map<string, Map<number, Uint8Array>>();

function multipartUpload(
  key: string,
  uploadId: string,
  contentType = "application/octet-stream",
): MultipartUpload {
  const parts = multipartParts.get(key) ?? new Map<number, Uint8Array>();
  multipartParts.set(key, parts);
  return {
    abort: async () => {
      if (abortFailures.has(uploadId)) {
        throw new Error("injected abort failure");
      }
      abortedUploads.push(uploadId);
      parts.clear();
    },
    complete: async () => {
      const assembled = Uint8Array.from(
        [...parts.entries()]
          .sort(([left], [right]) => left - right)
          .flatMap(([, bytes]) => [...bytes]),
      );
      putObject(key, assembled, contentType);
      const metadata = metadataOf(key);
      if (!metadata) throw new Error("the assembled object is absent");
      return metadata;
    },
    uploadId,
    uploadPart: async (partNumber, value) => {
      const bytes =
        value instanceof Uint8Array
          ? value
          : value instanceof Blob
            ? new Uint8Array(await value.arrayBuffer())
            : ArrayBuffer.isView(value)
              ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
              : new Uint8Array(value);
      parts.set(partNumber, bytes);
      return { etag: etagOf(bytes), partNumber };
    },
  };
}

const automationObjectStore: ObjectStore = {
  copyObject: async (sourceKey, destinationKey, options) =>
    copyInBucket(sourceKey, destinationKey, options),
  createMultipartUpload: async (key, contentType) =>
    multipartUpload(key, `upload-${key}`, contentType),
  delete: async (key) => {
    removeObject(key);
  },
  head: async (key) => metadataOf(key),
  readPrefix: async (key) => objects.get(key)?.bytes ?? null,
  readRange: async (key, offset, maximumBytes) => {
    const bytes = objects.get(key)?.bytes;
    return bytes ? bytes.subarray(offset, offset + maximumBytes) : null;
  },
  resumeMultipartUpload: (key, uploadId) => multipartUpload(key, uploadId),
};

type EngineMode = "original_compatible" | "retryable_failure";

let engineMode: EngineMode = "original_compatible";
const engineInvocations: string[] = [];

const engineOutputDeadlines: number[] = [];

async function runEngine(job: NativeProcessorJob) {
  engineInvocations.push(job.job_id);
  engineOutputDeadlines.push(signedUrlDeadlineMs(job.output_url));
  if (engineMode === "retryable_failure") {
    return {
      error: {
        code: "engine_container_unavailable",
        message: "The media processor container is still starting.",
        retryable: true,
      },
      ok: false as const,
    };
  }
  const inputKey = decodeURIComponent(new URL(job.input_url).pathname).replace(
    `/${r2BucketName}/`,
    "",
  );
  const source = objects.get(inputKey);
  if (!source) {
    return {
      error: {
        code: "input_unreadable",
        message: "The input capability did not resolve to a stored object.",
        retryable: true,
      },
      ok: false as const,
    };
  }
  const view = new DataView(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength);
  return {
    ok: true as const,
    result: {
      engine: {
        duration_ms: 1,
        ffmpeg: "boundary-double",
        vips: "boundary-double",
      },
      input: { bytes: source.bytes.length, sha256: digestOf(source.bytes) },
      job_id: job.job_id,
      media: {
        animated: false,
        content_type: job.declared_content_type,
        duration_seconds: null,
        frame_count: null,
        has_audio: false,
        height: view.getUint32(20),
        width: view.getUint32(16),
      },
      output: null,
      result: "original_compatible" as const,
      status: "succeeded" as const,
    },
  };
}

const mediaProcessorNamespace: AutomationEnv["MEDIA_PROCESSOR"] = {
  get: () => ({ process: (job: NativeProcessorJob) => runEngine(job) }),
  idFromName: (name: string) => ({ name, toString: () => name, equals: () => false }),
};

const assetProcessor = createAssetJobProcessor(
  { ...automationEnv, MEDIA_PROCESSOR: mediaProcessorNamespace },
  automationObjectStore,
);

interface Studio {
  accountId: string;
  app: Hono<ApiWorkerEnvironment>;
  name: string;
  organizationId: string;
  profileId: string;
  slug: string;
}

const quotaIdentity: JwtIdentity = {
  email: "quota@meltiply.local",
  name: "Quota Studio",
  subject: seededUserId,
};

function createStudio(options: { name: string; suffix: string }): Studio {
  const organizationId = `f5000000-0000-4000-8000-${options.suffix}`;
  const profileId = `f6000000-0000-4000-8000-${options.suffix}`;
  const slug = `quota-${options.suffix}`;
  const accountId = `f7000000-0000-4000-8000-${options.suffix}`;
  return {
    accountId,
    app: createApiApp({
      assetService,
      coreService,
      postService,
      resolveActor: async () => ({
        authUserId: seededUserId,
        claims: {
          organizationId,
          organizationRole: "admin",
          subject: seededUserId,
          userId: seededUserId,
        },
        displayName: "Quota Admin",
        email: `${seededUserId}@example.test`,
        isInstallationOwner: false,
        role: "admin",
        userId: seededUserId,
        workspace: {
          id: organizationId,
          name: options.name,
          slug,
        },
      }),
      verifyJwtToken: async () => quotaIdentity,
    }),
    name: options.name,
    organizationId,
    profileId,
    slug,
  };
}

async function provisionStudio(studio: Studio, accountPlatform?: string): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, $2, $3)`,
      [studio.organizationId, studio.name, studio.slug],
    );
    await client.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')", [
      studio.organizationId,
      seededUserId,
    ]);
    await client.query(
      `INSERT INTO brand_profiles (id, org_id, name, color)
       VALUES ($1, $2, 'Quota Brand', '#1d4ed8')`,
      [studio.profileId, studio.organizationId],
    );
    if (accountPlatform) {
      await client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id, access_token)
         VALUES ($1, $2, $3, $4, $5, 'quota-test-token')`,
        [
          studio.accountId,
          studio.organizationId,
          studio.profileId,
          accountPlatform,
          `quota-${accountPlatform}`,
        ],
      );
    }
    await client.query(
      `INSERT INTO usage_reconciliation_state (org_id, next_reconciliation_at)
       VALUES ($1, now() - INTERVAL '1 minute')
       ON CONFLICT (org_id) DO UPDATE
       SET next_reconciliation_at = EXCLUDED.next_reconciliation_at,
           lease_until = NULL`,
      [studio.organizationId],
    );
  });
}

const reservationStudio = createStudio({
  name: "Reservation Cap Studio",
  suffix: "000000000001",
});
const lifecycleStudio = createStudio({
  name: "Media Lifecycle Studio",
  suffix: "000000000002",
});

function systemTransaction<T>(operation: (client: Queryable) => Promise<T>): Promise<T> {
  return Effect.runPromise(
    withSystemTransactionEffect(apiEnv, (client) =>
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () =>
          operation({
            query: (text, values) => Effect.runPromise(client.query(text, values)),
          }),
      }),
    ),
  );
}

interface ApiResponse {
  body: unknown;
  replayed: boolean;
  status: number;
}

let requestCounter = 0;

function nextKey(prefix: string): string {
  requestCounter += 1;
  return `upload-quota-${prefix}-${requestCounter}`;
}

async function api(
  studio: Studio,
  path: string,
  init: { body?: unknown; idempotencyKey?: string; method?: string } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    Authorization: "Bearer upload-quota.jwt",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const response = await studio.app.request(
    path,
    {
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      headers,
      method: init.method ?? "GET",
    },
    apiEnv,
  );
  return {
    body: await response.json().catch(() => null),
    replayed: response.headers.get("Idempotency-Replayed") === "true",
    status: response.status,
  };
}

function errorOf(body: unknown): { code: string; message: string } {
  if (!body || typeof body !== "object" || !("error" in body)) {
    throw new Error("response body carries no error envelope");
  }
  const envelope: unknown = body.error;
  if (!envelope || typeof envelope !== "object") {
    throw new Error("response error member is not an object");
  }
  const code = "code" in envelope ? String(envelope.code ?? "") : "";
  const message = "message" in envelope ? String(envelope.message ?? "") : "";
  return { code, message };
}

function attachmentIdsOf(body: unknown): string[] {
  if (!body || typeof body !== "object" || !("attachments" in body)) {
    throw new Error("response body has no attachments projection");
  }
  const attachments: unknown = body.attachments;
  if (!Array.isArray(attachments)) {
    throw new Error("attachments projection is not an array");
  }
  const assetIds: string[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object" || !("asset_id" in attachment)) {
      throw new Error("attachment projection is missing asset_id");
    }
    assetIds.push(String(attachment.asset_id));
  }
  return assetIds;
}

async function recordedUsage(studio: Studio): Promise<number> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ storage_bytes: string }>(
      `SELECT storage_bytes::text AS storage_bytes FROM usage_records
       WHERE org_id = $1 AND period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`,
      [studio.organizationId],
    );
    return Number(result.rows[0]?.storage_bytes ?? 0);
  });
}

async function chargedBytes(organizationId: string): Promise<bigint> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ total: string | null }>(
      `SELECT (
         SELECT COALESCE(SUM(GREATEST(COALESCE(object.bytes, 0),
                                       COALESCE(object.reserved_bytes, 0))), 0)
         FROM asset_objects AS object
         WHERE object.org_id = $1 AND object.status <> 'deleted'
       ) + (
         SELECT COALESCE(SUM(reservation.bytes), 0)
         FROM asset_quota_reservations AS reservation
         WHERE reservation.org_id = $1 AND reservation.state = 'reserved'
       )::bigint AS total`,
      [organizationId],
    );
    return BigInt(result.rows[0]?.total ?? "0");
  });
}

async function liveReservations(organizationId: string) {
  return systemTransaction(async (client) => {
    const result = await client.query<{
      bytes: string;
      session_id: string;
      state: string;
    }>(
      `SELECT reservation.session_id, reservation.bytes::text, reservation.state
       FROM asset_quota_reservations AS reservation
       WHERE reservation.org_id = $1 AND reservation.state = 'reserved'
       ORDER BY reservation.created_at, reservation.session_id`,
      [organizationId],
    );
    return result.rows;
  });
}

async function assetState(assetId: string) {
  return systemTransaction(async (client) => {
    const result = await client.query<{
      failure_code: string | null;
      status: string;
    }>("SELECT status, failure_code FROM assets WHERE id = $1", [assetId]);
    return result.rows[0]!;
  });
}

async function objectRows(assetId: string) {
  return systemTransaction(async (client) => {
    const result = await client.query<{
      bytes: string | null;
      kind: string;
      r2_key: string;
      reserved_bytes: string | null;
      status: string;
      write_hold_until: Date | null;
    }>(
      `SELECT kind, r2_key, bytes::text, reserved_bytes::text, status,
              write_hold_until
       FROM asset_objects
       WHERE asset_id = $1
       ORDER BY kind, r2_key`,
      [assetId],
    );
    return result.rows;
  });
}

function pngPayload(size: number, width = 64, height = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.fill(0x2a, 33);
  return bytes;
}

interface BegunUpload {
  assetId: string;
  grantExpiresAt: Date | null;
  grantUrl: string | null;
  objectKey: string;
  sessionId: string;
  strategy: "single" | "multipart";
}

function uploadSessionBody(
  studio: Studio,
  options: { contentType?: string; fileSize: number; title: string },
) {
  const contentType = options.contentType ?? "image/png";
  const extension = contentType === "image/png" ? "png" : "mp4";
  return {
    asset_type: contentType === "image/png" ? ("image" as const) : ("video" as const),
    brand_profile_id: studio.profileId,
    content_type: contentType,
    file_size: options.fileSize,
    filename: `${options.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${extension}`,
    title: options.title,
  };
}

function requestUpload(
  studio: Studio,
  options: { contentType?: string; fileSize: number; title: string },
): Promise<ApiResponse> {
  return api(studio, "/api/v1/asset-upload-sessions", {
    body: uploadSessionBody(studio, options),
    idempotencyKey: nextKey("session"),
    method: "POST",
  });
}

async function beginUpload(
  studio: Studio,
  options: { contentType?: string; fileSize: number; title: string },
): Promise<BegunUpload> {
  const created = await requestUpload(studio, options);
  if (created.status !== 201) {
    throw new Error(
      `upload session creation failed: ${created.status} ${JSON.stringify(created.body)}`,
    );
  }
  const session = created.body as Schemas["UploadSessionResponse"];
  const row = await systemTransaction(async (client) => {
    const result = await client.query<{ object_key: string }>(
      "SELECT object_key FROM asset_upload_sessions WHERE id = $1",
      [session.upload_session.id],
    );
    return result.rows[0]!;
  });
  return {
    assetId: session.asset.id,
    grantExpiresAt: session.upload_session.single_upload?.expires_at
      ? new Date(session.upload_session.single_upload.expires_at)
      : null,
    grantUrl: session.upload_session.single_upload?.url ?? null,
    objectKey: row.object_key,
    sessionId: session.upload_session.id,
    strategy: session.upload_session.strategy,
  };
}

function landBytes(upload: BegunUpload, bytes: Uint8Array): void {
  putObject(upload.objectKey, bytes, "image/png");
}

function finalizeUpload(studio: Studio, upload: BegunUpload): Promise<ApiResponse> {
  return api(studio, `/api/v1/asset-upload-sessions/${upload.sessionId}/complete`, {
    body: {},
    idempotencyKey: nextKey("complete"),
    method: "POST",
  });
}

async function uploadReadyImage(
  studio: Studio,
  title: string,
  size = probeBytes,
): Promise<BegunUpload> {
  const upload = await beginUpload(studio, { fileSize: size, title });
  landBytes(upload, pngPayload(size));
  const completed = await finalizeUpload(studio, upload);
  expect(completed.status).toBe(202);
  return upload;
}

async function lifecycleEventId(assetId: string, topic: string): Promise<string> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id::text FROM outbox_events
       WHERE aggregate_id = $1 AND topic = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [assetId, topic],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`no ${topic} event exists for ${assetId}`);
    return row.id;
  });
}

function outboxMessage(
  eventId: string,
  assetId: string,
  organizationId: string,
  topic: string,
): OutboxMessage {
  return {
    aggregate_id: assetId,
    event_id: eventId,
    organization_id: organizationId,
    payload: { asset_id: assetId },
    topic,
    type: "outbox.event",
    version: 1,
  };
}

async function deliver(message: OutboxMessage): Promise<"failed" | "processed" | "skipped"> {
  const exit = await Effect.runPromiseExit(assetProcessor.process(message));
  return Exit.isSuccess(exit) ? exit.value : "failed";
}

async function deliverProcessing(studio: Studio, assetId: string) {
  const eventId = await lifecycleEventId(assetId, "asset.processing.requested");
  return deliver(
    outboxMessage(eventId, assetId, studio.organizationId, "asset.processing.requested"),
  );
}

async function deliverDeletion(studio: Studio, assetId: string) {
  const eventId = await lifecycleEventId(assetId, "asset.deletion.requested");
  return deliver(
    outboxMessage(eventId, assetId, studio.organizationId, "asset.deletion.requested"),
  );
}

function runMaintenance() {
  return Effect.runPromise(assetProcessor.runMaintenance());
}

interface ResidentInventory {
  original: number;
  rendition: number;
  thumbnail: number;
}

async function seedResidentInventory(
  studio: Studio,
  totalBytes: number,
): Promise<ResidentInventory> {
  const perKind: Array<{ kind: string; profile: string | null; size: number }> = [
    { kind: "original", profile: null, size: 8 * 1024 * 1024 },
    { kind: "thumbnail", profile: null, size: 1024 * 1024 },
    {
      kind: "rendition",
      profile: "image_jpeg_webp_4096_long_edge",
      size: 4 * 1024 * 1024,
    },
  ];
  let remaining = totalBytes - perKind.reduce((sum, entry) => sum + entry.size, 0);
  while (remaining >= imageCeilingBytes) {
    perKind.push({ kind: "original", profile: null, size: imageCeilingBytes });
    remaining -= imageCeilingBytes;
  }
  if (remaining > 0) {
    perKind.push({ kind: "original", profile: null, size: remaining });
  }
  const assetIds = perKind.map(() => crypto.randomUUID());
  await systemTransaction(async (client) => {
    await client.query(
      `INSERT INTO assets
         (id, org_id, brand_profile_id, uploaded_by, asset_type, title, status,
          file_size, mime_type, finalized_at, updated_at)
       SELECT unnest($1::uuid[]), $2, $3, $4, 'image', 'Quota baseline', 'ready',
              1024, 'image/png', now() - INTERVAL '3 days', now()`,
      [assetIds, studio.organizationId, studio.profileId, seededUserId],
    );
    await client.query(
      `INSERT INTO asset_objects
         (org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
          content_type, status)
       SELECT $1::uuid, row.asset_id, $2, row.kind, row.profile,
              $1::text || '/' || row.asset_id::text || '/' || row.kind, row.bytes,
              'image/png', 'ready'
       FROM unnest($3::uuid[], $4::text[], $5::text[], $6::bigint[])
         AS row(asset_id, kind, profile, bytes)`,
      [
        studio.organizationId,
        studio.profileId,
        assetIds,
        perKind.map((entry) => entry.kind),
        perKind.map((entry) => entry.profile),
        perKind.map((entry) => entry.size),
      ],
    );
  });
  const totals: ResidentInventory = { original: 0, rendition: 0, thumbnail: 0 };
  for (const entry of perKind) {
    if (entry.kind === "original") totals.original += entry.size;
    else if (entry.kind === "rendition") totals.rendition += entry.size;
    else totals.thumbnail += entry.size;
  }
  return totals;
}

async function resetStudio(studio: Studio, residentBytes: number): Promise<ResidentInventory> {
  await systemTransaction(async (client) => {
    await client.query("DELETE FROM posts WHERE org_id = $1", [studio.organizationId]);
    await client.query("DELETE FROM asset_upload_sessions WHERE org_id = $1", [
      studio.organizationId,
    ]);
    await client.query("DELETE FROM assets WHERE org_id = $1", [studio.organizationId]);
    await client.query(
      `UPDATE usage_records SET storage_bytes = 0, uploads = 0
       WHERE org_id = $1`,
      [studio.organizationId],
    );
  });
  for (const key of [...objects.keys()]) {
    if (
      key.startsWith(`${studio.organizationId}/`) ||
      key.startsWith(`staging/${studio.organizationId}/`)
    ) {
      objects.delete(key);
    }
  }
  deletedKeys.length = 0;
  abortedUploads.length = 0;
  abortFailures.clear();
  deleteFailures.clear();
  multipartParts.clear();
  engineInvocations.length = 0;
  engineOutputDeadlines.length = 0;
  engineMode = "original_compatible";
  if (residentBytes === 0) return { original: 0, rendition: 0, thumbnail: 0 };
  return seedResidentInventory(studio, residentBytes);
}

async function reclaimSeededObject(
  studio: Studio,
  kind: "rendition" | "thumbnail",
): Promise<number> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ bytes: string }>(
      `UPDATE asset_objects
       SET status = 'deleted', deleted_at = now()
       WHERE id = (
         SELECT id FROM asset_objects
         WHERE org_id = $1 AND kind = $2 AND status = 'ready'
         ORDER BY created_at, id
         LIMIT 1
       )
       RETURNING bytes::text`,
      [studio.organizationId, kind],
    );
    return Number(result.rows[0]?.bytes ?? "0");
  });
}

function makeOrphanDue(assetId: string): Promise<void> {
  return systemTransaction(async (client) => {
    await client.query(
      `UPDATE assets
       SET orphaned_at = now() - INTERVAL '8 days',
           orphan_delete_after = now() - INTERVAL '1 day',
           updated_at = now()
       WHERE id = $1`,
      [assetId],
    );
  });
}

function expireSession(sessionId: string): Promise<void> {
  return systemTransaction(async (client) => {
    await client.query(
      `UPDATE asset_upload_sessions
       SET expires_at = now() - INTERVAL '1 minute', updated_at = now()
       WHERE id = $1`,
      [sessionId],
    );
  });
}

async function sessionExpiry(sessionId: string): Promise<Date> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ expires_at: Date }>(
      "SELECT expires_at FROM asset_upload_sessions WHERE id = $1",
      [sessionId],
    );
    return result.rows[0]!.expires_at;
  });
}

function makeUsageReconciliationDue(organizationId: string): Promise<void> {
  return systemTransaction(async (client) => {
    await client.query(
      `UPDATE usage_reconciliation_state
       SET next_reconciliation_at = now() - INTERVAL '1 minute', lease_until = NULL
       WHERE org_id = $1`,
      [organizationId],
    );
  });
}

function closeGrantWindow(assetId: string): Promise<void> {
  return systemTransaction(async (client) => {
    await client.query(
      `UPDATE asset_objects
       SET updated_at = now() - INTERVAL '1 minute',
           write_hold_until = now() - INTERVAL '1 minute'
       WHERE asset_id = $1 AND kind = 'staging'`,
      [assetId],
    );
  });
}

const seededDueOrphanId = "d0000000-0000-4000-8000-000000000008";
let seededDueOrphanBefore:
  | {
      orphan_delete_after: Date | null;
      orphaned_at: Date | null;
      status: string;
    }
  | undefined;

describeIntegration("workspace storage Entitlements with PostgreSQL", () => {
  beforeAll(async () => {
    await provisionStudio(reservationStudio);
    await provisionStudio(lifecycleStudio, "threads");
    seededDueOrphanBefore = await systemTransaction(async (client) => {
      const result = await client.query<{
        orphan_delete_after: Date | null;
        orphaned_at: Date | null;
        status: string;
      }>("SELECT status, orphaned_at, orphan_delete_after FROM assets WHERE id = $1", [
        seededDueOrphanId,
      ]);
      return result.rows[0];
    });
  });

  afterAll(async () => {
    await resetStudio(reservationStudio, 0);
    await resetStudio(lifecycleStudio, 0);
    await systemTransaction(async (client) => {
      await client.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [
        [reservationStudio.organizationId, lifecycleStudio.organizationId],
      ]);
      if (seededDueOrphanBefore) {
        await client.query("DELETE FROM outbox_events WHERE aggregate_id = $1", [
          seededDueOrphanId,
        ]);
        await client.query(
          `UPDATE assets
           SET status = $2, orphaned_at = $3, orphan_delete_after = $4,
               updated_at = now()
           WHERE id = $1`,
          [
            seededDueOrphanId,
            seededDueOrphanBefore.status,
            seededDueOrphanBefore.orphaned_at,
            seededDueOrphanBefore.orphan_delete_after,
          ],
        );
      }
    });
    await authenticatedPoolFor(apiEnv).end();
    await systemPoolFor(apiEnv).end();
  });

  it("charges a reserved upload once and refuses the next payload with a stable quota error", async () => {
    const baseline = await resetStudio(reservationStudio, storageCap - 2 * probeBytes);
    expect(baseline.original).toBeGreaterThan(0);
    expect(baseline.thumbnail).toBeGreaterThan(0);
    expect(baseline.rendition).toBeGreaterThan(0);
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(
      BigInt(storageCap - 2 * probeBytes),
    );

    const first = await beginUpload(reservationStudio, {
      fileSize: probeBytes,
      title: "Reservation one",
    });
    const second = await beginUpload(reservationStudio, {
      fileSize: probeBytes,
      title: "Reservation two",
    });

    for (const upload of [first, second]) {
      const rows = await objectRows(upload.assetId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe("staging");
      expect(rows[0]!.bytes).toBeNull();
      expect(rows[0]!.reserved_bytes).toBeNull();
    }
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(BigInt(storageCap));

    const refused = await requestUpload(reservationStudio, {
      fileSize: probeBytes,
      title: "One payload too many",
    });
    expect(refused.status).toBe(422);
    expect(errorOf(refused.body).code).toBe("quota_exceeded");

    const repeated = await requestUpload(reservationStudio, {
      fileSize: probeBytes,
      title: "One payload too many again",
    });
    expect(repeated.status).toBe(422);
    expect(errorOf(repeated.body)).toEqual(errorOf(refused.body));
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(BigInt(storageCap));
    expect((await liveReservations(reservationStudio.organizationId)).length).toBe(2);

    const beyond = probeBytes + baseline.thumbnail;
    const beforeReclaim = await requestUpload(reservationStudio, {
      fileSize: beyond,
      title: "Beyond by the thumbnail",
    });
    expect(beforeReclaim.status).toBe(422);
    const released = await reclaimSeededObject(reservationStudio, "thumbnail");
    expect(released).toBe(baseline.thumbnail);
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(
      BigInt(storageCap - baseline.thumbnail),
    );
    const afterReclaim = await requestUpload(reservationStudio, {
      fileSize: baseline.thumbnail,
      title: "Fits once the thumbnail is reclaimed",
    });
    expect(afterReclaim.status).toBe(201);
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(BigInt(storageCap));
  });

  it("admits exactly one of two concurrent reservations at the plan limit", async () => {
    await resetStudio(reservationStudio, storageCap - probeBytes);

    const attempts = await Promise.all([
      requestUpload(reservationStudio, {
        fileSize: probeBytes,
        title: "Concurrent left",
      }),
      requestUpload(reservationStudio, {
        fileSize: probeBytes,
        title: "Concurrent right",
      }),
    ]);
    const statuses = attempts.map((attempt) => attempt.status).sort();
    expect(statuses).toEqual([201, 422]);
    const refusedAttempt = attempts.find((attempt) => attempt.status === 422)!;
    expect(errorOf(refusedAttempt.body).code).toBe("quota_exceeded");

    const reservations = await liveReservations(reservationStudio.organizationId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.state).toBe("reserved");
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(BigInt(storageCap));

    const winner = await systemTransaction(async (client) => {
      const result = await client.query<{ object_key: string }>(
        "SELECT object_key FROM asset_upload_sessions WHERE id = $1",
        [reservations[0]!.session_id],
      );
      return result.rows[0]!.object_key;
    });
    putObject(winner, pngPayload(probeBytes), "image/png");
    const finalized = await api(
      reservationStudio,
      `/api/v1/asset-upload-sessions/${reservations[0]!.session_id}/complete`,
      { body: {}, idempotencyKey: nextKey("complete-winner"), method: "POST" },
    );
    expect(finalized.status).toBe(202);

    expect(await chargedBytes(reservationStudio.organizationId)).toBe(BigInt(storageCap));
    expect((await liveReservations(reservationStudio.organizationId)).length).toBe(0);

    const afterFull = await requestUpload(reservationStudio, {
      fileSize: 1,
      title: "Nothing left",
    });
    expect(afterFull.status).toBe(422);
    expect(errorOf(afterFull.body).code).toBe("quota_exceeded");
  });

  it("keeps a saved draft's ready media charged under the same plan limit", async () => {
    await resetStudio(lifecycleStudio, storageCap - 3 * probeBytes - imageCeilingBytes);

    const usageBefore = await recordedUsage(lifecycleStudio);
    const ready = await uploadReadyImage(lifecycleStudio, "Draft attachment");

    const usageAfterUpload = await recordedUsage(lifecycleStudio);
    expect(usageAfterUpload).toBe(usageBefore + probeBytes);

    expect(await deliverProcessing(lifecycleStudio, ready.assetId)).toBe("processed");
    expect((await assetState(ready.assetId)).status).toBe("ready");
    const chargedWithAttachment = await chargedBytes(lifecycleStudio.organizationId);
    const headroom = Number(BigInt(storageCap) - chargedWithAttachment);
    expect(headroom).toBeGreaterThan(0);

    const post = await api(lifecycleStudio, "/api/v1/posts", {
      body: {
        attachment_ids: [ready.assetId],
        brand_profile_id: lifecycleStudio.profileId,
        default_text: "A draft that keeps its media charged",
        title: "Quota draft",
      },
      idempotencyKey: nextKey("draft"),
      method: "POST",
    });
    expect(post.status).toBe(201);
    expect(attachmentIdsOf(post.body)).toEqual([ready.assetId]);
    const postId = (post.body as Post).id;

    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedWithAttachment);
    const refused = await requestUpload(lifecycleStudio, {
      fileSize: headroom + 1,
      title: "Draft exempt attempt",
    });
    expect(refused.status).toBe(422);
    expect(errorOf(refused.body).code).toBe("quota_exceeded");

    const exactFit = await beginUpload(lifecycleStudio, {
      fileSize: headroom,
      title: "Draft exact fit",
    });
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(storageCap));

    const resaved = await api(lifecycleStudio, `/api/v1/posts/${postId}`, {
      body: {
        brand_profile_id: lifecycleStudio.profileId,
        default_text: "A draft that keeps its media charged, revised",
      },
      idempotencyKey: nextKey("draft-resave"),
      method: "PATCH",
    });
    expect(resaved.status).toBe(200);
    expect(attachmentIdsOf(resaved.body)).toEqual([ready.assetId]);
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(storageCap));

    const cancelled = await api(
      lifecycleStudio,
      `/api/v1/asset-upload-sessions/${exactFit.sessionId}`,
      { idempotencyKey: nextKey("abort-exact-fit"), method: "DELETE" },
    );
    expect(cancelled.status).toBe(204);
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(storageCap));
    const cancelledRow = (await objectRows(exactFit.assetId))[0]!;
    expect(cancelledRow.status).toBe("deleting");
    expect(cancelledRow.reserved_bytes).toBe(String(headroom));

    await closeGrantWindow(exactFit.assetId);
    await makeOrphanDue(exactFit.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, exactFit.assetId)).toBe("processed");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedWithAttachment);
    expect((await objectRows(ready.assetId)).some((row) => row.kind === "original")).toBe(true);
  });

  it("reserves output capacity atomically for concurrent processors", async () => {
    await resetStudio(lifecycleStudio, storageCap - 4 * probeBytes - imageCeilingBytes);
    const left = await uploadReadyImage(lifecycleStudio, "Processing left");
    const right = await uploadReadyImage(lifecycleStudio, "Processing right");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(
      BigInt(storageCap - 2 * probeBytes - imageCeilingBytes),
    );

    engineMode = "retryable_failure";
    engineInvocations.length = 0;
    const outcomes = await Promise.all([
      deliverProcessing(lifecycleStudio, left.assetId),
      deliverProcessing(lifecycleStudio, right.assetId),
    ]);
    expect([...outcomes].sort()).toEqual(["failed", "processed"]);

    expect(engineInvocations).toHaveLength(1);

    const writingRows = await Promise.all(
      [left, right].map(async (upload) => ({
        assetId: upload.assetId,
        rows: (await objectRows(upload.assetId)).filter(
          (row) => row.kind === "rendition" && row.status === "writing",
        ),
      })),
    );
    const held = writingRows.filter((entry) => entry.rows.length === 1);
    const refused = writingRows.filter((entry) => entry.rows.length === 0);
    expect(held).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const heldRow = held[0]!.rows[0]!;
    expect(BigInt(heldRow.reserved_bytes ?? "0")).toBe(BigInt(imageCeilingBytes));
    expect(heldRow.bytes).toBeNull();
    expect(engineOutputDeadlines).toHaveLength(1);
    expect(heldRow.write_hold_until).not.toBeNull();
    const outputGrantDeadline = engineOutputDeadlines[0]!;
    expect(outputGrantDeadline).toBeLessThanOrEqual(heldRow.write_hold_until!.getTime());
    expect(heldRow.write_hold_until!.getTime() - outputGrantDeadline).toBeLessThan(10_000);

    const loser = await assetState(refused[0]!.assetId);
    expect(loser.status).toBe("failed");
    expect(loser.failure_code).toBe("storage_limit_reached");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(storageCap));

    expect(await deliverProcessing(lifecycleStudio, refused[0]!.assetId)).toBe("skipped");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(storageCap));
  });

  it("preserves the authoritative Post when an upload, save, or schedule is rejected", async () => {
    await resetStudio(lifecycleStudio, 0);
    const readyOne = await uploadReadyImage(lifecycleStudio, "Authoritative one");
    const readyTwo = await uploadReadyImage(lifecycleStudio, "Authoritative two");
    for (const upload of [readyOne, readyTwo]) {
      expect(await deliverProcessing(lifecycleStudio, upload.assetId)).toBe("processed");
    }

    const created = await api(lifecycleStudio, "/api/v1/posts", {
      body: {
        attachment_ids: [readyOne.assetId, readyTwo.assetId],
        brand_profile_id: lifecycleStudio.profileId,
        default_text: "Authoritative composition",
        targets: [
          {
            description_override: "Channel caption",
            platform_account_id: lifecycleStudio.accountId,
            title_override: "Channel title",
          },
        ],
        title: "Authoritative draft",
      },
      idempotencyKey: nextKey("authoritative-create"),
      method: "POST",
    });
    expect(created.status).toBe(201);
    const postId = (created.body as Post).id;
    const before = await api(lifecycleStudio, `/api/v1/posts/${postId}`);
    expect(before.status).toBe(200);
    const chargedBefore = await chargedBytes(lifecycleStudio.organizationId);

    const emptied = await api(lifecycleStudio, `/api/v1/posts/${postId}`, {
      body: {
        attachment_ids: [],
        brand_profile_id: lifecycleStudio.profileId,
        default_text: "",
        targets: [],
      },
      idempotencyKey: nextKey("authoritative-empty"),
      method: "PATCH",
    });
    expect(emptied.status).toBe(422);
    expect(errorOf(emptied.body).code).toBe("validation_error");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedBefore);

    const mismatched = await beginUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Rejected finalization",
    });
    landBytes(mismatched, pngPayload(probeBytes / 2));
    const rejectedUpload = await finalizeUpload(lifecycleStudio, mismatched);
    expect(rejectedUpload.status).toBe(422);
    expect(errorOf(rejectedUpload.body).code).toBe("metadata_mismatch");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(
      chargedBefore + BigInt(probeBytes),
    );
    const rejectedState = await assetState(mismatched.assetId);
    expect(rejectedState.status).toBe("failed");
    expect(rejectedState.failure_code).toBe("metadata_mismatch");
    const rejectedRow = (await objectRows(mismatched.assetId))[0]!;
    expect(rejectedRow.status).toBe("deleting");
    expect(rejectedRow.bytes).toBeNull();
    expect(rejectedRow.reserved_bytes).toBe(String(probeBytes));
    expect(objects.has(mismatched.objectKey)).toBe(true);
    expect(rejectedRow.write_hold_until).not.toBeNull();
    expect(
      Math.abs(rejectedRow.write_hold_until!.getTime() - mismatched.grantExpiresAt!.getTime()),
    ).toBeLessThanOrEqual(1_000);

    await closeGrantWindow(mismatched.assetId);
    await makeOrphanDue(mismatched.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, mismatched.assetId)).toBe("processed");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedBefore);
    expect(objects.has(mismatched.objectKey)).toBe(false);

    const unprocessed = await uploadReadyImage(lifecycleStudio, "Still processing");
    const secondDraft = await api(lifecycleStudio, "/api/v1/posts", {
      body: {
        attachment_ids: [unprocessed.assetId],
        brand_profile_id: lifecycleStudio.profileId,
        default_text: "Draft awaiting media",
      },
      idempotencyKey: nextKey("authoritative-second"),
      method: "POST",
    });
    expect(secondDraft.status).toBe(201);
    const secondId = (secondDraft.body as Post).id;
    const chargedBeforeSchedule = await chargedBytes(lifecycleStudio.organizationId);
    const refusedSchedule = await api(lifecycleStudio, `/api/v1/posts/${secondId}/schedule`, {
      body: {
        brand_profile_id: lifecycleStudio.profileId,
        scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
        targets: [{ platform_account_id: lifecycleStudio.accountId }],
      },
      idempotencyKey: nextKey("authoritative-schedule"),
      method: "POST",
    });
    expect(refusedSchedule.status).toBe(409);
    expect(errorOf(refusedSchedule.body).code).toBe("asset_not_ready");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedBeforeSchedule);

    const after = await api(lifecycleStudio, `/api/v1/posts/${postId}`);
    expect(after.status).toBe(200);
    expect(attachmentIdsOf(after.body)).toEqual(attachmentIdsOf(before.body));
    const afterPost = after.body as Post;
    const beforePost = before.body as Post;
    expect(afterPost.default_text).toBe(beforePost.default_text);
    expect(afterPost.title).toBe(beforePost.title);
    expect(afterPost.targets).toEqual(beforePost.targets);
    expect(afterPost.status).toBe(beforePost.status);
  });

  it("cancels an upload, reclaims its staged bytes, and frees only its reservation", async () => {
    await resetStudio(lifecycleStudio, storageCap - 2 * probeBytes);
    const cancelled = await beginUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Cancelled upload",
    });
    landBytes(cancelled, pngPayload(probeBytes));
    const kept = await beginUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Kept upload",
    });
    landBytes(kept, pngPayload(probeBytes));

    const abort = await api(
      lifecycleStudio,
      `/api/v1/asset-upload-sessions/${cancelled.sessionId}`,
      { idempotencyKey: nextKey("cancel"), method: "DELETE" },
    );
    expect(abort.status).toBe(204);

    expect(objects.has(cancelled.objectKey)).toBe(false);
    expect(deletedKeys).toContain(cancelled.objectKey);
    const blockedWhileHeld = await requestUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Blocked while the grant is live",
    });
    expect(blockedWhileHeld.status).toBe(422);
    expect(errorOf(blockedWhileHeld.body).code).toBe("quota_exceeded");
    const cancelledRow = (await objectRows(cancelled.assetId))[0]!;
    expect(cancelledRow.status).toBe("deleting");
    expect(cancelledRow.reserved_bytes).toBe(String(probeBytes));

    expect(cancelled.grantUrl).not.toBeNull();
    expect(cancelled.grantExpiresAt).not.toBeNull();
    signedGrantDeadlineMs(cancelled.grantUrl!, cancelled.grantExpiresAt!.getTime());
    const cancelledHold = cancelledRow.write_hold_until;
    expect(cancelledHold).not.toBeNull();
    expect(
      Math.abs(cancelledHold!.getTime() - cancelled.grantExpiresAt!.getTime()),
    ).toBeLessThanOrEqual(1_000);
    expect(cancelledHold!.getTime()).toBeLessThan(
      (await sessionExpiry(cancelled.sessionId)).getTime() - 60_000,
    );

    const duplicate = await api(
      lifecycleStudio,
      `/api/v1/asset-upload-sessions/${cancelled.sessionId}`,
      { idempotencyKey: nextKey("cancel-again"), method: "DELETE" },
    );
    expect(duplicate.status).toBe(204);
    const liveSessionIds = (await liveReservations(lifecycleStudio.organizationId)).map(
      (reservation) => reservation.session_id,
    );
    expect(liveSessionIds).toEqual([kept.sessionId]);

    const cancelledState = await assetState(cancelled.assetId);
    expect(cancelledState.status).toBe("failed");
    expect(cancelledState.failure_code).toBe("upload_aborted");

    await closeGrantWindow(cancelled.assetId);
    await makeOrphanDue(cancelled.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, cancelled.assetId)).toBe("processed");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(
      BigInt(storageCap - probeBytes),
    );
    const reused = await beginUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Reuses freed capacity",
    });
    expect(reused.sessionId).not.toBe(cancelled.sessionId);

    deleteFailures.add(kept.objectKey);
    const failingAbort = await api(
      lifecycleStudio,
      `/api/v1/asset-upload-sessions/${kept.sessionId}`,
      { idempotencyKey: nextKey("cancel-failing-delete"), method: "DELETE" },
    );
    expect(failingAbort.status).toBe(204);
    expect(objects.has(kept.objectKey)).toBe(true);
    const keptHeld = (await objectRows(kept.assetId))[0]!;
    expect(keptHeld.status).toBe("deleting");
    expect(keptHeld.write_hold_until).not.toBeNull();
    expect(
      Math.abs(keptHeld.write_hold_until!.getTime() - kept.grantExpiresAt!.getTime()),
    ).toBeLessThanOrEqual(1_000);
    deleteFailures.delete(kept.objectKey);
    await closeGrantWindow(kept.assetId);
    await makeOrphanDue(kept.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, kept.assetId)).toBe("processed");
    expect(objects.has(kept.objectKey)).toBe(false);
    expect((await assetState(kept.assetId)).status).toBe("deleted");
  });

  it("never mints a single-PUT grant past the recorded deadline when signing stalls across a cancel", async () => {
    await resetStudio(lifecycleStudio, 0);
    const upload = await beginUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Deferred grant",
    });
    landBytes(upload, pngPayload(probeBytes));
    const sessionEnds = await sessionExpiry(upload.sessionId);

    const gate = pauseNextUploadSign();
    const read = api(lifecycleStudio, `/api/v1/asset-upload-sessions/${upload.sessionId}`);
    await gate.entered;
    const abort = await api(lifecycleStudio, `/api/v1/asset-upload-sessions/${upload.sessionId}`, {
      idempotencyKey: nextKey("cancel-deferred"),
      method: "DELETE",
    });
    expect(abort.status).toBe(204);
    await platformDelay(1_200);
    gate.release();

    const detail = (await read).body as Schemas["UploadSessionDetailResponse"];
    const refreshed = detail.upload_session.single_upload;
    if (detail.upload_session.status === "aborted") {
      expect(refreshed).toBeNull();
    } else {
      expect(refreshed).not.toBeNull();
      expect(signedUrlDeadlineMs(refreshed!.url)).toBeLessThanOrEqual(
        Date.parse(refreshed!.expires_at),
      );
      expect(Date.parse(refreshed!.expires_at)).toBeLessThan(sessionEnds.getTime() - 60_000);
    }

    const stagedRow = (await objectRows(upload.assetId))[0]!;
    expect(stagedRow.status).toBe("deleting");
    expect(stagedRow.write_hold_until).not.toBeNull();
    expect(stagedRow.write_hold_until!.getTime()).toBeLessThan(sessionEnds.getTime() - 60_000);
    if (refreshed) {
      expect(signedUrlDeadlineMs(refreshed.url)).toBeLessThanOrEqual(
        stagedRow.write_hold_until!.getTime(),
      );
    }
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(probeBytes));

    await closeGrantWindow(upload.assetId);
    await makeOrphanDue(upload.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, upload.assetId)).toBe("processed");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(0n);
  });

  it("expires an abandoned session, releases its reservation, and reclaims once", async () => {
    await resetStudio(lifecycleStudio, storageCap - 3 * probeBytes);
    const abandoned = await beginUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Abandoned session",
    });
    landBytes(abandoned, pngPayload(probeBytes));
    const survivor = await beginUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Surviving upload",
    });
    landBytes(survivor, pngPayload(probeBytes));

    await expireSession(abandoned.sessionId);
    const next = await beginUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "After expiry",
    });
    expect(next.sessionId).not.toBe(abandoned.sessionId);

    const sessions = (await liveReservations(lifecycleStudio.organizationId)).map(
      (reservation) => reservation.session_id,
    );
    expect(sessions).not.toContain(abandoned.sessionId);
    expect(sessions).toContain(next.sessionId);
    expect(sessions).toContain(survivor.sessionId);
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(storageCap));
    const stillFull = await requestUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Still full",
    });
    expect(stillFull.status).toBe(422);
    expect(errorOf(stillFull.body).code).toBe("quota_exceeded");
    const expiredState = await assetState(abandoned.assetId);
    expect(expiredState.status).toBe("failed");
    expect(expiredState.failure_code).toBe("upload_session_expired");
    const expiredRow = (await objectRows(abandoned.assetId))[0]!;
    expect(expiredRow.status).toBe("deleting");
    expect(expiredRow.reserved_bytes).toBe(String(probeBytes));
    expect(objects.has(abandoned.objectKey)).toBe(true);
    expect(expiredRow.write_hold_until).not.toBeNull();
    expect(
      Math.abs(expiredRow.write_hold_until!.getTime() - abandoned.grantExpiresAt!.getTime()),
    ).toBeLessThanOrEqual(1_000);

    await closeGrantWindow(abandoned.assetId);
    await makeOrphanDue(abandoned.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, abandoned.assetId)).toBe("processed");
    expect(objects.has(abandoned.objectKey)).toBe(false);
    expect((await assetState(abandoned.assetId)).status).toBe("deleted");
    const chargedAfterReclaim = await chargedBytes(lifecycleStudio.organizationId);
    expect(chargedAfterReclaim).toBe(BigInt(storageCap - probeBytes));

    expect(await deliverDeletion(lifecycleStudio, abandoned.assetId)).toBe("skipped");
    await runMaintenance();
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedAfterReclaim);
    expect((await objectRows(survivor.assetId))[0]!.status).toBe("writing");
    expect(objects.has(survivor.objectKey)).toBe(true);
  });

  it("reclaims a confirmed-abort multipart upload immediately while a failed abort retains the charge", async () => {
    await resetStudio(lifecycleStudio, 0);
    const multipartBytes = ASSET_UPLOAD_POLICY.multipartThresholdBytes + 1;
    const session = await beginUpload(lifecycleStudio, {
      contentType: "video/mp4",
      fileSize: multipartBytes,
      title: "Abandoned multipart",
    });
    expect(session.strategy).toBe("multipart");
    const parts = await api(
      lifecycleStudio,
      `/api/v1/asset-upload-sessions/${session.sessionId}/parts`,
      {
        body: { part_numbers: [1, 2] },
        idempotencyKey: nextKey("parts"),
        method: "POST",
      },
    );
    expect(parts.status).toBe(200);
    const partResponse = parts.body as Schemas["CreateUploadPartsResponse"];
    const partGrants = partResponse.parts;
    expect(partGrants).toHaveLength(2);
    const partDeadline = Date.parse(partGrants[0]!.expires_at);
    for (const grant of partGrants) {
      expect(Date.parse(grant.expires_at)).toBe(partDeadline);
      expect(signedUrlDeadlineMs(grant.url)).toBeLessThanOrEqual(partDeadline + 1_000);
    }
    expect(partDeadline).toBeLessThan((await sessionExpiry(session.sessionId)).getTime() - 60_000);

    const abort = await api(lifecycleStudio, `/api/v1/asset-upload-sessions/${session.sessionId}`, {
      idempotencyKey: nextKey("multipart-abort"),
      method: "DELETE",
    });
    expect(abort.status).toBe(204);

    expect(abortedUploads).toContain(`upload-${session.objectKey}`);
    expect(objects.has(session.objectKey)).toBe(false);
    expect(
      (await liveReservations(lifecycleStudio.organizationId)).map(
        (reservation) => reservation.session_id,
      ),
    ).not.toContain(session.sessionId);
    const heldRow = (await objectRows(session.assetId))[0]!;
    expect(heldRow.status).toBe("deleting");
    expect(heldRow.reserved_bytes).toBe(String(multipartBytes));
    expect(heldRow.write_hold_until).not.toBeNull();
    expect(heldRow.write_hold_until!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(multipartBytes));

    const duplicate = await api(
      lifecycleStudio,
      `/api/v1/asset-upload-sessions/${session.sessionId}`,
      { idempotencyKey: nextKey("multipart-abort-again"), method: "DELETE" },
    );
    expect(duplicate.status).toBe(204);
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(multipartBytes));

    await makeOrphanDue(session.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, session.assetId)).toBe("processed");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(0n);

    const failed = await beginUpload(lifecycleStudio, {
      contentType: "video/mp4",
      fileSize: multipartBytes,
      title: "Failed abort",
    });
    expect(failed.strategy).toBe("multipart");
    const failedParts = await api(
      lifecycleStudio,
      `/api/v1/asset-upload-sessions/${failed.sessionId}/parts`,
      {
        body: { part_numbers: [1, 2] },
        idempotencyKey: nextKey("parts-failed"),
        method: "POST",
      },
    );
    expect(failedParts.status).toBe(200);
    const failedResponse = failedParts.body as Schemas["CreateUploadPartsResponse"];
    const failedDeadline = Date.parse(failedResponse.parts[0]!.expires_at);
    abortFailures.add(`upload-${failed.objectKey}`);
    const failedAbort = await api(
      lifecycleStudio,
      `/api/v1/asset-upload-sessions/${failed.sessionId}`,
      { idempotencyKey: nextKey("multipart-abort-fails"), method: "DELETE" },
    );
    expect(failedAbort.status).toBe(204);
    expect(abortedUploads).not.toContain(`upload-${failed.objectKey}`);
    const failedRow = (await objectRows(failed.assetId))[0]!;
    expect(failedRow.status).toBe("deleting");
    expect(failedRow.reserved_bytes).toBe(String(multipartBytes));
    expect(failedRow.write_hold_until).not.toBeNull();
    expect(Math.abs(failedRow.write_hold_until!.getTime() - failedDeadline)).toBeLessThanOrEqual(
      1_000,
    );
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(multipartBytes));

    abortFailures.delete(`upload-${failed.objectKey}`);
    await closeGrantWindow(failed.assetId);
    await makeOrphanDue(failed.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, failed.assetId)).toBe("processed");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(0n);
  });

  it("keeps resident object bytes counted across a monthly period rollover", async () => {
    await resetStudio(lifecycleStudio, storageCap - probeBytes);

    await makeUsageReconciliationDue(lifecycleStudio.organizationId);
    await runMaintenance();
    expect(await recordedUsage(lifecycleStudio)).toBe(storageCap - probeBytes);

    await systemTransaction(async (client) => {
      await client.query(
        `UPDATE usage_records SET storage_bytes = 0, uploads = 0
         WHERE org_id = $1 AND period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`,
        [lifecycleStudio.organizationId],
      );
    });
    expect(await recordedUsage(lifecycleStudio)).toBe(0);

    const refused = await requestUpload(lifecycleStudio, {
      fileSize: probeBytes + 1,
      title: "Rollover attempt",
    });
    expect(refused.status).toBe(422);
    expect(errorOf(refused.body).code).toBe("quota_exceeded");

    await makeUsageReconciliationDue(lifecycleStudio.organizationId);
    await runMaintenance();
    const afterRollover = await recordedUsage(lifecycleStudio);
    expect(afterRollover).toBe(storageCap - probeBytes);
  });
  it("accepts community uploads and processing beyond finite-policy allowances", async () => {
    const boundedPolicy = { ...COMMUNITY_LIMITS };
    try {
      const community = await vi.importActual<typeof Domain>("@meltiply/domain");
      Object.assign(COMMUNITY_LIMITS, community.COMMUNITY_LIMITS);
      const residentBytes = 2 * 1024 * 1024 * 1024;
      await resetStudio(reservationStudio, residentBytes);
      await systemTransaction(async (client) => {
        await client.query(
          `INSERT INTO usage_records (org_id, period, uploads)
           VALUES ($1, to_char(now(), 'YYYY-MM'), 1000)
           ON CONFLICT (org_id, period) DO UPDATE SET uploads = EXCLUDED.uploads`,
          [reservationStudio.organizationId],
        );
      });
      const uploads = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          beginUpload(reservationStudio, {
            fileSize: probeBytes,
            title: `Community upload ${index}`,
          }),
        ),
      );
      expect(await chargedBytes(reservationStudio.organizationId)).toBe(
        BigInt(residentBytes + 12 * probeBytes),
      );
      expect(await liveReservations(reservationStudio.organizationId)).toHaveLength(12);

      const first = uploads[0]!;
      landBytes(first, pngPayload(probeBytes));
      expect((await finalizeUpload(reservationStudio, first)).status).toBe(202);
      expect(await deliverProcessing(reservationStudio, first.assetId)).toBe("processed");
      expect((await assetState(first.assetId)).status).toBe("ready");
      expect(await liveReservations(reservationStudio.organizationId)).toHaveLength(11);
      expect(await chargedBytes(reservationStudio.organizationId)).toBe(
        BigInt(residentBytes + 13 * probeBytes + imageCeilingBytes),
      );
    } finally {
      Object.assign(COMMUNITY_LIMITS, boundedPolicy);
    }
  });
});
