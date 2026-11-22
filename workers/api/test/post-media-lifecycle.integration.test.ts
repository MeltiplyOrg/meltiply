import { integrationDatabaseUrl } from "../../../scripts/lib/integration-database";
import type { JwtIdentity } from "@meltiply/auth";
import { fakeDurableObjectNamespace } from "../test-support/fakes";
import type { components } from "@meltiply/contracts/schema";
import type { Queryable } from "@meltiply/database";
import { NotFoundError } from "@meltiply/domain";
import { createThreadsAdapter, ProviderRegistry } from "@meltiply/providers";
import {
  createStorageServiceTest,
  type EffectMultipartUpload,
  type MultipartUpload,
  type ObjectMetadata,
  type ObjectStore,
} from "@meltiply/storage";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createApiApp } from "../src/app";
import { createAssetApiService } from "../src/asset-service";
import { createCoreApiService } from "../src/core-service";
import { authenticatedPoolFor, systemPoolFor, withSystemTransactionEffect } from "../src/database";
import type { ApiWorkerEnv } from "../src/env";
import { createPostApiService } from "../src/post-service";
import { createAssetJobProcessor, type AssetMaintenanceResult } from "../../automation/src/assets";
import { systemPoolFor as automationSystemPoolFor } from "../../automation/src/database";
import type { AutomationEnv, MediaProcessorStub } from "../../automation/src/env";
import type { OutboxMessage } from "../../automation/src/messages";
import type {
  MediaProcessorRpcOutcome,
  NativeProcessorFailure,
  NativeProcessorJob,
} from "../../automation/src/native-processor";

type Schemas = components["schemas"];
type Asset = Schemas["Asset"];
type Post = Schemas["Post"];
type UploadSessionResponse = Schemas["UploadSessionResponse"];
type AssetTopic = "asset.deletion.requested" | "asset.processing.requested";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;
const systemConnectionString = integrationDatabaseUrl(
  process.env.MELTIPLY_DATABASE_TEST_URL,
  "system",
);

const organizationId = "9f100000-0000-4000-8000-000000000001";
const brandProfileId = "9f100000-0000-4000-8000-000000000002";
const threadsAccountId = "9f100000-0000-4000-8000-000000000003";
const membershipId = "9f100000-0000-4000-8000-000000000004";
const userId = "10000000-0000-4000-8000-000000000001";
const subject = "auth_user_local_alpha";
const slug = "lifecycle-studio";
const daySeconds = 86_400;

const foreignOrganizationId = "9f100000-0000-4000-8000-000000000011";
const foreignBrandProfileId = "9f100000-0000-4000-8000-000000000012";
const foreignAssetId = "9f100000-0000-4000-8000-000000000013";
const foreignSlug = "lifecycle-foreign";

const baselineStorageBytes = 5_000_000;

const providerRegistry = new ProviderRegistry();
providerRegistry.register(
  "threads",
  createThreadsAdapter({
    clientId: "lifecycle-threads-client",
    clientSecret: "lifecycle-threads-client-secret",
    redirectUri: "https://lifecycle.invalid/oauth/threads/callback",
  }),
);
const capabilities = providerRegistry.capabilities();

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

function storageHarness() {
  const objects = new Map<string, StoredObject>();
  const abortedUploads: string[] = [];
  const createOnlyKeys: string[] = [];
  const deleteFailures = new Set<string>();

  const sha256Of = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
  const etagOf = (value: Uint8Array): string =>
    `"${createHash("md5").update(value).digest("hex")}"`;
  const metadataOf = (key: string): ObjectMetadata | null => {
    const object = objects.get(key);
    if (!object) return null;
    return {
      contentType: object.contentType,
      etag: etagOf(object.bytes),
      key,
      sha256: sha256Of(object.bytes),
      size: object.bytes.length,
      uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
  };
  const multipartOf = (key: string, uploadId: string, contentType: string): MultipartUpload => {
    const uploaded = new Map<number, Uint8Array>();
    return {
      abort: async () => {
        abortedUploads.push(uploadId);
      },
      complete: async (completed) => {
        const ordered = [...completed].sort((left, right) => left.partNumber - right.partNumber);
        const value = new Uint8Array(
          ordered.reduce((total, part) => total + (uploaded.get(part.partNumber)?.length ?? 0), 0),
        );
        let offset = 0;
        for (const part of ordered) {
          const chunk = uploaded.get(part.partNumber) ?? new Uint8Array(0);
          value.set(chunk, offset);
          offset += chunk.length;
        }
        objects.set(key, { bytes: value, contentType });
        const metadata = metadataOf(key);
        if (!metadata) throw new Error(`multipart assembly lost ${key}`);
        return metadata;
      },
      uploadId,
      uploadPart: async (partNumber, value) => {
        uploaded.set(partNumber, new Uint8Array(value as ArrayBuffer));
        return {
          etag: `"part-${partNumber}-${sha256Of(uploaded.get(partNumber)!)}"`,
          partNumber,
        };
      },
    };
  };

  const store: ObjectStore = {
    copyObject: async (sourceKey, destinationKey, options) => {
      const source = objects.get(sourceKey);
      if (!source) return null;
      if (
        options?.ifSourceEtagMatches !== undefined &&
        etagOf(source.bytes) !== options.ifSourceEtagMatches
      ) {
        return null;
      }
      if (options?.ifDestinationAbsent && objects.has(destinationKey)) {
        return null;
      }
      objects.set(destinationKey, {
        bytes: source.bytes,
        contentType: options?.contentType ?? source.contentType,
      });
      return metadataOf(destinationKey);
    },
    createMultipartUpload: async (key, contentType) => multipartOf(key, `mpu-${key}`, contentType),
    delete: async (key) => {
      if (deleteFailures.has(key)) {
        throw new Error(`injected storage delete failure for ${key}`);
      }
      objects.delete(key);
    },
    head: async (key) => metadataOf(key),
    readPrefix: async (key, maximumBytes) => {
      const object = objects.get(key);
      return object ? object.bytes.slice(0, maximumBytes) : null;
    },
    readRange: async (key, offset, maximumBytes) => {
      const object = objects.get(key);
      return object ? object.bytes.slice(offset, offset + maximumBytes) : null;
    },
    resumeMultipartUpload: (key, uploadId) =>
      multipartOf(key, uploadId, objects.get(key)?.contentType ?? "video/mp4"),
  };

  const effectMultipart = (
    key: string,
    uploadId: string,
    contentType: string,
  ): EffectMultipartUpload => {
    const inner = multipartOf(key, uploadId, contentType);
    return {
      abort: () => Effect.promise(() => inner.abort()),
      complete: (parts) => Effect.promise(() => inner.complete(parts)),
      uploadId,
      uploadPart: (partNumber, value) => Effect.promise(() => inner.uploadPart(partNumber, value)),
    };
  };

  return {
    abortedUploads,
    bytesAt: (key: string): Uint8Array | undefined => objects.get(key)?.bytes,
    createOnlyKeys,
    deleteFailures,
    effectMultipart,
    keysFor: (assetId: string): string[] =>
      [...objects.keys()]
        .filter(
          (key) =>
            key.startsWith(`${organizationId}/${assetId}/`) ||
            key.startsWith(`staging/${organizationId}/${assetId}/`),
        )
        .sort(),
    metadataOf,
    objects,
    sha256Of,
    protectedKeysFor: (assetId: string): string[] =>
      [...objects.keys()].filter((key) => key.startsWith(`${organizationId}/${assetId}/`)).sort(),
    putBytes: (key: string, bytes: Uint8Array, contentType: string): void => {
      objects.set(key, { bytes, contentType });
    },
    putThroughGrant: (grantUrl: string, bytes: Uint8Array, contentType: string): string => {
      const key = keyFromCapability(grantUrl);
      objects.set(key, { bytes, contentType });
      return key;
    },
    store,
  };
}

const harness = storageHarness();

function keyFromCapability(url: string): string {
  const segments = new URL(url).pathname.split("/").filter((part) => part !== "");
  return decodeURIComponent(segments.slice(1).join("/"));
}

const engine = {
  calls: [] as string[],
  failure: null as NativeProcessorFailure | null,
};

function pngDimensions(bytes: Uint8Array): { height: number; width: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { height: view.getUint32(20), width: view.getUint32(16) };
}

function mediaProcessorNamespace(): DurableObjectNamespace<MediaProcessorStub> {
  const process = async (job: NativeProcessorJob): Promise<MediaProcessorRpcOutcome> => {
    engine.calls.push(job.job_id);
    if (engine.failure) {
      return { error: engine.failure, ok: false };
    }
    const inputKey = keyFromCapability(job.input_url);
    const outputKey = keyFromCapability(job.output_url);
    const source = harness.objects.get(inputKey);
    if (!source) {
      return {
        error: {
          code: "input_unavailable",
          message: "The promoted original could not be read.",
          retryable: true,
        },
        ok: false,
      };
    }
    const contentType = job.profile.kind === "image" ? "image/jpeg" : "video/mp4";
    const header =
      job.profile.kind === "image"
        ? [0xff, 0xd8, 0xff, 0xe0]
        : [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70];
    const body = source.bytes.slice(0, Math.max(4, source.bytes.length >> 2));
    const output = new Uint8Array([...header, ...body]);
    if (harness.objects.has(outputKey)) {
      harness.createOnlyKeys.push(outputKey);
      return {
        error: {
          code: "output_exists",
          message: "The rendition object already exists.",
          retryable: false,
        },
        ok: false,
      };
    }
    harness.createOnlyKeys.push(outputKey);
    harness.objects.set(outputKey, { bytes: output, contentType });
    const dimensions = pngDimensions(source.bytes);
    return {
      ok: true,
      result: {
        engine: {
          duration_ms: 1,
          ffmpeg: "lifecycle-boundary-double",
          vips: "lifecycle-boundary-double",
        },
        input: {
          bytes: source.bytes.length,
          sha256: harness.sha256Of(source.bytes),
        },
        job_id: job.job_id,
        media: {
          animated: false,
          content_type: contentType,
          duration_seconds:
            job.profile.kind === "video" ? containerDurationSeconds(source.bytes) : null,
          frame_count: null,
          has_audio: false,
          height: dimensions.height,
          width: dimensions.width,
        },
        output: {
          bytes: output.length,
          content_type: contentType,
          etag: harness.metadataOf(outputKey)?.etag ?? null,
          sha256: harness.sha256Of(output),
        },
        result: "optimized",
        status: "succeeded",
      },
    };
  };
  return fakeDurableObjectNamespace<MediaProcessorStub>({
    get: () => ({ process }),
    idFromName: (name: string) => ({ name }),
  });
}

const storageServiceLayer = createStorageServiceTest({
  createMultipartUpload: (key, contentType) =>
    Effect.succeed(harness.effectMultipart(key, `mpu-${key}`, contentType)),
  delete: (key) =>
    Effect.sync(() => {
      harness.objects.delete(key);
    }),
  getMetadata: (key) => {
    const metadata = harness.metadataOf(key);
    return metadata
      ? Effect.succeed(metadata)
      : Effect.fail(new NotFoundError({ message: `no object at ${key}` }));
  },
  head: (key) => Effect.succeed(harness.metadataOf(key)),
  readPrefix: (key, maximumBytes) =>
    Effect.succeed(harness.objects.get(key)?.bytes.slice(0, maximumBytes) ?? null),
  readRange: (key, offset, maximumBytes) =>
    Effect.succeed(harness.objects.get(key)?.bytes.slice(offset, offset + maximumBytes) ?? null),
  resumeMultipartUpload: (key, uploadId) =>
    Effect.succeed(harness.effectMultipart(key, uploadId, "video/mp4")),
  signDownload: ({ downloadFilename, key }) => {
    const url = new URL(`https://lifecycle.invalid/download/${encodeURIComponent(key)}`);
    if (downloadFilename !== undefined) {
      url.searchParams.set(
        "response-content-disposition",
        `attachment; filename="${downloadFilename}"`,
      );
      url.searchParams.set("response-content-type", "application/octet-stream");
    }
    return Effect.succeed(url.toString());
  },
  signMultipartPart: ({ key, partNumber }) =>
    Effect.succeed(`https://lifecycle.invalid/part/${encodeURIComponent(key)}?part=${partNumber}`),
  signUpload: ({ key }) =>
    Effect.succeed(`https://lifecycle.invalid/upload/${encodeURIComponent(key)}`),
});

const apiEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: { connectionString: systemConnectionString } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "post-media-lifecycle-test",
} satisfies ApiWorkerEnv;

const automationEnv = {
  DB_SYSTEM: apiEnv.DB_SYSTEM,
  ENVIRONMENT: "test",
  MEDIA_PROCESSOR: mediaProcessorNamespace(),
  R2_ACCESS_KEY_ID: "lifecycleaccesskeyid",
  R2_ACCOUNT_ID: "lifecycleaccount",
  R2_BUCKET_NAME: "lifecycle-bucket",
  R2_SECRET_ACCESS_KEY: "lifecycle-secret-access-key",
  VERSION: "post-media-lifecycle-test",
} satisfies AutomationEnv;

const processor = createAssetJobProcessor(automationEnv, harness.store);

const alphaIdentity: JwtIdentity = {
  email: "alpha@meltiply.local",
  name: "Alpha Creator",
  subject,
};

const app = createApiApp({
  assetService: createAssetApiService({ storageServiceLayer }),
  coreService: createCoreApiService(capabilities),
  postService: createPostApiService(capabilities),
  resolveActor: async () => ({
    authUserId: subject,
    claims: {
      organizationId,
      organizationRole: "admin",
      subject,
      userId,
    },
    displayName: "Lifecycle Admin",
    email: `${subject}@example.test`,
    isInstallationOwner: false,
    role: "admin",
    userId,
    workspace: {
      id: organizationId,
      name: "Lifecycle Studio",
      slug,
    },
  }),
  verifyJwtToken: async () => alphaIdentity,
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
  status: number;
}

let requestCounter = 0;

function nextKey(prefix: string): string {
  requestCounter += 1;
  return `lifecycle-${prefix}-${requestCounter}`;
}

async function api(
  path: string,
  init: {
    body?: unknown;
    idempotencyKey?: string;
    method?: string;
  } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    Authorization: "Bearer post-media-lifecycle.jwt",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const response = await app.request(
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
    status: response.status,
  };
}

function errorCode(body: unknown): string {
  if (
    !body ||
    typeof body !== "object" ||
    !("error" in body) ||
    !body.error ||
    typeof body.error !== "object" ||
    !("code" in body.error) ||
    typeof body.error.code !== "string"
  ) {
    throw new Error("response body is not an error envelope");
  }
  return body.error.code;
}

function signedUrl(body: unknown): string {
  if (!body || typeof body !== "object" || !("url" in body) || typeof body.url !== "string") {
    throw new Error("response body has no signed url");
  }
  return body.url;
}

function downloadFilenameOf(url: string): string | null {
  const disposition = new URL(url).searchParams.get("response-content-disposition");
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? null;
}

async function signedMediaUrl(assetId: string, variant: "download" | "preview"): Promise<string> {
  const response = await api(`/api/v1/assets/${assetId}/${variant}-url`);
  expect(response.status).toBe(200);
  return signedUrl(response.body);
}

function attachmentIdsOf(body: unknown): string[] {
  if (
    !body ||
    typeof body !== "object" ||
    !("attachments" in body) ||
    !Array.isArray(body.attachments)
  ) {
    throw new Error("response body has no attachments projection");
  }
  return body.attachments.map((attachment) => {
    if (
      !attachment ||
      typeof attachment !== "object" ||
      !("asset_id" in attachment) ||
      typeof attachment.asset_id !== "string"
    ) {
      throw new Error("attachment projection is missing asset_id");
    }
    return attachment.asset_id;
  });
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
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

function containerBytes(size: number, majorBrand: string, durationSeconds = 12): Uint8Array {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 24);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  for (const [index, code] of [...majorBrand].entries()) {
    bytes.set([code.charCodeAt(0)], 8 + index);
  }
  view.setUint32(12, 0x00000200);
  view.setUint32(16, 640);
  view.setUint32(20, 480);
  view.setUint32(24, 1000);
  view.setUint32(28, durationSeconds * 1000);
  bytes.fill(0x5a, 32);
  return bytes;
}

function containerDurationSeconds(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timescale = view.getUint32(24);
  return timescale > 0 ? view.getUint32(28) / timescale : 0;
}

const mediaKinds = {
  "image/png": { assetType: "image", extension: "png" },
  "video/quicktime": { assetType: "video", extension: "mov" },
} as const;

async function stagingKeyOf(assetId: string): Promise<string> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ object_key: string }>(
      `SELECT object_key FROM asset_upload_sessions WHERE asset_id = $1`,
      [assetId],
    );
    return result.rows[0]!.object_key;
  });
}

async function uploadAsset(options: {
  contentType?: keyof typeof mediaKinds;
  declaredSize?: number;
  filename?: string;
  title: string;
}): Promise<{
  assetId: string;
  grantUrl: string;
  sessionId: string;
  stagingKey: string;
}> {
  const contentType = options.contentType ?? "image/png";
  const media = mediaKinds[contentType];
  const created = await api("/api/v1/asset-upload-sessions", {
    body: {
      asset_type: media.assetType,
      brand_profile_id: brandProfileId,
      content_type: contentType,
      file_size: options.declaredSize ?? 64,
      filename:
        options.filename ??
        `${options.title.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}.${media.extension}`,
      title: options.title,
    },
    idempotencyKey: nextKey("upload-session"),
    method: "POST",
  });
  expect(created.status).toBe(201);
  const session = created.body as UploadSessionResponse;
  const assetId = session.asset.id;
  const grantUrl =
    session.upload_session.single_upload?.url ??
    `https://lifecycle.invalid/upload/${encodeURIComponent(await stagingKeyOf(assetId))}`;
  const stagingKey = keyFromCapability(grantUrl);
  expect(stagingKey.startsWith("staging/")).toBe(true);
  return {
    assetId,
    grantUrl,
    sessionId: session.upload_session.id,
    stagingKey,
  };
}

async function createMultipartUpload(options: { declaredSize: number; title: string }): Promise<{
  assetId: string;
  declaredSize: number;
  sessionId: string;
  stagingKey: string;
}> {
  const created = await api("/api/v1/asset-upload-sessions", {
    body: {
      asset_type: "video",
      brand_profile_id: brandProfileId,
      content_type: "video/mp4",
      file_size: options.declaredSize,
      filename: "abandoned-multipart.mp4",
      title: options.title,
    },
    idempotencyKey: nextKey("multipart-session"),
    method: "POST",
  });
  expect(created.status).toBe(201);
  const session = (created.body as UploadSessionResponse).upload_session;
  expect(session.strategy).toBe("multipart");
  const assetId = (created.body as UploadSessionResponse).asset.id;
  return {
    assetId,
    declaredSize: options.declaredSize,
    sessionId: session.id,
    stagingKey: await stagingKeyOf(assetId),
  };
}

function finalizeUpload(sessionId: string): Promise<ApiResponse> {
  return api(`/api/v1/asset-upload-sessions/${sessionId}/complete`, {
    body: {},
    idempotencyKey: nextKey("upload-complete"),
    method: "POST",
  });
}

async function assetMessage(
  assetId: string,
  topic: AssetTopic,
  eventId?: string,
): Promise<OutboxMessage> {
  const armed = await systemTransaction(async (client) => {
    const result = await client.query<{
      event_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT id::text AS event_id, payload
         FROM outbox_events
        WHERE org_id = $1 AND aggregate_id = $2 AND topic = $3
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [organizationId, assetId, topic],
    );
    return result.rows[0];
  });
  return {
    aggregate_id: assetId,
    event_id: eventId ?? armed?.event_id ?? crypto.randomUUID(),
    organization_id: organizationId,
    payload: armed?.payload ?? { asset_id: assetId },
    topic,
    type: "outbox.event",
    version: 1,
  };
}

function deliver(
  assetId: string,
  topic: AssetTopic,
  eventId?: string,
): Promise<"processed" | "skipped"> {
  return assetMessage(assetId, topic, eventId).then((message) =>
    Effect.runPromise(processor.process(message)),
  );
}

function runMaintenance(): Promise<AssetMaintenanceResult> {
  return Effect.runPromise(processor.runMaintenance());
}

async function jobEventOutcome(eventId: string): Promise<string | null> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ outcome: string | null }>(
      `SELECT outcome FROM async_job_events WHERE event_key = $1`,
      [`outbox:${eventId}`],
    );
    return result.rows[0]?.outcome ?? null;
  });
}

interface AssetLifecycleRow extends Record<string, unknown> {
  deleted_at: Date | null;
  failure_code: string | null;
  finalized_at: Date | null;
  height: number | null;
  orphan_delete_after: Date | null;
  orphaned_at: Date | null;
  status: string;
  width: number | null;
}

async function assetRow(assetId: string): Promise<AssetLifecycleRow> {
  return systemTransaction(async (client) => {
    const result = await client.query<AssetLifecycleRow>(
      `SELECT status, failure_code, width, height, finalized_at, orphaned_at,
              orphan_delete_after, deleted_at
         FROM assets WHERE id = $1`,
      [assetId],
    );
    return result.rows[0]!;
  });
}

interface ObjectRow extends Record<string, unknown> {
  bytes: string | null;
  content_type: string | null;
  id: string;
  kind: string;
  profile: string | null;
  r2_key: string;
  reserved_bytes: string | null;
  status: string;
  write_hold_until: Date | null;
}

async function objectRows(assetId: string): Promise<ObjectRow[]> {
  return systemTransaction(async (client) => {
    const result = await client.query<ObjectRow>(
      `SELECT id, kind, profile, r2_key, bytes::text, reserved_bytes::text, status,
              content_type, write_hold_until
         FROM asset_objects
        WHERE asset_id = $1
        ORDER BY kind, r2_key`,
      [assetId],
    );
    return result.rows;
  });
}

function chargedBytes(rows: readonly ObjectRow[]): bigint {
  return rows.reduce((total, row) => {
    const bytes = BigInt(row.bytes ?? "0");
    const reserved = BigInt(row.reserved_bytes ?? "0");
    return total + (bytes > reserved ? bytes : reserved);
  }, 0n);
}

async function residentCharge(assetId: string): Promise<bigint> {
  const rows = await objectRows(assetId);
  return chargedBytes(rows.filter((row) => row.status !== "deleted"));
}

async function releasableCharge(): Promise<bigint> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ charged: string }>(
      `SELECT COALESCE(
                SUM(GREATEST(COALESCE(bytes, 0),
                             COALESCE(reserved_bytes, 0))),
                0
              )::text AS charged
         FROM asset_objects
        WHERE org_id = $1 AND status <> 'deleted'`,
      [organizationId],
    );
    return BigInt(result.rows[0]!.charged);
  });
}

async function recordedUsageBytes(): Promise<bigint> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ storage_bytes: string }>(
      `SELECT storage_bytes::text
         FROM usage_records
        WHERE org_id = $1 AND period = to_char(now(), 'YYYY-MM')`,
      [organizationId],
    );
    return BigInt(result.rows[0]!.storage_bytes);
  });
}

async function setRecordedUsage(bytes: number): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE usage_records
          SET storage_bytes = $2, updated_at = now()
        WHERE org_id = $1 AND period = to_char(now(), 'YYYY-MM')`,
      [organizationId, bytes],
    );
  });
}

async function attachmentCount(assetId: string): Promise<number> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM post_attachments WHERE asset_id = $1`,
      [assetId],
    );
    return Number(result.rows[0]!.count);
  });
}

async function sessionStatus(sessionId: string): Promise<string> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ status: string }>(
      `SELECT status FROM asset_upload_sessions WHERE id = $1`,
      [sessionId],
    );
    return result.rows[0]!.status;
  });
}

async function reservationState(sessionId: string): Promise<{ bytes: string; state: string }> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ bytes: string; state: string }>(
      `SELECT bytes::text, state
         FROM asset_quota_reservations
        WHERE session_id = $1`,
      [sessionId],
    );
    return result.rows[0]!;
  });
}

async function danglingAttachmentCount(): Promise<number> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM post_attachments AS attachment
        WHERE attachment.org_id = $1
          AND NOT EXISTS (
          SELECT 1
            FROM asset_objects AS object
           WHERE object.asset_id = attachment.asset_id
             AND object.status <> 'deleted'
        )`,
      [organizationId],
    );
    return Number(result.rows[0]!.count);
  });
}

async function setOrphanClock(
  assetId: string,
  options: { daysFromNow: number; orphanedDaysAgo: number },
): Promise<void> {
  const direction = options.daysFromNow < 0 ? "-" : "+";
  const days = Math.abs(options.daysFromNow);
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE assets
          SET orphaned_at = now() - make_interval(days => $2::integer),
              orphan_delete_after =
                now() ${direction} make_interval(days => $3::integer),
              updated_at = now()
        WHERE id = $1`,
      [assetId, options.orphanedDaysAgo, days],
    );
  });
}

async function backdateFinalization(assetId: string, days: number): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE assets
          SET finalized_at = now() - make_interval(days => $2::integer),
              updated_at = now()
        WHERE id = $1`,
      [assetId, days],
    );
  });
}

async function backdateSessionExpiry(sessionId: string, hours: number): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE asset_upload_sessions
          SET expires_at = now() - make_interval(hours => $2::integer),
              updated_at = now()
        WHERE id = $1`,
      [sessionId, hours],
    );
  });
}

async function lapseWriterHolds(assetId?: string): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE asset_objects
          SET write_hold_until = now() - INTERVAL '1 minute'
        WHERE write_hold_until > now()
          AND ($1::uuid IS NULL OR asset_id = $1::uuid)`,
      [assetId ?? null],
    );
  });
}

async function lapseWorkspaceWriterHolds(): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE asset_objects
          SET write_hold_until = now() - INTERVAL '1 minute'
        WHERE org_id = $1
          AND write_hold_until > now()`,
      [organizationId],
    );
  });
}

async function backdateAssetTouch(assetId: string, minutes: number): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE assets
          SET updated_at = now() - make_interval(mins => $2::integer)
        WHERE id = $1`,
      [assetId, minutes],
    );
  });
}

async function makeReclaimable(assetId: string): Promise<void> {
  await setOrphanClock(assetId, { daysFromNow: -1, orphanedDaysAgo: 8 });
  await lapseWriterHolds(assetId);
}

async function crashSettledWrite(options: { assetId: string; bytes: number }): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE assets
          SET status = 'failed',
              failure_code = 'native_processing_failed',
              failure_message = 'The engine did not answer.',
              failure_retryable = false,
              failure_at = now(),
              orphaned_at = now(),
              orphan_delete_after = now() + make_interval(days => 7),
              updated_at = now()
        WHERE id = $1`,
      [options.assetId],
    );
    await client.query(
      `UPDATE asset_upload_sessions
          SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE asset_id = $1`,
      [options.assetId],
    );
    await client.query(
      `UPDATE asset_objects
          SET bytes = $2,
              status = 'writing',
              write_hold_until = now() - INTERVAL '1 minute',
              updated_at = now() - INTERVAL '40 minutes'
        WHERE asset_id = $1 AND kind = 'staging'`,
      [options.assetId, options.bytes],
    );
  });
}

async function discardStagedObject(assetId: string): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE asset_objects
          SET status = 'deleted',
              bytes = NULL,
              reserved_bytes = NULL,
              deleted_at = now(),
              updated_at = now()
        WHERE asset_id = $1 AND kind = 'staging'`,
      [assetId],
    );
  });
}

async function createPost(body: { attachmentIds?: string[]; defaultText: string }): Promise<Post> {
  const response = await api("/api/v1/posts", {
    body: {
      ...(body.attachmentIds !== undefined ? { attachment_ids: body.attachmentIds } : {}),
      brand_profile_id: brandProfileId,
      default_text: body.defaultText,
    },
    idempotencyKey: nextKey("create-post"),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return response.body as Post;
}

async function savePost(
  postId: string,
  body: { attachmentIds?: string[]; defaultText?: string },
): Promise<ApiResponse> {
  return api(`/api/v1/posts/${postId}`, {
    body: {
      ...(body.attachmentIds !== undefined ? { attachment_ids: body.attachmentIds } : {}),
      brand_profile_id: brandProfileId,
      ...(body.defaultText !== undefined ? { default_text: body.defaultText } : {}),
    },
    idempotencyKey: nextKey("save-post"),
    method: "PATCH",
  });
}

function deletePost(postId: string): Promise<ApiResponse> {
  return api(`/api/v1/posts/${postId}`, {
    body: { brand_profile_id: brandProfileId },
    idempotencyKey: nextKey("delete-post"),
    method: "DELETE",
  });
}

function schedulePost(
  postId: string,
  options: { platformAccountId: string; scheduledAt: string | null },
): Promise<ApiResponse> {
  return api(`/api/v1/posts/${postId}/schedule`, {
    body: {
      brand_profile_id: brandProfileId,
      scheduled_at: options.scheduledAt,
      targets: [{ platform_account_id: options.platformAccountId }],
    },
    idempotencyKey: nextKey("schedule-post"),
    method: "POST",
  });
}

async function publishThenRelease(assetId: string, text: string): Promise<string> {
  const post = await createPost({
    attachmentIds: [assetId],
    defaultText: text,
  });
  const queued = await schedulePost(post.id, {
    platformAccountId: threadsAccountId,
    scheduledAt: null,
  });
  expect(queued.status).toBe(200);
  const distributionId = (queued.body as Post).distributions[0]!.id;
  expect((await deletePost(post.id)).status).toBe(200);
  return distributionId;
}

async function holdProviderMedia(options: {
  assetId: string;
  distributionId: string;
  outcome: "ambiguous" | "failed" | "started";
  retryWindowMinutes?: number;
}): Promise<void> {
  const status = {
    ambiguous: "needs_reconciliation",
    failed: "failed",
    started: "started",
  }[options.outcome];
  const window = options.retryWindowMinutes;
  await systemTransaction(async (client) => {
    await client.query(
      `INSERT INTO provider_operations
         (org_id, distribution_id, operation, idempotency_key, status,
          media_asset_ids, media_hold_until, publication_snapshot)
       VALUES ($1, $2, 'publish', $3, $4, ARRAY[$5]::uuid[],
               CASE WHEN $6::integer IS NULL THEN NULL
                    ELSE now() + make_interval(mins => $6::integer) END,
               '{}'::jsonb)`,
      [
        organizationId,
        options.distributionId,
        `lifecycle-hold-${options.assetId}-${options.outcome}`,
        status,
        options.assetId,
        window ?? null,
      ],
    );
    await client.query(
      `INSERT INTO provider_operation_media
         (operation_id, org_id, distribution_id, asset_id, brand_profile_id,
          object_key, position)
       SELECT operation.id, operation.org_id, operation.distribution_id,
              $2, $3, $4, 0
         FROM provider_operations AS operation
        WHERE operation.idempotency_key = $1`,
      [
        `lifecycle-hold-${options.assetId}-${options.outcome}`,
        options.assetId,
        brandProfileId,
        `${organizationId}/${options.assetId}/original`,
      ],
    );
  });
}

async function resolveProviderMedia(resolution: "finish" | "lapse"): Promise<void> {
  await systemTransaction(async (client) => {
    if (resolution === "finish") {
      await client.query(
        `UPDATE provider_operations
            SET status = 'succeeded', media_hold_until = NULL, updated_at = now()
          WHERE org_id = $1 AND status <> 'succeeded'`,
        [organizationId],
      );
      return;
    }
    await client.query(
      `UPDATE provider_operations
          SET media_hold_until = now() - INTERVAL '1 minute', updated_at = now()
        WHERE org_id = $1 AND media_hold_until > now()`,
      [organizationId],
    );
  });
}

async function processedAsset(options: { height?: number; title: string; width?: number }) {
  const upload = await uploadAsset({ title: options.title });
  harness.putBytes(
    upload.stagingKey,
    pngBytes(options.width ?? 64, options.height ?? 64),
    "image/png",
  );
  const finalized = await finalizeUpload(upload.sessionId);
  expect(finalized.status).toBe(202);
  expect((finalized.body as Asset).status).toBe("processing");
  await expect(deliver(upload.assetId, "asset.processing.requested")).resolves.toBe("processed");
  expect((await assetRow(upload.assetId)).status).toBe("ready");
  expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
  return upload;
}

async function failedUpload(title: string, storedSize: number) {
  const upload = await uploadAsset({ declaredSize: 64, title });
  const payload = new Uint8Array(storedSize);
  payload.set(pngBytes(64, 64));
  harness.putBytes(upload.stagingKey, payload, "image/png");
  return upload;
}

interface RenditionRow extends Record<string, unknown> {
  object_id: string | null;
  profile: string;
  status: string;
}

async function renditionRow(assetId: string): Promise<RenditionRow> {
  return systemTransaction(async (client) => {
    const result = await client.query<RenditionRow>(
      `SELECT profile, status, object_id
         FROM asset_renditions
        WHERE asset_id = $1`,
      [assetId],
    );
    return result.rows[0]!;
  });
}

async function setRenditionState(
  assetId: string,
  state: "failed" | "processing" | "ready",
): Promise<void> {
  await systemTransaction(async (client) => {
    await client.query(
      `UPDATE asset_renditions
          SET status = $2,
              failure_code = CASE WHEN $2 = 'failed'
                                  THEN 'native_processing_failed' END,
              failure_message = CASE WHEN $2 = 'failed'
                                      THEN 'The engine could not produce a rendition.'
                                   END,
              failure_at = CASE WHEN $2 = 'failed' THEN now() END,
              updated_at = now()
        WHERE asset_id = $1`,
      [assetId, state],
    );
    await client.query(
      `UPDATE asset_objects AS object
          SET status = CASE WHEN $2 = 'failed' THEN 'deleting' ELSE 'ready' END,
              updated_at = now()
         FROM asset_renditions AS rendition
        WHERE rendition.asset_id = $1
          AND rendition.object_id = object.id`,
      [assetId, state],
    );
  });
}

async function duplicateLiveRenditionProfiles(assetId: string): Promise<string[]> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ profile: string }>(
      `SELECT profile
         FROM asset_objects
        WHERE asset_id = $1
          AND kind = 'rendition'
          AND status IN ('writing', 'ready')
        GROUP BY profile
       HAVING COUNT(*) > 1`,
      [assetId],
    );
    return result.rows.map((row) => row.profile);
  });
}

async function createForeignReadyVideo(profile: string): Promise<string> {
  const originalKey = `${foreignOrganizationId}/${foreignAssetId}/original`;
  const renditionKey = `${foreignOrganizationId}/${foreignAssetId}/rendition-${profile}`;
  const original = containerBytes(96, "qt  ");
  const rendition = containerBytes(80, "mp42");
  harness.putBytes(originalKey, original, "video/quicktime");
  harness.putBytes(renditionKey, rendition, "video/mp4");
  await systemTransaction(async (client) => {
    await client.query(
      `INSERT INTO assets (id, org_id, brand_profile_id, asset_type, title,
                           original_filename, mime_type, file_size, width, height,
                           status, finalized_at)
       VALUES ($1, $2, $3, 'video', 'Foreign camera clip', 'foreign-clip.mov',
               'video/quicktime', $4, 640, 480, 'ready', now())`,
      [foreignAssetId, foreignOrganizationId, foreignBrandProfileId, original.length],
    );
    const objects = await client.query<{ id: string; kind: string }>(
      `INSERT INTO asset_objects (org_id, asset_id, brand_profile_id, kind, profile,
                                  r2_key, bytes, content_type, width, height, status)
       VALUES ($1, $2, $3, 'original', NULL, $4, $5, 'video/quicktime',
               640, 480, 'ready'),
              ($1, $2, $3, 'rendition', $6, $7, $8, 'video/mp4',
               640, 480, 'ready')
       RETURNING id, kind`,
      [
        foreignOrganizationId,
        foreignAssetId,
        foreignBrandProfileId,
        originalKey,
        original.length,
        profile,
        renditionKey,
        rendition.length,
      ],
    );
    await client.query(
      `INSERT INTO asset_renditions (org_id, asset_id, brand_profile_id, profile,
                                     object_id, status)
       VALUES ($1, $2, $3, $4, $5, 'ready')`,
      [
        foreignOrganizationId,
        foreignAssetId,
        foreignBrandProfileId,
        profile,
        objects.rows.find((object) => object.kind === "rendition")!.id,
      ],
    );
  });
  return foreignAssetId;
}

async function processedVideoAsset(options: { filename: string; title: string }) {
  const payload = containerBytes(96, "qt  ");
  const upload = await uploadAsset({
    contentType: "video/quicktime",
    declaredSize: payload.length,
    filename: options.filename,
    title: options.title,
  });
  harness.putBytes(upload.stagingKey, payload, "video/quicktime");
  expect((await finalizeUpload(upload.sessionId)).status).toBe(202);
  await expect(deliver(upload.assetId, "asset.processing.requested")).resolves.toBe("processed");
  expect((await assetRow(upload.assetId)).status).toBe("ready");
  expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
  const asset = await api(`/api/v1/assets/${upload.assetId}`);
  expect(asset.status).toBe(200);
  expect(asset.body as Asset).toMatchObject({
    asset_type: "video",
    mime_type: "video/quicktime",
    status: "ready",
  });
  return upload;
}

describeIntegration("post-owned media retention with PostgreSQL", () => {
  beforeEach(async () => {
    engine.calls.length = 0;
    engine.failure = null;
    harness.deleteFailures.clear();
    harness.abortedUploads.length = 0;
    await systemTransaction(async (client) => {
      await client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await client.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1, 'Lifecycle Studio', $2)`,
        [organizationId, slug],
      );
      await client.query(
        `INSERT INTO org_members (id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'admin')`,
        [membershipId, organizationId, userId],
      );
      await client.query(
        `INSERT INTO brand_profiles (id, org_id, name, color)
         VALUES ($1, $2, 'Lifecycle Brand', '#1d4ed8')`,
        [brandProfileId, organizationId],
      );
      await client.query("DELETE FROM organizations WHERE id = $1", [foreignOrganizationId]);
      await client.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1, 'Foreign Studio', $2)`,
        [foreignOrganizationId, foreignSlug],
      );
      await client.query(
        `INSERT INTO brand_profiles (id, org_id, name, color)
         VALUES ($1, $2, 'Foreign Brand', '#0f766e')`,
        [foreignBrandProfileId, foreignOrganizationId],
      );
      await client.query(
        `INSERT INTO platform_accounts
           (id, org_id, brand_profile_id, platform, platform_user_id,
            display_name, access_token, scopes, connection_status)
         VALUES ($1, $2, $3, 'threads', 'lifecycle-threads',
                 'Lifecycle Channel', 'local-only-not-a-provider-credential',
                 ARRAY['basic'], 'connected')`,
        [threadsAccountId, organizationId, brandProfileId],
      );
      await client.query(
        `INSERT INTO usage_records (org_id, period, storage_bytes)
         VALUES ($1, to_char(now(), 'YYYY-MM'), $2)`,
        [organizationId, baselineStorageBytes],
      );
    });
  });

  afterAll(async () => {
    await systemTransaction(async (client) => {
      await client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await client.query("DELETE FROM organizations WHERE id = $1", [foreignOrganizationId]);
      await client.query(
        `UPDATE assets
            SET status = 'ready', deleted_at = NULL,
                finalized_at = now() - INTERVAL '8 days',
                orphaned_at = now() - INTERVAL '8 days',
                orphan_delete_after = now() - INTERVAL '1 day',
                updated_at = now()
          WHERE id = 'd0000000-0000-4000-8000-000000000008'`,
      );
      await client.query(
        `DELETE FROM outbox_events
          WHERE aggregate_id = 'd0000000-0000-4000-8000-000000000008'`,
      );
    });
    await authenticatedPoolFor(apiEnv).end();
    await systemPoolFor(apiEnv).end();
    await automationSystemPoolFor(automationEnv).end();
  });

  it("reclaims a completed upload that was never attached once its seven days elapse", async () => {
    const never = await processedAsset({ title: "Lifecycle unattached" });
    const young = await processedAsset({ title: "Lifecycle young orphan" });
    await makeReclaimable(never.assetId);
    await setOrphanClock(young.assetId, {
      daysFromNow: 6,
      orphanedDaysAgo: 1,
    });
    const usageBeforeSweep = await recordedUsageBytes();
    const stagedRows = (await objectRows(never.assetId)).filter(
      (object) =>
        object.status === "superseded" &&
        (object.kind === "staging" || object.r2_key.startsWith("staging/")),
    );

    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    expect(await recordedUsageBytes()).toBe(usageBeforeSweep - chargedBytes(stagedRows));
    const usageBefore = await recordedUsageBytes();

    const claimed = await assetRow(never.assetId);
    expect(claimed.status).toBe("deleting");
    expect(claimed.orphaned_at).toBeNull();
    expect(claimed.orphan_delete_after).toBeNull();
    const armed = await systemTransaction(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
             FROM outbox_events
            WHERE org_id = $1 AND aggregate_id = $2
              AND topic = 'asset.deletion.requested'`,
        [organizationId, never.assetId],
      );
      return Number(result.rows[0]!.count);
    });
    expect(armed).toBe(1);

    const untouched = await assetRow(young.assetId);
    expect(untouched.status).toBe("ready");
    expect(untouched.orphan_delete_after).not.toBeNull();
    expect(harness.protectedKeysFor(young.assetId)).toHaveLength(2);
    const claimable = (await objectRows(never.assetId)).filter(
      (object) => object.status !== "deleted",
    );
    expect(claimable.length).toBeGreaterThan(0);

    await expect(deliver(never.assetId, "asset.deletion.requested")).resolves.toBe("processed");

    const reclaimed = await assetRow(never.assetId);
    expect(reclaimed.status).toBe("deleted");
    expect(reclaimed.deleted_at).not.toBeNull();
    expect(harness.keysFor(never.assetId)).toEqual([]);
    const settled = await objectRows(never.assetId);
    for (const object of settled) {
      expect(object.status).toBe("deleted");
    }
    expect(await recordedUsageBytes()).toBe(usageBefore - chargedBytes(claimable));

    await expect(deliver(never.assetId, "asset.deletion.requested")).resolves.toBe("skipped");
    expect(await recordedUsageBytes()).toBe(usageBefore - chargedBytes(claimable));
    expect((await assetRow(young.assetId)).status).toBe("ready");
    expect(harness.protectedKeysFor(young.assetId)).toHaveLength(2);
  }, 90_000);

  it("keeps a saved draft's attachment and its bytes however old the upload is", async () => {
    const upload = await processedAsset({ title: "Lifecycle ancient draft" });
    const post = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "A slow drafting session",
    });
    await backdateFinalization(upload.assetId, 400);
    await lapseWriterHolds(upload.assetId);

    await runMaintenance();
    const row = await assetRow(upload.assetId);
    expect(row.status).toBe("ready");
    expect(row.orphaned_at).toBeNull();
    expect(row.orphan_delete_after).toBeNull();
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
    expect(await residentCharge(upload.assetId)).toBeGreaterThan(0n);

    const reopened = await api(`/api/v1/posts/${post.id}`);
    expect(reopened.status).toBe(200);
    expect((reopened.body as Post).id).toBe(post.id);
    expect(attachmentIdsOf(reopened.body)).toEqual([upload.assetId]);

    const resaved = await savePost(post.id, {
      defaultText: "A slow drafting session, revised",
    });
    expect(resaved.status).toBe(200);
    expect(attachmentIdsOf(resaved.body)).toEqual([upload.assetId]);
    expect((await assetRow(upload.assetId)).orphan_delete_after).toBeNull();
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
  }, 90_000);

  it("keeps a Post scheduled weeks ahead together with its scheduled Channel target", async () => {
    const upload = await processedAsset({ title: "Lifecycle far future" });
    const post = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Scheduled weeks out",
    });
    const scheduled = await schedulePost(post.id, {
      platformAccountId: threadsAccountId,
      scheduledAt: new Date(Date.now() + 30 * daySeconds * 1_000).toISOString(),
    });
    expect(scheduled.status).toBe(200);
    const projection = scheduled.body as Post;
    expect(projection.distributions).toHaveLength(1);
    expect(projection.distributions[0]?.status).toBe("scheduled");

    await backdateFinalization(upload.assetId, 30);
    await lapseWriterHolds(upload.assetId);
    await runMaintenance();

    expect((await assetRow(upload.assetId)).status).toBe("ready");
    expect((await assetRow(upload.assetId)).orphan_delete_after).toBeNull();
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
    const detail = await api(`/api/v1/posts/${post.id}`);
    expect((detail.body as Post).distributions[0]?.status).toBe("scheduled");
    expect(attachmentIdsOf(detail.body)).toEqual([upload.assetId]);
  }, 90_000);

  it("starts a fresh seven-day grace when the last retained attachment is removed", async () => {
    const upload = await processedAsset({ title: "Lifecycle detach renewal" });
    const post = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Detach renewal fixture",
    });
    await backdateFinalization(upload.assetId, 30);
    expect((await assetRow(upload.assetId)).orphan_delete_after).toBeNull();

    const detached = await savePost(post.id, { attachmentIds: [] });
    expect(detached.status).toBe(200);
    expect(attachmentIdsOf(detached.body)).toEqual([]);

    const renewed = await assetRow(upload.assetId);
    expect(renewed.status).toBe("ready");
    expect(renewed.orphaned_at).not.toBeNull();
    expect(renewed.orphan_delete_after).not.toBeNull();
    const remainingDays =
      (new Date(renewed.orphan_delete_after!).getTime() - Date.now()) / (daySeconds * 1_000);
    expect(remainingDays).toBeGreaterThan(6.9);
    expect(remainingDays).toBeLessThanOrEqual(7);

    await lapseWriterHolds(upload.assetId);
    await runMaintenance();
    expect((await assetRow(upload.assetId)).status).toBe("ready");
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);

    await makeReclaimable(upload.assetId);
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(upload.assetId)).toEqual([]);
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
  }, 90_000);

  it("keeps an Asset another retained Post still references when one Post is deleted", async () => {
    const upload = await processedAsset({
      title: "Lifecycle shared reference",
    });
    const first = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Shared first",
    });
    const second = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Shared second",
    });

    const deleted = await deletePost(first.id);
    expect(deleted.status).toBe(200);

    const retained = await assetRow(upload.assetId);
    expect(retained.status).toBe("ready");
    expect(retained.orphaned_at).toBeNull();
    expect(retained.orphan_delete_after).toBeNull();
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
    const detail = await api(`/api/v1/posts/${second.id}`);
    expect(attachmentIdsOf(detail.body)).toEqual([upload.assetId]);

    await makeReclaimable(upload.assetId);
    await runMaintenance();
    expect((await assetRow(upload.assetId)).status).toBe("ready");
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);

    const secondDeleted = await deletePost(second.id);
    expect(secondDeleted.status).toBe(200);
    const released = await assetRow(upload.assetId);
    expect(released.orphaned_at).not.toBeNull();
    expect(released.orphan_delete_after).not.toBeNull();
    await runMaintenance();
    expect((await assetRow(upload.assetId)).status).toBe("ready");
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
  }, 90_000);

  it("records an actionable native-processing failure, keeps a draft's copy, and reclaims an unretained one after its grace", async () => {
    const failOnce = async (title: string) => {
      engine.failure = {
        code: "unsupported_media",
        message: "The uploaded file could not be decoded.",
        retryable: false,
      };
      try {
        const upload = await uploadAsset({ title });
        harness.putBytes(upload.stagingKey, pngBytes(64, 64), "image/png");
        expect((await finalizeUpload(upload.sessionId)).status).toBe(202);
        await expect(deliver(upload.assetId, "asset.processing.requested")).resolves.toBe(
          "processed",
        );
        const failed = await assetRow(upload.assetId);
        expect(failed.status).toBe("failed");
        expect(failed.failure_code).toBe("unsupported_media");
        const concluded = await assetMessage(upload.assetId, "asset.processing.requested");
        expect(await jobEventOutcome(concluded.event_id)).toBe("succeeded");
        return upload;
      } finally {
        engine.failure = null;
      }
    };

    const kept = await failOnce("Lifecycle engine failure kept");
    const post = await createPost({
      attachmentIds: [kept.assetId],
      defaultText: "Failed attachment from the engine",
    });
    const visible = await api(`/api/v1/assets/${kept.assetId}`);
    expect(visible.status).toBe(200);
    expect((visible.body as Asset).failure).toMatchObject({
      code: "unsupported_media",
      retryable: false,
    });
    expect(harness.objects.has(kept.stagingKey)).toBe(true);
    expect(await residentCharge(kept.assetId)).toBeGreaterThan(0n);
    expect(harness.protectedKeysFor(kept.assetId)).toEqual([
      `${organizationId}/${kept.assetId}/original`,
    ]);

    await makeReclaimable(kept.assetId);
    await runMaintenance();
    expect((await assetRow(kept.assetId)).status).toBe("failed");
    expect(harness.objects.has(kept.stagingKey)).toBe(true);

    const abandoned = await failOnce("Lifecycle engine failure abandoned");
    expect((await assetRow(abandoned.assetId)).status).toBe("failed");
    await makeReclaimable(abandoned.assetId);
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    await expect(deliver(abandoned.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(abandoned.assetId)).toEqual([]);
    expect((await assetRow(abandoned.assetId)).status).toBe("deleted");
    expect(await residentCharge(abandoned.assetId)).toBe(0n);

    const detached = await savePost(post.id, { attachmentIds: [] });
    expect(detached.status).toBe(200);
    await runMaintenance();
    expect((await assetRow(kept.assetId)).status).toBe("failed");
  }, 120_000);

  it("keeps a draft's failed attachment with its reason, then reclaims an unretained failed upload after its grace", async () => {
    const kept = await failedUpload("Lifecycle failed kept", 96);
    const rejected = await finalizeUpload(kept.sessionId);
    expect(rejected.status).toBe(422);
    expect(errorCode(rejected.body)).toBe("metadata_mismatch");
    expect((await assetRow(kept.assetId)).status).toBe("failed");

    const post = await createPost({
      attachmentIds: [kept.assetId],
      defaultText: "Failed attachment kept",
    });
    const visible = await api(`/api/v1/assets/${kept.assetId}`);
    expect(visible.status).toBe(200);
    expect((visible.body as Asset).failure).toMatchObject({
      code: "metadata_mismatch",
      retryable: false,
    });

    await makeReclaimable(kept.assetId);
    await runMaintenance();
    expect((await assetRow(kept.assetId)).status).toBe("failed");
    expect(harness.objects.has(kept.stagingKey)).toBe(false);
    expect(await residentCharge(kept.assetId)).toBe(0n);

    const detached = await savePost(post.id, { attachmentIds: [] });
    expect(detached.status).toBe(200);
    expect(attachmentIdsOf(detached.body)).toEqual([]);
    await runMaintenance();
    expect((await assetRow(kept.assetId)).status).toBe("failed");
    expect(harness.objects.has(kept.stagingKey)).toBe(false);

    const abandoned = await failedUpload("Lifecycle failed abandoned", 112);
    expect((await finalizeUpload(abandoned.sessionId)).status).toBe(422);
    await makeReclaimable(abandoned.assetId);
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    await expect(deliver(abandoned.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.objects.has(abandoned.stagingKey)).toBe(false);
    expect((await assetRow(abandoned.assetId)).status).toBe("deleted");
    expect(await residentCharge(abandoned.assetId)).toBe(0n);
  }, 120_000);

  it("refuses to reclaim media an unfinished rendition or a live Provider attempt still needs", async () => {
    const rendering = await processedAsset({
      title: "Lifecycle rendition hold",
    });
    await systemTransaction(async (client) => {
      await client.query(
        `INSERT INTO asset_renditions
             (org_id, asset_id, brand_profile_id, profile, status)
           VALUES ($1, $2, $3, 'in_flight_profile_hold', 'processing')`,
        [organizationId, rendering.assetId, brandProfileId],
      );
    });

    const publishing = await processedAsset({
      title: "Lifecycle provider hold",
    });
    const distributionId = await publishThenRelease(publishing.assetId, "Held for publication");
    await holdProviderMedia({
      assetId: publishing.assetId,
      distributionId,
      outcome: "started",
      retryWindowMinutes: 30,
    });

    await makeReclaimable(rendering.assetId);
    await makeReclaimable(publishing.assetId);
    await runMaintenance();

    expect((await assetRow(rendering.assetId)).status).toBe("ready");
    expect((await assetRow(publishing.assetId)).status).toBe("ready");
    expect(harness.protectedKeysFor(publishing.assetId)).toHaveLength(2);

    await systemTransaction(async (client) => {
      await client.query(
        `UPDATE asset_renditions
              SET status = 'failed', failure_code = 'abandoned_profile',
                  failure_message = 'The profile attempt was abandoned.',
                  failure_at = now(), updated_at = now()
            WHERE asset_id = $1 AND profile = 'in_flight_profile_hold'`,
        [rendering.assetId],
      );
    });
    await resolveProviderMedia("finish");
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(2);
    await expect(deliver(rendering.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    await expect(deliver(publishing.assetId, "asset.deletion.requested")).resolves.toBe(
      "processed",
    );
    expect(harness.keysFor(rendering.assetId)).toEqual([]);
    expect(harness.keysFor(publishing.assetId)).toEqual([]);
  }, 120_000);

  it("protects media for a retry window and for an ambiguous outcome awaiting reconciliation", async () => {
    const retrying = await processedAsset({ title: "Lifecycle retry hold" });
    const ambiguous = await processedAsset({
      title: "Lifecycle ambiguous hold",
    });
    await holdProviderMedia({
      assetId: retrying.assetId,
      distributionId: await publishThenRelease(retrying.assetId, "Awaiting a retry"),
      outcome: "failed",
      retryWindowMinutes: 30,
    });
    await holdProviderMedia({
      assetId: ambiguous.assetId,
      distributionId: await publishThenRelease(ambiguous.assetId, "Awaiting reconciliation"),
      outcome: "ambiguous",
    });
    await makeReclaimable(retrying.assetId);
    await makeReclaimable(ambiguous.assetId);

    await runMaintenance();
    expect((await assetRow(retrying.assetId)).status).toBe("ready");
    expect((await assetRow(ambiguous.assetId)).status).toBe("ready");
    expect(harness.protectedKeysFor(retrying.assetId)).toHaveLength(2);
    expect(harness.protectedKeysFor(ambiguous.assetId)).toHaveLength(2);

    await resolveProviderMedia("lapse");
    await runMaintenance();
    expect((await assetRow(retrying.assetId)).status).toBe("deleting");
    expect((await assetRow(ambiguous.assetId)).status).toBe("ready");

    await resolveProviderMedia("finish");
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    await expect(deliver(retrying.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    await expect(deliver(ambiguous.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(retrying.assetId)).toEqual([]);
    expect(harness.keysFor(ambiguous.assetId)).toEqual([]);
  }, 120_000);

  it("refuses a new attachment to media already claimed for reclamation", async () => {
    const upload = await processedAsset({
      title: "Lifecycle attach delete claim",
    });
    await makeReclaimable(upload.assetId);
    await runMaintenance();
    expect((await assetRow(upload.assetId)).status).toBe("deleting");

    const refused = await api("/api/v1/posts", {
      body: {
        attachment_ids: [upload.assetId],
        brand_profile_id: brandProfileId,
        default_text: "Racing a deletion claim",
      },
      idempotencyKey: nextKey("attach-deleting"),
      method: "POST",
    });
    expect(refused.status).toBe(409);
    expect(errorCode(refused.body)).toBe("asset_not_attachable");
    expect(await attachmentCount(upload.assetId)).toBe(0);

    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(upload.assetId)).toEqual([]);
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
    expect(await danglingAttachmentCount()).toBe(0);
  }, 90_000);

  it("keeps a retained attachment and reclaimed bytes mutually exclusive when a save races the sweep", async () => {
    const upload = await processedAsset({ title: "Lifecycle concurrent race" });
    await makeReclaimable(upload.assetId);

    const [sweep, saved] = await Promise.allSettled([
      runMaintenance(),
      createPost({
        attachmentIds: [upload.assetId],
        defaultText: "Saved while cleanup ran",
      }),
    ]);
    expect(sweep.status).toBe("fulfilled");
    expect(await danglingAttachmentCount()).toBe(0);

    const references = await attachmentCount(upload.assetId);
    const row = await assetRow(upload.assetId);
    if (references > 0) {
      expect(saved.status).toBe("fulfilled");
      expect(row.status).toBe("ready");
      expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
      return;
    }
    expect(saved.status).toBe("rejected");
    expect(row.status).toBe("deleting");
    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(upload.assetId)).toEqual([]);
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
    expect(await danglingAttachmentCount()).toBe(0);
  }, 90_000);

  it("holds a cancelled upload's staged bytes until its grant window lapses, then reclaims them once", async () => {
    const upload = await uploadAsset({ title: "Lifecycle cancelled single" });
    const assetId = upload.assetId;
    const objectKey = upload.stagingKey;
    harness.putBytes(objectKey, pngBytes(32, 32), "image/png");

    const cancelled = await api(`/api/v1/asset-upload-sessions/${upload.sessionId}`, {
      idempotencyKey: nextKey("cancel-upload"),
      method: "DELETE",
    });
    expect(cancelled.status).toBe(204);
    const cancelledRow = await assetRow(assetId);
    expect(cancelledRow.status).toBe("failed");
    expect(cancelledRow.failure_code).toBe("upload_aborted");
    const stagedAfterCancel = await objectRows(assetId);
    expect(stagedAfterCancel).toHaveLength(1);
    expect(stagedAfterCancel[0]!.kind).toBe("staging");
    expect(stagedAfterCancel[0]!.status).toBe("deleting");

    await setOrphanClock(assetId, { daysFromNow: -1, orphanedDaysAgo: 8 });
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    expect((await assetRow(assetId)).status).toBe("deleting");
    const heldMessage = await assetMessage(assetId, "asset.deletion.requested");
    await expect(Effect.runPromise(processor.process(heldMessage))).resolves.toBe("skipped");

    const held = (await objectRows(assetId))[0]!;
    expect(held.kind).toBe("staging");
    expect(held.status).toBe("deleting");
    expect(held.write_hold_until!.getTime()).toBeGreaterThan(Date.now());
    expect(await residentCharge(assetId)).toBeGreaterThan(0n);

    expect(harness.putThroughGrant(upload.grantUrl, pngBytes(32, 32), "image/png")).toBe(objectKey);
    expect(harness.objects.has(objectKey)).toBe(true);

    await lapseWriterHolds(assetId);
    await backdateAssetTouch(assetId, 20);
    const resumed = await runMaintenance();
    expect(resumed.reconciliation_events).toBeGreaterThanOrEqual(1);
    await expect(deliver(assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.objects.has(objectKey)).toBe(false);
    expect((await assetRow(assetId)).status).toBe("deleted");
    expect(await residentCharge(assetId)).toBe(0n);

    await expect(Effect.runPromise(processor.process(heldMessage))).rejects.toThrow(
      /already being processed/,
    );
    expect(await jobEventOutcome(heldMessage.event_id)).toBe("processing");
    expect(await residentCharge(assetId)).toBe(0n);

    const lateDuplicate = await assetMessage(
      assetId,
      "asset.deletion.requested",
      crypto.randomUUID(),
    );
    await expect(Effect.runPromise(processor.process(lateDuplicate))).resolves.toBe("skipped");
    expect(await jobEventOutcome(lateDuplicate.event_id)).toBe("skipped");
    expect(await residentCharge(assetId)).toBe(0n);
  }, 120_000);

  it("releases each object's bytes once when a bucket delete fails midway and finishes on redelivery", async () => {
    const upload = await processedAsset({ title: "Lifecycle partial delete" });
    await makeReclaimable(upload.assetId);
    await runMaintenance();
    expect((await assetRow(upload.assetId)).status).toBe("deleting");

    const claimable = (await objectRows(upload.assetId)).filter(
      (object) => object.status !== "deleted",
    );
    const rendition = claimable.find((object) => object.kind === "rendition")!;
    expect(claimable.length).toBeGreaterThan(1);
    const settledBySweep = new Set(
      (await objectRows(upload.assetId))
        .filter((object) => object.status === "deleted")
        .map((object) => object.r2_key),
    );
    await setRecordedUsage(baselineStorageBytes + Number(await releasableCharge()));
    const usageBefore = await recordedUsageBytes();

    harness.deleteFailures.add(rendition.r2_key);
    const message = await assetMessage(upload.assetId, "asset.deletion.requested");
    await expect(Effect.runPromise(processor.process(message))).rejects.toThrow(
      /injected storage delete failure/,
    );

    expect(harness.objects.has(rendition.r2_key)).toBe(true);
    const afterFailure = await objectRows(upload.assetId);
    const settledNow = afterFailure.filter((object) => object.status === "deleted");
    expect(settledNow.length).toBeGreaterThan(0);
    expect(settledNow.map((object) => object.r2_key)).not.toContain(rendition.r2_key);
    const stillDeleting = afterFailure.find((object) => object.r2_key === rendition.r2_key)!;
    expect(stillDeleting.status).toBe("deleting");
    const settledByThisRun = settledNow.filter((object) => !settledBySweep.has(object.r2_key));
    expect(settledByThisRun).toHaveLength(1);
    expect(await recordedUsageBytes()).toBe(usageBefore - chargedBytes(settledByThisRun));
    expect((await assetRow(upload.assetId)).status).toBe("deleting");

    harness.deleteFailures.delete(rendition.r2_key);
    await expect(Effect.runPromise(processor.process(message))).resolves.toBe("processed");
    expect(harness.keysFor(upload.assetId)).toEqual([]);
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
    const settled = await objectRows(upload.assetId);
    for (const object of settled) {
      expect(object.status).toBe("deleted");
    }
    expect(await recordedUsageBytes()).toBe(usageBefore - chargedBytes(claimable));

    await expect(Effect.runPromise(processor.process(message))).resolves.toBe("skipped");
    expect(await recordedUsageBytes()).toBe(usageBefore - chargedBytes(claimable));
  }, 120_000);

  it("keeps approved and published media unchanged when a still-valid upload grant is replayed after promotion", async () => {
    const upload = await uploadAsset({ title: "Lifecycle grant replay" });
    const uploaded = pngBytes(64, 64);
    harness.putBytes(upload.stagingKey, uploaded, "image/png");
    expect((await finalizeUpload(upload.sessionId)).status).toBe(202);
    await expect(deliver(upload.assetId, "asset.processing.requested")).resolves.toBe("processed");
    engine.calls.length = 0;

    const post = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Grant replay fixture",
    });
    const approvedKeys = harness.protectedKeysFor(upload.assetId);
    expect(approvedKeys).toHaveLength(2);
    const approvedDigests = approvedKeys.map((key) => [
      key,
      harness.sha256Of(harness.bytesAt(key)!),
    ]);
    expect(
      harness.createOnlyKeys.filter((key) =>
        key.startsWith(`staging/${organizationId}/${upload.assetId}/processing-`),
      ),
    ).toHaveLength(1);
    const inventoryBefore = await objectRows(upload.assetId);
    const detailBefore = await api(`/api/v1/posts/${post.id}`);
    const previewBefore = await api(`/api/v1/assets/${upload.assetId}/preview-url`);

    const replayedKey = harness.putThroughGrant(upload.grantUrl, pngBytes(8, 8), "image/png");
    expect(replayedKey).toBe(upload.stagingKey);
    expect(harness.sha256Of(harness.bytesAt(upload.stagingKey)!)).not.toBe(
      harness.sha256Of(uploaded),
    );

    expect(harness.protectedKeysFor(upload.assetId)).toEqual(approvedKeys);
    expect(approvedKeys.map((key) => [key, harness.sha256Of(harness.bytesAt(key)!)])).toEqual(
      approvedDigests,
    );
    expect(await objectRows(upload.assetId)).toEqual(inventoryBefore);
    const detailAfter = await api(`/api/v1/posts/${post.id}`);
    expect(detailAfter.body).toEqual(detailBefore.body);
    expect(attachmentIdsOf(detailAfter.body)).toEqual([upload.assetId]);
    const previewAfter = await api(`/api/v1/assets/${upload.assetId}/preview-url`);
    expect(signedUrl(previewAfter.body)).toBe(signedUrl(previewBefore.body));

    const replay = await assetMessage(
      upload.assetId,
      "asset.processing.requested",
      crypto.randomUUID(),
    );
    await expect(Effect.runPromise(processor.process(replay))).resolves.toBe("skipped");
    expect(await jobEventOutcome(replay.event_id)).toBe("skipped");
    expect(engine.calls).toHaveLength(0);
    expect(harness.protectedKeysFor(upload.assetId)).toEqual(approvedKeys);
    expect(approvedKeys.map((key) => [key, harness.sha256Of(harness.bytesAt(key)!)])).toEqual(
      approvedDigests,
    );
    expect(await objectRows(upload.assetId)).toEqual(inventoryBefore);
    expect((await assetRow(upload.assetId)).status).toBe("ready");

    const staged = (await objectRows(upload.assetId)).find((object) => object.kind === "staging");
    expect(staged).toBeDefined();
    expect(staged!.status).not.toBe("deleted");
    expect(chargedBytes([staged!])).toBeGreaterThan(0n);
  }, 120_000);

  it("reclaims a replayed upload once its writer window has lapsed, releasing the bytes once", async () => {
    const upload = await uploadAsset({ title: "Lifecycle grant reclaim" });
    const uploaded = pngBytes(64, 64);
    harness.putBytes(upload.stagingKey, uploaded, "image/png");
    expect((await finalizeUpload(upload.sessionId)).status).toBe(202);
    await expect(deliver(upload.assetId, "asset.processing.requested")).resolves.toBe("processed");
    harness.putThroughGrant(upload.grantUrl, pngBytes(8, 8), "image/png");
    expect(harness.sha256Of(harness.bytesAt(upload.stagingKey)!)).not.toBe(
      harness.sha256Of(uploaded),
    );

    await makeReclaimable(upload.assetId);
    await runMaintenance();
    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(upload.assetId)).toEqual([]);
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
    expect(await residentCharge(upload.assetId)).toBe(0n);
    for (const object of await objectRows(upload.assetId)) {
      expect(object.status).toBe("deleted");
    }
  }, 120_000);

  it("previews an approved QuickTime upload through its ready MP4 rendition while downloads keep the original", async () => {
    const upload = await processedVideoAsset({
      filename: "clip.mov",
      title: "Lifecycle quicktime preview",
    });

    const objects = await objectRows(upload.assetId);
    const original = objects.find((object) => object.kind === "original")!;
    const rendition = objects.find((object) => object.kind === "rendition")!;
    expect(original).toMatchObject({
      content_type: "video/quicktime",
      status: "ready",
    });
    expect(rendition).toMatchObject({
      content_type: "video/mp4",
      status: "ready",
    });
    expect(await renditionRow(upload.assetId)).toMatchObject({
      object_id: rendition.id,
      status: "ready",
    });

    const preview = await signedMediaUrl(upload.assetId, "preview");
    expect(keyFromCapability(preview)).toBe(rendition.r2_key);
    expect(harness.metadataOf(rendition.r2_key)?.contentType).toBe("video/mp4");
    expect(harness.sha256Of(harness.bytesAt(rendition.r2_key)!)).not.toBe(
      harness.sha256Of(harness.bytesAt(original.r2_key)!),
    );
    expect(downloadFilenameOf(preview)).toBeNull();

    const download = await signedMediaUrl(upload.assetId, "download");
    expect(keyFromCapability(download)).toBe(original.r2_key);
    expect(downloadFilenameOf(download)).toBe("clip.mov");
    expect(harness.metadataOf(original.r2_key)?.contentType).toBe("video/quicktime");

    const post = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Publish the normalized camera clip",
    });
    const scheduled = await schedulePost(post.id, {
      platformAccountId: threadsAccountId,
      scheduledAt: new Date(Date.now() + daySeconds * 1_000).toISOString(),
    });
    expect(scheduled.status).toBe(200);
    expect((scheduled.body as Post).distributions[0]?.status).toBe("scheduled");

    const foreign = await createForeignReadyVideo((await renditionRow(upload.assetId)).profile);
    for (const variant of ["download", "preview"] as const) {
      const response = await api(`/api/v1/assets/${foreign}/${variant}-url`);
      expect(response.status, variant).toBe(404);
      expect(errorCode(response.body), variant).toBe("not_found");
    }
  }, 120_000);

  it("rejects preview and scheduling without a decoder-approved rendition while retaining original download", async () => {
    const upload = await processedVideoAsset({
      filename: "clip.mov",
      title: "Lifecycle quicktime staging",
    });
    const post = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Keep the draft intact while its rendition is unavailable",
    });
    const objects = await objectRows(upload.assetId);
    const original = objects.find((object) => object.kind === "original")!;
    expect(harness.bytesAt(upload.stagingKey)).toEqual(harness.bytesAt(original.r2_key));

    const committedRendition = objects.find((object) => object.kind === "rendition")!;
    for (const state of ["failed", "processing"] as const) {
      await setRenditionState(upload.assetId, state);
      expect(await duplicateLiveRenditionProfiles(upload.assetId)).toEqual([]);
      const preview = await api(`/api/v1/assets/${upload.assetId}/preview-url`);
      expect(preview.status).toBe(409);
      expect(errorCode(preview.body)).toBe("invalid_state");
      const scheduled = await schedulePost(post.id, {
        platformAccountId: threadsAccountId,
        scheduledAt: new Date(Date.now() + daySeconds * 1_000).toISOString(),
      });
      expect(scheduled.status).toBe(409);
      expect(errorCode(scheduled.body)).toBe("asset_not_ready");
      expect(keyFromCapability(await signedMediaUrl(upload.assetId, "download"))).toBe(
        original.r2_key,
      );
    }

    await setRenditionState(upload.assetId, "ready");
    expect(await duplicateLiveRenditionProfiles(upload.assetId)).toEqual([]);
    expect(keyFromCapability(await signedMediaUrl(upload.assetId, "preview"))).toBe(
      committedRendition.r2_key,
    );
  }, 120_000);

  it("keeps a saved draft's in-flight attachment actionable when its session expires", async () => {
    const upload = await uploadAsset({ title: "Lifecycle retained expiry" });
    harness.putBytes(upload.stagingKey, pngBytes(48, 48), "image/png");
    const post = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Draft whose upload stalled",
    });
    expect(attachmentIdsOf(post)).toEqual([upload.assetId]);
    expect((await assetRow(upload.assetId)).status).toBe("pending_upload");

    await backdateSessionExpiry(upload.sessionId, 1);
    const polled = await api(`/api/v1/asset-upload-sessions/${upload.sessionId}`);
    expect(polled.status).toBe(200);
    const polledSession = (polled.body as UploadSessionResponse).upload_session;
    expect(polledSession.status).toBe("expired");
    expect(await sessionStatus(upload.sessionId)).toBe("expired");

    const failed = await assetRow(upload.assetId);
    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("upload_session_expired");
    expect(failed.orphaned_at).toBeNull();
    expect(failed.orphan_delete_after).toBeNull();
    const visible = await api(`/api/v1/assets/${upload.assetId}`);
    expect(visible.status).toBe(200);
    expect((visible.body as Asset).failure).toMatchObject({
      code: "upload_session_expired",
      retryable: true,
    });

    const detail = await api(`/api/v1/posts/${post.id}`);
    expect(detail.status).toBe(200);
    expect(attachmentIdsOf(detail.body)).toEqual([upload.assetId]);
    expect((detail.body as Post).default_text).toBe("Draft whose upload stalled");

    await makeReclaimable(upload.assetId);
    await runMaintenance();
    expect((await assetRow(upload.assetId)).status).toBe("failed");
    expect(await attachmentCount(upload.assetId)).toBe(1);

    expect((await deletePost(post.id)).status).toBe(200);
    const detached = await assetRow(upload.assetId);
    expect(detached.orphan_delete_after).not.toBeNull();
    await makeReclaimable(upload.assetId);
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(upload.assetId)).toEqual([]);
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
    expect(await residentCharge(upload.assetId)).toBe(0n);
  }, 120_000);

  it("cancels a retained upload without claiming its draft's media for deletion", async () => {
    const upload = await uploadAsset({ title: "Lifecycle retained cancel" });
    harness.putBytes(upload.stagingKey, pngBytes(40, 40), "image/png");
    const post = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Draft whose upload is cancelled",
    });

    const cancelled = await api(`/api/v1/asset-upload-sessions/${upload.sessionId}`, {
      idempotencyKey: nextKey("cancel-retained"),
      method: "DELETE",
    });
    expect(cancelled.status).toBe(204);
    expect(await sessionStatus(upload.sessionId)).toBe("aborted");

    const staged = (await objectRows(upload.assetId))[0]!;
    expect(staged.kind).toBe("staging");
    expect(staged.status).toBe("deleting");
    expect(staged.reserved_bytes).toBe("64");
    expect((await reservationState(upload.sessionId)).state).toBe("released");
    expect(await residentCharge(upload.assetId)).toBe(64n);

    const failed = await assetRow(upload.assetId);
    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("upload_aborted");
    expect(failed.orphaned_at).toBeNull();
    expect(failed.orphan_delete_after).toBeNull();
    const detail = await api(`/api/v1/posts/${post.id}`);
    expect(attachmentIdsOf(detail.body)).toEqual([upload.assetId]);
    expect((detail.body as Post).default_text).toBe("Draft whose upload is cancelled");

    await makeReclaimable(upload.assetId);
    await runMaintenance();
    expect((await assetRow(upload.assetId)).status).toBe("failed");
    expect(await attachmentCount(upload.assetId)).toBe(1);

    expect((await deletePost(post.id)).status).toBe(200);
    await makeReclaimable(upload.assetId);
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
    expect(await residentCharge(upload.assetId)).toBe(0n);
    expect(await danglingAttachmentCount()).toBe(0);
  }, 120_000);

  it("concludes the processing lease once the committed rendition exists", async () => {
    const upload = await uploadAsset({ title: "Lifecycle lease conclusion" });
    harness.putBytes(upload.stagingKey, pngBytes(64, 64), "image/png");
    expect((await finalizeUpload(upload.sessionId)).status).toBe(202);
    const message = await assetMessage(upload.assetId, "asset.processing.requested");

    await expect(Effect.runPromise(processor.process(message))).resolves.toBe("processed");
    expect((await assetRow(upload.assetId)).status).toBe("ready");
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
    expect(await jobEventOutcome(message.event_id)).toBe("succeeded");

    engine.calls.length = 0;
    await expect(Effect.runPromise(processor.process(message))).resolves.toBe("skipped");
    expect(engine.calls).toHaveLength(0);
    expect(await jobEventOutcome(message.event_id)).toBe("succeeded");
    expect((await assetRow(upload.assetId)).status).toBe("ready");

    const preview = await signedMediaUrl(upload.assetId, "preview");
    expect(harness.metadataOf(keyFromCapability(preview))?.contentType).toBe("image/jpeg");

    await makeReclaimable(upload.assetId);
    await runMaintenance();
    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(await residentCharge(upload.assetId)).toBe(0n);
    expect(await danglingAttachmentCount()).toBe(0);
  }, 120_000);

  it("reclaims a crashed settled write once while leaving a live upload and an emptied session alone", async () => {
    await lapseWorkspaceWriterHolds();
    await runMaintenance();

    const live = await uploadAsset({ title: "Lifecycle live upload" });
    harness.putBytes(live.stagingKey, pngBytes(64, 64), "image/png");
    await lapseWriterHolds(live.assetId);
    await systemTransaction(async (client) => {
      await client.query(
        `UPDATE asset_objects
              SET updated_at = now() - INTERVAL '90 minutes'
            WHERE asset_id = $1`,
        [live.assetId],
      );
    });

    const crashed = await uploadAsset({ title: "Lifecycle crashed write" });
    harness.putBytes(crashed.stagingKey, pngBytes(64, 64), "image/png");
    await crashSettledWrite({ assetId: crashed.assetId, bytes: 64 });

    const emptied = await createMultipartUpload({
      declaredSize: 26 * 1024 * 1024,
      title: "Lifecycle emptied session",
    });
    await discardStagedObject(emptied.assetId);
    await backdateSessionExpiry(emptied.sessionId, 2);

    const crashCharge = chargedBytes(await objectRows(crashed.assetId));
    expect(crashCharge).toBeGreaterThan(0n);
    await setRecordedUsage(baselineStorageBytes + Number(await releasableCharge()));
    const usageBefore = await recordedUsageBytes();
    const sweep = await runMaintenance();
    expect(sweep.stale_writing_objects_deleted).toBeGreaterThanOrEqual(1);

    expect(harness.objects.has(crashed.stagingKey)).toBe(false);
    expect((await objectRows(crashed.assetId))[0]!.status).toBe("deleted");
    expect(await residentCharge(crashed.assetId)).toBe(0n);
    expect(await recordedUsageBytes()).toBe(usageBefore - crashCharge);

    const liveRow = (await objectRows(live.assetId))[0]!;
    expect(liveRow.status).toBe("writing");
    expect(liveRow.bytes).toBeNull();
    expect(liveRow.reserved_bytes).toBeNull();
    expect((await reservationState(live.sessionId)).state).toBe("reserved");
    expect(harness.objects.has(live.stagingKey)).toBe(true);
    expect((await assetRow(live.assetId)).status).toBe("pending_upload");

    expect(harness.abortedUploads).toContain(`mpu-${emptied.stagingKey}`);
    expect(await sessionStatus(emptied.sessionId)).toBe("aborted");
    const emptiedReservation = await reservationState(emptied.sessionId);
    expect(emptiedReservation.state).toBe("released");
    expect(await residentCharge(emptied.assetId)).toBe(0n);
    expect(await recordedUsageBytes()).toBe(usageBefore - crashCharge);

    await runMaintenance();
    expect((await objectRows(crashed.assetId))[0]!.status).toBe("deleted");
    const afterSecondSweep = await reservationState(emptied.sessionId);
    expect(afterSecondSweep.state).toBe("released");
    expect(await recordedUsageBytes()).toBe(usageBefore - crashCharge);
    expect(harness.objects.has(crashed.stagingKey)).toBe(false);
  }, 120_000);

  it("aborts a confirmed abandoned multipart upload and releases its charge exactly once", async () => {
    const abandoned = await createMultipartUpload({
      declaredSize: 26 * 1024 * 1024,
      title: "Lifecycle confirmed abort",
    });
    harness.putBytes(abandoned.stagingKey, containerBytes(96, "mp42"), "video/mp4");
    await backdateSessionExpiry(abandoned.sessionId, 2);

    await setRecordedUsage(67_108_864);

    expect((await reservationState(abandoned.sessionId)).state).toBe("reserved");
    expect(await residentCharge(abandoned.assetId)).toBe(0n);
    const usageBefore = await recordedUsageBytes();

    const sweep = await runMaintenance();
    expect(sweep.cleanup_errors).toBe(0);
    expect(sweep.expired_sessions).toBeGreaterThanOrEqual(1);

    expect(harness.abortedUploads).toContain(`mpu-${abandoned.stagingKey}`);
    expect(await sessionStatus(abandoned.sessionId)).toBe("aborted");
    const reservation = await reservationState(abandoned.sessionId);
    expect(reservation.state).toBe("released");
    expect(reservation.bytes).toBe(String(abandoned.declaredSize));

    expect(harness.objects.has(abandoned.stagingKey)).toBe(false);
    expect(await residentCharge(abandoned.assetId)).toBe(0n);
    expect(await recordedUsageBytes()).toBe(usageBefore - BigInt(abandoned.declaredSize));

    const failed = await assetRow(abandoned.assetId);
    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("upload_aborted");
    expect(failed.orphaned_at).not.toBeNull();
    const remainingDays =
      (new Date(failed.orphan_delete_after!).getTime() - Date.now()) / (daySeconds * 1_000);
    expect(remainingDays).toBeGreaterThan(6.9);
    expect(remainingDays).toBeLessThanOrEqual(7);

    await runMaintenance();
    expect((await reservationState(abandoned.sessionId)).state).toBe("released");
    expect(await recordedUsageBytes()).toBe(usageBefore - BigInt(abandoned.declaredSize));
    expect(await residentCharge(abandoned.assetId)).toBe(0n);
  }, 120_000);

  it("fails a retained draft's abandoned multipart upload without claiming its media", async () => {
    const abandoned = await createMultipartUpload({
      declaredSize: 26 * 1024 * 1024,
      title: "Lifecycle retained multipart abort",
    });
    harness.putBytes(abandoned.stagingKey, containerBytes(96, "mp42"), "video/mp4");
    const post = await createPost({
      attachmentIds: [abandoned.assetId],
      defaultText: "Draft whose multipart upload was abandoned",
    });
    await setRecordedUsage(67_108_864);
    const usageBefore = await recordedUsageBytes();

    await backdateSessionExpiry(abandoned.sessionId, 2);
    const sweep = await runMaintenance();
    expect(sweep.cleanup_errors).toBe(0);
    expect(sweep.expired_sessions).toBeGreaterThanOrEqual(1);

    expect(harness.abortedUploads).toContain(`mpu-${abandoned.stagingKey}`);
    expect(await sessionStatus(abandoned.sessionId)).toBe("aborted");
    const reservation = await reservationState(abandoned.sessionId);
    expect(reservation.state).toBe("released");
    expect(reservation.bytes).toBe(String(abandoned.declaredSize));

    const staged = (await objectRows(abandoned.assetId))[0]!;
    expect(staged.kind).toBe("staging");
    expect(staged.status).toBe("deleted");
    expect(staged.reserved_bytes).toBe(String(abandoned.declaredSize));
    expect(staged.write_hold_until!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(harness.objects.has(abandoned.stagingKey)).toBe(false);
    expect(await recordedUsageBytes()).toBe(usageBefore - BigInt(abandoned.declaredSize));

    const failed = await assetRow(abandoned.assetId);
    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("upload_aborted");
    expect(failed.orphaned_at).toBeNull();
    expect(failed.orphan_delete_after).toBeNull();
    const detail = await api(`/api/v1/posts/${post.id}`);
    expect(detail.status).toBe(200);
    expect(attachmentIdsOf(detail.body)).toEqual([abandoned.assetId]);
    expect((detail.body as Post).default_text).toBe("Draft whose multipart upload was abandoned");

    await makeReclaimable(abandoned.assetId);
    await runMaintenance();
    expect((await assetRow(abandoned.assetId)).status).toBe("failed");
    expect(await attachmentCount(abandoned.assetId)).toBe(1);

    expect((await deletePost(post.id)).status).toBe(200);
    expect((await assetRow(abandoned.assetId)).orphan_delete_after).not.toBeNull();
    await makeReclaimable(abandoned.assetId);
    const reclaim = await runMaintenance();
    expect(reclaim.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    await expect(deliver(abandoned.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect((await assetRow(abandoned.assetId)).status).toBe("deleted");
    expect(await residentCharge(abandoned.assetId)).toBe(0n);
  }, 120_000);
});
