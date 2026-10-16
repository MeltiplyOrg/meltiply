// Ownership-aware retention, cleanup, and grant safety for post-owned media
// (issue #284), proven through the two public seams that actually own the
// lifecycle:
//
//   * the authenticated API app — upload sessions, Post attachment/save/
//     schedule/delete, asset reads and signed media URLs;
//   * the automation `AssetJobProcessor` — native media processing, the
//     ownership-aware orphan sweep, deletion, and hourly storage maintenance.
//
// The object store is a byte-holding boundary double: the API signer, the
// automation processor, and the native-engine capability boundary all address
// real payloads by key, so availability, promotion, and reclamation are read
// back rather than inferred from a row. Retention time is moved by writing
// durable timestamps, never by waiting seven real days. Every assertion reads
// persisted domain state, a public API projection, actual object availability,
// or recorded storage accounting; nothing asserts SQL text, source text, or an
// echoed request.
import type { JwtIdentity } from "@meltiply/auth";
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
const systemConnectionString =
  "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable";

// A throwaway workspace with its own Brand Profile and Channel, created and
// dropped by this file. Nothing here shares rows, ids, or usage counters with
// another suite, so retention boundaries are observed without depending on — or
// disturbing — seeded fixtures.
const organizationId = "9f100000-0000-4000-8000-000000000001";
const brandProfileId = "9f100000-0000-4000-8000-000000000002";
const threadsAccountId = "9f100000-0000-4000-8000-000000000003";
const membershipId = "9f100000-0000-4000-8000-000000000004";
const userId = "10000000-0000-4000-8000-000000000001";
const subject = "auth_user_local_alpha";
const slug = "lifecycle-studio";
const daySeconds = 86_400;

// A second throwaway workspace whose ready video exists only to show that a media
// capability never crosses the tenant boundary. Its objects are real bytes at real
// keys, so a leak would be observable rather than a lookup that happened to find
// nothing; the cross-tenant assertions read the refusal, never a URL.
const foreignOrganizationId = "9f100000-0000-4000-8000-000000000011";
const foreignBrandProfileId = "9f100000-0000-4000-8000-000000000012";
const foreignAssetId = "9f100000-0000-4000-8000-000000000013";
const foreignSlug = "lifecycle-foreign";

/**
 * Resident bytes the workspace starts with, standing in for media this suite
 * does not own. It keeps every "released exactly once" delta observable: a
 * release is a subtraction from this running total, so a workspace sitting at
 * zero could only ever prove the clamp, never the accounting.
 */
const baselineStorageBytes = 5_000_000;

/**
 * Platform capabilities this workspace schedules against.
 *
 * `ProviderRegistry.capabilities()` reports an unregistered Platform as an
 * empty stub — `publish: false`, no accepted media, no asset types — and
 * `validateTargetScheduleEffect` then refuses the schedule twice over: with
 * `422 unsupported_capability` at the publish gate, and, once that is passed,
 * with `422 validation_error` from `validatePublishInput` because no accepted
 * MIME type and no asset type match the attachment. Flipping `publish` on the
 * stub only moves the refusal, so the Channel this file schedules onto is
 * registered with the real Threads adapter instead: the suite then measures
 * retention against the capability that connected account really has, and a
 * refused schedule proves something about the media rather than about which
 * Platforms happen to be configured.
 */
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

/**
 * Byte-holding object store plus the writer-side controls the failure and grant
 * cases drive.
 *
 * `deleteFailures` fails one bucket delete so a reclamation is observable half
 * done, and `createOnlyKeys` records every key an engine-style writer claimed
 * exclusively, which is what keeps a replayed output grant from overwriting an
 * already-approved object.
 */
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
        // Assemble parts in part order exactly as the bucket does, so a
        // finalized multipart session leaves the real declared payload behind.
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
        // A guarded copy declines; the caller adopts the existing object.
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

  /** Effect-shaped multipart handle for the API's storage seam. */
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
    /**
     * Every key this workspace owns for one Asset: the protected
     * `<org>/<asset>/…` keys plus the `staging/<org>/<asset>/…` upload and
     * renderer staging keys, sorted for stable comparison.
     */
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
    /** The protected publish-ready keys, which no upload grant may reach. */
    protectedKeysFor: (assetId: string): string[] =>
      [...objects.keys()].filter((key) => key.startsWith(`${organizationId}/${assetId}/`)).sort(),
    /**
     * Writes bytes at an object key.
     */
    putBytes: (key: string, bytes: Uint8Array, contentType: string): void => {
      objects.set(key, { bytes, contentType });
    },
    /**
     * Performs a PUT through a still-valid signed capability: the key is
     * resolved from the URL the holder was given, so this is exactly the replay
     * a browser performs after promotion rather than a direct write.
     */
    putThroughGrant: (grantUrl: string, bytes: Uint8Array, contentType: string): string => {
      const key = keyFromCapability(grantUrl);
      objects.set(key, { bytes, contentType });
      return key;
    },
    store,
  };
}

const harness = storageHarness();

/**
 * Extracts the object key a signed capability addresses. The API's test signer
 * encodes the whole key into one path segment and the native processor's SigV4
 * signer uses `/<bucket>/<key>`, so dropping the first segment and decoding
 * yields the bucket key in both cases.
 */
function keyFromCapability(url: string): string {
  const segments = new URL(url).pathname.split("/").filter((part) => part !== "");
  return decodeURIComponent(segments.slice(1).join("/"));
}

/**
 * Native media compute at the container boundary.
 *
 * The engine is the one external process in this lifecycle: it receives exactly
 * two capabilities — a read on the protected original and a create-only write
 * on an inventoried staging key — and answers with what it measured. This
 * double performs exactly that contract against the byte-holding store: it
 * reads the input key, refuses to overwrite an existing output key the way
 * `If-None-Match: *` does at the origin, writes a smaller payload of the
 * profile's content type, and reports the size and digest it really produced.
 * Real FFmpeg/libvips execution is proven by the processor smoke, not here.
 */
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
    // The output capability is create-only: an existing object is never
    // overwritten, so a delayed duplicate cannot replace approved bytes.
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
          // Video reports the length its container encodes, measured the same
          // way the frame size is; a still image has no length to report.
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
  return {
    get: () => ({ process }),
    idFromName: (name: string) => ({ name }),
  } as unknown as DurableObjectNamespace<MediaProcessorStub>;
}

// The API's own storage seam, pointed at the same bytes: uploads finalize
// against real object metadata and a cancelled upload aborts a real multipart.
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
    // Mirrors the real signer: only a forced download carries a filename and
    // an octet-stream content type, so the two capabilities are distinguishable
    // from the URL alone exactly as a browser sees them.
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
  // Object-storage signing credentials: the processor mints the two
  // single-object capabilities its job runs on, so the boundary double receives
  // real signed URLs rather than a hand-written one.
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
    role: "admin",
    userId,
    workspace: {
      id: organizationId,
      isPersonal: false,
      name: "Lifecycle Studio",
      slug,
    },
  }),
  verifyJwtToken: async () => alphaIdentity,
});

/**
 * Runs a Promise-style fixture or assertion body inside the system transaction
 * so fixtures share the transaction lifecycle while keeping their original
 * shape.
 */
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

/** One API call's observable outcome. */
interface ApiResponse {
  body: unknown;
  status: number;
}

let requestCounter = 0;

/** Unique idempotency key per mutation so no case replays another's response. */
function nextKey(prefix: string): string {
  requestCounter += 1;
  return `lifecycle-${prefix}-${requestCounter}`;
}

/** Runs an authenticated call; preserves status and untrusted JSON, or null for a non-JSON body. */
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

/**
 * Reads the machine-readable failure code out of an API error body, failing
 * loudly when the error envelope is absent so a contract change surfaces as a
 * test error instead of a silent `undefined`.
 */
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

/** Reads the `url` member of a signed media-URL response. */
function signedUrl(body: unknown): string {
  if (!body || typeof body !== "object" || !("url" in body) || typeof body.url !== "string") {
    throw new Error("response body has no signed url");
  }
  return body.url;
}

/**
 * Reads the filename a signed capability forces the browser to save, taken from
 * the disposition the signer attached to the URL.
 *
 * @param url - Signed media URL as the public endpoint returned it.
 * @returns The forced filename, or `null` for an inline preview capability.
 */
function downloadFilenameOf(url: string): string | null {
  const disposition = new URL(url).searchParams.get("response-content-disposition");
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? null;
}

/**
 * Signs one Asset's media capability through the same public route the composer
 * calls, so an assertion observes the URL a consumer is actually handed.
 *
 * @param assetId - Ready media Asset to sign.
 * @param variant - `preview` for inline playback, `download` for the original file.
 * @returns The signed URL from the API response body.
 */
async function signedMediaUrl(assetId: string, variant: "download" | "preview"): Promise<string> {
  const response = await api(`/api/v1/assets/${assetId}/${variant}-url`);
  expect(response.status).toBe(200);
  return signedUrl(response.body);
}

/**
 * Reads the ordered attachment projection out of a Post body, so retention
 * assertions observe what a creator's composer reads back rather than the
 * request that produced it.
 */
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

/**
 * A real decodable PNG: signature, IHDR with true dimensions, IDAT-shaped body.
 * The bytes are genuine image data, so the boundary engine measures real
 * dimensions from them instead of being told what to report.
 */
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

/**
 * Real ISO base-media bytes for one container: an `ftyp` box declaring the
 * requested major brand, the 640x480 frame size and the clip duration the
 * boundary engine reads at its fixed header offsets, and filler out to the
 * requested length. Nothing in this suite decodes them — the engine double
 * addresses stored objects by key and reports what it measured, while real
 * FFmpeg execution is proven by the processor smoke — so what these bytes have
 * to carry is the declared container identity plus the offsets the double
 * reads.
 *
 * The duration is modelled rather than omitted because Threads enforces a
 * `max_video_duration_sec` ceiling and `attachmentIssues` treats an unknown
 * duration as an issue: a clip with no length in its header is genuinely
 * unpublishable, which is a fact about the media, not a Platform limit this
 * suite should relax.
 *
 * @param size - Total byte length, at least 32 for the header the double reads.
 * @param majorBrand - Four-character major brand: `qt  ` for QuickTime, `mp42` for MP4.
 * @param durationSeconds - Clip length encoded as milliseconds over a 1000 Hz
 *   timescale, read back by `containerDurationSeconds`.
 * @returns Container bytes of exactly `size` bytes.
 */
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

/**
 * Reads the clip length a container encodes, in whole seconds.
 *
 * Mirrors `pngDimensions`: the double reads a fixed header offset rather than
 * being handed a value, so a reported duration is measured from the stored
 * bytes the way the reported frame size is.
 *
 * @param bytes - Stored container bytes.
 * @returns Duration in seconds, or 0 when the header declares no timescale.
 */
function containerDurationSeconds(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timescale = view.getUint32(24);
  return timescale > 0 ? view.getUint32(28) / timescale : 0;
}

/**
 * The upload declarations this suite drives, paired with the asset kind and
 * filename extension the upload policy requires for them. The API validates the
 * pair, so a fixture cannot declare a camera clip as a still image.
 */
const mediaKinds = {
  "image/png": { assetType: "image", extension: "png" },
  "video/quicktime": { assetType: "video", extension: "mov" },
} as const;

/** Reads the durable staging key the API recorded for one Asset's session. */
async function stagingKeyOf(assetId: string): Promise<string> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ object_key: string }>(
      `SELECT object_key FROM asset_upload_sessions WHERE asset_id = $1`,
      [assetId],
    );
    return result.rows[0]!.object_key;
  });
}

/**
 * Creates an upload session through the public route and reports the durable
 * identity together with the grant and staging key a browser would be holding.
 *
 * @param options - Fixture title plus the declared media type, the real byte
 *   length to upload, and the filename the creator chose. A PNG is declared
 *   unless a case needs a camera container.
 * @returns The Asset identity, its session, and the signed upload grant.
 */
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
  // The signed target is the upload-writable staging namespace, never a
  // publishable key.
  expect(stagingKey.startsWith("staging/")).toBe(true);
  return {
    assetId,
    grantUrl,
    sessionId: session.upload_session.id,
    stagingKey,
  };
}

/**
 * Creates a real multipart upload session through the public route, the shape
 * the maintenance sweep's abandoned-multipart pass acts on.
 *
 * @param options - Fixture title plus a declared size above the server-owned
 *   multipart boundary, so the session carries a live upload id the bucket can
 *   really abort.
 * @returns The Asset identity, its session, and the staging key it writes to.
 */
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

/**
 * Finalizes an upload session after its payload has landed, returning the API
 * outcome verbatim so a verification failure is observed as a creator sees it.
 */
function finalizeUpload(sessionId: string): Promise<ApiResponse> {
  return api(`/api/v1/asset-upload-sessions/${sessionId}/complete`, {
    body: {},
    idempotencyKey: nextKey("upload-complete"),
    method: "POST",
  });
}

/**
 * Builds the queue message for one Asset event, reading the armed outbox row so
 * the message identity, topic, and payload are the ones the running system
 * produced. `eventId` overrides the identity for a duplicate or recovery
 * redelivery.
 */
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

/**
 * Delivers one Asset event through the real queue consumer.
 *
 * @param assetId - Asset the event belongs to.
 * @param topic - Asset event topic.
 * @param eventId - Overrides the message identity for a redelivery.
 * @returns The consumer's terminal outcome.
 */
function deliver(
  assetId: string,
  topic: AssetTopic,
  eventId?: string,
): Promise<"processed" | "skipped"> {
  return assetMessage(assetId, topic, eventId).then((message) =>
    Effect.runPromise(processor.process(message)),
  );
}

/** Runs the real hourly maintenance unit and reports its counters. */
function runMaintenance(): Promise<AssetMaintenanceResult> {
  return Effect.runPromise(processor.runMaintenance());
}

/**
 * Reads the durable lease outcome one Asset outbox event concluded, so the
 * consumer-visible lease is asserted directly instead of inferred from the
 * Asset row.
 *
 * @param eventId - Outbox event id the queue message carried.
 * @returns The recorded outcome, or `null` while no lease row exists.
 */
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

/** Reads one Asset's persisted lifecycle state. */
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

/** Reads every inventoried object of one Asset, ordered for stable comparison. */
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

/**
 * Charged bytes of a set of inventoried objects under the authoritative
 * settlement rule `GREATEST(COALESCE(bytes, 0), COALESCE(reserved_bytes, 0))`,
 * so a released total can be compared against what the inventory actually
 * owed. A row that recorded measured bytes while still holding its reservation
 * contributes the larger of the two — one physical key cannot hold both at
 * once — which is the charge the settlement then releases exactly once.
 */
function chargedBytes(rows: readonly ObjectRow[]): bigint {
  return rows.reduce((total, row) => {
    const bytes = BigInt(row.bytes ?? "0");
    const reserved = BigInt(row.reserved_bytes ?? "0");
    return total + (bytes > reserved ? bytes : reserved);
  }, 0n);
}

/** Resident inventory charge of one Asset: every row not yet durably removed. */
async function residentCharge(assetId: string): Promise<bigint> {
  const rows = await objectRows(assetId);
  return chargedBytes(rows.filter((row) => row.status !== "deleted"));
}

/**
 * The largest charge this workspace could still release: every inventoried row
 * that is not durably removed, charged by the same
 * `GREATEST(COALESCE(bytes, 0), COALESCE(reserved_bytes, 0))` rule the
 * settlement charges it with.
 *
 * `usage_records.storage_bytes` is a running counter, not a mirror of this sum:
 * finalization adds the verified upload's real size, while a settlement also
 * releases the reservation an aborted or cancelled upload handed onto its
 * staged row — bytes no finalize ever added. So across a run that exercises
 * both outcomes the counter drifts below the resident inventory and eventually
 * sits on the settlement's `GREATEST(..., 0)` floor, where every further
 * release is silently absorbed. That is a property of the counter rather than a
 * release happening twice, and lifting the floor back to a value derived from
 * the inventory is what keeps an exact delta observable.
 *
 * @returns Charge of every non-deleted inventory row in this workspace.
 */
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

/** The workspace's recorded storage usage for the current period. */
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

/**
 * Moves the workspace's recorded period storage to a known floor, so a large
 * release is observable as an exact delta instead of being hidden by the
 * settlement's zero floor.
 *
 * @param bytes - Storage bytes the period counter starts from, as a plain
 *   integer because the driver serializes no bigint parameter.
 * @returns Resolves once the durable counter is written.
 */
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

/** Counts the retained Post references to one Asset. */
async function attachmentCount(assetId: string): Promise<number> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM post_attachments WHERE asset_id = $1`,
      [assetId],
    );
    return Number(result.rows[0]!.count);
  });
}

/** Reads one upload session's durable status. */
async function sessionStatus(sessionId: string): Promise<string> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ status: string }>(
      `SELECT status FROM asset_upload_sessions WHERE id = $1`,
      [sessionId],
    );
    return result.rows[0]!.status;
  });
}

/**
 * Reads one session's quota reservation: the charge that exists before any
 * bytes do, and the evidence of whether it was released or handed onto an
 * inventoried row.
 */
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

/**
 * Counts retained attachments in this workspace whose Asset has already had
 * every inventoried object reclaimed. This must always be zero: it is the
 * consumer-visible shape of "no reference to deleted bytes".
 *
 * Scoped to the workspace this file owns, like every other helper here. The
 * integration gate runs the database, API and automation suites serially
 * against one reset database, so an unscoped whole-database count reports
 * whatever an earlier suite left behind — which would make this invariant
 * depend on file order instead of on the retention contract under test. Inside
 * this workspace it stays absolute: a draft this suite created that ends up
 * referencing reclaimed bytes still fails.
 */
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

/**
 * Moves an Asset's orphan clock, which is how the seven-day policy is crossed
 * without waiting. A negative `daysFromNow` puts the deadline in the past (the
 * grace has fully elapsed); a positive one leaves it still running.
 */
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

/** Ages the upload itself, proving retention is measured from finalization. */
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

/**
 * Moves a session's own deadline, which is the only clock the API's expiry
 * sweep and the maintenance abort grace both read.
 *
 * @param sessionId - Upload session whose expiry moves.
 * @param hours - How many hours into the past the deadline lands.
 * @returns Resolves once the durable deadline is written.
 */
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

/**
 * Lets any staging writer window lapse. A signed upload or renderer capability
 * stays usable until its own deadline, so reclamation deliberately waits while
 * that hold is live; crossing it is what makes staged bytes reclaimable.
 */
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

/**
 * Closes every writer window this workspace's inventory still holds.
 *
 * A `superseded` staging copy keeps charging for as long as the signed grant
 * that wrote it could still recreate it, so the maintenance sweep releases it
 * only after that window closes. Scoped to this workspace on purpose: the
 * sweeps themselves are workspace-agnostic, so a retention fixture that moved
 * another workspace's holds would let this suite settle another suite's rows.
 *
 * @returns Resolves once every live hold in this workspace has lapsed.
 */
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

/** Backdates an Asset's last touch so a genuinely stuck job is re-armed. */
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

/**
 * Puts one Asset into reclaimable position: its orphan grace has fully elapsed
 * and any staging writer window has lapsed.
 */
async function makeReclaimable(assetId: string): Promise<void> {
  await setOrphanClock(assetId, { daysFromNow: -1, orphanedDaysAgo: 8 });
  await lapseWriterHolds(assetId);
}

/**
 * Drives one upload into the state a crashed run leaves behind: the staged
 * write settled a verified size, the Asset is durably failed inside a grace it
 * has not served, and the session row is already terminal while its own
 * deadline still runs. That is the abandoned in-flight write the maintenance
 * sweep exists to reclaim — charged bytes on a row no completion will promote
 * — so the durable timestamps are written rather than waited out.
 *
 * @param options - The Asset to crash and the verified size its row carries.
 * @returns Resolves once the durable crashed shape is written.
 */
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

/**
 * Records one Asset's staged object as already durably removed, which is the
 * state an earlier reclamation left behind: the session still holds its
 * reservation, but no inventoried row accounts for those bytes any more.
 *
 * @param assetId - Asset whose staged row is treated as already reclaimed.
 * @returns Resolves once the row carries its reclaimed state.
 */
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

/** Creates one retained Post through the public API and returns its projection. */
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

/** Saves one Post's ordered attachment set through the public API. */
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

/** Deletes one Post through the public API under its Brand Profile scope. */
function deletePost(postId: string): Promise<ApiResponse> {
  return api(`/api/v1/posts/${postId}`, {
    body: { brand_profile_id: brandProfileId },
    idempotencyKey: nextKey("delete-post"),
    method: "DELETE",
  });
}

/** Schedules one Post for one Channel through the public API. */
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

/**
 * Attaches an Asset to a throwaway Post and immediately schedules it, which is
 * how a Provider attempt holding that media comes into existence; the Post is
 * then deleted so only the attempt hold can keep the media alive.
 */
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

/**
 * Records a Provider attempt that still holds one Asset's media: the durable
 * hold reclamation must respect while publication work is unresolved.
 */
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

/**
 * Releases this workspace's Provider holds. `finish` records a terminal
 * outcome, which is the only thing an ambiguous attempt waits for; `lapse`
 * simply lets a retry's media window run out.
 */
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

/**
 * Runs the whole real upload-to-publishable-media path: create the session,
 * store the genuine payload at the signed staging key, finalize it, and deliver
 * the armed processing event so the native boundary promotes the verified bytes
 * and commits the rendition.
 *
 * @param options - Title and real dimensions of the fixture payload.
 * @returns The Asset identity plus the grant and staging key a browser holds.
 */
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
  // One protected original plus the promoted rendition: publishing media is
  // reachable outside the upload-writable namespace.
  expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
  return upload;
}

/**
 * Uploads a payload whose real size differs from the declared size, which is
 * the genuine verification failure: the API rejects it with a durable reason
 * and hands the staged bytes to the reclamation path.
 */
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

/** Reads one Asset's committed rendition bookkeeping. */
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

/**
 * Drives the durable rendition state a creator's preview has to survive: a
 * permanent engine failure, where the rendition row failed and its object is
 * claimed for reclamation, and an attempt still producing bytes, where the row
 * is `processing` again while the object it points at is settled.
 *
 * Only the row `asset_renditions.object_id` names is driven. A processed Asset
 * owns two `kind = 'rendition'` inventory rows for the same profile: the
 * engine's `superseded` staging output and the promoted destination, and
 * `idx_asset_objects_live_rendition_profile` admits one *live* row per
 * (asset, profile). That is why the real system inserts the destination with
 * `profile` NULL and stamps the profile only as the staging row leaves
 * `writing` in the committing transaction, so a state change that touched both
 * rows would put two live rows on one profile and be rejected outright — which
 * is what the real system never does and a fixture must not either. Driving
 * the referenced row keeps the index's invariant as an observed fact.
 *
 * @param assetId - Asset whose rendition bookkeeping to move.
 * @param state - The rendition state a consumer's next preview request meets.
 * @returns Resolves once the rendition row and the object it references carry the state.
 */
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

/**
 * Lists the (asset, profile) pairs this Asset currently holds more than one
 * live rendition object for — exactly the condition
 * `idx_asset_objects_live_rendition_profile` refuses. Read after every
 * deliberate state change so the fixture proves it stayed inside the index
 * rather than only that its own queries returned what it expected.
 *
 * @param assetId - Asset to audit.
 * @returns Profiles with more than one live (`writing` or `ready`) rendition row; empty when the index still holds.
 */
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

/**
 * Gives the second workspace a ready video of the same shape as the one under
 * test — verified original, approved rendition, ready rendition bookkeeping — and
 * real stored bytes behind both keys, so a capability that crossed the tenant
 * boundary would hand out a playable URL rather than fail for want of an object.
 *
 * @param profile - Rendition profile name copied from the Asset under test.
 * @returns The foreign Asset id.
 */
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

/**
 * Runs the whole real path for a camera-format upload: a QuickTime session, the
 * genuine container bytes at the signed staging key, finalization, and the armed
 * processing event. The Asset ends up holding both the promoted original and the
 * engine's MP4 rendition, which is exactly the pair a consumer's preview and
 * download capabilities have to choose between.
 *
 * @param options - Fixture title and the filename the creator uploaded.
 * @returns The Asset identity plus the grant and staging key a browser holds.
 */
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
  // One protected original plus the promoted rendition, and the Asset still
  // reports the camera type the creator uploaded rather than the rendition.
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
  // Each lifecycle scenario owns fresh rows and quota headroom; prior uploads
  // must not consume the next scenario's monthly allowance or reservations.
  beforeEach(async () => {
    engine.calls.length = 0;
    engine.failure = null;
    harness.deleteFailures.clear();
    harness.abortedUploads.length = 0;
    await systemTransaction(async (client) => {
      // A previous interrupted run must not leak into this one.
      await client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await client.query(
        `INSERT INTO organizations (id, name, slug, plan, billing_status)
         VALUES ($1, 'Lifecycle Studio', $2, 'creator', 'active')`,
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
      // The other workspace exists only to be unreachable: its rows are created
      // here so the cross-tenant assertions have something real to be refused for.
      await client.query("DELETE FROM organizations WHERE id = $1", [foreignOrganizationId]);
      await client.query(
        `INSERT INTO organizations (id, name, slug, plan, billing_status)
         VALUES ($1, 'Foreign Studio', $2, 'creator', 'active')`,
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
      // Everything this suite created hangs off its throwaway workspace.
      await client.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await client.query("DELETE FROM organizations WHERE id = $1", [foreignOrganizationId]);
      // The orphan sweep is workspace-agnostic by design, so it may also have
      // claimed the seeded demo orphan. Leave that fixture exactly as seeded.
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
    // One has served its full grace; the other still has six days to run.
    await makeReclaimable(never.assetId);
    await setOrphanClock(young.assetId, {
      daysFromNow: 6,
      orphanedDaysAgo: 1,
    });
    const usageBeforeSweep = await recordedUsageBytes();
    // `makeReclaimable` lapsed this Asset's writer windows, so this sweep
    // reclaims both promoted staging copies — the uploaded source and the
    // engine's output, each now a `superseded` row — before the deletion job
    // below ever runs. That charge leaves the period counter here, which is
    // why the deletion job's own release is measured from after the sweep.
    const stagedRows = (await objectRows(never.assetId)).filter(
      (object) =>
        object.status === "superseded" &&
        (object.kind === "staging" || object.r2_key.startsWith("staging/")),
    );

    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    expect(await recordedUsageBytes()).toBe(usageBeforeSweep - chargedBytes(stagedRows));
    // The deletion job therefore owes exactly the two approved objects the
    // sweep left behind.
    const usageBefore = await recordedUsageBytes();

    // The claim is durable: status and clock move together with the event.
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

    // Inside its grace window: untouched, with its bytes still resident.
    const untouched = await assetRow(young.assetId);
    expect(untouched.status).toBe("ready");
    expect(untouched.orphan_delete_after).not.toBeNull();
    expect(harness.protectedKeysFor(young.assetId)).toHaveLength(2);
    // Whatever the maintenance pass already reclaimed on its own, the deletion
    // job owes exactly the charge of the objects it can still claim.
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
    // The release equals exactly what the claimed objects were charged.
    expect(await recordedUsageBytes()).toBe(usageBefore - chargedBytes(claimable));

    // A duplicate delivery of the same event releases nothing a second time.
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
    // Four hundred days past the window the policy measures from.
    await backdateFinalization(upload.assetId, 400);
    await lapseWriterHolds(upload.assetId);

    await runMaintenance();
    const row = await assetRow(upload.assetId);
    expect(row.status).toBe("ready");
    expect(row.orphaned_at).toBeNull();
    expect(row.orphan_delete_after).toBeNull();
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
    expect(await residentCharge(upload.assetId)).toBeGreaterThan(0n);

    // Reopening the draft resolves the same Post and the same attachment.
    const reopened = await api(`/api/v1/posts/${post.id}`);
    expect(reopened.status).toBe(200);
    expect((reopened.body as Post).id).toBe(post.id);
    expect(attachmentIdsOf(reopened.body)).toEqual([upload.assetId]);

    // Editing the same draft keeps the attachment: one Post identity.
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

    // The upload is a month old and the publication is a month out.
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
    // Age the upload well past its original window before detaching it.
    await backdateFinalization(upload.assetId, 30);
    expect((await assetRow(upload.assetId)).orphan_delete_after).toBeNull();

    const detached = await savePost(post.id, { attachmentIds: [] });
    expect(detached.status).toBe(200);
    expect(attachmentIdsOf(detached.body)).toEqual([]);

    const renewed = await assetRow(upload.assetId);
    expect(renewed.status).toBe("ready");
    expect(renewed.orphaned_at).not.toBeNull();
    expect(renewed.orphan_delete_after).not.toBeNull();
    // Seven days from the detachment, not from the original finalization.
    const remainingDays =
      (new Date(renewed.orphan_delete_after!).getTime() - Date.now()) / (daySeconds * 1_000);
    expect(remainingDays).toBeGreaterThan(6.9);
    expect(remainingDays).toBeLessThanOrEqual(7);

    // Inside the renewed grace the media is still publishable.
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

    // The other retained Post still owns the media, so no clock starts.
    const retained = await assetRow(upload.assetId);
    expect(retained.status).toBe("ready");
    expect(retained.orphaned_at).toBeNull();
    expect(retained.orphan_delete_after).toBeNull();
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
    const detail = await api(`/api/v1/posts/${second.id}`);
    expect(attachmentIdsOf(detail.body)).toEqual([upload.assetId]);

    // Even past the seven-day window, a retained reference blocks reclamation.
    await makeReclaimable(upload.assetId);
    await runMaintenance();
    expect((await assetRow(upload.assetId)).status).toBe("ready");
    expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);

    // Releasing the last reference starts the grace from the deletion.
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
    /**
     * Drives one real permanent engine failure twice, because retention must
     * diverge on it: a saved draft keeps the actionable failure, an
     * unretained copy ages out through the orphan policy.
     */
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
        // A permanent engine verdict is not a transport failure: the run
        // records it durably on the Asset and concludes the event, so the
        // Queue never redelivers a job that can never succeed. The
        // observable outcome is therefore the recorded failure and the
        // concluded lease, not a rejected promise.
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
    // The creator's own bytes are still resident, not silently dropped.
    expect(harness.objects.has(kept.stagingKey)).toBe(true);
    expect(await residentCharge(kept.assetId)).toBeGreaterThan(0n);
    // Promotion runs before the engine, so the verified upload already sits
    // behind its protected original key. What the failure withholds is the
    // approved rendition, so that original is the only publishable-namespace
    // key this Asset owns.
    expect(harness.protectedKeysFor(kept.assetId)).toEqual([
      `${organizationId}/${kept.assetId}/original`,
    ]);

    // A draft's failed attachment keeps its error: no sweep, however far past
    // the window the upload is.
    await makeReclaimable(kept.assetId);
    await runMaintenance();
    expect((await assetRow(kept.assetId)).status).toBe("failed");
    expect(harness.objects.has(kept.stagingKey)).toBe(true);

    // The unretained failure ages out exactly like any other orphan.
    const abandoned = await failOnce("Lifecycle engine failure abandoned");
    expect((await assetRow(abandoned.assetId)).status).toBe("failed");
    await makeReclaimable(abandoned.assetId);
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    await expect(deliver(abandoned.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(abandoned.assetId)).toEqual([]);
    expect((await assetRow(abandoned.assetId)).status).toBe("deleted");
    expect(await residentCharge(abandoned.assetId)).toBe(0n);

    // Detaching the kept copy starts its own grace instead of deleting now.
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

    // A saved draft's failed attachment is never reclaimed as an Asset: the
    // row keeps its reason and the Post keeps its attachment, however far
    // past the window the sweep runs. The bytes are a separate matter — a
    // payload that failed verification was never approved media, so
    // finalization handed its charge to the sweep, and once the writer
    // window lapses that staged copy is really removed.
    await makeReclaimable(kept.assetId);
    await runMaintenance();
    expect((await assetRow(kept.assetId)).status).toBe("failed");
    expect(harness.objects.has(kept.stagingKey)).toBe(false);
    expect(await residentCharge(kept.assetId)).toBe(0n);

    // Detaching starts its own grace rather than deleting immediately.
    const detached = await savePost(post.id, { attachmentIds: [] });
    expect(detached.status).toBe(200);
    expect(attachmentIdsOf(detached.body)).toEqual([]);
    await runMaintenance();
    expect((await assetRow(kept.assetId)).status).toBe("failed");
    // Detaching changes the reclaim clock only; the staged bytes were
    // already gone and no sweep brings them back.
    expect(harness.objects.has(kept.stagingKey)).toBe(false);

    // The same failure with no retained Post ages out like any other orphan.
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

    // A terminal rendition outcome plus a resolved attempt releases both.
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
    // A failed attempt inside its media window and an ambiguous outcome are
    // both still media the system needs.
    expect((await assetRow(retrying.assetId)).status).toBe("ready");
    expect((await assetRow(ambiguous.assetId)).status).toBe("ready");
    expect(harness.protectedKeysFor(retrying.assetId)).toHaveLength(2);
    expect(harness.protectedKeysFor(ambiguous.assetId)).toHaveLength(2);

    // Letting the retry window lapse ends the only hold a failed attempt
    // carries, so unreferenced media is reclaimable again; the ambiguous
    // attempt is still media the system needs and waits for a terminal
    // outcome.
    await resolveProviderMedia("lapse");
    await runMaintenance();
    expect((await assetRow(retrying.assetId)).status).toBe("deleting");
    expect((await assetRow(ambiguous.assetId)).status).toBe("ready");

    await resolveProviderMedia("finish");
    const sweep = await runMaintenance();
    // Only the ambiguous attempt was still unclaimed; the retrying one was
    // already claimed above and its event is what finishes it.
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

    // The claim still completes: that media was never retained.
    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(upload.assetId)).toEqual([]);
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
    expect(await danglingAttachmentCount()).toBe(0);
  }, 90_000);

  it("keeps a retained attachment and reclaimed bytes mutually exclusive when a save races the sweep", async () => {
    const upload = await processedAsset({ title: "Lifecycle concurrent race" });
    await makeReclaimable(upload.assetId);

    // Whichever durable state wins, no Post may end up referencing bytes that
    // were already reclaimed.
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
      // The save won: the media is retained and still physically present.
      expect(saved.status).toBe("fulfilled");
      expect(row.status).toBe("ready");
      expect(harness.protectedKeysFor(upload.assetId)).toHaveLength(2);
      return;
    }
    // The claim won: the save was refused and the bytes are reclaimed.
    expect(saved.status).toBe("rejected");
    expect(row.status).toBe("deleting");
    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.keysFor(upload.assetId)).toEqual([]);
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
    expect(await danglingAttachmentCount()).toBe(0);
  }, 90_000);

  it("holds a cancelled upload's staged bytes until its grant window lapses, then reclaims them once", async () => {
    // A single-PUT session is what this case needs: cancelling one confirms
    // no dead `uploadId`, so `abortUploadSession` cannot close the writer
    // window and the signed upload grant the browser still holds stays live.
    // A confirmed multipart abort kills every part grant instead
    // (`writersClosed`, asset-service.ts:2465-2536), so its bytes are
    // reclaimable at once — which the abandoned-multipart cases cover.
    const upload = await uploadAsset({ title: "Lifecycle cancelled single" });
    const assetId = upload.assetId;
    const objectKey = upload.stagingKey;
    // The payload landed before the creator cancelled the upload.
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

    // The deadline has long elapsed, but the signed upload grant the browser
    // still holds is not dead yet, so reclamation must wait.
    await setOrphanClock(assetId, { daysFromNow: -1, orphanedDaysAgo: 8 });
    const sweep = await runMaintenance();
    expect(sweep.orphan_assets_claimed).toBeGreaterThanOrEqual(1);
    expect((await assetRow(assetId)).status).toBe("deleting");
    const heldMessage = await assetMessage(assetId, "asset.deletion.requested");
    await expect(Effect.runPromise(processor.process(heldMessage))).resolves.toBe("skipped");

    // What reclamation waits for is the durable writer hold and the charge it
    // protects, not the bytes' presence in the bucket: cancelling a single
    // PUT cannot revoke a URL that was already signed, so the API still
    // issues its best-effort delete and then *keeps* the recorded grant
    // deadline — which is exactly why `writersClosed` is false on this path.
    // Asserting presence would prove nothing either way, since the bucket is
    // empty whether the hold closed or not.
    const held = (await objectRows(assetId))[0]!;
    expect(held.kind).toBe("staging");
    expect(held.status).toBe("deleting");
    expect(held.write_hold_until!.getTime()).toBeGreaterThan(Date.now());
    expect(await residentCharge(assetId)).toBeGreaterThan(0n);

    // The grant is genuinely still writable, which is the fact that keeps
    // the charge held: replaying the capability a browser still holds really
    // recreates the bytes under the very key the row is holding them for.
    expect(harness.putThroughGrant(upload.grantUrl, pngBytes(32, 32), "image/png")).toBe(objectKey);
    expect(harness.objects.has(objectKey)).toBe(true);

    // The writer window lapses; the interrupted job is re-armed and finishes.
    await lapseWriterHolds(assetId);
    await backdateAssetTouch(assetId, 20);
    const resumed = await runMaintenance();
    expect(resumed.reconciliation_events).toBeGreaterThanOrEqual(1);
    await expect(deliver(assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(harness.objects.has(objectKey)).toBe(false);
    expect((await assetRow(assetId)).status).toBe("deleted");
    expect(await residentCharge(assetId)).toBe(0n);

    // The held delivery resolved 'skipped' without concluding its lease:
    // `processDeletion` records an outcome only once the inventory is gone,
    // so an Asset left 'deleting' behind a live writer hold keeps the event
    // 'processing'. That 300-second reclaim lease is what makes the duplicate
    // below lose the claim — the deferral the shared catch handler exists for,
    // and the reason a redelivery can never reclaim twice.
    await expect(Effect.runPromise(processor.process(heldMessage))).rejects.toThrow(
      /already being processed/,
    );
    expect(await jobEventOutcome(heldMessage.event_id)).toBe("processing");
    expect(await residentCharge(assetId)).toBe(0n);

    // A late duplicate under a fresh identity — the message the Queue hands
    // the consumer once the re-armed event is dispatched — finds the Asset
    // already reclaimed and releases nothing a second time.
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

    // Whatever the maintenance pass already reclaimed, the deletion job owes
    // exactly the charge of the objects it can still claim.
    const claimable = (await objectRows(upload.assetId)).filter(
      (object) => object.status !== "deleted",
    );
    const rendition = claimable.find((object) => object.kind === "rendition")!;
    expect(claimable.length).toBeGreaterThan(1);
    // Rows the sweep already settled are charged against a counter that was
    // read after it, so only rows this run settles may appear in its release.
    const settledBySweep = new Set(
      (await objectRows(upload.assetId))
        .filter((object) => object.status === "deleted")
        .map((object) => object.r2_key),
    );
    // The period counter is a running total that a settlement also decrements
    // by reservations no finalize ever added, so it can already be sitting on
    // the `GREATEST(..., 0)` floor by the time this case runs and would then
    // absorb every release below. Lifting it to the workspace's own releasable
    // charge — read from the inventory, not a literal — is what makes the two
    // exact deltas asserted below possible.
    await setRecordedUsage(baselineStorageBytes + Number(await releasableCharge()));
    const usageBefore = await recordedUsageBytes();

    // One bucket delete fails after the others have already succeeded.
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
    // Exactly the rows this run transitioned released, once; the rows the
    // sweep settled earlier were already out of `usageBefore`.
    const settledByThisRun = settledNow.filter((object) => !settledBySweep.has(object.r2_key));
    expect(settledByThisRun).toHaveLength(1);
    expect(await recordedUsageBytes()).toBe(usageBefore - chargedBytes(settledByThisRun));
    expect((await assetRow(upload.assetId)).status).toBe("deleting");

    // Redelivery after the fault clears finishes the job exactly once.
    harness.deleteFailures.delete(rendition.r2_key);
    await expect(Effect.runPromise(processor.process(message))).resolves.toBe("processed");
    expect(harness.keysFor(upload.assetId)).toEqual([]);
    expect((await assetRow(upload.assetId)).status).toBe("deleted");
    const settled = await objectRows(upload.assetId);
    for (const object of settled) {
      expect(object.status).toBe("deleted");
    }
    expect(await recordedUsageBytes()).toBe(usageBefore - chargedBytes(claimable));

    // A third delivery is a no-op: nothing is released twice.
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
    // The engine wrote its rendition create-only to an inventoried staging
    // key of this Asset, never to a publish-ready one. The profile name is a
    // pure function of (organization, asset, profile), so the assertion keys
    // off that namespace rather than a literal profile string.
    expect(
      harness.createOnlyKeys.filter((key) =>
        key.startsWith(`staging/${organizationId}/${upload.assetId}/processing-`),
      ),
    ).toHaveLength(1);
    const inventoryBefore = await objectRows(upload.assetId);
    const detailBefore = await api(`/api/v1/posts/${post.id}`);
    const previewBefore = await api(`/api/v1/assets/${upload.assetId}/preview-url`);

    // The browser still holds the signed upload URL it was given before
    // promotion, and writes through it after the source was promoted.
    const replayedKey = harness.putThroughGrant(upload.grantUrl, pngBytes(8, 8), "image/png");
    expect(replayedKey).toBe(upload.stagingKey);
    expect(harness.sha256Of(harness.bytesAt(upload.stagingKey)!)).not.toBe(
      harness.sha256Of(uploaded),
    );

    // Nothing publishable moved: same protected keys, same bytes, same
    // inventory, same Post projection, same signed media URL.
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

    // A redelivered processing job must not re-run compute or move anything:
    // the Asset already left 'processing', so the consumer reports the
    // concluded lease rather than pretending it did the work again.
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

    // The replayed bytes stay inside the inventoried staging row, so a live
    // writer window cannot leave resident bytes unaccounted.
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
    // The original grant is replayed after promotion and really rewrites the
    // staging key the browser still holds.
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

    // The promoted original is genuinely a camera container, so a correct
    // preview can only be the rendition the engine committed — the original is
    // not a type a browser can play.
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
    // The capability names real MP4 bytes that are not the uploaded original,
    // and is an inline preview rather than a forced download.
    expect(harness.metadataOf(rendition.r2_key)?.contentType).toBe("video/mp4");
    expect(harness.sha256Of(harness.bytesAt(rendition.r2_key)!)).not.toBe(
      harness.sha256Of(harness.bytesAt(original.r2_key)!),
    );
    expect(downloadFilenameOf(preview)).toBeNull();

    const download = await signedMediaUrl(upload.assetId, "download");
    expect(keyFromCapability(download)).toBe(original.r2_key);
    expect(downloadFilenameOf(download)).toBe("clip.mov");
    expect(harness.metadataOf(original.r2_key)?.contentType).toBe("video/quicktime");

    // Scheduling must use decoder-approved MP4 facts, never the smaller
    // protected QuickTime source that is retained solely for download.
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

    // The other workspace owns a ready video of the same shape with real bytes
    // behind it; neither capability may address it, whichever one is asked for.
    const foreign = await createForeignReadyVideo((await renditionRow(upload.assetId)).profile);
    for (const variant of ["download", "preview"] as const) {
      const response = await api(`/api/v1/assets/${foreign}/${variant}-url`);
      expect([403, 404]).toContain(response.status);
      if (response.status === 404) {
        expect(errorCode(response.body)).toBe("not_found");
      }
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
    // Processing leaves the upload-writable and the engine-writable bytes
    // resident behind their writer holds, so each exclusion below is a real
    // refusal rather than the absence of anything that could have leaked.
    expect(harness.bytesAt(upload.stagingKey)).toEqual(harness.bytesAt(original.r2_key));

    const committedRendition = objects.find((object) => object.kind === "rendition")!;
    for (const state of ["failed", "processing"] as const) {
      await setRenditionState(upload.assetId, state);
      // Driving the state never puts two live rows on one (asset, profile),
      // which is what `idx_asset_objects_live_rendition_profile` admits one
      // of: the engine's superseded staging output keeps the profile out of
      // the live set for as long as it exists.
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

    // Re-approving the rendition restores the preview that names it, so the
    // refusals above came from the rendition's own state rather than from the
    // Asset having lost everything a consumer could be shown.
    await setRenditionState(upload.assetId, "ready");
    expect(await duplicateLiveRenditionProfiles(upload.assetId)).toEqual([]);
    expect(keyFromCapability(await signedMediaUrl(upload.assetId, "preview"))).toBe(
      committedRendition.r2_key,
    );
  }, 120_000);

  it("keeps a saved draft's in-flight attachment actionable when its session expires", async () => {
    const upload = await uploadAsset({ title: "Lifecycle retained expiry" });
    // The creator saves media into a draft while its upload is still
    // running, which is what the composer does with a queued upload.
    harness.putBytes(upload.stagingKey, pngBytes(48, 48), "image/png");
    const post = await createPost({
      attachmentIds: [upload.assetId],
      defaultText: "Draft whose upload stalled",
    });
    expect(attachmentIdsOf(post)).toEqual([upload.assetId]);
    expect((await assetRow(upload.assetId)).status).toBe("pending_upload");

    // The session's own deadline is the only clock the expiry sweep reads.
    await backdateSessionExpiry(upload.sessionId, 1);
    const polled = await api(`/api/v1/asset-upload-sessions/${upload.sessionId}`);
    expect(polled.status).toBe(200);
    const polledSession = (polled.body as UploadSessionResponse).upload_session;
    expect(polledSession.status).toBe("expired");
    expect(await sessionStatus(upload.sessionId)).toBe("expired");

    // The draft keeps its media, and the media now says why it never
    // arrived instead of staying an unexplained pending upload.
    const failed = await assetRow(upload.assetId);
    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("upload_session_expired");
    // Retention is the only thing the reclaim clock waits on.
    expect(failed.orphaned_at).toBeNull();
    expect(failed.orphan_delete_after).toBeNull();
    const visible = await api(`/api/v1/assets/${upload.assetId}`);
    expect(visible.status).toBe(200);
    expect((visible.body as Asset).failure).toMatchObject({
      code: "upload_session_expired",
      retryable: true,
    });

    // The draft itself is untouched: same Post, same text, same attachment.
    const detail = await api(`/api/v1/posts/${post.id}`);
    expect(detail.status).toBe(200);
    expect(attachmentIdsOf(detail.body)).toEqual([upload.assetId]);
    expect((detail.body as Post).default_text).toBe("Draft whose upload stalled");

    // However far past the window the sweep runs, a retained reference keeps
    // the Asset itself out of the reclaim: no delete claim is ever armed.
    await makeReclaimable(upload.assetId);
    await runMaintenance();
    expect((await assetRow(upload.assetId)).status).toBe("failed");
    expect(await attachmentCount(upload.assetId)).toBe(1);

    // Releasing the last reference arms the seven-day grace for the failed
    // Asset, so the retained copy is reclaimed rather than stranded.
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

    // The abandoned upload's staged bytes are handed over, not dropped: the
    // reservation's charge now lives on the inventoried row.
    const staged = (await objectRows(upload.assetId))[0]!;
    expect(staged.kind).toBe("staging");
    expect(staged.status).toBe("deleting");
    expect(staged.reserved_bytes).toBe("64");
    expect((await reservationState(upload.sessionId)).state).toBe("released");
    expect(await residentCharge(upload.assetId)).toBe(64n);

    // Cancelling is not a deletion: the retained Asset is durably failed
    // with its reason and no reclaim clock, and the draft still resolves.
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

    // Detaching hands the failed Asset its own grace, and only then is the
    // abandoned upload's charge released.
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
    // The run that committed the rendition concludes its own lease, so the
    // event never sits in 'processing' waiting for a redelivery timer.
    expect(await jobEventOutcome(message.event_id)).toBe("succeeded");

    // A redelivery of that concluded event claims nothing, re-runs no
    // compute, and does not reopen the lease.
    engine.calls.length = 0;
    await expect(Effect.runPromise(processor.process(message))).resolves.toBe("skipped");
    expect(engine.calls).toHaveLength(0);
    expect(await jobEventOutcome(message.event_id)).toBe("succeeded");
    expect((await assetRow(upload.assetId)).status).toBe("ready");

    // What a consumer is handed is still the committed rendition.
    const preview = await signedMediaUrl(upload.assetId, "preview");
    expect(harness.metadataOf(keyFromCapability(preview))?.contentType).toBe("image/jpeg");

    await makeReclaimable(upload.assetId);
    await runMaintenance();
    await expect(deliver(upload.assetId, "asset.deletion.requested")).resolves.toBe("processed");
    expect(await residentCharge(upload.assetId)).toBe(0n);
    expect(await danglingAttachmentCount()).toBe(0);
  }, 120_000);

  it("reclaims a crashed settled write once while leaving a live upload and an emptied session alone", async () => {
    // Settle this workspace's earlier cases first. Each processed Asset leaves
    // a `superseded` staging copy that is still charged and, once its signed
    // grant has lapsed, is releasable — so a sweep run inside the measured
    // window below would release those too and its delta would no longer be
    // this case's alone. Doing it before the measured baseline keeps the
    // workspace's writer windows closed and its inherited charges already out
    // of the counter.
    await lapseWorkspaceWriterHolds();
    await runMaintenance();

    // A live upload: nothing about it is recent any more, so only its live
    // session may keep the sweep away from its staged bytes.
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

    // A crashed run that settled a verified size on a row nothing promotes.
    const crashed = await uploadAsset({ title: "Lifecycle crashed write" });
    harness.putBytes(crashed.stagingKey, pngBytes(64, 64), "image/png");
    await crashSettledWrite({ assetId: crashed.assetId, bytes: 64 });

    // An abandoned multipart upload whose staged object an earlier
    // reclamation already removed: the reservation is all that is left.
    const emptied = await createMultipartUpload({
      declaredSize: 26 * 1024 * 1024,
      title: "Lifecycle emptied session",
    });
    await discardStagedObject(emptied.assetId);
    await backdateSessionExpiry(emptied.sessionId, 2);

    // The expected release is the abandoned write's own inventory charge, and
    // the floor is lifted from that same inventory, so nothing here depends on
    // a byte count written by hand: the period counter is a running total the
    // settlement also decrements by reservations no finalize ever added, and
    // it can already be sitting on the `GREATEST(..., 0)` floor.
    const crashCharge = chargedBytes(await objectRows(crashed.assetId));
    expect(crashCharge).toBeGreaterThan(0n);
    await setRecordedUsage(baselineStorageBytes + Number(await releasableCharge()));
    const usageBefore = await recordedUsageBytes();
    const sweep = await runMaintenance();
    expect(sweep.stale_writing_objects_deleted).toBeGreaterThanOrEqual(1);

    // The abandoned write is gone and its charge released exactly once.
    expect(harness.objects.has(crashed.stagingKey)).toBe(false);
    expect((await objectRows(crashed.assetId))[0]!.status).toBe("deleted");
    expect(await residentCharge(crashed.assetId)).toBe(0n);
    expect(await recordedUsageBytes()).toBe(usageBefore - crashCharge);

    // The live upload is untouched: not claimed, not settled, and still
    // charged to the reservation that is reserving it.
    const liveRow = (await objectRows(live.assetId))[0]!;
    expect(liveRow.status).toBe("writing");
    expect(liveRow.bytes).toBeNull();
    expect(liveRow.reserved_bytes).toBeNull();
    expect((await reservationState(live.sessionId)).state).toBe("reserved");
    expect(harness.objects.has(live.stagingKey)).toBe(true);
    expect((await assetRow(live.assetId)).status).toBe("pending_upload");

    // The emptied session's reservation is released rather than stranded,
    // and no charge that never existed is invented on the way out.
    expect(harness.abortedUploads).toContain(`mpu-${emptied.stagingKey}`);
    expect(await sessionStatus(emptied.sessionId)).toBe("aborted");
    const emptiedReservation = await reservationState(emptied.sessionId);
    expect(emptiedReservation.state).toBe("released");
    expect(await residentCharge(emptied.assetId)).toBe(0n);
    expect(await recordedUsageBytes()).toBe(usageBefore - crashCharge);

    // A second sweep finds nothing left to release.
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

    // The period counter starts well above this charge, so its release is
    // visible as an exact delta instead of being absorbed by the
    // settlement's zero floor.
    await setRecordedUsage(67_108_864);

    // Before the sweep the reserved bytes exist only on the reservation.
    expect((await reservationState(abandoned.sessionId)).state).toBe("reserved");
    expect(await residentCharge(abandoned.assetId)).toBe(0n);
    const usageBefore = await recordedUsageBytes();

    // A per-item statement that raises is absorbed as a cleanup error, so it
    // is asserted directly: a silently skipped reclamation is the one failure
    // mode this sweep cannot otherwise report.
    const sweep = await runMaintenance();
    expect(sweep.cleanup_errors).toBe(0);
    expect(sweep.expired_sessions).toBeGreaterThanOrEqual(1);

    // The bucket abort confirmed, so the upload id is dead and no part grant
    // can write again.
    expect(harness.abortedUploads).toContain(`mpu-${abandoned.stagingKey}`);
    expect(await sessionStatus(abandoned.sessionId)).toBe("aborted");
    const reservation = await reservationState(abandoned.sessionId);
    expect(reservation.state).toBe("released");
    expect(reservation.bytes).toBe(String(abandoned.declaredSize));

    // The reservation's bytes were handed onto the staged row and released
    // there by the shared settlement, never dropped: the period counter
    // moves by exactly that charge once.
    expect(harness.objects.has(abandoned.stagingKey)).toBe(false);
    expect(await residentCharge(abandoned.assetId)).toBe(0n);
    expect(await recordedUsageBytes()).toBe(usageBefore - BigInt(abandoned.declaredSize));

    // Nothing still waits on that upload: the Asset is durably failed with
    // the reason its session ended, and only because nothing retains it does
    // the seven-day reclaim clock start.
    const failed = await assetRow(abandoned.assetId);
    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("upload_aborted");
    expect(failed.orphaned_at).not.toBeNull();
    const remainingDays =
      (new Date(failed.orphan_delete_after!).getTime() - Date.now()) / (daySeconds * 1_000);
    expect(remainingDays).toBeGreaterThan(6.9);
    expect(remainingDays).toBeLessThanOrEqual(7);

    // A second sweep releases the same charge no second time.
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
    // Keep the release delta observable independently of any earlier scenario.
    await setRecordedUsage(67_108_864);
    const usageBefore = await recordedUsageBytes();

    // Time control: the session's own deadline is the only clock the abort
    // grace reads, so the creator is written as having vanished hours ago.
    await backdateSessionExpiry(abandoned.sessionId, 2);
    // The abort pass absorbs a raising statement as a cleanup error, so it is
    // asserted directly rather than inferred from the session's own state.
    const sweep = await runMaintenance();
    expect(sweep.cleanup_errors).toBe(0);
    expect(sweep.expired_sessions).toBeGreaterThanOrEqual(1);

    expect(harness.abortedUploads).toContain(`mpu-${abandoned.stagingKey}`);
    expect(await sessionStatus(abandoned.sessionId)).toBe("aborted");
    const reservation = await reservationState(abandoned.sessionId);
    expect(reservation.state).toBe("released");
    expect(reservation.bytes).toBe(String(abandoned.declaredSize));

    // The confirmed abort ended every part grant at once, so the staged copy
    // carried that exact reservation until its delete settled, and the
    // release happened exactly once.
    const staged = (await objectRows(abandoned.assetId))[0]!;
    expect(staged.kind).toBe("staging");
    expect(staged.status).toBe("deleted");
    expect(staged.reserved_bytes).toBe(String(abandoned.declaredSize));
    expect(staged.write_hold_until!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(harness.objects.has(abandoned.stagingKey)).toBe(false);
    expect(await recordedUsageBytes()).toBe(usageBefore - BigInt(abandoned.declaredSize));

    // The draft keeps its media and its reason, and never starts a reclaim
    // clock while the Post still references it.
    const failed = await assetRow(abandoned.assetId);
    expect(failed.status).toBe("failed");
    expect(failed.failure_code).toBe("upload_aborted");
    expect(failed.orphaned_at).toBeNull();
    expect(failed.orphan_delete_after).toBeNull();
    const detail = await api(`/api/v1/posts/${post.id}`);
    expect(detail.status).toBe(200);
    expect(attachmentIdsOf(detail.body)).toEqual([abandoned.assetId]);
    expect((detail.body as Post).default_text).toBe("Draft whose multipart upload was abandoned");

    // However far past the window cleanup runs, the retained reference keeps
    // the Asset itself out of the reclaim.
    await makeReclaimable(abandoned.assetId);
    await runMaintenance();
    expect((await assetRow(abandoned.assetId)).status).toBe("failed");
    expect(await attachmentCount(abandoned.assetId)).toBe(1);

    // Detaching arms the grace for that failed Asset, and only then is it
    // reclaimed with its accounting released once.
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
