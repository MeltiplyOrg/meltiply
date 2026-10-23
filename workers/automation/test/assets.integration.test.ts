// Response.json() is `unknown` under the pool's types but `any` in eslint's
// project, so the necessary body assertions look unnecessary to the rule
// (AUD-055); the assertions are required for tsc.
/* oxlint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { Cause, Effect, Layer, Option } from "effect";
import type { MultipartUpload, ObjectMetadata, ObjectStore } from "@meltiply/storage";
import {
  classifyProviderFailure,
  type ProviderAdapter,
  ProviderAdapterError,
  ProviderRegistry,
} from "@meltiply/providers";
import type { EffectTransactionClient, Queryable } from "@meltiply/database";
import {
  analyticsTerminalAgeSeconds,
  COMMUNITY_LIMITS,
  mediaUploadMaximum,
} from "@meltiply/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type * as Domain from "@meltiply/domain";

// Keep storage-boundary coverage under an explicit finite test policy while the
// real community policy is unrestricted. Scenarios may load that policy too.
vi.mock("@meltiply/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof Domain>()),
  COMMUNITY_LIMITS: {
    max_distributions: 30,
    max_platforms: 2,
    max_storage_bytes: 1024 * 1024 * 1024,
    max_uploads: 10,
  },
}));

import { createApiApp } from "../../api/src/app";
import { createCoreApiService } from "../../api/src/core-service";
import type { ApiWorkerEnv } from "../../api/src/env";
import { createAssetJobProcessor } from "../src/assets";
import { systemPoolFor, withSystemTransactionEffect } from "../src/database";
import {
  enqueueDueDistributions,
  processDistributionMessage,
  sweepDueDistributions,
} from "../src/distribution";
import {
  maximumProviderPollAttempts,
  maximumReconciliationAttempts,
  providerPollIntervalSeconds,
} from "../src/due-work";
import type { AutomationEnv } from "../src/env";
import {
  createPublishQueueResolverLive,
  createQueuePublisherLive,
  RetryableJobError,
} from "../src/effect/index";
import { relayOutbox, type OutboxRelayResult } from "../src/outbox";
import { publishingQueueFor } from "../src/publish-queues";
import { tokenCipherFor } from "../src/provider-credentials";
import { processProviderSyncMessage, sweepDueProviderJobs } from "../src/provider-sync";
import { processReplyMessage } from "../src/replies";
import { reconcileDueUsage } from "../src/usage";
import type { OutboxMessage } from "../src/messages";
import { NativeProcessorError, processorJobUrlsEffect } from "../src/native-processor";
import type {
  MediaProcessorRpcOutcome,
  NativeProcessorJob,
  NativeProcessorSuccess,
} from "../src/native-processor";
import { runSystemTransaction } from "./system-transaction";

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;
const organizationId = "20000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
// The seeded Alpha workspace profile owns every asset, platform account, and
// distribution fixture below: brand_profile_id is mandatory and the composite
// foreign keys require same-profile references.
const seededAlphaProfileId = "a0000000-0000-4000-8000-000000000001";
// Canonical publish fixtures from seed.sql: the ready image Asset and the
// connected YouTube Channel every distribution spec below composed over when
// distributions still keyed `asset_id` directly. Post-owned fixtures keep the
// same composition by attaching this Asset and targeting this Channel.
const seededAlphaAssetId = "40000000-0000-4000-8000-000000000001";
const seededYouTubeAccountId = "50000000-0000-4000-8000-000000000001";
const currentUsagePeriod = new Date().toISOString().slice(0, 7);
const storageLimit = COMMUNITY_LIMITS.max_storage_bytes;
if (storageLimit === null) {
  throw new Error("Storage boundary scenarios require a bounded test policy.");
}
let currentUsageBefore:
  | {
      api_calls: string;
      distributions: string;
      storage_bytes: string;
      uploads: string;
    }
  | undefined;

let baselineDistributionIds: string[] = [];

const send = vi.fn(async () => ({
  metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
}));
const youtubePublishSend = vi.fn(async (..._arguments: unknown[]) => ({
  metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
}));
const env = {
  ASSET_PROCESSING_QUEUE: { sendBatch: send } as unknown as Queue<unknown>,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
  } as Hyperdrive,
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
  YOUTUBE_PUBLISH_QUEUE: {
    sendBatch: youtubePublishSend,
  } as unknown as Queue<unknown>,
} satisfies AutomationEnv;

/**
 * Live QueuePublisher layer for provider-sync programs under test: dispatch
 * goes through the env's mocked Queue bindings so sendBatch recordings still
 * observe the exact message bodies each test asserts.
 */
const queuePublisherLayer = createQueuePublisherLive();

/**
 * Runs the outbox relay Effect at the test boundary with production wiring:
 * the live QueuePublisher drives the recorded fake bindings, and the live
 * PublishQueueResolver maps platforms through publishingQueueFor against the
 * supplied env, so distribution rows still exercise real binding lookup.
 */
function runRelay(relayEnv: AutomationEnv, batchSize?: number): Promise<OutboxRelayResult> {
  return Effect.runPromise(
    Effect.provide(
      relayOutbox(relayEnv, batchSize),
      Layer.mergeAll(
        queuePublisherLayer,
        createPublishQueueResolverLive((platform) => publishingQueueFor(relayEnv, platform)),
      ),
    ),
  );
}

/**
 * Runs the real global scheduler against this suite's newly inserted fixtures.
 * Pre-existing in-flight demo rows are skip-locked on a separate connection
 * only for this claim, without changing their statuses or clocks. The optional
 * limit retains the production default. Errors propagate after rollback/release,
 * so later provider-sync fixtures can freely update the baseline rows.
 */
async function enqueueFixtureDistributions(limit?: number): Promise<number> {
  const client = await systemPoolFor(env).connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT id FROM distributions
       WHERE id = ANY($1::uuid[])
       FOR UPDATE SKIP LOCKED`,
      [baselineDistributionIds],
    );
    return await Effect.runPromise(enqueueDueDistributions(env, limit));
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

const apiEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: env.DB_SYSTEM,
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies ApiWorkerEnv;

// Verified JWT identity for the seeded Alpha user; the `verifyJwtToken` test
// double returns it so HTTP-level requests authenticate as the same subject
// the seeded users row binds.
const alphaIdentity = {
  email: "alpha@meltiply.local",
  name: "Alpha Creator",
  subject: "auth_user_local_alpha",
};

// Fixed bearer JWT credential for API-level requests; protected routes accept
// it instead of a session cookie.
const bearerAuthorization = "Bearer test-only.jwt";

/**
 * Deterministic PNG fixture: real PNG signature plus a well-formed IHDR chunk
 * carrying the requested dimensions. The media-processor test double parses
 * these fields from the stored bytes exactly like ffprobe would, so media
 * facts asserted later are engine-measured rather than fixture-echoed.
 *
 * @param width - Image width in pixels.
 * @param height - Image height in pixels.
 * @returns A 24-byte PNG header (signature + IHDR length/type + dimensions).
 */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * Real-byte ObjectStore double for the media pipeline. Every stored object is
 * an actual `Uint8Array` body, so `head` derives size, content type, ETag and
 * SHA-256 from what was written — never from hand-entered metadata.
 *
 * `copyObject` is R2-faithful for the conditional promotion the module relies
 * on: it returns `null` when the source ETag does not match or the destination
 * already exists, and otherwise installs the source bytes under the
 * destination key. `delete` is idempotent like R2. `failKeys` injects a
 * transport failure into `head`/`delete`/`copyObject`/`readPrefix`/`readRange`
 * for a key; `oneShot` entries clear themselves after firing once so a fault
 * can simulate a single crash without poisoning the replay. `deletes`,
 * `copies`, and `multipartAborts` record every side effect for assertions.
 *
 * @returns The storage double plus its byte map and fault/assertion handles.
 */
interface ObjectStoreHarness {
  bodies: Map<string, Uint8Array>;
  /**
   * Optional hook awaited inside `copyObject` immediately before the copy runs,
   * so a spec can observe durable database state at the exact moment the
   * external write happens. That is what makes "the destination was reserved
   * before the copy" testable rather than merely reviewable: the observation is
   * taken while the copy is in flight, not after it.
   */
  copyProbe: {
    current: null | ((copy: { destination: string; source: string }) => Promise<void>);
  };
  copies: Array<{ destination: string; source: string }>;
  deletes: string[];
  failKeys: Set<string>;
  multipartAborts: string[];
  oneShot: Set<string>;
  put: (key: string, body: Uint8Array, contentType?: string) => void;
  storage: ObjectStore;
  types: Map<string, string>;
}

function objectStoreHarness(): ObjectStoreHarness {
  const bodies = new Map<string, Uint8Array>();
  const types = new Map<string, string>();
  const failKeys = new Set<string>();
  const oneShot = new Set<string>();
  const deletes: string[] = [];
  const copies: Array<{ destination: string; source: string }> = [];
  const multipartAborts: string[] = [];
  let generation = 0;

  /**
   * Raises the injected transport fault for a key when configured. One-shot
   * faults fire exactly once so a replayed attempt observes a healthy store.
   */
  const check = (key: string) => {
    if (oneShot.has(key)) {
      oneShot.delete(key);
      throw new Error("injected storage fault");
    }
    if (failKeys.has(key)) {
      throw new Error("injected storage fault");
    }
  };

  const metadataFor = async (key: string): Promise<ObjectMetadata | null> => {
    const body = bodies.get(key);
    if (!body) return null;
    const digest = await sha256Hex(body);
    return {
      contentType: types.get(key) ?? null,
      etag: digest.slice(0, 32),
      key,
      sha256: digest,
      size: body.byteLength,
      uploadedAt: new Date(),
      version: String(generation),
    };
  };

  const multipart = (uploadId: string): MultipartUpload => ({
    abort: vi.fn(async () => {
      multipartAborts.push(uploadId);
    }),
    complete: vi.fn(),
    uploadId,
    uploadPart: vi.fn(),
  });

  const storage: ObjectStore = {
    copyObject: vi.fn(async (sourceKey, destinationKey, options = {}) => {
      check(sourceKey);
      check(destinationKey);
      const source = bodies.get(sourceKey);
      if (!source) return null;
      if (options.ifSourceEtagMatches) {
        const etag = (await sha256Hex(source)).slice(0, 32);
        if (etag !== options.ifSourceEtagMatches) return null;
      }
      if (options.ifDestinationAbsent && bodies.has(destinationKey)) {
        return null;
      }
      // Awaited while the copy is still pending, so a probe observes the exact
      // durable state the promotion was required to establish first. It runs
      // after the guard checks, so a declined copy probes nothing.
      await copyProbe.current?.({
        destination: destinationKey,
        source: sourceKey,
      });
      const body = new Uint8Array(source);
      bodies.set(destinationKey, body);
      types.set(
        destinationKey,
        options.contentType ?? types.get(sourceKey) ?? "application/octet-stream",
      );
      generation += 1;
      copies.push({ destination: destinationKey, source: sourceKey });
      return metadataFor(destinationKey);
    }),
    createMultipartUpload: vi.fn(async () => multipart("created")),
    delete: vi.fn(async (key) => {
      check(key);
      deletes.push(key);
      bodies.delete(key);
      types.delete(key);
    }),
    head: vi.fn(async (key) => {
      check(key);
      return metadataFor(key);
    }),
    readPrefix: vi.fn(async (key, maximumBytes) => {
      check(key);
      const body = bodies.get(key);
      return body ? body.slice(0, maximumBytes) : null;
    }),
    readRange: vi.fn(async (key, offset, maximumBytes) => {
      check(key);
      const body = bodies.get(key);
      return body ? body.slice(offset, offset + maximumBytes) : null;
    }),
    resumeMultipartUpload: vi.fn((_key, uploadId) => multipart(uploadId)),
  };

  /**
   * Installs raw bytes under a key, exactly like an R2 PUT through a signed
   * capability: no inventory row is touched, so specs can place foreign or
   * engine-produced bytes and observe whether the pipeline adopts or deletes
   * them.
   */
  const put = (key: string, body: Uint8Array, contentType = "image/png") => {
    bodies.set(key, body);
    types.set(key, contentType);
  };
  // A mutable holder rather than a plain field: the probe is installed by a
  // spec after the harness is built, and `copyObject` closes over this box.
  const copyProbe = {
    current: null as null | ((copy: { destination: string; source: string }) => Promise<void>),
  };
  return {
    bodies,
    copyProbe,
    copies,
    deletes,
    failKeys,
    multipartAborts,
    oneShot,
    put,
    storage,
    types,
  };
}

interface MediaProcessorHarness {
  calls: Array<{
    expectedSize: number;
    inputKey: string;
    jobId: string;
    maximumOutputBytes: number;
    outputGrantDeadlineMs: number | null;
    outputKey: string;
  }>;
  conflicts: string[];
  namespace: AutomationEnv["MEDIA_PROCESSOR"];
  scripted: ScriptedOutcome[];
  stub: {
    process: (job: NativeProcessorJob) => Promise<MediaProcessorRpcOutcome>;
  };
}

/** SHA-256 hex digest of real bytes, mirroring R2's reported checksum. */
async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Per-file output ceiling `reserveOutputs` charges an image reservation at:
 * `mediaUploadMaximum('image/png')`. The reservation is deliberately the
 * media ceiling rather than the uploaded byte count, because normalization
 * can legitimately produce a larger object than an opaque source — so specs
 * assert this exact number rather than the fixture's 24-byte body length.
 */
const imageReservationCeiling = mediaUploadMaximum("image/png");
if (imageReservationCeiling === null) {
  throw new Error("Processing fixtures require the supported PNG upload policy.");
}

/** One scripted engine outcome consumed by the media-processor double. */
type ScriptedOutcome =
  | { kind: "misreport_checksum" }
  | { kind: "misreport_size" }
  | { kind: "optimized" }
  | { kind: "original_compatible" }
  | {
      error: { code: string; message: string; retryable: boolean };
      kind: "failure";
    };

/**
 * Deterministic rendition bytes the engine double produces for a source: a
 * JPEG-flavoured signature, the measured display dimensions, and the source
 * digest. The content is byte-distinct from its input and every field the
 * verdict reports is parsed back out of the bytes actually written, so the
 * Worker-side verification exercises real identity, not a metadata echo.
 */
function engineRenditionBytes(width: number, height: number, sourceSha256: string): Uint8Array {
  const output = new Uint8Array(44);
  output.set([0xff, 0xd8, 0xff, 0xe0], 0);
  const view = new DataView(output.buffer);
  view.setUint32(4, width);
  view.setUint32(8, height);
  const digest = new TextEncoder().encode(sourceSha256.slice(0, 32));
  output.set(digest, 12);
  return output;
}

/**
 * Reads the absolute instant a signed capability commits to, from the
 * `X-Amz-Date` and `X-Amz-Expires` parameters SigV4 puts on every presigned
 * URL. The pipeline bounds the output grant by the reservation row's persisted
 * write hold, so specs compare this deadline against that row — a relative
 * TTL minted after a delayed sign would land measurably later.
 */
function grantDeadlineMsFromUrl(url: string): number | null {
  const params = new URL(url).searchParams;
  const stamped = params.get("X-Amz-Date");
  const expires = params.get("X-Amz-Expires");
  if (!stamped || !expires) return null;
  const iso = `${stamped.slice(0, 4)}-${stamped.slice(4, 6)}-${stamped.slice(
    6,
    8,
  )}T${stamped.slice(9, 11)}:${stamped.slice(11, 13)}:${stamped.slice(13, 15)}Z`;
  const parsed = Number(expires);
  return Number.isFinite(parsed) ? Date.parse(iso) + parsed * 1_000 : null;
}

/**
 * Media-processor Durable Object namespace double: `get(idFromName(name))`
 * returns a stub whose `process(job)` is a real deterministic byte transformer
 * over the harness contents, matching the `MediaProcessorRpcOutcome` union the
 * production adapter consumes.
 *
 * The stub parses the object keys out of the job's signed `input_url` and
 * `output_url` (`https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`),
 * reads the input bytes from the harness, parses the PNG IHDR for real media
 * facts, and writes genuinely different bytes at the output key. It honours
 * the create-only capability: when the output key already exists it refuses
 * with a conflict outcome instead of overwriting. Scriptable
 * outcomes let specs drive `optimized`, `original_compatible`, permanent and
 * retryable failures, and verdicts whose reported size or checksum does not
 * match the bytes written. Jobs are deduplicated by `job_id` like the real
 * engine's replay guard, including its distrust rule: a recorded verdict
 * answers a redelivery directly, except an `optimized` verdict whose stored
 * object may have been deleted by the Worker's recovery — that job
 * re-executes, the create-only PUT either recreates the bytes or refuses with
 * a 412-shaped `output_exists`, and the recorded verdict replays only when the
 * recomputed output proves byte-identical to the recorded one — the engine
 * never inspects the stored object (a create-only grant carries no read), so
 * whether the stored bytes are that output is the Worker's stored-digest
 * check (sha256, else the PUT-recorded ETag) to prove before promotion.
 */
function mediaProcessorNamespace(harness: ObjectStoreHarness): MediaProcessorHarness {
  const calls: MediaProcessorHarness["calls"] = [];
  const conflicts: string[] = [];
  const verdictsByJob = new Map<string, NativeProcessorSuccess>();
  const scripted: ScriptedOutcome[] = [];

  const keyFromUrl = (url: string): string => {
    const pathname = new URL(url).pathname;
    const slash = pathname.indexOf("/", 1);
    return decodeURIComponent(pathname.slice(slash + 1));
  };

  const stub = {
    /**
     * Executes one job against the harness bytes. The outcome is derived from
     * what was actually read and written; failures arrive as data, never as
     * thrown RPC errors.
     */
    async process(job: NativeProcessorJob): Promise<MediaProcessorRpcOutcome> {
      const recorded = verdictsByJob.get(job.job_id);
      // An 'optimized' verdict is only replayable while the object it uploaded
      // still exists or provably holds the job's own bytes: the Worker deletes
      // an unrecorded staging object before re-invoking, so the entry is
      // distrusted and the job re-executes — exactly like the real engine. A
      // verdict with no output (original_compatible) replays directly.
      const distrusted = recorded?.result === "optimized" && recorded.output ? recorded : undefined;
      if (recorded && !distrusted) {
        return { ok: true, result: { ...recorded, replayed: true } };
      }
      const inputKey = keyFromUrl(job.input_url);
      const outputKey = keyFromUrl(job.output_url);
      calls.push({
        expectedSize: job.expected_size,
        inputKey,
        jobId: job.job_id,
        maximumOutputBytes: job.maximum_output_bytes,
        outputGrantDeadlineMs: grantDeadlineMsFromUrl(job.output_url),
        outputKey,
      });

      const input = harness.bodies.get(inputKey);
      if (!input) {
        return {
          error: {
            code: "input_missing",
            message: "The input object could not be read.",
            retryable: true,
          },
          ok: false,
        };
      }
      const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
      const isPng =
        input.byteLength >= 24 &&
        pngSignature.every((byte, index) => input[index] === byte) &&
        input[12] === 73 &&
        input[13] === 72 &&
        input[14] === 68 &&
        input[15] === 82;
      if (!isPng) {
        return {
          error: {
            code: "corrupt_media",
            message: "The uploaded file could not be decoded as image/png.",
            retryable: false,
          },
          ok: false,
        };
      }
      const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
      // Dimensions come from the body because the IHDR is the only real signal
      // these fixture bytes carry; the FORMAT decision is driven by
      // `job.declared_content_type` instead, because that is the value the
      // pipeline supplies and the value the engine classifies on. A PNG-
      // signature body declared as JPEG is therefore intentional, not a bug:
      // swapping in a real JPEG encoder would add bytes without adding
      // assertion power, and a second encoder here is surface to rot.
      const width = view.getUint32(16);
      const height = view.getUint32(20);
      const inputSha256 = await sha256Hex(input);
      // A duration is derived from the body the same way dimensions are: these
      // fixture bytes carry no container, so there is no real timeline to probe.
      // A video source reports a positive duration and an image reports none,
      // which is what makes "the accepted original object carries a measured
      // duration" a distinguishable claim rather than a NULL echo. It is still
      // derived from real bytes, never from the value an assertion wants.
      const durationSeconds = job.profile.kind === "video" ? input.byteLength / 10 : null;
      const directive = scripted.shift() ?? { kind: "optimized" as const };
      const media = {
        animated: false,
        content_type: "image/jpeg",
        duration_seconds: durationSeconds,
        frame_count: 1,
        has_audio: false,
        height,
        width,
      };
      const engine = {
        duration_ms: 12,
        ffmpeg: "double-1.0",
        vips: "double-1.0",
      };
      const inputFacts = { bytes: input.byteLength, sha256: inputSha256 };

      if (directive.kind === "failure") {
        return { error: directive.error, ok: false };
      }
      if (directive.kind === "original_compatible") {
        const result = {
          engine,
          input: inputFacts,
          job_id: job.job_id,
          media: { ...media, content_type: job.declared_content_type },
          output: null,
          result: "original_compatible" as const,
          status: "succeeded" as const,
        };
        verdictsByJob.set(job.job_id, result);
        return { ok: true, result };
      }

      // Create-only honouring: a signed PUT carrying If-None-Match: * is
      // rejected by the store when the key exists, so the engine surfaces the
      // same terminal conflict rather than clobbering committed bytes. When a
      // distrusted verdict exists, byte-identical recomputation
      // (produced sha == recorded output sha) is all the engine can prove —
      // it never inspects the stored object, so the verdict replays and
      // whether the STORED bytes match is the Worker's stored-digest check
      // (sha256, else recorded ETag) to decide. A conflict without a
      // distrusted entry is the same terminal `output_exists` the real
      // engine answers.
      const produced = engineRenditionBytes(width, height, inputSha256);
      const producedSha256 = await sha256Hex(produced);
      if (harness.bodies.has(outputKey)) {
        conflicts.push(outputKey);
        if (distrusted && producedSha256 === distrusted.output!.sha256) {
          return {
            ok: true,
            result: { ...distrusted, replayed: true },
          };
        }
        return {
          error: {
            code: "output_exists",
            message: "The rendition object already exists.",
            retryable: false,
          },
          ok: false,
        };
      }

      harness.put(outputKey, produced, "image/jpeg");
      const output = {
        bytes: directive.kind === "misreport_size" ? produced.byteLength + 1 : produced.byteLength,
        content_type: "image/jpeg",
        etag: producedSha256.slice(0, 32),
        sha256: directive.kind === "misreport_checksum" ? "f".repeat(64) : producedSha256,
      };
      const result = {
        engine,
        input: inputFacts,
        job_id: job.job_id,
        media,
        output,
        result: "optimized" as const,
        status: "succeeded" as const,
      };
      verdictsByJob.set(job.job_id, result);
      return { ok: true, result };
    },
  };

  const namespace = {
    get: vi.fn((_id: unknown) => stub),
    idFromName: vi.fn((name: string) => name),
  } as unknown as AutomationEnv["MEDIA_PROCESSOR"];

  return { calls, conflicts, namespace, scripted, stub };
}

/**
 * AutomationEnv for processing specs: the shared env plus the R2 signing
 * credentials `processorJobUrlsEffect` requires and the injected
 * `MEDIA_PROCESSOR` namespace double.
 */
function processorEnv(processor: MediaProcessorHarness): AutomationEnv {
  return {
    ...env,
    MEDIA_PROCESSOR: processor.namespace,
    R2_ACCESS_KEY_ID: "test-r2-access-key",
    R2_ACCOUNT_ID: "test-account",
    R2_BUCKET_NAME: "meltiply-test-assets",
    R2_SECRET_ACCESS_KEY: "test-r2-secret-access-key",
  };
}

/**
 * Fixture for the state `completeUploadSession` commits when an upload
 * finalizes: an Asset in `processing` carrying the pinned source identity, and
 * its `asset_objects` staging row in `ready` holding the verified bytes, ETag,
 * version, checksum, and content type. Both rows commit atomically, matching
 * the finalized upload state the processing pipeline promotes.
 *
 * The staging key mirrors the upload-writable namespace
 * (`staging/<org>/<asset>/<session>/<name>`) and the object is installed in
 * the harness so every derived identity (ETag/SHA-256/size) is real.
 *
 * @returns The staging key, real body, and derived object metadata.
 */
async function stagedUploadFixture(options: {
  assetId: string;
  assetType?: "image" | "video";
  body?: Uint8Array;
  contentType?: string;
  fileSize?: number;
  harness: ObjectStoreHarness;
  title: string;
}) {
  const {
    assetId,
    assetType = "image",
    body = png(320, 240),
    contentType = "image/png",
    fileSize,
    harness,
    title,
  } = options;
  const sessionId = `d5000000-0000-4000-8000-${assetId.slice(24)}`;
  const stagingKey = `staging/${organizationId}/${assetId}/${sessionId}/upload.bin`;
  harness.put(stagingKey, body, contentType);
  const metadata = await harness.storage.head(stagingKey);
  if (!metadata) throw new Error("staging fixture write failed");
  await runSystemTransaction(env, async (client) => {
    await client.query(
      `INSERT INTO assets
         (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
          file_size, mime_type, status, source_etag, source_sha256,
          finalized_at)
       VALUES ($1, $2, $4, $3, $5, $6, $7, $8, 'processing', $9, $10, now())`,
      [
        assetId,
        organizationId,
        userId,
        seededAlphaProfileId,
        assetType,
        title,
        fileSize ?? body.byteLength,
        contentType,
        metadata.etag,
        metadata.sha256 ?? null,
      ],
    );
    await client.query(
      `INSERT INTO asset_objects
         (org_id, asset_id, brand_profile_id, kind, r2_key, bytes, etag,
          version, sha256, content_type, status, write_hold_until)
       VALUES ($1, $2, $3, 'staging', $4, $5, $6, $7, $8, $9, 'ready',
               now() + interval '1 hour')`,
      [
        organizationId,
        assetId,
        seededAlphaProfileId,
        stagingKey,
        metadata.size,
        metadata.etag,
        metadata.version ?? null,
        metadata.sha256 ?? null,
        contentType,
      ],
    );
    await client.query(
      `INSERT INTO usage_records (org_id, period, uploads, storage_bytes)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (org_id, period) DO UPDATE
         SET uploads = usage_records.uploads + 1,
             storage_bytes = usage_records.storage_bytes + EXCLUDED.storage_bytes,
             updated_at = now()`,
      [organizationId, currentUsagePeriod, metadata.size],
    );
  });
  return { body, metadata, stagingKey };
}

interface InventoryRow extends Record<string, unknown> {
  asset_id: string;
  bytes: string | null;
  content_type: string | null;
  /** Native-decoded duration in seconds; NULL when no duration was measured. */
  duration_sec: string | null;
  /** R2-reported ETag recorded when the object's bytes were settled. */
  etag: string | null;
  height: number | null;
  width: number | null;
  id: string;
  kind: string;
  profile: string | null;
  r2_key: string;
  reserved_bytes: string | null;
  sha256: string | null;
  status: string;
  /** Persisted deadline a late writer grant could still recreate bytes by. */
  write_hold_until: Date | null;
}

/** Reads the full `asset_objects` inventory for one Asset, ordered by key. */
async function assetInventory(assetId: string): Promise<InventoryRow[]> {
  return runSystemTransaction(env, async (client) => {
    const result = await client.query<InventoryRow>(
      `SELECT id, asset_id, kind, profile, r2_key,
              bytes::text, reserved_bytes::text, etag, sha256, content_type,
              status, write_hold_until, width, height, duration_sec::text
       FROM asset_objects
       WHERE asset_id = $1
       ORDER BY r2_key`,
      [assetId],
    );
    return result.rows;
  });
}

interface RenditionRow extends Record<string, unknown> {
  failure_code: string | null;
  object_id: string | null;
  profile: string;
  status: string;
}

/** Reads the `asset_renditions` rows for one Asset, ordered by profile. */
async function assetRenditions(assetId: string): Promise<RenditionRow[]> {
  return runSystemTransaction(env, async (client) => {
    const result = await client.query<RenditionRow>(
      `SELECT profile, status, object_id, failure_code
       FROM asset_renditions
       WHERE asset_id = $1
       ORDER BY profile`,
      [assetId],
    );
    return result.rows;
  });
}

/**
 * Sums an organization's charged bytes exactly as `chargedCapacitySql`, the
 * API's usage query, and `settleDeletedObjects` all do: every inventoried
 * object that is not `'deleted'` contributes
 * `GREATEST(COALESCE(bytes, 0), COALESCE(reserved_bytes, 0))` — the larger of
 * its verified size and the reservation it still holds, never the sum, because
 * one physical key cannot hold both at once — plus every live
 * `asset_quota_reservations` promise, which is capacity an unfinished upload
 * has already claimed. Used to prove charge-once accounting without reading the
 * driftable `usage_records` counter.
 */
async function chargedObjectBytes(orgId: string): Promise<bigint> {
  return runSystemTransaction(env, async (client) => {
    const result = await client.query<{ charged: string }>(
      `SELECT (COALESCE(SUM(GREATEST(COALESCE(object.bytes, 0),
                                       COALESCE(object.reserved_bytes, 0))), 0)
              + COALESCE((
                  SELECT SUM(reservation.bytes)
                  FROM asset_quota_reservations AS reservation
                  WHERE reservation.org_id = $1
                    AND reservation.state = 'reserved'
                ), 0))::text AS charged
       FROM asset_objects AS object
       WHERE object.org_id = $1
         AND object.status <> 'deleted'`,
      [orgId],
    );
    return BigInt(result.rows[0]?.charged ?? "0");
  });
}

/**
 * Creates a genuine in-flight upload session for an Asset that is otherwise
 * unrelated to the spec under test: a `created` session, its `staging` object
 * row (the real upload path starts that row with neither `bytes` nor
 * `reserved_bytes`, because `asset_quota_reservations` holds these bytes), and
 * the `asset_quota_reservations` row that actually claims them.
 *
 * This is the boundary a processing reservation must respect: the session's
 * bytes are charged before any object row exists for them. Its single-request
 * session leaves multipart fields absent, matching the persisted upload shape;
 * ignoring the quota row would promise the same capacity twice.
 *
 * @param options - Identifiers for the fixture and the size it claims.
 * @returns The promised byte count, for asserting against a charged total.
 */
async function pendingUploadFixture(options: {
  assetId: string;
  bytes: number;
  title: string;
}): Promise<number> {
  const { assetId, bytes, title } = options;
  const sessionId = `d6000000-0000-4000-8000-${assetId.slice(24)}`;
  await runSystemTransaction(env, async (client) => {
    await client.query(
      `INSERT INTO assets
         (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
          status)
       VALUES ($1, $2, $3, $4, 'image', $5, 'pending_upload')`,
      [assetId, organizationId, seededAlphaProfileId, userId, title],
    );
    await client.query(
      `INSERT INTO asset_upload_sessions
         (id, org_id, asset_id, uploaded_by, strategy, status, content_type,
          file_size, object_key, expires_at)
       VALUES ($1, $2, $3, $4, 'single', 'uploading', 'image/png', $5, $6,
               now() + interval '1 hour')`,
      [
        sessionId,
        organizationId,
        assetId,
        userId,
        bytes,
        `staging/${organizationId}/${assetId}/${sessionId}/upload.bin`,
      ],
    );
    await client.query(
      `INSERT INTO asset_objects
         (org_id, asset_id, brand_profile_id, kind, r2_key, content_type,
          status)
       VALUES ($1, $2, $3, 'staging', $4, 'image/png', 'writing')`,
      [
        organizationId,
        assetId,
        seededAlphaProfileId,
        `staging/${organizationId}/${assetId}/${sessionId}/upload.bin`,
      ],
    );
    await client.query(
      `INSERT INTO asset_quota_reservations (session_id, org_id, bytes)
       VALUES ($1, $2, $3)`,
      [sessionId, organizationId, bytes],
    );
  });
  return bytes;
}

/**
 * Reads one Asset's lifecycle columns, its ownership-aware orphan clock, and
 * its processing lease outcome, so specs can assert both the durable failure
 * evidence and the reclamation deadline a failure arms.
 */
async function processingState(
  assetId: string,
  eventId: string,
): Promise<
  | {
      attempt_count: number;
      event_outcome: string;
      failure_code: string | null;
      height: number | null;
      orphan_armed: boolean;
      status: string;
      width: number | null;
    }
  | undefined
> {
  return runSystemTransaction(env, async (client) => {
    const result = await client.query<{
      attempt_count: number;
      event_outcome: string;
      failure_code: string | null;
      height: number | null;
      orphan_armed: boolean;
      status: string;
      width: number | null;
    }>(
      `SELECT asset.status, asset.width, asset.height, asset.failure_code,
              (asset.orphaned_at IS NOT NULL
               AND asset.orphan_delete_after IS NOT NULL) AS orphan_armed,
              event.outcome AS event_outcome, event.attempt_count
       FROM assets AS asset
       JOIN async_job_events AS event ON event.aggregate_id = asset.id
       WHERE asset.id = $1 AND event.event_key = $2`,
      [assetId, `outbox:${eventId}`],
    );
    return result.rows[0];
  });
}

function outboxMessage(eventId: string, aggregateId: string, topic = "asset.processing.requested") {
  return {
    aggregate_id: aggregateId,
    event_id: eventId,
    organization_id: organizationId,
    payload: { asset_id: aggregateId },
    topic,
    type: "outbox.event" as const,
    version: 1 as const,
  };
}

/**
 * Mints the fixture Post id paired with one fixture Distribution id.
 *
 * `distributions` enforces `(post_id, platform_account_id)` unique, so specs
 * that stage several rows on the same Channel need one Post each. Deriving
 * the Post id from the Distribution id keeps the pairing readable at the
 * fixture site and lets the suite cleanup enumerate every seeded Post from
 * the Distribution ids alone.
 *
 * @param distributionId - UUID of the Distribution the Post will own.
 * @returns UUID in the `4d000000-…` fixture family with the Distribution's id suffix.
 */
function postIdForDistribution(distributionId: string): string {
  return `4d000000-0000-4000-8000-${distributionId.slice(24)}`;
}

/**
 * Seeds the Post-owned identity a Distribution fixture requires in place of
 * the removed `distributions.asset_id` column.
 *
 * One call writes the complete composition a publish claim resolves: the Post
 * row, its ordered `post_attachments` (what the claim query joins for media),
 * and the saved `post_targets` row whose per-Channel settings the schedule
 * path copies onto the Distribution row. Defaults bind the seeded Alpha Brand
 * Profile, the canonical ready image Asset, and the seeded YouTube Channel so
 * single-Channel specs keep their pre-cutover shape; specs pass `orgId`,
 * `brandProfileId`, `assetIds`, or `target` overrides when they need a
 * different tenant or selection. All three statements are idempotent so a
 * re-run after an interrupted suite re-establishes the fixture instead of
 * failing on keys the suite cleanup never reached.
 *
 * @param client - Active system-transaction query client.
 * @param options - Fixture identity plus the composition it must carry.
 * @returns Resolves once the Post, its attachments, and its target exist.
 */
async function seedDistributionPost(
  client: Queryable,
  options: {
    postId: string;
    orgId?: string;
    brandProfileId?: string;
    title?: string;
    defaultText?: string;
    assetIds?: readonly string[];
    target?: {
      platformAccountId: string;
      titleOverride?: string;
      descriptionOverride?: string;
      hashtags?: readonly string[];
      attachmentIds?: readonly string[];
    };
  },
): Promise<void> {
  const orgId = options.orgId ?? organizationId;
  const brandProfileId = options.brandProfileId ?? seededAlphaProfileId;
  const assetIds = options.assetIds ?? [seededAlphaAssetId];
  await client.query(
    `INSERT INTO posts (id, org_id, brand_profile_id, title, default_text, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title,
           default_text = EXCLUDED.default_text,
           updated_at = now()`,
    [
      options.postId,
      orgId,
      brandProfileId,
      options.title ?? "Automation fixture post",
      options.defaultText ?? "",
    ],
  );
  await client.query(
    `INSERT INTO post_attachments
       (post_id, asset_id, org_id, brand_profile_id, position)
     SELECT $1, item.asset_id, $2, $3, (item.ordinality - 1)::int
     FROM unnest($4::uuid[]) WITH ORDINALITY AS item(asset_id, ordinality)
     ON CONFLICT (post_id, asset_id) DO NOTHING`,
    [options.postId, orgId, brandProfileId, [...assetIds]],
  );
  if (options.target !== undefined) {
    await client.query(
      `INSERT INTO post_targets
         (post_id, platform_account_id, org_id, brand_profile_id,
          title_override, description_override, hashtags, attachment_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::uuid[])
       ON CONFLICT (post_id, platform_account_id) DO UPDATE
         SET title_override = EXCLUDED.title_override,
             description_override = EXCLUDED.description_override,
             hashtags = EXCLUDED.hashtags,
             attachment_ids = EXCLUDED.attachment_ids,
             updated_at = now()`,
      [
        options.postId,
        options.target.platformAccountId,
        orgId,
        brandProfileId,
        options.target.titleOverride ?? null,
        options.target.descriptionOverride ?? null,
        options.target.hashtags ?? null,
        options.target.attachmentIds ?? null,
      ],
    );
  }
}

// Fixture Distribution ids staged by the specs below; the suite-level cleanup
// enumerates them once so each spec's rows cannot leak into later runs.
const automationDistributionFixtureIds = [
  "93000000-0000-4000-8000-000000000001",
  "93000000-0000-4000-8000-000000000002",
  "93000000-0000-4000-8000-000000000003",
  "93000000-0000-4000-8000-000000000004",
  "93000000-0000-4000-8000-000000000005",
  "93000000-0000-4000-8000-000000000006",
  "93000000-0000-4000-8000-000000000007",
  "93000000-0000-4000-8000-000000000008",
  "93000000-0000-4000-8000-000000000009",
  "93000000-0000-4000-8000-000000000010",
  "93000000-0000-4000-8000-000000000011",
  "93000000-0000-4000-8000-000000000031",
  "93000000-0000-4000-8000-000000000032",
  "93000000-0000-4000-8000-000000000033",
  "93000000-0000-4000-8000-000000000034",
  "93000000-0000-4000-8000-000000000035",
  "93000000-0000-4000-8000-000000000036",
  "93000000-0000-4000-8000-000000000037",
  "93000000-0000-4000-8000-000000000038",
  "93000000-0000-4000-8000-000000000051",
  "93000000-0000-4000-8000-000000000052",
  "93000000-0000-4000-8000-000000000053",
  "93000000-0000-4000-8000-000000000054",
  "93000000-0000-4000-8000-000000000061",
  "93000000-0000-4000-8000-000000000062",
  "93000000-0000-4000-8000-000000000063",
  "93000000-0000-4000-8000-000000000064",
  "93000000-0000-4000-8000-000000000065",
];

// The posts the fixtures seed for those Distributions, plus the three rows
// whose specs delete only the Distribution in-test: post_attachments and
// post_targets cascade, but posts themselves must be removed explicitly.
const automationFixturePostIds = [
  ...automationDistributionFixtureIds,
  "93000000-0000-4000-8000-000000000091",
  "93000000-0000-4000-8000-000000000148",
  "93000000-0000-4000-8000-000000000149",
].map(postIdForDistribution);

// Outbox aggregates the suite cleanup purges: every fixture Distribution id
// plus the `…071`–`…081` Asset ids whose deletion sweeps arm
// `asset.deletion.requested` events keyed on the Asset itself.
const automationOutboxAggregateIds = [
  ...automationDistributionFixtureIds,
  "93000000-0000-4000-8000-000000000071",
  "93000000-0000-4000-8000-000000000072",
  "93000000-0000-4000-8000-000000000073",
  "93000000-0000-4000-8000-000000000074",
  "93000000-0000-4000-8000-000000000075",
  "93000000-0000-4000-8000-000000000076",
  "93000000-0000-4000-8000-000000000077",
  "93000000-0000-4000-8000-000000000078",
  "93000000-0000-4000-8000-000000000079",
  "93000000-0000-4000-8000-000000000080",
  "93000000-0000-4000-8000-000000000081",
  "93000000-0000-4000-8000-000000000082",
  "93000000-0000-4000-8000-000000000083",
  "93000000-0000-4000-8000-000000000084",
  "93000000-0000-4000-8000-000000000085",
  "93000000-0000-4000-8000-000000000086",
  "93000000-0000-4000-8000-000000000087",
  "93000000-0000-4000-8000-000000000088",
];

// Aggregate-id families this suite owns outright. `outbox_events.aggregate_id`
// and `async_job_events.aggregate_id` are plain UUIDs with no foreign key, so
// deleting the Asset or Distribution row never removes the events and job
// leases keyed on it. The deletion sweeps arm `asset.deletion.requested` and
// lifecycle-recovery events on the Asset id itself, so purging only the
// enumerated Distribution ids left every media-processing fixture's events and
// leases behind: a re-run then met its own stale pending events and live
// leases. Each family below is minted only by this file and appears nowhere in
// seed.sql, so purging them cannot touch seeded or other suites' rows.
// `b7000000`–`b8000000` belong to the throwaway usage-window workspace (its
// Distributions and its Asset); the org itself is `b6000000` and cascades with
// its own rows.
const automationFixtureAggregateFamilies = [
  "92000000",
  "93000000",
  "94000000",
  "95000000",
  "96000000",
  "97000000",
  "b7000000",
  "b8000000",
].map((family) => `${family}-%`);

async function currentStorageBytes(): Promise<bigint> {
  return runSystemTransaction(env, async (client) => {
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
 * Reads a deleting Asset's durable state for deletion specs: lifecycle status,
 * lease outcome, the period storage counter, and its full object inventory so
 * specs can assert which rows were settled and which remain claimed.
 */
async function deletionState(assetId: string, eventId: string) {
  return runSystemTransaction(env, async (client) => {
    const asset = await client.query<{
      event_outcome: string;
      status: string;
      storage_bytes: string;
    }>(
      `SELECT asset.status,
              event.outcome AS event_outcome, usage.storage_bytes::text
       FROM assets AS asset
       JOIN async_job_events AS event ON event.aggregate_id = asset.id
       JOIN usage_records AS usage
         ON usage.org_id = asset.org_id
        AND usage.period = to_char(now(), 'YYYY-MM')
       WHERE asset.id = $1 AND event.event_key = $2`,
      [assetId, `outbox:${eventId}`],
    );
    const objects = await client.query<{
      bytes: string | null;
      kind: string;
      r2_key: string;
      status: string;
    }>(
      `SELECT kind, r2_key, status, bytes::text
       FROM asset_objects
       WHERE asset_id = $1
       ORDER BY r2_key`,
      [assetId],
    );
    return { ...asset.rows[0], objects: objects.rows };
  });
}

/**
 * Registers a single test-double YouTube adapter so distribution specs can swap
 * only the operations under test. `publish` is required; omitting
 * `cancelPublication` exercises the no-cancel-adapter path, `lookupPublication`
 * defaults to `not_found`, and `retryPolicy` defaults to the 15 s/5-attempt
 * schedule. The returned registry advertises image remote_ingest publishing.
 */
function youtubeRegistry(
  publish: NonNullable<ProviderAdapter["publish"]>,
  cancelPublication?: ProviderAdapter["cancelPublication"],
  lookupPublication: NonNullable<ProviderAdapter["lookupPublication"]> = async () => ({
    state: "not_found",
  }),
  retryPolicy: ProviderAdapter["retryPolicy"] = {
    baseDelaySeconds: 15,
    maxAttempts: 5,
    maxDelaySeconds: 300,
  },
): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("youtube", {
    capability: {
      accepted_mime_types: ["image/png"],
      analytics: false,
      asset_types: ["image"],
      comments: false,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: 25 * 1024 * 1024,
      max_media_count: 1,
      min_media_count: 1,
      multi_asset_types: [],
      max_hashtags: 5,
      max_video_duration_sec: null,
      notes: [],
      platform: "youtube",
      publish: true,
      reply: false,
    },
    lookupPublication,
    publish,
    ...(cancelPublication ? { cancelPublication } : {}),
    retryPolicy,
    transferModes: ["remote_ingest"],
  });
  return registry;
}

/** Supplies reply-only capability so comment retries cannot accidentally publish media. */
function youtubeReplyRegistry(
  reply: NonNullable<ProviderAdapter["reply"]>,
  lookupPublication: NonNullable<ProviderAdapter["lookupPublication"]> = async () => ({
    state: "not_found",
  }),
): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("youtube", {
    capability: {
      accepted_mime_types: [],
      analytics: false,
      asset_types: [],
      comments: false,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: null,
      max_media_count: null,
      min_media_count: 0,
      multi_asset_types: [],
      max_hashtags: null,
      max_video_duration_sec: null,
      notes: [],
      platform: "youtube",
      publish: false,
      reply: true,
    },
    lookupPublication,
    reply,
    retryPolicy: {
      baseDelaySeconds: 15,
      maxAttempts: 5,
      maxDelaySeconds: 300,
    },
    transferModes: [],
  });
  return registry;
}

/** Supplies sync-only capability for analytics/comment lifecycle work without publication. */
function youtubeSyncRegistry(
  listAnalytics: NonNullable<ProviderAdapter["listAnalytics"]>,
  listComments: NonNullable<ProviderAdapter["listComments"]>,
  refreshAccessToken: NonNullable<ProviderAdapter["refreshAccessToken"]>,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("youtube", {
    capability: {
      accepted_mime_types: [],
      analytics: true,
      asset_types: [],
      comments: true,
      connect_available: false,
      max_caption_length: 500,
      max_file_size: null,
      max_media_count: null,
      min_media_count: 0,
      multi_asset_types: [],
      max_hashtags: null,
      max_video_duration_sec: null,
      notes: [],
      platform: "youtube",
      publish: false,
      reply: false,
    },
    listAnalytics,
    listComments,
    refreshAccessToken,
    retryPolicy: {
      baseDelaySeconds: 15,
      maxAttempts: 5,
      maxDelaySeconds: 300,
    },
    transferModes: [],
  });
  return registry;
}

describeIntegration("Automation jobs with PostgreSQL", () => {
  beforeAll(async () => {
    await runSystemTransaction(env, async (client) => {
      const baseline = await client.query<{ id: string }>(
        `SELECT id FROM distributions
         WHERE status NOT IN ('published', 'cancelled')`,
      );
      baselineDistributionIds = baseline.rows.map((row) => row.id);
      const usage = await client.query<{
        api_calls: string;
        distributions: string;
        storage_bytes: string;
        uploads: string;
      }>(
        `SELECT api_calls::text, distributions::text,
                storage_bytes::text, uploads::text
         FROM usage_records
         WHERE org_id = $1 AND period = $2`,
        [organizationId, currentUsagePeriod],
      );
      currentUsageBefore = usage.rows[0];
    });
  });

  afterAll(async () => {
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `DELETE FROM outbox_events
         WHERE dedupe_key LIKE 'automation-integration-%'
            OR dedupe_key LIKE 'comment-reply-reconcile:%'
            OR aggregate_id = ANY($1::uuid[])
            OR aggregate_id::text LIKE ANY($2::text[])`,
        [automationOutboxAggregateIds, automationFixtureAggregateFamilies],
      );
      await client.query(
        `DELETE FROM async_job_events
         WHERE event_key LIKE 'outbox:automation-integration-%'
            OR event_key LIKE 'r2:%automation-integration%'
            OR aggregate_id = ANY($1::uuid[])
            OR aggregate_id::text LIKE ANY($2::text[])`,
        [automationOutboxAggregateIds, automationFixtureAggregateFamilies],
      );
      await client.query(
        `DELETE FROM provider_operations
         WHERE comment_id = '80000000-0000-4000-8000-000000000001'`,
      );
      await client.query(
        `DELETE FROM comments
         WHERE distribution_id = '60000000-0000-4000-8000-000000000001'
           AND platform_comment_id LIKE 'automation-sync-%'`,
      );
      await client.query(
        `DELETE FROM analytics_snapshots
         WHERE distribution_id = '60000000-0000-4000-8000-000000000001'
           AND snapshot_at = '2026-07-19T12:00:00Z'`,
      );
      await client.query("DELETE FROM rate_limit_budgets");
      await client.query(
        `UPDATE comments
         SET reply_text = NULL, reply_status = 'none', reply_error = NULL,
             replied = false, reply_attempted_at = NULL,
             reply_provider_operation_id = NULL,
             reply_provider_post_id = NULL, reply_attempt_count = 0,
             reply_reconciliation_attempt_count = 0,
             reply_lease_expires_at = NULL, updated_at = now()
         WHERE id = '80000000-0000-4000-8000-000000000001'`,
      );
      await client.query("DELETE FROM assets WHERE title LIKE 'Automation integration %'");
      await client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [
        automationDistributionFixtureIds,
      ]);
      // Post-owned fixtures leave their Posts behind otherwise: deleting the
      // Post cascades its post_attachments and post_targets in one statement.
      await client.query("DELETE FROM posts WHERE id = ANY($1::uuid[])", [
        automationFixturePostIds,
      ]);
      if (currentUsageBefore) {
        await client.query(
          `UPDATE usage_records
           SET uploads = $3, distributions = $4, api_calls = $5,
               storage_bytes = $6, updated_at = now()
           WHERE org_id = $1 AND period = $2`,
          [
            organizationId,
            currentUsagePeriod,
            currentUsageBefore.uploads,
            currentUsageBefore.distributions,
            currentUsageBefore.api_calls,
            currentUsageBefore.storage_bytes,
          ],
        );
      }
      await client.query(
        `UPDATE distributions
         SET analytics_cursor = NULL, analytics_last_synced_at = NULL,
             analytics_next_sync_at = NULL,
             analytics_lease_expires_at = NULL,
             analytics_sync_event_id = NULL, analytics_attempt_count = 0,
             analytics_last_error = NULL,
             comments_cursor = NULL, comments_last_synced_at = NULL,
             comments_next_sync_at = NULL,
             comments_lease_expires_at = NULL,
             comments_sync_event_id = NULL, comments_attempt_count = 0,
             comments_last_error = NULL, updated_at = now()
         WHERE id = '60000000-0000-4000-8000-000000000001'`,
      );
      await client.query(
        `UPDATE platform_accounts
         SET access_token = 'local-only-not-a-provider-credential',
             refresh_token = NULL, token_expires_at = NULL,
             scopes = ARRAY['upload'], connection_status = 'connected',
             token_refresh_next_attempt_at = NULL,
             token_refresh_lease_expires_at = NULL,
             token_refresh_event_id = NULL,
             token_refresh_attempt_count = 0,
             token_refresh_last_error = NULL,
             reconnect_notified_at = NULL, updated_at = now()
         WHERE id = '50000000-0000-4000-8000-000000000001'`,
      );
    });
    await systemPoolFor(env).end();
  });

  it("leases, publishes, and closes an outbox event once", async () => {
    const eventId = "92000000-0000-4000-8000-000000000001";
    send.mockClear();
    await runSystemTransaction(env, (client) =>
      client.query(
        `INSERT INTO outbox_events
           (id, org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES (
           $1, $2, 'asset.processing.requested', 'asset',
           '40000000-0000-4000-8000-000000000001',
           'automation-integration-relay',
           '{
             "asset_id":"40000000-0000-4000-8000-000000000001",
             "request_id":"automation-asset-request"
           }'::jsonb
         )`,
        [eventId, organizationId],
      ),
    );

    const relayed = await runRelay(env);
    expect(relayed.failed).toBe(0);
    expect(relayed.claimed).toBeGreaterThanOrEqual(1);
    expect(relayed.published).toBe(relayed.claimed);
    expect(send).toHaveBeenCalledWith([
      {
        body: expect.objectContaining({
          aggregate_id: "40000000-0000-4000-8000-000000000001",
          event_id: eventId,
          payload: {
            asset_id: "40000000-0000-4000-8000-000000000001",
          },
          request_id: "automation-asset-request",
          type: "outbox.event",
        }),
      },
    ]);
    await expect(runRelay(env)).resolves.toEqual({
      claimed: 0,
      dead: 0,
      failed: 0,
      published: 0,
    });
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{ state: string }>(
        "SELECT state FROM outbox_events WHERE id = $1",
        [eventId],
      );
      expect(result.rows[0]?.state).toBe("published");
    });
  });

  it("replays a failed Queue publication without leaking the failing URL", async () => {
    const eventId = "92000000-0000-4000-8000-000000000009";
    send.mockClear();
    send.mockRejectedValueOnce(new Error("queue unavailable at https://signed.example/private"));
    await runSystemTransaction(env, (client) =>
      client.query(
        `INSERT INTO outbox_events
           (id, org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES (
           $1, $2, 'asset.processing.requested', 'asset',
           '40000000-0000-4000-8000-000000000001',
           'automation-integration-relay-failure',
           '{"asset_id":"40000000-0000-4000-8000-000000000001"}'::jsonb
         )`,
        [eventId, organizationId],
      ),
    );

    const failed = await runRelay(env);
    expect(failed).toMatchObject({ failed: 1, published: 0 });
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        attempt_count: number;
        last_error: string;
        state: string;
      }>("SELECT state, attempt_count, last_error FROM outbox_events WHERE id = $1", [eventId]);
      expect(result.rows[0]).toEqual({
        attempt_count: 1,
        last_error: "queue unavailable at [REDACTED_URL]",
        state: "failed",
      });
      await client.query("UPDATE outbox_events SET available_at = now() WHERE id = $1", [eventId]);
    });

    const replayed = await runRelay(env);
    expect(replayed).toMatchObject({ failed: 0, published: 1 });
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        attempt_count: number;
        last_error: string | null;
        state: string;
      }>("SELECT state, attempt_count, last_error FROM outbox_events WHERE id = $1", [eventId]);
      expect(result.rows[0]).toEqual({
        attempt_count: 2,
        last_error: null,
        state: "published",
      });
    });
  });

  it("replays an expired lease after Queue acceptance with the same event identity", async () => {
    const eventId = "92000000-0000-4000-8000-000000000010";
    send.mockClear();
    await runSystemTransaction(env, (client) =>
      client.query(
        `INSERT INTO outbox_events
           (id, org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload,
            state, attempt_count, lease_expires_at)
         VALUES (
           $1, $2, 'asset.processing.requested', 'asset',
           '40000000-0000-4000-8000-000000000001',
           'automation-integration-post-send-crash',
           '{"asset_id":"40000000-0000-4000-8000-000000000001"}'::jsonb,
           'leased', 1, now() - INTERVAL '1 second'
         )`,
        [eventId, organizationId],
      ),
    );

    const replayed = await runRelay(env);
    expect(replayed).toMatchObject({ failed: 0, published: 1 });
    expect(send).toHaveBeenCalledWith([
      {
        body: expect.objectContaining({
          attempt: 2,
          event_id: eventId,
        }),
      },
    ]);
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        attempt_count: number;
        state: string;
      }>("SELECT state, attempt_count FROM outbox_events WHERE id = $1", [eventId]);
      expect(result.rows[0]).toEqual({
        attempt_count: 2,
        state: "published",
      });
    });
  });

  it("routes a distribution outbox row by its authoritative provider", async () => {
    const eventId = "92000000-0000-4000-8000-000000000011";
    const distributionId = "60000000-0000-4000-8000-000000000001";
    youtubePublishSend.mockClear();
    await runSystemTransaction(env, (client) =>
      client.query(
        `INSERT INTO outbox_events
           (id, org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES (
           $1, $2, 'distribution.publish.requested', 'distribution', $3::uuid,
           'automation-integration-provider-route',
           jsonb_build_object('distribution_id', $3::uuid::text, 'version', 1)
         )`,
        [eventId, organizationId, distributionId],
      ),
    );

    await expect(runRelay(env)).resolves.toMatchObject({
      failed: 0,
      published: 1,
    });
    expect(youtubePublishSend).toHaveBeenCalledWith([
      {
        body: expect.objectContaining({
          aggregate_id: distributionId,
          event_id: eventId,
          payload: { distribution_id: distributionId },
        }),
      },
    ]);
    const queuedBatch = youtubePublishSend.mock.calls[0]?.[0] as { body: unknown }[] | undefined;
    const queuedMessage = queuedBatch?.[0]?.body;
    expect(queuedMessage).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(queuedMessage)).byteLength).toBeLessThan(
      64 * 1_024,
    );
  });

  it("promotes a staged upload through the native engine into a ready rendition", async () => {
    const assetId = "92000000-0000-4000-8000-000000000010";
    const eventId = "automation-integration-processing-e2e";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body, stagingKey } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration promoted",
    });
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventId, assetId))),
    ).resolves.toBe("processed");

    const originalKey = `${organizationId}/${assetId}/original`;
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    const produced = engineRenditionBytes(320, 240, await sha256Hex(body));

    // The engine ran exactly once against the promoted original and its
    // create-only grant was the inventoried staging key. The job pinned the
    // real source size and the media-ceiling reservation as its output cap.
    expect(processor.calls).toHaveLength(1);
    const [call] = processor.calls;
    expect(call).toMatchObject({
      expectedSize: body.byteLength,
      inputKey: originalKey,
      jobId: `asset-media:${organizationId}:${assetId}:${profile}`,
      maximumOutputBytes: imageReservationCeiling,
      outputKey: processingKey,
    });
    // The bucket really holds the promoted bytes at the protected keys; the
    // superseded processing copy is still charged while its write hold runs.
    expect(harness.bodies.get(originalKey)).toEqual(body);
    expect(harness.bodies.get(readyKey)).toEqual(produced);
    expect(harness.bodies.get(processingKey)).toEqual(produced);

    const inventory = await assetInventory(assetId);
    const staged = inventory.find((row) => row.kind === "staging");
    const original = inventory.find((row) => row.kind === "original");
    const supersededOutput = inventory.find(
      (row) => row.kind === "rendition" && row.status === "superseded",
    );
    const readyOutput = inventory.find((row) => row.kind === "rendition" && row.status === "ready");
    expect(staged).toMatchObject({ r2_key: stagingKey, status: "superseded" });
    expect(original).toMatchObject({
      bytes: String(body.byteLength),
      content_type: "image/png",
      r2_key: originalKey,
      status: "ready",
    });
    expect(supersededOutput).toMatchObject({
      bytes: String(produced.byteLength),
      profile,
      r2_key: processingKey,
    });
    expect(readyOutput).toMatchObject({
      bytes: String(produced.byteLength),
      content_type: "image/jpeg",
      profile,
      r2_key: readyKey,
    });
    expect(inventory).toHaveLength(4);

    // The signed output capability commits to the reservation row's persisted
    // write hold as an absolute deadline: the grant's own signature instant
    // plus its expires seconds can never outlive the window in which a late
    // PUT could still land. The few-seconds slack absorbs only the transaction
    // and signing work between writing the hold and minting the URL; the
    // signature timestamp itself comes from the URL, not from Date.now().
    expect(call?.outputGrantDeadlineMs).toBeTypeOf("number");
    expect(supersededOutput?.write_hold_until).toBeInstanceOf(Date);
    const outputHoldMs = Number(supersededOutput?.write_hold_until);
    const outputDeadlineMs = Number(call?.outputGrantDeadlineMs);
    expect(outputDeadlineMs).toBeLessThanOrEqual(outputHoldMs);
    expect(outputHoldMs - outputDeadlineMs).toBeLessThan(10_000);

    // Exactly one rendition reference, and it points at the verified optimized
    // output. Promotion deliberately does NOT create an `original`-profile
    // reference: the original is protected at that point but has not been
    // decoded, and a ready reference is precisely what the API's ready-media
    // query joins to, so approving it there would make a corrupt or truncated
    // upload publishable before anything inspected the media.
    const renditions = await assetRenditions(assetId);
    expect(renditions).toHaveLength(1);
    expect(renditions[0]).toMatchObject({
      object_id: readyOutput?.id,
      profile,
      status: "ready",
    });
    expect(renditions.map((row) => row.object_id)).not.toContain(original?.id);
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      height: 240,
      status: "ready",
      width: 320,
    });
  });

  it("bounds the minted output capability by the persisted write-hold deadline", async () => {
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);

    // The caller passes the reservation row's persisted deadline as an absolute
    // instant: the minted create-only grant can never outlive it, however much
    // of the capability TTL nominally remains. This spec drives the URL
    // boundary directly so no media bytes are involved.
    const bound = new Date(Date.now() + 120_000);
    const urls = await Effect.runPromise(
      processorJobUrlsEffect(processorEnv(processor), {
        inputKey: `${organizationId}/92000000-0000-4000-8000-000000000001/original`,
        outputExpiresAt: bound,
        outputKey:
          "staging/20000000-0000-4000-8000-000000000001/92000000-0000-4000-8000-000000000001/processing-image_auto_4096_long_edge",
      }),
    );
    const deadlineMs = grantDeadlineMsFromUrl(urls.output_url);
    expect(deadlineMs).toBeTypeOf("number");
    expect(deadlineMs!).toBeLessThanOrEqual(bound.getTime());
    expect(bound.getTime() - deadlineMs!).toBeLessThan(2_000);
    expect(new URL(urls.output_url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "host;if-none-match",
    );
    expect(new URL(urls.input_url).searchParams.get("X-Amz-Expires")).toBe("900");

    // A deadline that has already elapsed is refused at minting rather than
    // revived into a one-second grant that would outlive the released charge.
    const exit = await Effect.runPromiseExit(
      processorJobUrlsEffect(processorEnv(processor), {
        inputKey: `${organizationId}/92000000-0000-4000-8000-000000000001/original`,
        outputExpiresAt: new Date(Date.now() - 1_000),
        outputKey:
          "staging/20000000-0000-4000-8000-000000000001/92000000-0000-4000-8000-000000000001/processing-image_auto_4096_long_edge",
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(NativeProcessorError);
        expect(failure.value.code).toBe("processor_unavailable");
        expect(failure.value.retryable).toBe(true);
        expect(failure.value.message).toMatch(/elapsed/i);
      }
    }
  });

  it("settles a redelivered event by adoption with no second engine run", async () => {
    const assetId = "92000000-0000-4000-8000-000000000011";
    const eventA = "automation-integration-processing-redeliver-a";
    const eventB = "automation-integration-processing-redeliver-b";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body, stagingKey } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration redelivery",
    });
    const originalKey = `${organizationId}/${assetId}/original`;
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const produced = engineRenditionBytes(320, 240, await sha256Hex(body));
    // The durable post-commit state a crashed first delivery left behind: the
    // promotion and rendition commit landed but the Asset row never flipped.
    harness.put(originalKey, body, "image/png");
    harness.put(readyKey, produced, "image/jpeg");
    const originalObjectId = await runSystemTransaction(env, async (client) => {
      const original = await client.query<{ id: string }>(
        `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes, etag,
              sha256, content_type, status)
           VALUES ($1, $2, $3, 'original', $4, $5, $6, $7, 'image/png', 'ready')
           RETURNING id`,
        [
          organizationId,
          assetId,
          seededAlphaProfileId,
          originalKey,
          body.byteLength,
          (await sha256Hex(body)).slice(0, 32),
          await sha256Hex(body),
        ],
      );
      const ready = await client.query<{ id: string }>(
        `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
              etag, sha256, content_type, width, height, status)
           VALUES ($1, $2, $3, 'rendition', $4, $5, $6, $7, $8, 'image/jpeg',
                   320, 240, 'ready')
           RETURNING id`,
        [
          organizationId,
          assetId,
          seededAlphaProfileId,
          profile,
          readyKey,
          produced.byteLength,
          (await sha256Hex(produced)).slice(0, 32),
          await sha256Hex(produced),
        ],
      );
      await client.query(
        `INSERT INTO asset_renditions
             (org_id, asset_id, brand_profile_id, profile, object_id, status)
           VALUES ($1, $2, $3, $4, $5, 'ready'),
                  ($1, $2, $3, 'original', $6, 'ready')`,
        [
          organizationId,
          assetId,
          seededAlphaProfileId,
          profile,
          ready.rows[0]!.id,
          original.rows[0]!.id,
        ],
      );
      return original.rows[0]!.id;
    });
    expect(originalObjectId).toBeTruthy();
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventA, assetId))),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventA, assetId))),
    ).resolves.toBe("skipped");
    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventB, assetId))),
    ).resolves.toBe("skipped");

    // Only the first delivery adopted the committed rendition: the engine was
    // never invoked, no new object or copy appeared, and every later event is
    // skipped because the Asset row converged to 'ready' with the verdict.
    expect(processor.calls).toHaveLength(0);
    expect(harness.copies.filter((copy) => copy.destination === readyKey)).toHaveLength(0);
    expect(harness.bodies.get(readyKey)).toEqual(produced);
    const inventory = await assetInventory(assetId);
    expect(
      inventory.filter((row) => row.kind === "rendition" && row.status === "ready"),
    ).toHaveLength(1);
    expect(inventory.find((row) => row.kind === "staging")).toMatchObject({
      r2_key: stagingKey,
      status: "superseded",
    });
    await expect(processingState(assetId, eventA)).resolves.toMatchObject({
      event_outcome: "succeeded",
      status: "ready",
    });
    await expect(processingState(assetId, eventB)).resolves.toMatchObject({
      event_outcome: "skipped",
    });
  });

  it("converges a re-queued Asset with a committed rendition to 'ready' without re-running the engine", async () => {
    const assetId = "92000000-0000-4000-8000-000000000012";
    const eventId = "automation-integration-processing-requeued-adopt";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body, stagingKey } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration requeued adoption",
    });
    const originalKey = `${organizationId}/${assetId}/original`;
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const produced = engineRenditionBytes(320, 240, await sha256Hex(body));
    harness.put(originalKey, body, "image/png");
    harness.put(readyKey, produced, "image/jpeg");
    // Migration 007's re-queue state: the Asset was flipped back to
    // 'processing' for re-verification while the committed optimized rendition
    // stayed ready, and its 'original' approval was demoted to a 'processing'
    // reference with no object. Before the adoption commit landed the verdict
    // on the Asset, this Asset stayed 'processing' forever: the maintenance
    // rearmer kept re-arming it and the orphan sweep refused it.
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes, etag,
              sha256, content_type, status)
           VALUES ($1, $2, $3, 'original', $4, $5, $6, $7, 'image/png', 'ready')`,
        [
          organizationId,
          assetId,
          seededAlphaProfileId,
          originalKey,
          body.byteLength,
          (await sha256Hex(body)).slice(0, 32),
          await sha256Hex(body),
        ],
      );
      const ready = await client.query<{ id: string }>(
        `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
              etag, sha256, content_type, width, height, status)
           VALUES ($1, $2, $3, 'rendition', $4, $5, $6, $7, $8, 'image/jpeg',
                   320, 240, 'ready')
           RETURNING id`,
        [
          organizationId,
          assetId,
          seededAlphaProfileId,
          profile,
          readyKey,
          produced.byteLength,
          (await sha256Hex(produced)).slice(0, 32),
          await sha256Hex(produced),
        ],
      );
      await client.query(
        `INSERT INTO asset_renditions
             (org_id, asset_id, brand_profile_id, profile, object_id, status)
           VALUES ($1, $2, $3, $4, $5, 'ready'),
                  ($1, $2, $3, 'original', NULL, 'processing')`,
        [organizationId, assetId, seededAlphaProfileId, profile, ready.rows[0]!.id],
      );
    });
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventId, assetId))),
    ).resolves.toBe("processed");

    // The verdict was adopted, not recomputed: the media processor was never
    // invoked and no new object or copy appeared.
    expect(processor.calls).toHaveLength(0);
    expect(harness.copies.filter((copy) => copy.destination === readyKey)).toHaveLength(0);
    expect(harness.bodies.get(readyKey)).toEqual(produced);
    const renditions = await assetRenditions(assetId);
    expect(renditions.find((row) => row.profile === profile)).toMatchObject({
      status: "ready",
    });
    expect(renditions.find((row) => row.profile === "original")).toMatchObject({
      failure_code: "original_superseded",
      object_id: null,
      status: "failed",
    });
    expect(renditions.some((row) => row.status === "processing")).toBe(false);
    expect((await assetInventory(assetId)).find((row) => row.kind === "staging")).toMatchObject({
      r2_key: stagingKey,
      status: "superseded",
    });
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      height: 240,
      status: "ready",
      width: 320,
    });
  });

  it("processes a single upload outbox event exactly once and prevents batch collisions from double-consuming quota", async () => {
    const assetId = "92000000-0000-4000-8000-000000000009";
    const eventId = "automation-integration-batch-collision";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration batch collision",
    });
    const chargedBefore = await chargedObjectBytes(organizationId);
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);
    const message = outboxMessage(eventId, assetId);

    const [firstOutcome, secondOutcome] = await Promise.allSettled([
      Effect.runPromise(processorJob.process(message)),
      Effect.runPromise(processorJob.process(message)),
    ]);
    const outcomes = [firstOutcome, secondOutcome].map((result) =>
      result.status === "fulfilled" ? result.value : result.reason.name,
    );
    expect(
      outcomes.every(
        (outcome) =>
          outcome === "processed" ||
          outcome === "skipped" ||
          outcome === "JobInProgressError" ||
          outcome === "RetryableJobError",
      ),
    ).toBe(true);
    expect(outcomes.filter((outcome) => outcome === "processed")).toHaveLength(1);

    await expect(Effect.runPromise(processorJob.process(message))).resolves.toBe("skipped");

    // Exactly one engine run produced exactly one rendition object. The
    // fixture's staging row was already inside `chargedBefore`, so the delta is
    // the three new physical rows the run added: the promoted original copy
    // plus both the superseded processing staging output and its ready
    // rendition — every real byte charged once.
    expect(processor.calls).toHaveLength(1);
    const produced = engineRenditionBytes(320, 240, await sha256Hex(body));
    const chargedAfter = await chargedObjectBytes(organizationId);
    expect(chargedAfter - chargedBefore).toBe(BigInt(body.byteLength + 2 * produced.byteLength));
    const readyRenditions = (await assetInventory(assetId)).filter(
      (row) => row.kind === "rendition" && row.status === "ready",
    );
    expect(readyRenditions).toHaveLength(1);
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      height: 240,
      status: "ready",
      width: 320,
    });
  });

  it("reclaims an expired lease left after the durable event claim", async () => {
    const assetId = "93000000-0000-4000-8000-000000000017";
    const eventId = "automation-integration-asset-post-claim-crash";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration post claim",
    });
    await runSystemTransaction(env, (client) =>
      client.query(
        `INSERT INTO async_job_events
           (event_key, job_type, aggregate_id, outcome, attempt_count,
            lease_expires_at, org_id, aggregate_type)
         VALUES ($1, 'asset.processing.requested', $2, 'processing', 1,
                 now() - INTERVAL '1 second', $3, 'asset')`,
        [`outbox:${eventId}`, assetId, organizationId],
      ),
    );

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    await expect(processingState(assetId, eventId)).resolves.toEqual({
      attempt_count: 2,
      event_outcome: "succeeded",
      failure_code: null,
      height: 240,
      orphan_armed: false,
      status: "ready",
      width: 320,
    });
  });

  it("adopts a promotion that committed its copy before its inventory rows", async () => {
    const assetId = "93000000-0000-4000-8000-000000000018";
    const eventId = "automation-integration-processing-copy-adopt";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration promotion adoption",
    });
    const originalKey = `${organizationId}/${assetId}/original`;
    // Crash window: the promotion copy landed but the inventory transaction
    // never committed, so the original exists only as bucket bytes.
    harness.put(originalKey, body, "image/png");

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // The conditional copy declined and the Worker adopted the object it found
    // instead of writing a second one.
    expect(harness.copies.filter((copy) => copy.destination === originalKey)).toHaveLength(0);
    expect(harness.bodies.get(originalKey)).toEqual(body);
    const inventory = await assetInventory(assetId);
    const originals = inventory.filter((row) => row.kind === "original");
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({
      bytes: String(body.byteLength),
      r2_key: originalKey,
      status: "ready",
    });
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      status: "ready",
    });
    expect(processor.calls).toHaveLength(1);
  });

  it("recomputes an engine output that was never recorded", async () => {
    const assetId = "93000000-0000-4000-8000-000000000019";
    const eventId = "automation-integration-processing-unrecorded";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration unrecorded output",
    });
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    // The engine wrote bytes but the attempt died before the digest was
    // durable: foreign bytes nobody can verify, under a bare reservation.
    // The reservation is seeded at the image media ceiling `reserveOutputs`
    // would charge, not at the 24-byte fixture size.
    harness.put(processingKey, png(64, 48), "image/jpeg");
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, profile, r2_key,
            reserved_bytes, status, write_hold_until)
         VALUES ($1, $2, $3, 'rendition', $4, $5, 26214400, 'writing',
                 now() + INTERVAL '15 minutes')`,
        [organizationId, assetId, seededAlphaProfileId, profile, processingKey],
      );
      await client.query(
        `INSERT INTO asset_renditions
           (org_id, asset_id, brand_profile_id, profile, status)
         VALUES ($1, $2, $3, $4, 'processing')`,
        [organizationId, assetId, seededAlphaProfileId, profile],
      );
    });

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // Untracked bytes were deleted rather than trusted, then recomputed.
    expect(harness.deletes).toContain(processingKey);
    expect(processor.calls).toHaveLength(1);
    const inventory = await assetInventory(assetId);
    expect(
      inventory.find((row) => row.kind === "rendition" && row.status === "ready"),
    ).toMatchObject({
      r2_key: `${organizationId}/${assetId}/rendition-${profile}`,
    });
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      status: "ready",
    });
  });

  it("clears a partially recorded staging row back to a clean reservation", async () => {
    const assetId = "93000000-0000-4000-8000-000000000030";
    const eventId = "automation-integration-processing-partial-record";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration partial record",
    });
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    const produced = engineRenditionBytes(320, 240, await sha256Hex(body));
    // A row that was only partially recorded: real bytes and a digest landed,
    // but the media type never did. It is adoptable on nothing, so it must be
    // reset to a clean reservation rather than trusted or charged as output.
    harness.put(processingKey, produced, "image/jpeg");
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
            sha256, content_type, reserved_bytes, status, write_hold_until)
         VALUES ($1, $2, $3, 'rendition', $4, $5, $6, $7, NULL, $8, 'writing',
                 now() + INTERVAL '15 minutes')`,
        [
          organizationId,
          assetId,
          seededAlphaProfileId,
          profile,
          processingKey,
          produced.byteLength,
          await sha256Hex(produced),
          imageReservationCeiling,
        ],
      );
      await client.query(
        `INSERT INTO asset_renditions
           (org_id, asset_id, brand_profile_id, profile, status)
         VALUES ($1, $2, $3, $4, 'processing')`,
        [organizationId, assetId, seededAlphaProfileId, profile],
      );
    });
    // Fail once so the post-clear state is observable end of run: on a build
    // that resets only rows with `bytes IS NULL`, this row keeps its stale
    // bytes here and the reservation never returns to a clean state.
    processor.scripted.push({
      error: {
        code: "engine_overloaded",
        message: "engine is overloaded",
        retryable: true,
      },
      kind: "failure",
    });
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);
    const message = outboxMessage(eventId, assetId);

    await expect(Effect.runPromise(processorJob.process(message))).rejects.toThrow(
      "engine is overloaded",
    );

    const cleared = (await assetInventory(assetId)).find(
      (row) => row.kind === "rendition" && row.status === "writing",
    );
    expect(cleared).toMatchObject({
      bytes: null,
      content_type: null,
      r2_key: processingKey,
      reserved_bytes: String(imageReservationCeiling),
      sha256: null,
      status: "writing",
    });
    expect(harness.deletes).toContain(processingKey);
    expect(processor.calls).toHaveLength(1);

    // The cleared reservation is genuinely reusable: the retry recomputes and
    // commits rather than hanging on bytes it can no longer prove.
    await expect(Effect.runPromise(processorJob.process(message))).resolves.toBe("processed");
    expect(processor.calls).toHaveLength(2);
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      height: 240,
      status: "ready",
      width: 320,
    });
  });

  it("holds a crash-checkpoint output at its full reservation and retries it at full quota without a second charge", async () => {
    const assetId = "93000000-0000-4000-8000-000000000031";
    const holderAssetId = "93000000-0000-4000-8000-000000000032";
    const eventId = "automation-integration-processing-quota-checkpoint";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    // The promotion is granted exactly the headroom it needs — the staged
    // source bytes — and the checkpoint's full reservation completes the
    // workspace's charge, so nothing remains for a second reservation. A retry
    // that demanded fresh headroom for a key it already holds would be refused
    // here, which is exactly what this case pins.
    const storageCeiling = storageLimit;
    try {
      const { body } = await stagedUploadFixture({
        assetId,
        harness,
        title: "Automation integration quota checkpoint",
      });
      const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
      const produced = engineRenditionBytes(320, 240, await sha256Hex(png(320, 240)));
      harness.put(processingKey, produced, "image/jpeg");
      await runSystemTransaction(env, async (client) => {
        // The crash checkpoint itself: measured output recorded, but the
        // promotion never ran, so the row still holds its full reservation.
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
              sha256, content_type, width, height, reserved_bytes, status,
              write_hold_until)
           VALUES ($1, $2, $3, 'rendition', $4, $5, $6, $7, 'image/jpeg', 320,
                   240, $8, 'writing', now() + INTERVAL '15 minutes')`,
          [
            organizationId,
            assetId,
            seededAlphaProfileId,
            profile,
            processingKey,
            produced.byteLength,
            await sha256Hex(produced),
            imageReservationCeiling,
          ],
        );
        await client.query(
          `INSERT INTO asset_renditions
             (org_id, asset_id, brand_profile_id, profile, status)
           VALUES ($1, $2, $3, $4, 'processing')`,
          [organizationId, assetId, seededAlphaProfileId, profile],
        );
      });
      // Charged rows accumulate across this suite's fixtures and the seed, so
      // the holder is sized against the measured charge rather than a
      // constant: it leaves exactly the staged source bytes of headroom, which
      // the protected-copy reservation consumes, filling the workspace to its
      // ceiling alongside the checkpoint's full reservation.
      const chargedSoFar = await chargedObjectBytes(organizationId);
      const holderBytes = storageCeiling - body.byteLength - Number(chargedSoFar);
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration quota holder', 'ready')`,
          [holderAssetId, organizationId, seededAlphaProfileId, userId],
        );
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
              content_type, status)
           VALUES ($1, $2, $3, 'original', $4, $5, 'image/png', 'ready')`,
          [
            organizationId,
            holderAssetId,
            seededAlphaProfileId,
            `${organizationId}/${holderAssetId}/original`,
            holderBytes,
          ],
        );
      });

      // The checkpoint row is charged its full reservation rather than its
      // small measured output: charging its bytes instead would free the
      // reservation and let another request take capacity this attempt still
      // needs to write.
      expect(await chargedObjectBytes(organizationId)).toBe(chargedSoFar + BigInt(holderBytes));

      const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);
      const message = outboxMessage(eventId, assetId);

      await expect(Effect.runPromise(processorJob.process(message))).resolves.toBe("processed");

      // The checkpoint was adopted and promoted rather than recomputed or
      // refused for want of headroom it already held.
      expect(processor.calls).toHaveLength(0);
      const inventory = await assetInventory(assetId);
      // Promotion settled the checkpoint row onto its measured size and
      // released its reservation in one step, so the bytes are never charged as
      // both the reservation and the output.
      expect(inventory.find((row) => row.r2_key === processingKey)).toMatchObject({
        bytes: String(produced.byteLength),
        reserved_bytes: null,
        status: "superseded",
      });
      expect(
        inventory.find((row) => row.kind === "rendition" && row.status === "ready"),
      ).toMatchObject({
        bytes: String(produced.byteLength),
        reserved_bytes: null,
      });
      // Nothing is left writing, so no reservation survives the promotion to be
      // charged a second time: the workspace settled at the checkpoint's real
      // output plus the two copies the run added, and the surplus reservation
      // is gone.
      expect(inventory.find((row) => row.status === "writing")).toBeUndefined();
      expect(await chargedObjectBytes(organizationId)).toBe(
        BigInt(storageCeiling) + BigInt(2 * produced.byteLength) - BigInt(imageReservationCeiling),
      );
      await expect(processingState(assetId, eventId)).resolves.toMatchObject({
        event_outcome: "succeeded",
        status: "ready",
      });
    } finally {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM assets WHERE id = $1", [holderAssetId]),
      );
    }
  });

  it("adopts a recorded engine output instead of recomputing it", async () => {
    const assetId = "93000000-0000-4000-8000-000000000020";
    const eventId = "automation-integration-processing-recorded";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration recorded output",
    });
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    const produced = engineRenditionBytes(320, 240, await sha256Hex(body));
    // Crash window after the verified digest was recorded but before the
    // promotion ran: the staging row carries the real facts.
    harness.put(processingKey, produced, "image/jpeg");
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
            sha256, content_type, width, height, reserved_bytes, status,
            write_hold_until)
         VALUES ($1, $2, $3, 'rendition', $4, $5, $6, $7, 'image/jpeg', 320,
                 240, 26214400, 'writing', now() + INTERVAL '15 minutes')`,
        [
          organizationId,
          assetId,
          seededAlphaProfileId,
          profile,
          processingKey,
          produced.byteLength,
          await sha256Hex(produced),
        ],
      );
      await client.query(
        `INSERT INTO asset_renditions
           (org_id, asset_id, brand_profile_id, profile, status)
         VALUES ($1, $2, $3, $4, 'processing')`,
        [organizationId, assetId, seededAlphaProfileId, profile],
      );
    });

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // The recorded output was adopted and promoted without paying for the
    // compute again.
    expect(processor.calls).toHaveLength(0);
    expect(harness.bodies.get(processingKey)).toEqual(produced);
    expect(harness.bodies.get(`${organizationId}/${assetId}/rendition-${profile}`)).toEqual(
      produced,
    );
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      height: 240,
      status: "ready",
      width: 320,
    });
  });

  it("keeps the reservation charged across a retryable engine failure", async () => {
    const assetId = "93000000-0000-4000-8000-000000000021";
    const eventId = "automation-integration-processing-retryable";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration retryable failure",
    });
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    processor.scripted.push({
      error: {
        code: "engine_overloaded",
        message: "engine is overloaded",
        retryable: true,
      },
      kind: "failure",
    });
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);
    const message = outboxMessage(eventId, assetId);

    await expect(Effect.runPromise(processorJob.process(message))).rejects.toThrow(
      "engine is overloaded",
    );

    // The Asset is still processing, the lease recorded the failure, and the
    // 'writing' reservation row still holds its charge.
    const duringFailure = await assetInventory(assetId);
    const reservation = duringFailure.find(
      (row) => row.kind === "rendition" && row.status === "writing",
    );
    expect(reservation).toMatchObject({
      bytes: null,
      r2_key: processingKey,
      reserved_bytes: String(imageReservationCeiling),
    });
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "failed",
      status: "processing",
    });

    await expect(Effect.runPromise(processorJob.process(message))).resolves.toBe("processed");
    expect(processor.calls).toHaveLength(2);
    const inventory = await assetInventory(assetId);
    expect(inventory.find((row) => row.status === "writing")).toBeUndefined();
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      status: "ready",
    });
  });

  it("fails permanently on a corrupt upload while preserving the charged original", async () => {
    const assetId = "93000000-0000-4000-8000-000000000022";
    const eventId = "automation-integration-processing-permanent";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      body: new TextEncoder().encode("not a png"),
      harness,
      title: "Automation integration permanent failure",
    });
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventId, assetId))),
    ).resolves.toBe("processed");

    // The durable failed state carries the engine's actionable code, the
    // reservation is released and nothing is marked ready, the promoted
    // original stays inventoried and charged, and the unattached failed Asset
    // is armed for the seven-day ownership-aware orphan sweep.
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      failure_code: "corrupt_media",
      orphan_armed: true,
      status: "failed",
    });
    const inventory = await assetInventory(assetId);
    expect(inventory.find((row) => row.status === "writing")).toBeUndefined();
    expect(inventory.find((row) => row.kind === "original")).toMatchObject({
      status: "ready",
    });
    expect(inventory.find((row) => row.r2_key === readyKey)).toBeUndefined();
    const renditions = await assetRenditions(assetId);
    expect(renditions.find((row) => row.profile === profile)).toMatchObject({
      failure_code: "corrupt_media",
      status: "failed",
    });
    expect(harness.bodies.has(readyKey)).toBe(false);
    expect(processor.calls).toHaveLength(1);

    // A redelivery under a different event id cannot re-run a job whose input
    // can never succeed — and no raw bytes are ever published.
    const redelivery = "automation-integration-processing-permanent-redeliver";
    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(redelivery, assetId))),
    ).resolves.toBe("skipped");
    expect(processor.calls).toHaveLength(1);
    expect(harness.bodies.has(readyKey)).toBe(false);
  });

  it("accepts the original when the engine reports no optimization benefit", async () => {
    const assetId = "93000000-0000-4000-8000-000000000023";
    const eventId = "automation-integration-processing-no-benefit";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    // The source is declared as the profile's preferred opaque still type,
    // which is the only case in which a verified `original_compatible`
    // verdict is legitimate: a PNG source must actually be converted.
    const { body } = await stagedUploadFixture({
      assetId,
      contentType: "image/jpeg",
      harness,
      title: "Automation integration no benefit",
    });
    const chargedBefore = await chargedObjectBytes(organizationId);
    processor.scripted.push({ kind: "original_compatible" });

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // The rendition references the original object id: no second copy of the
    // bytes is ever created, so `rendition-<profile>` does not exist in the
    // bucket and no ready rendition object is inventoried for it.
    const inventory = await assetInventory(assetId);
    const original = inventory.find((row) => row.kind === "original");
    expect(
      inventory.filter((row) => row.kind === "rendition" && row.status === "ready"),
    ).toHaveLength(0);
    const renditions = await assetRenditions(assetId);
    expect(renditions.find((row) => row.profile === profile)).toMatchObject({
      object_id: original?.id,
      status: "ready",
    });

    // Two new charges land in this run and each is exactly one physical key:
    // the protected original (its real bytes) and the engine's staging output
    // row, which holds its full reservation rather than zero because the
    // create-only grant minted for the job is still live and could recreate
    // the key it never wrote. The retired staging source's real bytes were
    // already counted inside `chargedBefore`, so they are not part of the
    // delta.
    const supersededOutput = inventory.find(
      (row) => row.kind === "rendition" && row.status === "superseded",
    );
    expect(supersededOutput).toMatchObject({
      bytes: null,
      reserved_bytes: String(imageReservationCeiling),
    });
    const chargedAfter = await chargedObjectBytes(organizationId);
    expect(chargedAfter - chargedBefore).toBe(BigInt(body.byteLength + imageReservationCeiling));
    expect(harness.bodies.get(`${organizationId}/${assetId}/original`)).toEqual(body);
    expect(harness.bodies.has(`${organizationId}/${assetId}/rendition-${profile}`)).toBe(false);
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      status: "ready",
    });
  });

  it("settles a demoted 'original' rendition with the verdict so the orphan sweep can claim the asset", async () => {
    const assetId = "93000000-0000-4000-8000-000000000150";
    const eventId = "automation-integration-processing-demoted-original";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration demoted original",
    });
    // Migration 007's re-queue state: the legacy 'original' approval is
    // 'processing' with no object, and only the reserved profile row carries
    // the verdict this run commits. Nothing else ever writes the 'original'
    // row, so before the verdict-commit settle it stayed 'processing' forever
    // and excluded the Asset from the orphan sweep's live-rendition guard.
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO asset_renditions
           (org_id, asset_id, brand_profile_id, profile, status)
         VALUES ($1, $2, $3, 'original', 'processing')`,
        [organizationId, assetId, seededAlphaProfileId],
      );
    });
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventId, assetId))),
    ).resolves.toBe("processed");

    // The committed verdict settled the demoted row to a terminal state that
    // is neither publishable ('ready' needs a reference object) nor a
    // reclamation claim ('deleting'/'deleted' belong to the deletion path).
    const renditions = await assetRenditions(assetId);
    expect(renditions.find((row) => row.profile === profile)).toMatchObject({
      status: "ready",
    });
    expect(renditions.find((row) => row.profile === "original")).toMatchObject({
      failure_code: "original_superseded",
      object_id: null,
      status: "failed",
    });
    expect(renditions.some((row) => row.status === "processing")).toBe(false);
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      status: "ready",
    });

    // Orphan deadline elapsed and no Post retains the Asset, so the only thing
    // that could refuse the sweep's claim is a live rendition — the state the
    // stranded 'processing' row produced. Every other Asset's deadline is
    // parked for the duration of this spec, the way the bounded-cleanup spec
    // pins the shared database, so this Asset's claim is deterministic.
    const pinnedDeadlines = await runSystemTransaction(env, async (client) => {
      const rows = await client.query<{
        id: string;
        orphan_delete_after: Date | null;
        orphaned_at: Date | null;
      }>(
        `SELECT id, orphaned_at, orphan_delete_after
         FROM assets
         WHERE orphan_delete_after IS NOT NULL
           AND id <> $1`,
        [assetId],
      );
      await client.query(
        `UPDATE assets
         SET orphan_delete_after = now() + INTERVAL '30 days',
             updated_at = now()
         WHERE orphan_delete_after IS NOT NULL
           AND id <> $1`,
        [assetId],
      );
      await client.query(
        `UPDATE assets
         SET orphaned_at = now() - INTERVAL '8 days',
             orphan_delete_after = now() - INTERVAL '1 day',
             updated_at = now()
         WHERE id = $1`,
        [assetId],
      );
      await client.query(
        `UPDATE assets
         SET updated_at = now()
         WHERE status IN ('processing', 'deleting')`,
      );
      return rows.rows;
    });
    try {
      await expect(Effect.runPromise(processorJob.runMaintenance())).resolves.toMatchObject({
        orphan_assets_claimed: 1,
      });

      // The claim itself is the sweep predicate's verdict: the Asset moved to
      // 'deleting' and its deletion event was armed in one statement, which a
      // 'processing' rendition would have refused.
      await runSystemTransaction(env, async (client) => {
        const claimed = await client.query<{
          deletion_events: string;
          status: string;
        }>(
          `SELECT asset.status,
                  (SELECT count(*)::text FROM outbox_events AS event
                   WHERE event.aggregate_id = asset.id
                     AND event.topic = 'asset.deletion.requested')
                    AS deletion_events
           FROM assets AS asset
           WHERE asset.id = $1`,
          [assetId],
        );
        expect(claimed.rows[0]).toEqual({
          deletion_events: "1",
          status: "deleting",
        });
      });
    } finally {
      await runSystemTransaction(env, async (client) => {
        for (const row of pinnedDeadlines) {
          await client.query(
            `UPDATE assets
             SET orphaned_at = $2, orphan_delete_after = $3, updated_at = now()
             WHERE id = $1`,
            [row.id, row.orphaned_at, row.orphan_delete_after],
          );
        }
      });
    }
  });

  it("fails permanently when the engine misreports the written size", async () => {
    const assetId = "93000000-0000-4000-8000-000000000024";
    const eventId = "automation-integration-processing-size-mismatch";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration size mismatch",
    });
    processor.scripted.push({ kind: "misreport_size" });

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      failure_code: "output_size_mismatch",
      orphan_armed: true,
      status: "failed",
    });
    const inventory = await assetInventory(assetId);
    expect(inventory.find((row) => row.status === "writing")).toBeUndefined();
    expect(inventory.find((row) => row.kind === "original")).toMatchObject({
      status: "ready",
    });
    expect(
      inventory.find((row) => row.kind === "rendition" && row.status === "ready"),
    ).toBeUndefined();
    expect(harness.bodies.has(`${organizationId}/${assetId}/rendition-${profile}`)).toBe(false);
  });

  it("fails permanently when storage and the engine disagree on the checksum", async () => {
    const assetId = "93000000-0000-4000-8000-000000000025";
    const eventId = "automation-integration-processing-checksum-race";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration checksum race",
    });
    processor.scripted.push({ kind: "misreport_checksum" });

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      failure_code: "output_checksum_mismatch",
      orphan_armed: true,
      status: "failed",
    });
    const inventory = await assetInventory(assetId);
    expect(inventory.find((row) => row.status === "writing")).toBeUndefined();
    expect(inventory.find((row) => row.kind === "original")).toMatchObject({
      status: "ready",
    });
  });

  it("never overwrites a publish-ready object left by an earlier attempt", async () => {
    const assetId = "93000000-0000-4000-8000-000000000026";
    const eventId = "automation-integration-processing-ready-race";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration ready race",
    });
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const produced = engineRenditionBytes(320, 240, await sha256Hex(body));
    // A previous attempt produced verified output and promoted it before
    // dying; the ready key exists with no committed reference to it yet.
    harness.put(processingKey, produced, "image/jpeg");
    harness.put(readyKey, produced, "image/jpeg");
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
            sha256, content_type, width, height, reserved_bytes, status,
            write_hold_until)
         VALUES ($1, $2, $3, 'rendition', $4, $5, $6, $7, 'image/jpeg', 320,
                 240, 26214400, 'writing', now() + INTERVAL '15 minutes')`,
        [
          organizationId,
          assetId,
          seededAlphaProfileId,
          profile,
          processingKey,
          produced.byteLength,
          await sha256Hex(produced),
        ],
      );
      await client.query(
        `INSERT INTO asset_renditions
           (org_id, asset_id, brand_profile_id, profile, status)
         VALUES ($1, $2, $3, $4, 'processing')`,
        [organizationId, assetId, seededAlphaProfileId, profile],
      );
    });

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // The create-only promotion declined rather than clobbering the existing
    // object, and the settled inventory points at the bytes already there.
    expect(harness.copies.filter((copy) => copy.destination === readyKey)).toHaveLength(0);
    expect(harness.bodies.get(readyKey)).toEqual(produced);
    expect(processor.calls).toHaveLength(0);
    const inventory = await assetInventory(assetId);
    expect(
      inventory.filter((row) => row.kind === "rendition" && row.status === "ready"),
    ).toHaveLength(1);
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      status: "ready",
    });
  });

  it("fails permanently when no output capacity can be reserved", async () => {
    const assetId = "93000000-0000-4000-8000-000000000027";
    const holderAssetId = "93000000-0000-4000-8000-000000000028";
    const eventId = "automation-integration-processing-no-capacity";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    try {
      // Pre-charge the workspace to its community storage ceiling so the
      // reservation math finds zero headroom; this holder asset is deleted in
      // the finally block so later specs keep full capacity.
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration capacity holder', 'ready')`,
          [holderAssetId, organizationId, seededAlphaProfileId, userId],
        );
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
              content_type, status)
           VALUES ($1, $2, $3, 'original', $4, $5, 'image/png',
                   'ready')`,
          [
            organizationId,
            holderAssetId,
            seededAlphaProfileId,
            `${organizationId}/${holderAssetId}/original`,
            storageLimit,
          ],
        );
      });
      await stagedUploadFixture({
        assetId,
        harness,
        title: "Automation integration no capacity",
      });

      await expect(
        Effect.runPromise(
          createAssetJobProcessor(processorEnv(processor), harness.storage).process(
            outboxMessage(eventId, assetId),
          ),
        ),
      ).resolves.toBe("processed");

      // The engine was never invoked, no reservation row was written, and the
      // Asset is durably failed rather than declared ready.
      expect(processor.calls).toHaveLength(0);
      const inventory = await assetInventory(assetId);
      expect(
        inventory.find((row) => row.kind === "rendition" || row.status === "writing"),
      ).toBeUndefined();
      await expect(processingState(assetId, eventId)).resolves.toMatchObject({
        failure_code: "storage_limit_reached",
        orphan_armed: true,
        status: "failed",
      });
      expect(harness.bodies.has(`${organizationId}/${assetId}/rendition-${profile}`)).toBe(false);
    } finally {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM assets WHERE id = $1", [holderAssetId]),
      );
    }
  });

  it("fails permanently when the staged bytes no longer match the pinned identity", async () => {
    const assetId = "93000000-0000-4000-8000-000000000029";
    const eventId = "automation-integration-processing-source-race";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { stagingKey } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration source race",
    });
    // A still-valid upload grant rewrote the staged object after
    // finalization: the live checksum no longer matches the SHA-256 the
    // staging row pinned, so verification refuses before any promotion
    // reservation is taken.
    harness.put(stagingKey, png(160, 120), "image/png");

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      failure_code: "source_checksum_changed",
      orphan_armed: true,
      status: "failed",
    });
    const inventory = await assetInventory(assetId);
    expect(inventory.find((row) => row.kind === "original")).toBeUndefined();
    expect(
      inventory.find((row) => row.kind === "rendition" && row.status === "ready"),
    ).toBeUndefined();
    expect(harness.bodies.has(`${organizationId}/${assetId}/original`)).toBe(false);
    expect(processor.calls).toHaveLength(0);
  });
  it("records the engine's decoded facts on an accepted original object", async () => {
    const assetId = "93000000-0000-4000-8000-000000000081";
    const eventId = "automation-integration-processing-no-benefit-video";
    const profile = "video_h264_aac_1920x1080";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body } = await stagedUploadFixture({
      assetId,
      assetType: "video",
      body: png(640, 360),
      contentType: "video/mp4",
      harness,
      title: "Automation integration no benefit video",
    });
    processor.scripted.push({ kind: "original_compatible" });

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // Consumers resolve a publishable candidate by joining the ready rendition
    // reference to its object row and reading geometry/duration off the OBJECT,
    // not off the Asset. So the no-benefit path must populate the object it
    // accepted: a video left with NULL duration would be handed to a
    // duration-limited Platform as "unknown" and rejected, despite the engine
    // having measured it. These are the engine's real decoded values, not
    // fixture echoes — no row written before this point carries them at all.
    const original = (await assetInventory(assetId)).find((row) => row.kind === "original");
    expect(original).toMatchObject({
      bytes: String(body.byteLength),
      content_type: "video/mp4",
      status: "ready",
    });
    // The double derives duration from the body length, so this is a measured
    // value the pipeline had to carry across, not a constant both sides could
    // have agreed on independently.
    expect(Number(original?.duration_sec)).toBe(body.byteLength / 10);
    expect(Number(original?.width)).toBe(640);
    expect(Number(original?.height)).toBe(360);
    // The Asset carries the same facts, and the reference points at the object
    // that now holds them.
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      height: 360,
      status: "ready",
      width: 640,
    });
    expect(await assetRenditions(assetId)).toEqual([
      expect.objectContaining({
        object_id: original?.id,
        profile,
        status: "ready",
      }),
    ]);
  });

  it("counts a live upload reservation before granting any new capacity", async () => {
    const controlAssetId = "93000000-0000-4000-8000-000000000071";
    const blockedAssetId = "93000000-0000-4000-8000-000000000072";
    const pendingAssetId = "93000000-0000-4000-8000-000000000073";
    const holderAssetId = "93000000-0000-4000-8000-000000000074";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const body = png(320, 240);
    const sourceBytes = body.byteLength;
    const ceiling = storageLimit;
    // Charged rows from the seed and earlier fixture assets accumulate until
    // the suite's teardown, so the holder is sized against the measured charge
    // rather than a constant.
    const chargedBase = await chargedObjectBytes(organizationId);
    try {
      // Headroom once the control's staging row lands is exactly one source
      // copy: enough to promote the original, far too little for the media
      // ceiling the engine reservation needs. The control asset proves this
      // fixture would otherwise reach that point.
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration quota control', 'ready')`,
          [holderAssetId, organizationId, seededAlphaProfileId, userId],
        );
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
              content_type, status)
           VALUES ($1, $2, $3, 'original', $4, $5, 'image/png', 'ready')`,
          [
            organizationId,
            holderAssetId,
            seededAlphaProfileId,
            `${organizationId}/${holderAssetId}/original`,
            ceiling - 2 * sourceBytes - Number(chargedBase),
          ],
        );
      });
      await stagedUploadFixture({
        assetId: controlAssetId,
        body,
        harness,
        title: "Automation integration quota control asset",
      });
      await expect(
        Effect.runPromise(
          createAssetJobProcessor(processorEnv(processor), harness.storage).process(
            outboxMessage("automation-integration-processing-quota-control", controlAssetId),
          ),
        ),
      ).resolves.toBe("processed");
      // The control reached the protected copy, so the only difference in the
      // second run is the pending upload's promised bytes.
      expect(
        (await assetInventory(controlAssetId)).find((row) => row.kind === "original"),
      ).toMatchObject({ status: "ready" });
      await expect(
        processingState(controlAssetId, "automation-integration-processing-quota-control"),
      ).resolves.toMatchObject({ failure_code: "storage_limit_reached" });

      // One byte of live upload reservation removes the last byte of headroom.
      // Those bytes are charged before any object row exists for them, so a
      // reservation that summed `asset_objects` alone would hand out capacity
      // this workspace has already promised to an unfinished upload.
      await pendingUploadFixture({
        assetId: pendingAssetId,
        bytes: 1,
        title: "Automation integration pending upload",
      });
      await stagedUploadFixture({
        assetId: blockedAssetId,
        body,
        harness,
        title: "Automation integration quota blocked asset",
      });
      await expect(
        Effect.runPromise(
          createAssetJobProcessor(processorEnv(processor), harness.storage).process(
            outboxMessage("automation-integration-processing-quota-blocked", blockedAssetId),
          ),
        ),
      ).resolves.toBe("processed");

      await expect(
        processingState(blockedAssetId, "automation-integration-processing-quota-blocked"),
      ).resolves.toMatchObject({
        failure_code: "storage_limit_reached",
        orphan_armed: true,
        status: "failed",
      });
      // Refused before any external write: no protected copy, and no leftover
      // pending row holding a reservation nothing would ever release.
      const blocked = await assetInventory(blockedAssetId);
      expect(blocked.find((row) => row.kind === "original")).toBeUndefined();
      expect(blocked.find((row) => row.reserved_bytes !== null)).toBeUndefined();
      expect(harness.bodies.has(`${organizationId}/${blockedAssetId}/original`)).toBe(false);
      expect(processor.calls).toHaveLength(0);
    } finally {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM assets WHERE id = ANY($1::uuid[])", [
          [holderAssetId, pendingAssetId],
        ]),
      );
    }
  });

  it("serializes concurrent source promotions so one cannot oversubscribe the other", async () => {
    const firstAssetId = "93000000-0000-4000-8000-000000000075";
    const secondAssetId = "93000000-0000-4000-8000-000000000076";
    const holderAssetId = "93000000-0000-4000-8000-000000000077";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const body = png(320, 240);
    const sourceBytes = body.byteLength;
    const ceiling = storageLimit;
    // The seed and earlier fixture assets keep their charged rows until
    // teardown, so the holder is sized against the measured charge rather
    // than a constant.
    const chargedBase = await chargedObjectBytes(organizationId);
    try {
      // Headroom is exactly one source copy once both staging rows are
      // charged, so two concurrent promotions cannot both fit. This is the
      // oversubscription boundary: copying first and reserving after would
      // let both proceed.
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration promotion holder', 'ready')`,
          [holderAssetId, organizationId, seededAlphaProfileId, userId],
        );
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
              content_type, status)
           VALUES ($1, $2, $3, 'original', $4, $5, 'image/png', 'ready')`,
          [
            organizationId,
            holderAssetId,
            seededAlphaProfileId,
            `${organizationId}/${holderAssetId}/original`,
            ceiling - 3 * sourceBytes - Number(chargedBase),
          ],
        );
      });
      await stagedUploadFixture({
        assetId: firstAssetId,
        body,
        harness,
        title: "Automation integration promotion first",
      });
      await stagedUploadFixture({
        assetId: secondAssetId,
        body,
        harness,
        title: "Automation integration promotion second",
      });

      await Promise.all([
        Effect.runPromise(
          createAssetJobProcessor(processorEnv(processor), harness.storage).process(
            outboxMessage("automation-integration-processing-promotion-first", firstAssetId),
          ),
        ),
        Effect.runPromise(
          createAssetJobProcessor(processorEnv(processor), harness.storage).process(
            outboxMessage("automation-integration-processing-promotion-second", secondAssetId),
          ),
        ),
      ]);

      // Exactly one protected copy exists. The winner's reservation was already
      // charged when the loser measured headroom, so the loser never copied.
      const firstOriginal = (await assetInventory(firstAssetId)).find(
        (row) => row.kind === "original",
      );
      const secondOriginal = (await assetInventory(secondAssetId)).find(
        (row) => row.kind === "original",
      );
      expect([firstOriginal, secondOriginal].filter(Boolean)).toHaveLength(1);
      const refused = [firstAssetId, secondAssetId].filter((id) =>
        id === firstAssetId ? !firstOriginal : !secondOriginal,
      );
      expect(refused).toHaveLength(1);
      await expect(
        processingState(
          refused[0]!,
          refused[0] === firstAssetId
            ? "automation-integration-processing-promotion-first"
            : "automation-integration-processing-promotion-second",
        ),
      ).resolves.toMatchObject({
        failure_code: "storage_limit_reached",
        status: "failed",
      });
      // No orphan reservation: the refused attempt leaves nothing charged that
      // no later sweep would release.
      expect(
        (await assetInventory(refused[0]!)).find((row) => row.reserved_bytes !== null),
      ).toBeUndefined();
    } finally {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM assets WHERE id = $1", [holderAssetId]),
      );
    }
  });

  it("commits the rendition when headroom fits two real copies but not the media ceiling", async () => {
    const assetId = "93000000-0000-4000-8000-000000000082";
    const holderAssetId = "93000000-0000-4000-8000-000000000083";
    const eventId = "automation-integration-processing-headroom-two-copies";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    try {
      const { body } = await stagedUploadFixture({
        assetId,
        harness,
        title: "Automation integration headroom two copies",
      });
      const producedSha = await sha256Hex(engineRenditionBytes(320, 240, await sha256Hex(body)));
      // Engine output size is deterministic: the double always writes the
      // 44-byte rendition body `engineRenditionBytes` builds.
      const outputBytes = 44;
      const chargedSoFar = await chargedObjectBytes(organizationId);
      const ceiling = BigInt(storageLimit);
      // Headroom ends at exactly two copies of the real output plus the source
      // copy and the staging reservation the source consumed: enough for the
      // promotion path when reservations settle to real bytes, nowhere near
      // enough for the 25 MiB media ceiling the old reservation demanded.
      const holderBytes = Number(ceiling - chargedSoFar) - body.byteLength - 2 * outputBytes;
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration headroom holder', 'ready')`,
          [holderAssetId, organizationId, seededAlphaProfileId, userId],
        );
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
              content_type, status)
           VALUES ($1, $2, $3, 'original', $4, $5, 'image/png', 'ready')`,
          [
            organizationId,
            holderAssetId,
            seededAlphaProfileId,
            `${organizationId}/${holderAssetId}/original`,
            holderBytes,
          ],
        );
      });

      await expect(
        Effect.runPromise(
          createAssetJobProcessor(processorEnv(processor), harness.storage).process(
            outboxMessage(eventId, assetId),
          ),
        ),
      ).resolves.toBe("processed");

      // The rendition committed even though headroom never reached the media
      // ceiling: the reservation settled to the real 44-byte output before the
      // protected copy was charged, so headroom >= 2 * output sufficed.
      const inventory = await assetInventory(assetId);
      const rendition = inventory.find((row) => row.kind === "rendition" && row.status === "ready");
      expect(rendition).toMatchObject({
        bytes: String(outputBytes),
        reserved_bytes: null,
        sha256: producedSha,
      });
      await expect(processingState(assetId, eventId)).resolves.toMatchObject({
        status: "ready",
      });
      // Exactness check: the workspace is now at its ceiling to the byte.
      expect(await chargedObjectBytes(organizationId)).toBe(ceiling);
    } finally {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM assets WHERE id = $1", [holderAssetId]),
      );
    }
  });

  it("refuses the protected copy when headroom is under twice the real output", async () => {
    const assetId = "93000000-0000-4000-8000-000000000084";
    const holderAssetId = "93000000-0000-4000-8000-000000000085";
    const eventId = "automation-integration-processing-headroom-refused";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    try {
      const { body } = await stagedUploadFixture({
        assetId,
        harness,
        title: "Automation integration headroom refused",
      });
      const outputBytes = 44;
      const chargedSoFar = await chargedObjectBytes(organizationId);
      const ceiling = BigInt(storageLimit);
      // One byte short of the guarantee: the staging reservation covers the
      // source copy and the output reservation, but the destination needs
      // 2 * output — one real byte more than is free.
      const holderBytes = Number(ceiling - chargedSoFar) - body.byteLength - 2 * outputBytes + 1;
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration headroom holder', 'ready')`,
          [holderAssetId, organizationId, seededAlphaProfileId, userId],
        );
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
              content_type, status)
           VALUES ($1, $2, $3, 'original', $4, $5, 'image/png', 'ready')`,
          [
            organizationId,
            holderAssetId,
            seededAlphaProfileId,
            `${organizationId}/${holderAssetId}/original`,
            holderBytes,
          ],
        );
      });

      await expect(
        Effect.runPromise(
          createAssetJobProcessor(processorEnv(processor), harness.storage).process(
            outboxMessage(eventId, assetId),
          ),
        ),
      ).resolves.toBe("processed");

      // The refusal is terminal for the Asset, not retried forever: an
      // undersized workspace is a durable answer the creator can act on, and
      // the pending rows are superseded rather than left holding a reservation
      // no later run would release.
      await expect(processingState(assetId, eventId)).resolves.toMatchObject({
        failure_code: "storage_limit_reached",
        orphan_armed: true,
        status: "failed",
      });
      const inventory = await assetInventory(assetId);
      expect(
        inventory.find((row) => row.kind === "rendition" && row.status === "ready"),
      ).toBeUndefined();
      expect(inventory.find((row) => row.status === "writing")).toBeUndefined();
      // No orphan reservation: the refused destination row was rolled back, so
      // nothing charges bytes that were never produced.
      expect(inventory.find((row) => row.r2_key.endsWith(`rendition-${profile}`))).toBeUndefined();
      expect(harness.bodies.has(`${organizationId}/${assetId}/rendition-${profile}`)).toBe(false);
    } finally {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM assets WHERE id = $1", [holderAssetId]),
      );
    }
  });

  it("adopts a settled staging output without double-charging on replay", async () => {
    const assetId = "93000000-0000-4000-8000-000000000086";
    const eventId = "automation-integration-processing-settled-replay";
    const profile = "image_auto_4096_long_edge";
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration settled replay",
    });
    // A previous attempt verified the engine's output and exchanged its
    // reservation for real bytes, then crashed before the protected copy was
    // reserved: the row is still 'writing' with bytes recorded and
    // reserved_bytes NULL — the exact mid-state the replay must adopt.
    const produced = engineRenditionBytes(320, 240, await sha256Hex(body));
    const producedSha = await sha256Hex(produced);
    harness.put(processingKey, produced, "image/jpeg");
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, profile, r2_key,
            bytes, sha256, content_type, status, write_hold_until)
         VALUES ($1, $2, $3, 'rendition', $4, $5, $6, $7, 'image/jpeg',
                 'writing', now() + interval '1 hour')`,
        [
          organizationId,
          assetId,
          seededAlphaProfileId,
          profile,
          processingKey,
          produced.byteLength,
          producedSha,
        ],
      );
      await client.query(
        `INSERT INTO asset_renditions
           (org_id, asset_id, brand_profile_id, profile, status)
         VALUES ($1, $2, $3, $4, 'processing')
         ON CONFLICT (asset_id, profile) DO NOTHING`,
        [organizationId, assetId, seededAlphaProfileId, profile],
      );
    });
    const chargedBefore = await chargedObjectBytes(organizationId);

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // The settled reservation was adopted, not re-settled: the destination was
    // charged exactly once for the real output, and the replay added only the
    // canonical source and the destination copy to the workspace's charge.
    const inventory = await assetInventory(assetId);
    expect(
      inventory.find((row) => row.kind === "rendition" && row.status === "ready"),
    ).toMatchObject({
      bytes: String(produced.byteLength),
      reserved_bytes: null,
      r2_key: readyKey,
      sha256: producedSha,
    });
    expect(await chargedObjectBytes(organizationId)).toBe(
      chargedBefore + BigInt(body.byteLength + produced.byteLength),
    );
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      status: "ready",
    });
    expect(processor.calls).toHaveLength(0);
  });

  it("re-arms the full reservation before clearing untrusted staged output", async () => {
    const assetId = "93000000-0000-4000-8000-000000000087";
    const holderAssetId = "93000000-0000-4000-8000-000000000088";
    const eventId = "automation-integration-processing-rearm-retry";
    const profile = "image_auto_4096_long_edge";
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    try {
      const { body } = await stagedUploadFixture({
        assetId,
        harness,
        title: "Automation integration re-arm retry",
      });
      const produced = engineRenditionBytes(320, 240, await sha256Hex(body));
      const producedSha = await sha256Hex(produced);
      harness.put(processingKey, produced, "image/jpeg");
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, profile, r2_key,
              bytes, sha256, content_type, status, write_hold_until)
           VALUES ($1, $2, $3, 'rendition', $4, $5, $6, $7, 'image/jpeg',
                   'writing', now() + interval '1 hour')`,
          [
            organizationId,
            assetId,
            seededAlphaProfileId,
            profile,
            processingKey,
            produced.byteLength,
            producedSha,
          ],
        );
        await client.query(
          `INSERT INTO asset_renditions
             (org_id, asset_id, brand_profile_id, profile, status)
           VALUES ($1, $2, $3, $4, 'processing')
           ON CONFLICT (asset_id, profile) DO NOTHING`,
          [organizationId, assetId, seededAlphaProfileId, profile],
        );
      });
      // Fill the workspace so the re-arm to the media ceiling cannot fit: the
      // settled row holds only its real bytes, and re-arming needs the full
      // reservation because a stale create-only grant could still write to
      // that ceiling.
      const chargedSoFar = await chargedObjectBytes(organizationId);
      const ceiling = BigInt(storageLimit);
      const holderBytes =
        Number(ceiling - chargedSoFar) -
        body.byteLength -
        Number(imageReservationCeiling) +
        produced.byteLength +
        1;
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration re-arm holder', 'ready')`,
          [holderAssetId, organizationId, seededAlphaProfileId, userId],
        );
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
              content_type, status)
           VALUES ($1, $2, $3, 'original', $4, $5, 'image/png', 'ready')`,
          [
            organizationId,
            holderAssetId,
            seededAlphaProfileId,
            `${organizationId}/${holderAssetId}/original`,
            holderBytes,
          ],
        );
      });
      // A stale grant rewrote the key after the facts were recorded, so the
      // recorded digest no longer matches the live bytes: the pipeline must
      // re-arm the reservation before it may delete and recompute.
      harness.put(processingKey, png(160, 120), "image/jpeg");

      await expect(
        Effect.runPromise(
          createAssetJobProcessor(processorEnv(processor), harness.storage).process(
            outboxMessage(eventId, assetId),
          ),
        ),
      ).rejects.toThrow("room to re-arm");

      // The capacity failure left the measured facts and the object in place:
      // clearing them before re-arming would let the stale grant write to the
      // ceiling against a row that only accounts for the settled bytes.
      const duringFailure = await assetInventory(assetId);
      expect(duringFailure.find((row) => row.r2_key === processingKey)).toMatchObject({
        bytes: String(produced.byteLength),
        reserved_bytes: null,
        status: "writing",
      });
      expect(harness.bodies.has(processingKey)).toBe(true);

      // Freeing the holder lets the retry re-arm to the full ceiling and
      // recompute; the grant the engine receives is bounded by that re-armed
      // reservation, not by the settled byte count.
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM assets WHERE id = $1", [holderAssetId]),
      );
      await expect(
        Effect.runPromise(
          createAssetJobProcessor(processorEnv(processor), harness.storage).process(
            outboxMessage(eventId, assetId),
          ),
        ),
      ).resolves.toBe("processed");

      const rearmCall = processor.calls.find((call) => call.outputKey === processingKey);
      expect(rearmCall?.maximumOutputBytes).toBe(Number(imageReservationCeiling));
      const inventory = await assetInventory(assetId);
      expect(
        inventory.find((row) => row.kind === "rendition" && row.status === "ready"),
      ).toMatchObject({
        bytes: String(produced.byteLength),
        reserved_bytes: null,
      });
      await expect(processingState(assetId, eventId)).resolves.toMatchObject({
        status: "ready",
      });
    } finally {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM assets WHERE id = $1", [holderAssetId]),
      );
    }
  });

  it("reserves the protected rendition key before copying into it", async () => {
    const assetId = "93000000-0000-4000-8000-000000000078";
    const eventId = "automation-integration-processing-ready-reserved";
    const profile = "image_auto_4096_long_edge";
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const processingKey = `staging/${readyKey.replace(`rendition-`, "processing-")}`;
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration ready copy reserved",
    });
    const chargedBeforePromotion = await chargedObjectBytes(organizationId);
    // Captured while the promotion copy is still in flight, which is the only
    // point at which "reserved before the copy" is a claim about ordering rather
    // than about the final state.
    let pendingRowAtCopyTime: InventoryRow | undefined;
    harness.copyProbe.current = async ({ destination }) => {
      if (destination !== readyKey) return;
      pendingRowAtCopyTime = (await assetInventory(assetId)).find((row) => row.r2_key === readyKey);
    };

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // While the copy ran, the destination already had a charged inventory row
    // reserved at exactly the measured output size. Both physical copies — the
    // staging output and its protected copy — are accounted for at once.
    expect(pendingRowAtCopyTime).toMatchObject({
      bytes: null,
      reserved_bytes: expect.stringMatching(/^\d+$/) as unknown as string,
      status: "writing",
    });
    const produced = harness.bodies.get(processingKey);
    expect(pendingRowAtCopyTime?.reserved_bytes).toBe(String(produced?.byteLength));
    expect(chargedBeforePromotion).toBeGreaterThan(0n);
    const settled = (await assetInventory(assetId)).find((row) => row.r2_key === readyKey);
    expect(settled).toMatchObject({
      bytes: String(produced?.byteLength),
      reserved_bytes: null,
      status: "ready",
    });
    expect(harness.bodies.get(readyKey)).toEqual(produced);
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it("never publishes an original the engine refused to decode", async () => {
    const assetId = "93000000-0000-4000-8000-000000000079";
    const eventId = "automation-integration-processing-original-unpublishable";
    const originalKey = `${organizationId}/${assetId}/original`;
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      body: new Uint8Array([1, 2, 3, 4]),
      contentType: "image/png",
      harness,
      title: "Automation integration corrupt source",
    });

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // The protected original exists — it is real creator-visible bytes — but
    // nothing references it as a rendition. Only the engine's
    // `original_compatible` verdict may approve the original, and it refused.
    const original = (await assetInventory(assetId)).find((row) => row.kind === "original");
    expect(original).toMatchObject({ r2_key: originalKey, status: "ready" });
    const renditions = await assetRenditions(assetId);
    expect(renditions.filter((row) => row.status === "ready")).toHaveLength(0);
    expect(renditions.map((row) => row.object_id)).not.toContain(original?.id);
    expect(
      harness.bodies.has(`${organizationId}/${assetId}/rendition-image_auto_4096_long_edge`),
    ).toBe(false);
    await expect(processingState(assetId, eventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      failure_code: "corrupt_media",
      status: "failed",
    });
  });

  // A landed protected copy settles its existing reservation without charging
  // another source copy; only the engine's two physical output copies add bytes.
  it("adopts a protected copy that landed before its row was settled", async () => {
    const assetId = "93000000-0000-4000-8000-000000000080";
    const eventId = "automation-integration-processing-pending-copy";
    const originalKey = `${organizationId}/${assetId}/original`;
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    const { body, metadata } = await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration pending original copy",
    });
    // Crash checkpoint: the copy completed but the settle never ran, so the row
    // is still `writing` with a reservation and no bytes while the object it
    // owns already exists in the bucket.
    harness.put(originalKey, body, "image/png");
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, reserved_bytes,
            content_type, status, write_hold_until)
         VALUES ($1, $2, $3, 'original', $4, $5, 'image/png', 'writing',
                 now() + interval '15 minutes')`,
        [organizationId, assetId, seededAlphaProfileId, originalKey, body.byteLength],
      );
    });
    const chargedBefore = await chargedObjectBytes(organizationId);

    await expect(
      Effect.runPromise(
        createAssetJobProcessor(processorEnv(processor), harness.storage).process(
          outboxMessage(eventId, assetId),
        ),
      ),
    ).resolves.toBe("processed");

    // The pending row was adopted and settled in place: one row for the key,
    // charged once at the original's real size, with no second reservation for
    // bytes already in the bucket.
    const inventory = await assetInventory(assetId);
    const originals = inventory.filter((row) => row.kind === "original");
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({
      bytes: String(body.byteLength),
      etag: metadata.etag,
      reserved_bytes: null,
      r2_key: originalKey,
      status: "ready",
    });
    const chargedAfter = await chargedObjectBytes(organizationId);
    // The original's reservation was already charged and is replaced by the
    // same byte count. Only the uploaded staging output and its ready copy add
    // physical storage; no fresh protected-source reservation may be charged.
    const rendition = inventory.find((row) => row.kind === "rendition");
    const output = rendition && harness.bodies.get(rendition.r2_key);
    if (!output) throw new Error("The processing fixture produced no ready object");
    expect(chargedAfter - chargedBefore).toBe(BigInt(2 * output.byteLength));
  });

  it("replays deletion when storage acknowledgement is lost", async () => {
    const assetId = "93000000-0000-4000-8000-000000000012";
    const eventId = "automation-integration-asset-delete-ambiguous";
    const key = `${organizationId}/${assetId}/original`;
    const usageBefore = await currentStorageBytes();
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
            file_size, mime_type, status)
         VALUES ($1, $2, $4, $3, 'image',
                 'Automation integration delete ambiguous', 24, 'image/png',
                 'deleting')`,
        [assetId, organizationId, userId, seededAlphaProfileId],
      );
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
            content_type, status)
         VALUES ($1, $2, $3, 'original', $4, 24, 'image/png', 'ready')`,
        [organizationId, assetId, seededAlphaProfileId, key],
      );
      await client.query(
        `UPDATE usage_records
         SET storage_bytes = storage_bytes + 24, updated_at = now()
         WHERE org_id = $1 AND period = $2`,
        [organizationId, currentUsagePeriod],
      );
    });
    const harness = objectStoreHarness();
    harness.put(key, png(8, 8), "image/png");
    // The delete lands in the bucket but the acknowledgement is lost, so the
    // durable row never settles and the delivery must be retried.
    let lostAcknowledgement = true;
    const ambiguousStorage: ObjectStore = {
      ...harness.storage,
      delete: vi.fn(async (objectKey) => {
        await harness.storage.delete(objectKey);
        if (lostAcknowledgement) {
          lostAcknowledgement = false;
          throw new Error("storage delete acknowledgement was lost");
        }
      }),
    };
    const message = outboxMessage(eventId, assetId, "asset.deletion.requested");

    await expect(
      Effect.runPromise(createAssetJobProcessor(env, ambiguousStorage).process(message)),
    ).rejects.toThrow("storage delete acknowledgement was lost");
    const failedState = await deletionState(assetId, eventId);
    expect(failedState).toMatchObject({
      event_outcome: "failed",
      status: "deleting",
      storage_bytes: (usageBefore + 24n).toString(),
    });
    expect(failedState.objects).toEqual([
      expect.objectContaining({ r2_key: key, status: "deleting" }),
    ]);

    await expect(
      Effect.runPromise(createAssetJobProcessor(env, harness.storage).process(message)),
    ).resolves.toBe("processed");
    const settledState = await deletionState(assetId, eventId);
    expect(settledState).toMatchObject({
      event_outcome: "succeeded",
      status: "deleted",
      storage_bytes: usageBefore.toString(),
    });
    expect(settledState.objects).toEqual([
      expect.objectContaining({ r2_key: key, status: "deleted" }),
    ]);
    // R2's idempotent DELETE ran once per attempt; the charge was released
    // exactly once through the guarded deleting→deleted transition.
    expect(harness.deletes).toEqual([key, key]);
  });

  it("reclaims each inventoried object exactly once across an interrupted deletion", async () => {
    const assetId = "93000000-0000-4000-8000-000000000015";
    const eventId = "automation-integration-asset-delete-between-objects";
    const originalKey = `${organizationId}/${assetId}/original`;
    const renditionKey = `${organizationId}/${assetId}/rendition-image_auto_4096_long_edge`;
    const usageBefore = await currentStorageBytes();
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
            file_size, mime_type, status)
         VALUES ($1, $2, $4, $3, 'image',
                 'Automation integration partial delete', 4096, 'image/png',
                 'deleting')`,
        [assetId, organizationId, userId, seededAlphaProfileId],
      );
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, profile, r2_key, bytes,
            content_type, status)
         VALUES ($1, $2, $3, 'original', NULL, $4, 4096, 'image/png', 'ready'),
                ($1, $2, $3, 'rendition', 'image_auto_4096_long_edge', $5,
                 20, 'image/jpeg', 'ready')`,
        [organizationId, assetId, seededAlphaProfileId, originalKey, renditionKey],
      );
      await client.query(
        `UPDATE usage_records
         SET storage_bytes = storage_bytes + 4116, updated_at = now()
         WHERE org_id = $1 AND period = $2`,
        [organizationId, currentUsagePeriod],
      );
    });
    const harness = objectStoreHarness();
    harness.put(originalKey, png(64, 64), "image/png");
    harness.put(renditionKey, new Uint8Array(20), "image/jpeg");
    // Interruption between the two external deletes: the original's removal
    // throws before landing, leaving its row claimed but unsettled.
    let failOriginal = true;
    const interruptedStorage: ObjectStore = {
      ...harness.storage,
      delete: vi.fn(async (objectKey) => {
        if (objectKey === originalKey && failOriginal) {
          failOriginal = false;
          throw new Error("processing terminated before original deletion");
        }
        await harness.storage.delete(objectKey);
      }),
    };
    const message = outboxMessage(eventId, assetId, "asset.deletion.requested");

    await expect(
      Effect.runPromise(createAssetJobProcessor(env, interruptedStorage).process(message)),
    ).rejects.toThrow("processing terminated before original deletion");
    const interruptedState = await deletionState(assetId, eventId);
    expect(interruptedState).toMatchObject({
      event_outcome: "failed",
      status: "deleting",
      storage_bytes: (usageBefore + 4096n).toString(),
    });
    expect(interruptedState.objects).toEqual([
      expect.objectContaining({ r2_key: originalKey, status: "deleting" }),
      expect.objectContaining({ r2_key: renditionKey, status: "deleted" }),
    ]);
    expect(harness.deletes).toEqual([renditionKey]);

    await expect(
      Effect.runPromise(createAssetJobProcessor(env, harness.storage).process(message)),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(createAssetJobProcessor(env, harness.storage).process(message)),
    ).resolves.toBe("skipped");
    const settledState = await deletionState(assetId, eventId);
    expect(settledState).toMatchObject({
      event_outcome: "succeeded",
      status: "deleted",
      storage_bytes: usageBefore.toString(),
    });
    expect(settledState.objects).toEqual([
      expect.objectContaining({ r2_key: originalKey, status: "deleted" }),
      expect.objectContaining({ r2_key: renditionKey, status: "deleted" }),
    ]);
    expect(harness.deletes).toEqual([renditionKey, originalKey]);
  });

  it("rolls back the deleting lifecycle commit before replay", async () => {
    const assetId = "93000000-0000-4000-8000-000000000016";
    const eventId = "automation-integration-asset-delete-db-rollback";
    const distributionId = "60000000-0000-4000-8000-000000000001";
    const originalKey = `${organizationId}/${assetId}/original`;
    const usageBefore = await currentStorageBytes();
    const providerOperationId = "97000000-0000-4000-8000-000000000009";
    try {
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              file_size, mime_type, status)
           VALUES ($1, $2, $4, $3, 'image',
                   'Automation integration deletion transaction rollback',
                   24, 'image/png', 'deleting')`,
          [assetId, organizationId, userId, seededAlphaProfileId],
        );
        const original = await client.query<{ id: string }>(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
              content_type, status)
           VALUES ($1, $2, $3, 'original', $4, 24, 'image/png', 'ready')
           RETURNING id`,
          [organizationId, assetId, seededAlphaProfileId, originalKey],
        );
        await client.query(
          `INSERT INTO asset_renditions
             (org_id, asset_id, brand_profile_id, profile, object_id, status)
           VALUES ($1, $2, $3, 'original', $4, 'ready')`,
          [organizationId, assetId, seededAlphaProfileId, original.rows[0]!.id],
        );
        await client.query(
          `UPDATE usage_records
           SET storage_bytes = storage_bytes + 24, updated_at = now()
           WHERE org_id = $1 AND period = $2`,
          [organizationId, currentUsagePeriod],
        );
        // An active provider operation holds the Asset, so the lifecycle
        // update fires the delete-claim guard and the whole commit (rendition
        // settle + status flip + lease outcome) rolls back together.
        await client.query(
          `INSERT INTO provider_operations
             (id, org_id, distribution_id, operation, idempotency_key, status)
           VALUES ($1, $2, $3, 'publish', $4, 'started')`,
          [providerOperationId, organizationId, distributionId, `guard:${eventId}`],
        );
        await client.query(
          `INSERT INTO provider_operation_media
             (operation_id, org_id, distribution_id, asset_id,
              brand_profile_id, object_key, position)
           VALUES ($1, $2, $3, $4, $5, $6, 0)`,
          [
            providerOperationId,
            organizationId,
            distributionId,
            assetId,
            seededAlphaProfileId,
            originalKey,
          ],
        );
      });
      const harness = objectStoreHarness();
      harness.put(originalKey, png(8, 8), "image/png");
      const message = outboxMessage(eventId, assetId, "asset.deletion.requested");

      await expect(
        Effect.runPromise(createAssetJobProcessor(env, harness.storage).process(message)),
      ).rejects.toThrow(/held by an active provider operation/u);
      const rolledBack = await deletionState(assetId, eventId);
      expect(rolledBack).toMatchObject({
        event_outcome: "failed",
        status: "deleting",
        storage_bytes: usageBefore.toString(),
      });
      // The bucket delete settled, but the lifecycle commit rolled back: the
      // rendition row is not 'deleted' and the Asset still awaits its worker.
      expect(rolledBack.objects).toEqual([
        expect.objectContaining({ r2_key: originalKey, status: "deleted" }),
      ]);
      await expect(
        runSystemTransaction(env, async (client) => {
          const result = await client.query<{ status: string }>(
            `SELECT status FROM asset_renditions WHERE asset_id = $1`,
            [assetId],
          );
          return result.rows[0]?.status;
        }),
      ).resolves.toBe("ready");

      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM provider_operations WHERE id = $1", [providerOperationId]),
      );
      await expect(
        Effect.runPromise(createAssetJobProcessor(env, harness.storage).process(message)),
      ).resolves.toBe("processed");
      const settledState = await deletionState(assetId, eventId);
      expect(settledState).toMatchObject({
        event_outcome: "succeeded",
        status: "deleted",
      });
      // The settled object released its charge exactly once: the replay could
      // not subtract the same bytes twice.
      expect(settledState.storage_bytes).toBe(usageBefore.toString());
      expect(harness.deletes).toEqual([originalKey]);
    } finally {
      await runSystemTransaction(env, (client) =>
        client.query("DELETE FROM provider_operations WHERE id = $1", [providerOperationId]),
      );
    }
  });

  it("quarantines invalid media through the engine verdict and completes deletion", async () => {
    const invalidId = "92000000-0000-4000-8000-000000000003";
    const deleteId = "92000000-0000-4000-8000-000000000004";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId: invalidId,
      body: new TextEncoder().encode("not a png"),
      harness,
      title: "Automation integration invalid",
    });
    const deleteKey = `${organizationId}/${deleteId}/original`;
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
            file_size, mime_type, status)
         VALUES ($1, $2, $4, $3, 'image', 'Automation integration deleting',
                 24, 'image/png', 'deleting')`,
        [deleteId, organizationId, userId, seededAlphaProfileId],
      );
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
            content_type, status)
         VALUES ($1, $2, $3, 'original', $4, 24, 'image/png', 'ready')`,
        [organizationId, deleteId, seededAlphaProfileId, deleteKey],
      );
      await client.query(
        `UPDATE usage_records
         SET storage_bytes = storage_bytes + 24, updated_at = now()
         WHERE org_id = $1 AND period = $2`,
        [organizationId, currentUsagePeriod],
      );
    });
    harness.put(deleteKey, png(8, 8), "image/png");
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);

    const invalidMessage = outboxMessage("automation-integration-invalid", invalidId);
    // The engine decoded the staged bytes and refused them permanently: the
    // Asset is quarantined as 'failed' and its protected original stays
    // charged rather than being published anywhere.
    await expect(Effect.runPromise(processorJob.process(invalidMessage))).resolves.toBe(
      "processed",
    );
    await expect(Effect.runPromise(processorJob.process(invalidMessage))).resolves.toBe("skipped");
    await expect(
      Effect.runPromise(
        processorJob.process(
          outboxMessage("automation-integration-delete", deleteId, "asset.deletion.requested"),
        ),
      ),
    ).resolves.toBe("processed");
    expect(harness.deletes).toEqual([deleteKey]);
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{ id: string; status: string }>(
        "SELECT id, status FROM assets WHERE id IN ($1, $2) ORDER BY id",
        [invalidId, deleteId],
      );
      expect(result.rows).toEqual([
        { id: invalidId, status: "failed" },
        { id: deleteId, status: "deleted" },
      ]);
    });
  });

  it("aborts abandoned multipart uploads during maintenance while leaving DB state untouched", async () => {
    const assetId = "92000000-0000-4000-8000-000000000005";
    const sessionId = "92000000-0000-4000-8000-000000000006";
    const key = `${organizationId}/${assetId}/expired.png`;
    const multipartUploadId = "mp-upload-maintenance-test";
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
            status)
         VALUES ($1, $2, $4, $3, 'image', 'Automation integration expired',
                 'pending_upload')`,
        [assetId, organizationId, userId, seededAlphaProfileId],
      );
      await client.query(
        `INSERT INTO asset_upload_sessions
           (id, org_id, asset_id, uploaded_by, strategy, status,
            content_type, file_size, object_key, multipart_upload_id,
            part_size, part_count, max_parallel_parts, expires_at)
         VALUES ($1, $2, $3, $4, 'multipart', 'created',
                 'image/png', 24, $5, $6, 8388608, 2, 4,
                 now() - INTERVAL '2 hours')`,
        [sessionId, organizationId, assetId, userId, key, multipartUploadId],
      );
      await client.query(
        `INSERT INTO asset_quota_reservations (session_id, org_id, bytes)
         VALUES ($1, $2, 24)`,
        [sessionId, organizationId],
      );
      // The finalize step never ran, so the staged object exists only as an
      // uncharged 'writing' inventory row the session's reservation maps to.
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, content_type,
            status)
         VALUES ($1, $2, $3, 'staging', $4, 'image/png', 'writing')`,
        [organizationId, assetId, seededAlphaProfileId, key],
      );
    });
    const harness = objectStoreHarness();
    const result = await Effect.runPromise(
      createAssetJobProcessor(env, harness.storage).runMaintenance(),
    );
    expect(result).toMatchObject({
      cleanup_errors: 0,
      expired_sessions: 1,
    });
    expect(harness.multipartAborts).toContain(multipartUploadId);
    await runSystemTransaction(env, async (client) => {
      const state = await client.query<{
        asset_status: string;
        object_hold: Date | null;
        object_reserved: string | null;
        object_status: string;
        reservation_state: string;
        session_status: string;
      }>(
        `SELECT
           asset.status AS asset_status,
           session.status AS session_status,
           reservation.state AS reservation_state,
           object.status AS object_status,
           object.write_hold_until AS object_hold,
           object.reserved_bytes::text AS object_reserved
         FROM asset_upload_sessions AS session
         JOIN assets AS asset ON asset.id = session.asset_id
         JOIN asset_quota_reservations AS reservation
           ON reservation.session_id = session.id
         JOIN asset_objects AS object ON object.asset_id = asset.id
         WHERE session.id = $1`,
        [sessionId],
      );
      // The abort is replayable: the session is terminal, the reservation's
      // charge moved onto the staged row rather than being dropped, and that
      // row was claimed for deletion with the reservation released exactly
      // once. The bucket confirmed the abort, so the upload id and its part
      // grants are dead: the write hold closed at once rather than parking at
      // the session's expiry, which lets the same sweep's
      // `releaseStaleProcessingStaging` pass pick the claimed row straight
      // back up. R2 DELETE is idempotent and the key was already absent here,
      // so the claim settles to `'deleted'` in this same `runMaintenance`
      // rather than lingering in `'deleting'` for a later sweep.
      const hold = state.rows[0]!.object_hold;
      expect(hold === null || hold.getTime() <= Date.now() + 1_000).toBe(true);
      const { object_hold: _hold, ...rest } = state.rows[0]!;
      expect(rest).toEqual({
        // The abandoned upload leaves its Asset durably failed with a stable
        // reason rather than pending forever on a session that will never
        // finalize. Its object and reservation are reclaimed exactly as
        // before; only the object's lifecycle slot advances past `'deleting'`
        // because this sweep completes the delete it claimed.
        asset_status: "failed",
        object_reserved: "24",
        object_status: "deleted",
        reservation_state: "released",
        session_status: "aborted",
      });
    });
  });

  it("expires abandoned single-PUT upload sessions during maintenance, respects writer holds, and settles quota once", async () => {
    const assetId = "92000000-0000-4000-8000-000000000091";
    const sessionId = "92000000-0000-4000-8000-000000000092";
    const key = `staging/${organizationId}/${assetId}/single-expired.png`;

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
            status)
         VALUES ($1, $2, $4, $3, 'image', 'Automation integration single expired',
                 'pending_upload')`,
        [assetId, organizationId, userId, seededAlphaProfileId],
      );
      await client.query(
        `INSERT INTO asset_upload_sessions
           (id, org_id, asset_id, uploaded_by, strategy, status,
            content_type, file_size, object_key, expires_at)
         VALUES ($1, $2, $3, $4, 'single', 'created',
                 'image/png', 32, $5, now() - INTERVAL '2 hours')`,
        [sessionId, organizationId, assetId, userId, key],
      );
      await client.query(
        `INSERT INTO asset_quota_reservations (session_id, org_id, bytes)
         VALUES ($1, $2, 32)`,
        [sessionId, organizationId],
      );
      // The single-PUT grant minted an active write hold 30 minutes in the future.
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, content_type,
            status, write_hold_until)
         VALUES ($1, $2, $3, 'staging', $4, 'image/png', 'writing',
                 now() + INTERVAL '30 minutes')`,
        [organizationId, assetId, seededAlphaProfileId, key],
      );
    });

    const harness = objectStoreHarness();
    const processor = createAssetJobProcessor(env, harness.storage);

    // First maintenance sweep: expires session without any tenant API call,
    // fails the Asset, transfers reservation to the staging row as 'deleting',
    // but the active writer hold prevents premature object deletion.
    const sweep1 = await Effect.runPromise(processor.runMaintenance());
    expect(sweep1).toMatchObject({
      cleanup_errors: 0,
      expired_sessions: 1,
    });

    await runSystemTransaction(env, async (client) => {
      const state = await client.query<{
        asset_status: string;
        failure_code: string | null;
        object_reserved: string | null;
        object_status: string;
        reservation_state: string;
        session_status: string;
      }>(
        `SELECT
           asset.status AS asset_status,
           asset.failure_code AS failure_code,
           session.status AS session_status,
           reservation.state AS reservation_state,
           object.status AS object_status,
           object.reserved_bytes::text AS object_reserved
         FROM asset_upload_sessions AS session
         JOIN assets AS asset ON asset.id = session.asset_id
         JOIN asset_quota_reservations AS reservation
           ON reservation.session_id = session.id
         JOIN asset_objects AS object ON object.asset_id = asset.id
         WHERE session.id = $1`,
        [sessionId],
      );
      expect(state.rows[0]).toEqual({
        asset_status: "failed",
        failure_code: "upload_session_expired",
        object_reserved: "32",
        object_status: "deleting",
        reservation_state: "released",
        session_status: "expired",
      });
    });

    // Now lapse the writer hold so the object becomes eligible for physical reclamation.
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE asset_objects
         SET write_hold_until = now() - INTERVAL '1 minute',
             updated_at = now()
         WHERE asset_id = $1 AND kind = 'staging'`,
        [assetId],
      );
    });

    // Second maintenance sweep: reclaims the 'deleting' object with expired write hold,
    // deletes it from storage, and settles it to 'deleted'.
    const sweep2 = await Effect.runPromise(processor.runMaintenance());
    expect(sweep2).toMatchObject({
      cleanup_errors: 0,
    });

    await runSystemTransaction(env, async (client) => {
      const row = await client.query<{ status: string }>(
        `SELECT status FROM asset_objects WHERE asset_id = $1 AND kind = 'staging'`,
        [assetId],
      );
      expect(row.rows[0]?.status).toBe("deleted");
    });

    // Third sweep: repeated cleanup is idempotent and changes nothing.
    const sweep3 = await Effect.runPromise(processor.runMaintenance());
    expect(sweep3).toMatchObject({
      cleanup_errors: 0,
    });
  });

  it("recomputes an engine verdict whose staged bytes the Worker deleted instead of replaying it", async () => {
    const assetId = "92000000-0000-4000-8000-000000000094";
    const eventId = "automation-integration-replay-deleted-output";
    const retryEventId = "automation-integration-replay-deleted-output-retry";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration replay deleted output",
    });
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventId, assetId))),
    ).resolves.toBe("processed");

    // Rewind to the state a crashed recovery leaves: the engine's verdict is
    // still recorded in its dedupe cache, but the Worker cleared the staging
    // key for a recompute — row back to a bare reservation, object gone,
    // committed references unwound.
    harness.bodies.delete(processingKey);
    harness.types.delete(processingKey);
    harness.bodies.delete(readyKey);
    harness.types.delete(readyKey);
    await runSystemTransaction(env, async (client) => {
      // The rendition reference must leave 'ready' before its object row goes:
      // `asset_renditions_ready_object_check` forbids a ready row with a NULL
      // reference, which deleting the object would otherwise produce through
      // ON DELETE SET NULL.
      await client.query(
        `UPDATE asset_renditions
         SET status = 'processing', object_id = NULL, failure_code = NULL,
             failure_message = NULL, failure_at = NULL, updated_at = now()
         WHERE asset_id = $1 AND profile = $2`,
        [assetId, profile],
      );
      await client.query(
        `DELETE FROM asset_objects
         WHERE asset_id = $1 AND kind = 'rendition' AND status = 'ready'
           AND r2_key <> $2`,
        [assetId, processingKey],
      );
      await client.query(
        `UPDATE asset_objects
         SET bytes = NULL, etag = NULL, sha256 = NULL, content_type = NULL,
             width = NULL, height = NULL, duration_sec = NULL,
             reserved_bytes = $2, status = 'writing',
             write_hold_until = now() + INTERVAL '1 hour', updated_at = now()
         WHERE asset_id = $1 AND r2_key = $3`,
        [assetId, imageReservationCeiling, processingKey],
      );
      await client.query(
        `UPDATE assets SET status = 'processing', updated_at = now()
         WHERE id = $1`,
        [assetId],
      );
    });

    // The replayed 'optimized' verdict must not be trusted once its staging
    // bytes are gone: the engine re-executes, the create-only PUT recreates
    // the object, and the rendition commits from real bytes — never from a
    // verdict pointing at an absent object.
    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(retryEventId, assetId))),
    ).resolves.toBe("processed");

    // The staging key was deleted before redelivery, so a body there now can
    // only be the re-executed engine's recreated output.
    expect(harness.bodies.has(processingKey)).toBe(true);
    expect(harness.bodies.has(readyKey)).toBe(true);
    await expect(processingState(assetId, retryEventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      status: "ready",
    });
  });

  it("replays the recorded verdict when a stale grant re-created byte-identical output", async () => {
    const assetId = "92000000-0000-4000-8000-000000000095";
    const eventId = "automation-integration-replay-identical-output";
    const retryEventId = "automation-integration-replay-identical-output-retry";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration replay identical output",
    });
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventId, assetId))),
    ).resolves.toBe("processed");
    const produced = harness.bodies.get(processingKey);
    if (!produced) throw new Error("first run must have staged an output");

    // Same rewind as the deleted-bytes spec, but the staging bytes stay in the
    // store: a still-valid stale grant then re-creates byte-identical output
    // the instant the Worker's recovery clears the key — the engine's
    // create-only PUT answers 412 on bytes it itself produced, which proves
    // this job's output is unchanged and the recorded verdict replays.
    harness.bodies.delete(readyKey);
    harness.types.delete(readyKey);
    await runSystemTransaction(env, async (client) => {
      // Same FK-safe order as the deleted-bytes spec: the rendition reference
      // leaves 'ready' before its object row is removed.
      await client.query(
        `UPDATE asset_renditions
         SET status = 'processing', object_id = NULL, failure_code = NULL,
             failure_message = NULL, failure_at = NULL, updated_at = now()
         WHERE asset_id = $1 AND profile = $2`,
        [assetId, profile],
      );
      await client.query(
        `DELETE FROM asset_objects
         WHERE asset_id = $1 AND kind = 'rendition' AND status = 'ready'
           AND r2_key <> $2`,
        [assetId, processingKey],
      );
      await client.query(
        `UPDATE asset_objects
         SET bytes = NULL, etag = NULL, sha256 = NULL, content_type = NULL,
             width = NULL, height = NULL, duration_sec = NULL,
             reserved_bytes = $2, status = 'writing',
             write_hold_until = now() + INTERVAL '1 hour', updated_at = now()
         WHERE asset_id = $1 AND r2_key = $3`,
        [assetId, imageReservationCeiling, processingKey],
      );
      await client.query(
        `UPDATE assets SET status = 'processing', updated_at = now()
         WHERE id = $1`,
        [assetId],
      );
    });
    const originalDelete = harness.storage.delete.bind(harness.storage);
    harness.storage.delete = async (key: string) => {
      await originalDelete(key);
      if (key === processingKey) harness.put(processingKey, produced, "image/jpeg");
    };

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(retryEventId, assetId))),
    ).resolves.toBe("processed");

    // The re-executed run hit the create-only refusal and replayed the honest
    // verdict, so the pipeline still converged to a committed rendition holding
    // exactly the bytes the first attempt produced.
    expect(harness.bodies.get(readyKey)).toEqual(produced);
    await expect(processingState(assetId, retryEventId)).resolves.toMatchObject({
      event_outcome: "succeeded",
      status: "ready",
    });
  });

  it("fails permanently when re-created staging bytes carry a different stored digest", async () => {
    const assetId = "92000000-0000-4000-8000-000000000096";
    const eventId = "automation-integration-replay-foreign-output";
    const retryEventId = "automation-integration-replay-foreign-output-retry";
    const profile = "image_auto_4096_long_edge";
    const harness = objectStoreHarness();
    const processor = mediaProcessorNamespace(harness);
    await stagedUploadFixture({
      assetId,
      harness,
      title: "Automation integration replay foreign output",
    });
    const processingKey = `staging/${organizationId}/${assetId}/processing-${profile}`;
    const readyKey = `${organizationId}/${assetId}/rendition-${profile}`;
    const processorJob = createAssetJobProcessor(processorEnv(processor), harness.storage);

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(eventId, assetId))),
    ).resolves.toBe("processed");
    const produced = harness.bodies.get(processingKey);
    if (!produced) throw new Error("first run must have staged an output");

    // A live writer re-creates the key with SAME-SIZE foreign bytes the moment
    // the Worker clears it: the engine's recomputation is byte-identical to
    // the recorded verdict, so the verdict replays, but the Worker's
    // stored-digest check (sha256/ETag of the live object vs the verdict)
    // proves these bytes are NOT that rendition and fails terminally rather
    // than promoting foreign content. Size equality is deliberate: it is the
    // case where only a digest check can catch the swap. The staging bytes
    // stay in the store until the Worker's own delete so the wrapper below
    // actually fires (a missing key short-circuits deleteObject).
    const foreign = new Uint8Array(produced.byteLength).fill(0xab);
    harness.bodies.delete(readyKey);
    harness.types.delete(readyKey);

    await runSystemTransaction(env, async (client) => {
      // The rendition reference leaves 'ready' before its object row is
      // deleted, or ON DELETE SET NULL violates the ready-needs-object check.
      await client.query(
        `UPDATE asset_renditions
         SET status = 'processing', object_id = NULL, failure_code = NULL,
             failure_message = NULL, failure_at = NULL, updated_at = now()
         WHERE asset_id = $1`,
        [assetId],
      );
      await client.query(
        `DELETE FROM asset_objects
         WHERE asset_id = $1 AND kind = 'rendition' AND status = 'ready'`,
        [assetId],
      );
      await client.query(
        `UPDATE asset_objects
         SET bytes = NULL, etag = NULL, sha256 = NULL, content_type = NULL,
             width = NULL, height = NULL, duration_sec = NULL,
             reserved_bytes = $2, status = 'writing',
             write_hold_until = now() + INTERVAL '1 hour', updated_at = now()
         WHERE asset_id = $1 AND r2_key = $3`,
        [assetId, imageReservationCeiling, processingKey],
      );
      await client.query(
        `UPDATE assets SET status = 'processing', updated_at = now()
         WHERE id = $1`,
        [assetId],
      );
    });
    const originalDelete = harness.storage.delete.bind(harness.storage);
    harness.storage.delete = async (key: string) => {
      await originalDelete(key);
      if (key === processingKey) {
        harness.put(processingKey, foreign, "image/jpeg");
      }
    };

    await expect(
      Effect.runPromise(processorJob.process(outboxMessage(retryEventId, assetId))),
    ).resolves.toBe("processed");

    // The foreign bytes were never promoted: no ready rendition object exists.
    expect(harness.bodies.has(readyKey)).toBe(false);
    await expect(processingState(assetId, retryEventId)).resolves.toMatchObject({
      // The verdict replayed (the engine cannot see foreign bytes), then the
      // Worker's stored-digest check rejected it: the Asset fails with the
      // checksum-mismatch evidence rather than promoting the swapped object.
      event_outcome: "succeeded",
      failure_code: "output_checksum_mismatch",
      status: "failed",
    });
  });

  it("expires a stranded completing single-PUT session and a reservation that never staged an object", async () => {
    const completingAssetId = "92000000-0000-4000-8000-000000000097";
    const completingSessionId = "92000000-0000-4000-8000-000000000098";
    const orphanAssetId = "92000000-0000-4000-8000-000000000099";
    const orphanSessionId = "92000000-0000-4000-8000-00000000009a";
    const completingKey = `staging/${organizationId}/${completingAssetId}/completing.png`;
    const orphanKey = `staging/${organizationId}/${orphanAssetId}/gone.png`;

    await runSystemTransaction(env, async (client) => {
      // A session stranded in 'completing': the checkpoint committed and the
      // request died before the final write, well past the stale-write grace.
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
            status)
         VALUES ($1, $2, $4, $3, 'image', 'Stranded completing upload',
                 'uploading')`,
        [completingAssetId, organizationId, userId, seededAlphaProfileId],
      );
      await client.query(
        `INSERT INTO asset_upload_sessions
           (id, org_id, asset_id, uploaded_by, strategy, status,
            content_type, file_size, object_key, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, 'single', 'completing',
                 'image/png', 64, $5, now() - INTERVAL '2 hours',
                 now() - INTERVAL '1 hour')`,
        [completingSessionId, organizationId, completingAssetId, userId, completingKey],
      );
      await client.query(
        `INSERT INTO asset_quota_reservations (session_id, org_id, bytes)
         VALUES ($1, $2, 64)`,
        [completingSessionId, organizationId],
      );
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, content_type,
            status, write_hold_until)
         VALUES ($1, $2, $3, 'staging', $4, 'image/png', 'writing',
                 now() + INTERVAL '30 minutes')`,
        [organizationId, completingAssetId, seededAlphaProfileId, completingKey],
      );
      // A second abandoned session whose staging row is already gone: its
      // reservation must still be released by the no-live-row branch, not held
      // forever because no staged row claimed it.
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
            status)
         VALUES ($1, $2, $4, $3, 'image', 'Reservation without staging row',
                 'uploading')`,
        [orphanAssetId, organizationId, userId, seededAlphaProfileId],
      );
      await client.query(
        `INSERT INTO asset_upload_sessions
           (id, org_id, asset_id, uploaded_by, strategy, status,
            content_type, file_size, object_key, expires_at)
         VALUES ($1, $2, $3, $4, 'single', 'uploading',
                 'image/png', 96, $5, now() - INTERVAL '2 hours')`,
        [orphanSessionId, organizationId, orphanAssetId, userId, orphanKey],
      );
      await client.query(
        `INSERT INTO asset_quota_reservations (session_id, org_id, bytes)
         VALUES ($1, $2, 96)`,
        [orphanSessionId, organizationId],
      );
    });

    const harness = objectStoreHarness();
    const processor = createAssetJobProcessor(env, harness.storage);
    const sweep = await Effect.runPromise(processor.runMaintenance());
    expect(sweep).toMatchObject({
      cleanup_errors: 0,
      expired_sessions: 2,
    });

    await runSystemTransaction(env, async (client) => {
      const state = await client.query<{
        asset_id: string;
        asset_status: string;
        failure_code: string | null;
        reservation_state: string;
        session_status: string;
      }>(
        `SELECT asset.id AS asset_id, asset.status AS asset_status,
                asset.failure_code AS failure_code,
                session.status AS session_status,
                reservation.state AS reservation_state
         FROM asset_upload_sessions AS session
         JOIN assets AS asset ON asset.id = session.asset_id
         JOIN asset_quota_reservations AS reservation
           ON reservation.session_id = session.id
         WHERE session.id IN ($1, $2)
         ORDER BY asset.id`,
        [completingSessionId, orphanSessionId],
      );
      expect(state.rows).toEqual([
        {
          asset_id: completingAssetId,
          asset_status: "failed",
          failure_code: "upload_session_expired",
          reservation_state: "released",
          session_status: "expired",
        },
        {
          asset_id: orphanAssetId,
          asset_status: "failed",
          failure_code: "upload_session_expired",
          reservation_state: "released",
          session_status: "expired",
        },
      ]);
      const staged = await client.query<{ held: boolean; status: string }>(
        `SELECT status, write_hold_until > now() AS held
         FROM asset_objects
         WHERE asset_id = $1 AND kind = 'staging'`,
        [completingAssetId],
      );
      // The session ended but its minted PUT grant still lives: the staged row
      // is claimed for the sweep while its write hold remains in force.
      expect(staged.rows[0]).toMatchObject({
        held: true,
        status: "deleting",
      });
    });
  });

  it("reclaims a superseded original after promotion once holds expire, preserving promoted and rendition bytes with exact quota settlement", async () => {
    const assetId = "92000000-0000-4000-8000-000000000093";
    const legacyKey = `legacy/${organizationId}/${assetId}/original.png`;
    const canonicalKey = `${organizationId}/${assetId}/original`;
    const renditionKey = `${organizationId}/${assetId}/rendition-image_auto_4096_long_edge`;
    const originalBody = png(320, 240);
    const originalBytes = originalBody.byteLength;

    const harness = objectStoreHarness();
    harness.put(legacyKey, originalBody, "image/png");

    await runSystemTransaction(env, async (client) => {
      await client.query(
        `INSERT INTO assets
           (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
            mime_type, file_size, status)
         VALUES ($1, $2, $4, $3, 'image', 'Migrated asset promotion test',
                 'image/png', $5, 'processing')`,
        [assetId, organizationId, userId, seededAlphaProfileId, originalBytes],
      );
      await client.query(
        `INSERT INTO asset_objects
           (org_id, asset_id, brand_profile_id, kind, r2_key, bytes,
            content_type, status, write_hold_until)
         VALUES ($1, $2, $3, 'original', $4, $5, 'image/png', 'ready',
                 now() - INTERVAL '1 hour')`,
        [organizationId, assetId, seededAlphaProfileId, legacyKey, originalBytes],
      );
    });

    const processorNs = mediaProcessorNamespace(harness);
    const processor = createAssetJobProcessor(processorEnv(processorNs), harness.storage);

    const outcome = await Effect.runPromise(
      processor.process(outboxMessage("migrated-original-test-event", assetId)),
    );
    expect(outcome).toBe("processed");

    const inventoryBefore = await assetInventory(assetId);
    const legacyOriginal = inventoryBefore.find((row) => row.r2_key === legacyKey);
    const promotedOriginal = inventoryBefore.find((row) => row.r2_key === canonicalKey);
    const readyRendition = inventoryBefore.find((row) => row.r2_key === renditionKey);

    expect(legacyOriginal).toMatchObject({
      kind: "original",
      status: "superseded",
    });
    expect(promotedOriginal).toMatchObject({
      kind: "original",
      status: "ready",
    });
    expect(readyRendition).toMatchObject({
      kind: "rendition",
      status: "ready",
    });

    // While write hold is active, maintenance leaves the superseded original untouched.
    const sweepHoldActive = await Effect.runPromise(processor.runMaintenance());
    expect(sweepHoldActive.cleanup_errors).toBe(0);
    const inventoryDuringHold = await assetInventory(assetId);
    expect(inventoryDuringHold.find((row) => row.r2_key === legacyKey)?.status).toBe("superseded");
    expect(harness.bodies.has(legacyKey)).toBe(true);

    // Now lapse writer holds on superseded objects of this asset
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE asset_objects
         SET write_hold_until = now() - INTERVAL '1 minute',
             updated_at = now()
         WHERE asset_id = $1 AND status = 'superseded'`,
        [assetId],
      );
    });

    const usageBeforeSweep = await chargedObjectBytes(organizationId);

    // Run maintenance: superseded original is claimed, deleted from store, settled to deleted.
    // Promoted original and rendition bytes remain intact! Quota settles once.
    const sweepHoldElapsed = await Effect.runPromise(processor.runMaintenance());
    expect(sweepHoldElapsed.cleanup_errors).toBe(0);

    const inventoryAfter = await assetInventory(assetId);
    expect(inventoryAfter.find((row) => row.r2_key === legacyKey)?.status).toBe("deleted");
    expect(inventoryAfter.find((row) => row.r2_key === canonicalKey)?.status).toBe("ready");
    expect(inventoryAfter.find((row) => row.r2_key === renditionKey)?.status).toBe("ready");

    expect(harness.bodies.has(legacyKey)).toBe(false);
    expect(harness.bodies.has(canonicalKey)).toBe(true);
    expect(harness.bodies.has(renditionKey)).toBe(true);

    const usageAfterSweep = await chargedObjectBytes(organizationId);
    expect(usageBeforeSweep).toBeGreaterThan(usageAfterSweep);

    // Repeated sweep: quota does not settle again, nothing is re-deleted.
    const repeatedSweep = await Effect.runPromise(processor.runMaintenance());
    expect(repeatedSweep.cleanup_errors).toBe(0);
    expect(await chargedObjectBytes(organizationId)).toBe(usageAfterSweep);
  });

  it("bounds each cleanup class across two maintenance sweeps", async () => {
    const batchSize = 55;
    const expiredAssetIds = Array.from(
      { length: batchSize },
      (_, index) => `94000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const expiredSessionIds = Array.from(
      { length: batchSize },
      (_, index) => `95000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const orphanAssetIds = Array.from(
      { length: batchSize },
      (_, index) => `96000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const expiredKeys = expiredAssetIds.map(
      (assetId) => `staging/${organizationId}/${assetId}/expired.png`,
    );
    const multipartUploadIds = expiredSessionIds.map((sessionId) => `mp-${sessionId}`);
    const staleWriteAssetId = "97000000-0000-4000-8000-000000000001";
    const terminalSessionAssetId = "97000000-0000-4000-8000-000000000004";
    const stuckAssetId = "97000000-0000-4000-8000-000000000003";
    const terminalSessionId = "97000000-0000-4000-8000-000000000002";
    const staleWriteKey = `staging/${organizationId}/${staleWriteAssetId}/stuck.png`;
    const staleForeignKey = `staging/${organizationId}/${staleWriteAssetId}/foreign.png`;
    const staleSessionKey = `staging/${organizationId}/${terminalSessionAssetId}/session.png`;
    const expiredSupersededKey = `staging/${organizationId}/${staleWriteAssetId}/superseded.png`;

    // Pin every sweep's cross-spec inputs so counters are deterministic: the
    // seeded orphan 'd8' from the shared fixture keeps its deadline parked for
    // the duration of this spec, other suites' in-flight assets cannot be
    // mistaken for stuck work, and usage reconciliation has no due orgs. Both
    // raised values are captured here and put back in the `finally` block, so
    // this spec leaves no state behind for the suites that share the database.
    const pinnedSweepInputs = await runSystemTransaction(env, async (client) => {
      const rows = await client.query<{
        id: string;
        orphan_delete_after: Date | null;
        orphaned_at: Date | null;
      }>(
        `SELECT id, orphaned_at, orphan_delete_after
           FROM assets
           WHERE orphan_delete_after IS NOT NULL
             AND id <> ALL($1::uuid[])`,
        [orphanAssetIds],
      );
      await client.query(
        `UPDATE assets
           SET orphan_delete_after = now() + INTERVAL '30 days',
               updated_at = now()
           WHERE orphan_delete_after IS NOT NULL
             AND id <> ALL($1::uuid[])`,
        [orphanAssetIds],
      );
      await client.query(
        `UPDATE assets
           SET updated_at = now()
           WHERE status IN ('processing', 'deleting')
             AND id <> $1`,
        [stuckAssetId],
      );
      // One row per organization, so capture every schedule this spec is
      // about to park and put each one back individually.
      const reconciliationBefore = await client.query<{
        next_reconciliation_at: Date;
        org_id: string;
      }>(
        `SELECT org_id, next_reconciliation_at
           FROM usage_reconciliation_state
           ORDER BY org_id`,
      );
      await client.query(
        `UPDATE usage_reconciliation_state
           SET next_reconciliation_at = now() + INTERVAL '30 days',
               lease_until = NULL`,
      );
      return {
        orphanDeadlines: rows.rows,
        reconciliationDeadlines: reconciliationBefore.rows,
      };
    });
    try {
      await runSystemTransaction(env, async (client) => {
        // One row per expired Asset. `unnest` is called with two arrays
        // because the alias needs two columns: a single-argument `unnest`
        // returns one column and `AS source(id, title)` over it is a 42P10
        // alias-arity error, not a missing cast.
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status)
           SELECT source.id::uuid, $1, $4, $2, 'image', source.title,
                  'pending_upload'
           FROM unnest($3::uuid[], $5::text[]) AS source(id, title)`,
          [
            organizationId,
            userId,
            expiredAssetIds,
            seededAlphaProfileId,
            expiredAssetIds.map((_, index) => `Automation integration cleanup expired ${index}`),
          ],
        );
        await client.query(
          `INSERT INTO asset_upload_sessions
             (id, org_id, asset_id, uploaded_by, strategy, status,
              content_type, file_size, object_key, multipart_upload_id,
              part_size, part_count, max_parallel_parts, expires_at)
           SELECT source.id::uuid, $1, source.asset_id::uuid, $2,
                  'multipart', 'created', 'image/png', 24, source.object_key,
                  source.mp_id, 8388608, 2, 4, now() - INTERVAL '2 hours'
           FROM unnest($3::text[], $4::text[], $5::text[], $6::text[])
             AS source(id, asset_id, object_key, mp_id)`,
          [
            organizationId,
            userId,
            expiredSessionIds,
            expiredAssetIds,
            expiredKeys,
            multipartUploadIds,
          ],
        );
        await client.query(
          `INSERT INTO asset_quota_reservations (session_id, org_id, bytes)
           SELECT source.id::uuid, $1, 24
           FROM unnest($2::text[]) AS source(id)`,
          [organizationId, expiredSessionIds],
        );
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, status)
           SELECT $1, source.asset_id::uuid, $2, 'staging', source.object_key,
                  'writing'
           FROM unnest($3::text[], $4::text[])
             AS source(asset_id, object_key)`,
          [organizationId, seededAlphaProfileId, expiredAssetIds, expiredKeys],
        );
        // Orphaned ready assets whose deadline elapsed claim one
        // asset.deletion.requested event each through the due-work sweep.
        // Same two-array shape as the expired rows above: one column per
        // alias name.
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status, orphaned_at, orphan_delete_after)
           SELECT source.id::uuid, $1, $4, $2, 'image', source.title,
                  'ready', now() - INTERVAL '8 days',
                  now() - INTERVAL '1 day'
           FROM unnest($3::uuid[], $5::text[]) AS source(id, title)`,
          [
            organizationId,
            userId,
            orphanAssetIds,
            seededAlphaProfileId,
            orphanAssetIds.map((_, index) => `Automation integration cleanup orphan ${index}`),
          ],
        );
        // Two abandoned in-flight writes on a failed Asset: one settles, one
        // fails its external delete and stays claimed.
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status, failure_code, failure_message, failure_retryable,
              failure_at)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration cleanup stale writes', 'failed',
                   'processing_failed', 'injected old failure', false,
                   now() - INTERVAL '25 hours')`,
          [staleWriteAssetId, organizationId, seededAlphaProfileId, userId],
        );
        await client.query(
          // Every tuple must supply all nine target columns. The two abandoned
          // writes record no writer deadline at all (NULL), which is the state
          // the claim queries treat as "no live capability can recreate these
          // bytes"; only the superseded row carries an explicitly closed hold.
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, bytes, status,
              updated_at, write_hold_until)
           VALUES ($1, $2, $3, 'staging', $4, 24, 'writing',
                   now() - INTERVAL '2 hours', NULL),
                  ($1, $2, $3, 'rendition', $5, 40, 'writing',
                   now() - INTERVAL '2 hours', NULL),
                  ($1, $2, $3, 'staging', $6, 32, 'superseded',
                   now() - INTERVAL '2 hours',
                   now() - INTERVAL '90 minutes')`,
          [
            organizationId,
            staleWriteAssetId,
            seededAlphaProfileId,
            staleWriteKey,
            staleForeignKey,
            expiredSupersededKey,
          ],
        );
        // A terminal session whose staged bytes nobody reclaimed.
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration cleanup terminal session',
                   'pending_upload')`,
          [terminalSessionAssetId, organizationId, seededAlphaProfileId, userId],
        );
        await client.query(
          `INSERT INTO asset_upload_sessions
             (id, org_id, asset_id, uploaded_by, strategy, status,
              content_type, file_size, object_key, multipart_upload_id,
              part_size, part_count, max_parallel_parts, expires_at,
              completed_at)
           VALUES ($1, $2, $3, $4, 'multipart', 'completed',
                   'image/png', 24, $5, 'mp-terminal-session', 8388608, 2, 4,
                   now() - INTERVAL '5 hours', now() - INTERVAL '6 hours')`,
          [terminalSessionId, organizationId, terminalSessionAssetId, userId, staleSessionKey],
        );
        await client.query(
          `INSERT INTO asset_objects
             (org_id, asset_id, brand_profile_id, kind, r2_key, status)
           VALUES ($1, $2, $3, 'staging', $4, 'writing')`,
          [organizationId, terminalSessionAssetId, seededAlphaProfileId, staleSessionKey],
        );
        // One genuinely stuck Asset: still 'processing' long past the grace,
        // so the sweep re-arms exactly one lifecycle event.
        await client.query(
          `INSERT INTO assets
             (id, org_id, brand_profile_id, uploaded_by, asset_type, title,
              status, updated_at)
           VALUES ($1, $2, $3, $4, 'image',
                   'Automation integration cleanup stuck', 'processing',
                   now() - INTERVAL '2 hours')`,
          [stuckAssetId, organizationId, seededAlphaProfileId, userId],
        );
      });

      const harness = objectStoreHarness();
      harness.failKeys.add(staleForeignKey);
      const processor = createAssetJobProcessor(env, harness.storage);
      await expect(Effect.runPromise(processor.runMaintenance())).resolves.toMatchObject({
        cleanup_errors: 1,
        expired_sessions: 50,
        orphan_assets_claimed: 50,
        reconciliation_events: 1,
        stale_writing_objects_deleted: 1,
        terminal_sessions_reclaimed: 1,
        usage_rows: 0,
      });
      expect(harness.multipartAborts).toHaveLength(50);

      // The second sweep reports no cleanup errors: the row whose delete
      // failed left the first sweep claimed as 'deleting', so the stale-write
      // pass never sees it again and only the release pass retries the bucket
      // delete — idempotently and silently, since the error was already
      // reported by the pass that claimed the row.
      await expect(Effect.runPromise(processor.runMaintenance())).resolves.toMatchObject({
        cleanup_errors: 0,
        expired_sessions: 5,
        orphan_assets_claimed: 5,
        reconciliation_events: 0,
        stale_writing_objects_deleted: 0,
        terminal_sessions_reclaimed: 0,
        usage_rows: 0,
      });
      expect(harness.multipartAborts).toHaveLength(55);
      // The unfinished delete is genuinely retried, not parked: the store was
      // asked to remove the key once in each claiming pass of sweep one and
      // once more by the release pass in sweep two.
      expect(
        vi.mocked(harness.storage.delete).mock.calls.filter((call) => call[0] === staleForeignKey),
      ).toHaveLength(3);

      await runSystemTransaction(env, async (client) => {
        const state = await client.query<{
          aborted_sessions: string;
          claimed_orphans: string;
          created_sessions: string;
          deleting_objects: string;
          recovery_events: string;
          stuck_failed_delete: string;
          superseded_staging_status: string;
          terminal_staging_status: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM asset_upload_sessions AS session
              JOIN assets AS asset ON asset.id = session.asset_id
              WHERE asset.title LIKE 'Automation integration cleanup expired %'
                AND session.status = 'aborted') AS aborted_sessions,
             (SELECT count(*)::text FROM asset_upload_sessions AS session
              JOIN assets AS asset ON asset.id = session.asset_id
              WHERE asset.title LIKE 'Automation integration cleanup expired %'
                AND session.status = 'created') AS created_sessions,
             (SELECT count(*)::text FROM assets
              WHERE title LIKE 'Automation integration cleanup orphan %'
                AND status = 'deleting') AS claimed_orphans,
             (SELECT count(*)::text FROM asset_objects AS object
              JOIN assets AS asset ON asset.id = object.asset_id
              WHERE asset.title LIKE 'Automation integration cleanup expired %'
                AND object.status = 'deleting') AS deleting_objects,
             (SELECT count(*)::text FROM outbox_events
              WHERE org_id = $1
                AND dedupe_key LIKE 'asset:%:lifecycle-recovery:%')
               AS recovery_events,
             (SELECT object.status FROM asset_objects AS object
              WHERE object.r2_key = $2) AS stuck_failed_delete,
             (SELECT object.status FROM asset_objects AS object
              WHERE object.r2_key = $3) AS terminal_staging_status,
             (SELECT object.status FROM asset_objects AS object
              WHERE object.r2_key = $4) AS superseded_staging_status`,
          [organizationId, staleForeignKey, staleSessionKey, expiredSupersededKey],
        );
        expect(state.rows[0]).toEqual({
          aborted_sessions: "55",
          claimed_orphans: "55",
          created_sessions: "0",
          // Every expired Asset's staged row was claimed for deletion by the
          // abort pass and then finished: `releaseStaleProcessingStaging`
          // claims `deleting` rows whose write hold already lapsed (the abort
          // closes the hold to `now()` because the multipart id is dead), and
          // its 50-row bound is never saturated across these two sweeps, so no
          // staged row is left mid-settlement. Only the row whose delete
          // genuinely fails stays claimed, below.
          deleting_objects: "0",
          recovery_events: "1",
          // A failed delete keeps the row claimed so the next sweep retries it.
          stuck_failed_delete: "deleting",
          // The superseded row passed through the deleting claim and was
          // released by the shared settlement, never directly overwritten.
          superseded_staging_status: "deleted",
          // Same reason as `deleting_objects`: the terminal session's staged
          // row was claimed in the second sweep and settled once its hold
          // lapsed, so it does not linger in `deleting` for a later pass.
          terminal_staging_status: "deleted",
        });
      });
    } finally {
      await runSystemTransaction(env, async (client) => {
        for (const row of pinnedSweepInputs.orphanDeadlines) {
          await client.query(
            `UPDATE assets
             SET orphaned_at = $2, orphan_delete_after = $3, updated_at = now()
             WHERE id = $1`,
            [row.id, row.orphaned_at, row.orphan_delete_after],
          );
        }
        // Put every schedule back exactly as it was found: another suite (or
        // the seed) owns those deadlines, so this spec parks them only for its
        // own duration.
        for (const row of pinnedSweepInputs.reconciliationDeadlines) {
          await client.query(
            `UPDATE usage_reconciliation_state
             SET next_reconciliation_at = $2::timestamptz,
                 lease_until = NULL
             WHERE org_id = $1`,
            [row.org_id, row.next_reconciliation_at],
          );
        }
        await client.query(
          `DELETE FROM outbox_events
           WHERE org_id = $1
             AND dedupe_key LIKE 'asset:%:lifecycle-recovery:%'`,
          [organizationId],
        );
      });
    }
  });

  it("reconciles bounded current-period usage and audits only corrections", async () => {
    const now = new Date("2026-07-19T14:00:00.000Z");
    const period = "2026-07";
    const original = await runSystemTransaction(env, async (client) => {
      const usage = await client.query<{
        api_calls: string;
        distributions: string;
        storage_bytes: string;
        uploads: string;
      }>(
        `SELECT uploads::text, distributions::text, api_calls::text,
                storage_bytes::text
         FROM usage_records WHERE org_id = $1 AND period = $2`,
        [organizationId, period],
      );
      await client.query(
        `UPDATE usage_records
         SET uploads = 900, distributions = 901, storage_bytes = 902
         WHERE org_id = $1 AND period = $2`,
        [organizationId, period],
      );
      await client.query(
        `UPDATE usage_reconciliation_state
         SET next_reconciliation_at = $2::timestamptz - INTERVAL '1 minute',
             lease_until = NULL
         WHERE org_id = $1`,
        [organizationId, now],
      );
      await client.query("DELETE FROM usage_corrections WHERE org_id = $1 AND period = $2", [
        organizationId,
        period,
      ]);
      return usage.rows[0]!;
    });

    const first = await reconcileDueUsage(env, { batchLimit: 100, now });
    expect(first.failed).toBe(0);
    expect(first.reconciled).toBeGreaterThanOrEqual(1);
    expect(first.corrected).toBeGreaterThanOrEqual(1);

    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        correction_count: string;
        evidence: { source: string };
        prior_usage: {
          distributions: number;
          storage_bytes: number;
          uploads: number;
        };
        reconciled_usage: {
          distributions: number;
          storage_bytes: number;
          uploads: number;
        };
        usage: {
          distributions: number;
          storage_bytes: number;
          uploads: number;
        };
      }>(
        `SELECT
           correction.prior_usage,
           correction.reconciled_usage,
           correction.evidence,
           jsonb_build_object(
             'uploads', usage.uploads,
             'distributions', usage.distributions,
             'storage_bytes', usage.storage_bytes
           ) AS usage,
           COUNT(*) OVER ()::text AS correction_count
         FROM usage_corrections AS correction
         JOIN usage_records AS usage
           ON usage.org_id = correction.org_id
          AND usage.period = correction.period
         WHERE correction.org_id = $1 AND correction.period = $2`,
        [organizationId, period],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        correction_count: "1",
        evidence: { source: "domain_rows_and_r2_verified_metadata" },
        prior_usage: {
          distributions: 901,
          storage_bytes: 902,
          uploads: 900,
        },
      });
      expect(result.rows[0]?.reconciled_usage).toMatchObject(result.rows[0]!.usage);
      await client.query(
        `UPDATE usage_reconciliation_state
         SET next_reconciliation_at = $2::timestamptz - INTERVAL '1 minute',
             lease_until = NULL
         WHERE org_id = $1`,
        [organizationId, now],
      );
    });

    const second = await reconcileDueUsage(env, { batchLimit: 100, now });
    expect(second.failed).toBe(0);
    expect(second.corrected).toBe(0);
    await runSystemTransaction(env, async (client) => {
      const corrections = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM usage_corrections
         WHERE org_id = $1 AND period = $2`,
        [organizationId, period],
      );
      expect(corrections.rows[0]?.count).toBe("1");
      await client.query(
        `UPDATE usage_records
         SET uploads = $3, distributions = $4, api_calls = $5,
             storage_bytes = $6
         WHERE org_id = $1 AND period = $2`,
        [
          organizationId,
          period,
          original.uploads,
          original.distributions,
          original.api_calls,
          original.storage_bytes,
        ],
      );
      await client.query("DELETE FROM usage_corrections WHERE org_id = $1 AND period = $2", [
        organizationId,
        period,
      ]);
    });
  });

  it("reconciles the usage-period distribution count from bounded created_at windows", async () => {
    const now = new Date("2026-07-19T14:00:00.000Z");
    const period = "2026-07";
    const orgId = "b6000000-0000-4000-8000-000000000001";
    // This test's distributions live in a throwaway workspace, so they need
    // profile-owned posts and a channel there: the composite foreign keys bind
    // each row's Post and platform account to the same Brand Profile, which
    // forbids referencing the seeded Alpha rows across organizations. One Post
    // per row because `(post_id, platform_account_id)` is unique.
    const profileId = "b8000000-0000-4000-8000-000000000001";
    const windowAssetId = "b8000000-0000-4000-8000-000000000002";
    const windowAccountId = "b8000000-0000-4000-8000-000000000003";
    const distributionIds = Array.from(
      { length: 5 },
      (_, index) => `b7000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    const postIds = distributionIds.map(
      (_, index) => `b9000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    try {
      await runSystemTransaction(env, async (client) => {
        await client.query(
          `INSERT INTO organizations (id, name, slug, plan, billing_status)
           VALUES (
             $1, 'Usage Window Studio', 'usage-window-studio', 'agency', 'active'
           )`,
          [orgId],
        );
        await client.query(
          `INSERT INTO brand_profiles (id, org_id, name, color)
           VALUES ($1, $2, 'Usage Window Brand', '#1d4ed8')`,
          [profileId, orgId],
        );
        await client.query(
          `INSERT INTO assets (id, org_id, brand_profile_id, title)
           VALUES ($1, $2, $3, 'Usage window asset')`,
          [windowAssetId, orgId, profileId],
        );
        await client.query(
          `INSERT INTO platform_accounts
             (id, org_id, brand_profile_id, platform, platform_user_id,
              access_token)
           VALUES ($1, $2, $3, 'youtube', 'usage-window-yt', 'tok')`,
          [windowAccountId, orgId, profileId],
        );
        // One distribution at each window boundary: only rows inside
        // [period start, period end) may enter the authoritative count. Each
        // row keeps its own Post carrying the same window Asset, mirroring
        // the pre-cutover asset-scoped fixture.
        const createdAts = [
          "2026-06-30T23:59:59Z",
          "2026-07-01T00:00:00Z",
          "2026-07-16T12:00:00Z",
          "2026-07-31T23:59:59Z",
          "2026-08-01T00:00:00Z",
        ];
        for (const [index, id] of distributionIds.entries()) {
          await seedDistributionPost(client, {
            assetIds: [windowAssetId],
            brandProfileId: profileId,
            orgId,
            postId: postIds[index]!,
            target: { platformAccountId: windowAccountId },
          });
          await client.query(
            `INSERT INTO distributions
               (id, org_id, brand_profile_id, post_id, platform_account_id,
                platform, status, created_at)
             VALUES ($1, $2, $3, $4, $5, 'youtube', 'published',
                     $6::timestamptz)`,
            [id, orgId, profileId, postIds[index], windowAccountId, createdAts[index]],
          );
        }
        await client.query(
          `INSERT INTO usage_reconciliation_state
             (org_id, next_reconciliation_at)
           VALUES ($1, $2::timestamptz - INTERVAL '1 minute')
           ON CONFLICT (org_id) DO UPDATE
           SET next_reconciliation_at = EXCLUDED.next_reconciliation_at,
               lease_until = NULL`,
          [orgId, now],
        );
      });

      const result = await reconcileDueUsage(env, { batchLimit: 100, now });
      expect(result.failed).toBe(0);
      expect(result.reconciled).toBeGreaterThanOrEqual(1);

      await runSystemTransaction(env, async (client) => {
        const usage = await client.query<{ distributions: string }>(
          `SELECT distributions::text FROM usage_records
           WHERE org_id = $1 AND period = $2`,
          [orgId, period],
        );
        expect(usage.rows[0]?.distributions).toBe("3");

        const corrections = await client.query<{
          reconciled_usage: { distributions: number };
        }>(
          `SELECT reconciled_usage FROM usage_corrections
           WHERE org_id = $1 AND period = $2`,
          [orgId, period],
        );
        expect(corrections.rows).toHaveLength(1);
        expect(corrections.rows[0]?.reconciled_usage.distributions).toBe(3);
      });
    } finally {
      await runSystemTransaction(env, async (client) => {
        await client.query("DELETE FROM organizations WHERE id = $1", [orgId]);
      });
    }
  });

  it("queues a missed due schedule exactly once across repeated scans", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000001";
    await runSystemTransaction(env, async (client) => {
      // The schedule claim path now keys on posts: seed the Post that
      // composes the canonical image over the seeded YouTube Channel before
      // the Distribution row can reference it.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: seededYouTubeAccountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, scheduled_at)
         VALUES (
           $1, $2, $3,
           $4,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'scheduled', now() - INTERVAL '1 day'
         )`,
        [
          distributionId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
    });

    await expect(enqueueFixtureDistributions()).resolves.toBe(1);
    await expect(enqueueFixtureDistributions()).resolves.toBe(0);
    await expect(runRelay(env, 100)).resolves.toMatchObject({
      failed: 0,
      published: expect.any(Number),
    });

    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        count: string;
        created_at: Date;
        payload: Record<string, unknown>;
        published_at: Date;
        scheduled_at: Date;
        status: string;
      }>(
        `SELECT distribution.status,
                distribution.scheduled_at,
                event.created_at,
                event.published_at,
                (SELECT COUNT(*)::text
                 FROM outbox_events
                 WHERE aggregate_id = distribution.id
                   AND topic = 'distribution.publish.requested') AS count,
                (SELECT payload
                 FROM outbox_events
                 WHERE aggregate_id = distribution.id
                   AND topic = 'distribution.publish.requested'
         LIMIT 1) AS payload
         FROM distributions AS distribution
         JOIN outbox_events AS event
           ON event.aggregate_id = distribution.id
          AND event.topic = 'distribution.publish.requested'
         WHERE distribution.id = $1`,
        [distributionId],
      );
      expect(result.rows[0]).toMatchObject({
        count: "1",
        payload: { distribution_id: distributionId, version: 1 },
        status: "queued",
      });
      const row = result.rows[0]!;
      expect(row.published_at).toBeInstanceOf(Date);
      const queueStartDelayMs = row.published_at.getTime() - row.created_at.getTime();
      const scheduledPublishingGapMs = row.published_at.getTime() - row.scheduled_at.getTime();
      expect(queueStartDelayMs).toBeGreaterThanOrEqual(0);
      expect(scheduledPublishingGapMs).toBeGreaterThanOrEqual(0);
      process.stdout.write(
        `automation_schedule_baseline ${JSON.stringify({
          queue_start_delay_ms: queueStartDelayMs,
          scheduled_publishing_gap_ms: scheduledPublishingGapMs,
        })}\n`,
      );
    });
  });

  it("claims a mixed due page with distinct source-specific outbox events", async () => {
    const scheduledId = "93000000-0000-4000-8000-000000000031";
    const retryId = "93000000-0000-4000-8000-000000000032";
    const awaitingId = "93000000-0000-4000-8000-000000000033";
    const reconciliationId = "93000000-0000-4000-8000-000000000034";
    const stalledId = "93000000-0000-4000-8000-000000000051";
    try {
      await runSystemTransaction(env, async (client) => {
        // Each row must own its Post: the unique (post_id, platform_account_id)
        // keeps five rows on the same Channel distinct only through their
        // Posts, all composing the canonical image.
        for (const distributionId of [
          scheduledId,
          retryId,
          awaitingId,
          reconciliationId,
          stalledId,
        ]) {
          await seedDistributionPost(client, {
            postId: postIdForDistribution(distributionId),
            target: { platformAccountId: seededYouTubeAccountId },
          });
        }
        await client.query(
          `INSERT INTO distributions
             (id, org_id, brand_profile_id, post_id, platform_account_id,
              platform, status, scheduled_at, attempt_count, next_attempt_at,
              failure_code, failure_retryable, error_message,
              reconciliation_attempt_count, updated_at)
           VALUES
             ($1, $6, $7,
              $8,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'scheduled', now() - INTERVAL '4 minutes', 0,
              NULL, NULL, NULL, NULL, 0, now() - INTERVAL '4 minutes'),
             ($2, $6, $7,
              $9,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'failed', NULL, 2,
              now() - INTERVAL '3 minutes', 'rate_limited', true, 'retry me', 0,
              now() - INTERVAL '3 minutes'),
             ($3, $6, $7,
              $10,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'awaiting_provider', NULL, 1,
              now() - INTERVAL '2 minutes', NULL, NULL, NULL, 1,
              now() - INTERVAL '2 minutes'),
             ($4, $6, $7,
              $11,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'needs_reconciliation', NULL, 3,
              now() - INTERVAL '1 minute', NULL, NULL, NULL, 4,
              now() - INTERVAL '1 minute'),
             ($5, $6, $7,
              $12,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'processing', NULL, 1,
              NULL, NULL, NULL, NULL, 0,
              now() - INTERVAL '6 minutes')`,
          [
            scheduledId,
            retryId,
            awaitingId,
            reconciliationId,
            stalledId,
            organizationId,
            seededAlphaProfileId,
            postIdForDistribution(scheduledId),
            postIdForDistribution(retryId),
            postIdForDistribution(awaitingId),
            postIdForDistribution(reconciliationId),
            postIdForDistribution(stalledId),
          ],
        );
      });

      await expect(enqueueFixtureDistributions(5)).resolves.toBe(5);
      await expect(enqueueFixtureDistributions(5)).resolves.toBe(0);

      await runSystemTransaction(env, async (client) => {
        const result = await client.query<{
          dedupe_key: string;
          failure_code: string | null;
          failure_retryable: boolean | null;
          id: string;
          next_attempt_at: Date | null;
          payload: Record<string, unknown>;
          status: string;
          topic: string;
        }>(
          `SELECT distribution.id, distribution.status,
                  distribution.next_attempt_at, distribution.failure_code,
                  distribution.failure_retryable, event.topic,
                  event.dedupe_key, event.payload
           FROM distributions AS distribution
           JOIN outbox_events AS event
             ON event.aggregate_id = distribution.id
           WHERE distribution.id IN ($1, $2, $3, $4, $5)
           ORDER BY distribution.id`,
          [scheduledId, retryId, awaitingId, reconciliationId, stalledId],
        );
        expect(result.rows).toEqual([
          {
            dedupe_key: `distribution:${scheduledId}:publish`,
            failure_code: null,
            failure_retryable: null,
            id: scheduledId,
            next_attempt_at: null,
            payload: { distribution_id: scheduledId, version: 1 },
            status: "queued",
            topic: "distribution.publish.requested",
          },
          {
            dedupe_key: `distribution:${retryId}:automatic-retry:3`,
            failure_code: null,
            failure_retryable: null,
            id: retryId,
            next_attempt_at: null,
            payload: { distribution_id: retryId, version: 1 },
            status: "queued",
            topic: "distribution.publish.requested",
          },
          {
            dedupe_key: `distribution:${awaitingId}:reconcile:2`,
            failure_code: null,
            failure_retryable: null,
            id: awaitingId,
            next_attempt_at: null,
            payload: { distribution_id: awaitingId, version: 1 },
            status: "awaiting_provider",
            topic: "distribution.reconcile.requested",
          },
          {
            dedupe_key: `distribution:${reconciliationId}:reconcile:5`,
            failure_code: null,
            failure_retryable: null,
            id: reconciliationId,
            next_attempt_at: null,
            payload: { distribution_id: reconciliationId, version: 1 },
            status: "needs_reconciliation",
            topic: "distribution.reconcile.requested",
          },
          {
            dedupe_key: `distribution:${stalledId}:reconcile:1`,
            failure_code: "provider_outcome_ambiguous",
            failure_retryable: false,
            id: stalledId,
            next_attempt_at: null,
            payload: { distribution_id: stalledId, version: 1 },
            status: "needs_reconciliation",
            topic: "distribution.reconcile.requested",
          },
        ]);
      });
    } finally {
      await runSystemTransaction(env, async (client) => {
        await client.query(`DELETE FROM outbox_events WHERE aggregate_id IN ($1, $2, $3, $4, $5)`, [
          scheduledId,
          retryId,
          awaitingId,
          reconciliationId,
          stalledId,
        ]);
        await client.query(`DELETE FROM distributions WHERE id IN ($1, $2, $3, $4, $5)`, [
          scheduledId,
          retryId,
          awaitingId,
          reconciliationId,
          stalledId,
        ]);
      });
    }
  });

  it("claims stalled processing distributions beyond the grace period while protecting active ones", async () => {
    const stalledId = "93000000-0000-4000-8000-000000000052";
    const activeId = "93000000-0000-4000-8000-000000000053";
    try {
      await runSystemTransaction(env, async (client) => {
        // Two stalled-or-active rows on one Channel need two Posts under the
        // (post_id, platform_account_id) uniqueness, each composing the
        // canonical image.
        for (const distributionId of [stalledId, activeId]) {
          await seedDistributionPost(client, {
            postId: postIdForDistribution(distributionId),
            target: { platformAccountId: seededYouTubeAccountId },
          });
        }
        await client.query(
          `INSERT INTO distributions
             (id, org_id, brand_profile_id, post_id, platform_account_id,
              platform, status, attempt_count, updated_at)
           VALUES
             ($1, $3, $4, $5,
              '50000000-0000-4000-8000-000000000001', 'youtube', 'processing',
              1, now() - INTERVAL '6 minutes'),
             ($2, $3, $4, $6,
              '50000000-0000-4000-8000-000000000001', 'youtube', 'processing',
              1, now() - INTERVAL '1 minute')`,
          [
            stalledId,
            activeId,
            organizationId,
            seededAlphaProfileId,
            postIdForDistribution(stalledId),
            postIdForDistribution(activeId),
          ],
        );
      });

      await expect(enqueueFixtureDistributions(10)).resolves.toBe(1);

      await runSystemTransaction(env, async (client) => {
        const distributions = await client.query<{
          id: string;
          status: string;
        }>(`SELECT id, status FROM distributions WHERE id IN ($1, $2) ORDER BY id`, [
          stalledId,
          activeId,
        ]);
        expect(distributions.rows).toEqual([
          { id: stalledId, status: "needs_reconciliation" },
          { id: activeId, status: "processing" },
        ]);

        const events = await client.query<{
          aggregate_id: string;
          dedupe_key: string;
          topic: string;
        }>(
          `SELECT aggregate_id, dedupe_key, topic FROM outbox_events WHERE aggregate_id IN ($1, $2)`,
          [stalledId, activeId],
        );
        expect(events.rows).toEqual([
          {
            aggregate_id: stalledId,
            dedupe_key: `distribution:${stalledId}:reconcile:1`,
            topic: "distribution.reconcile.requested",
          },
        ]);
      });
    } finally {
      await runSystemTransaction(env, async (client) => {
        await client.query(`DELETE FROM outbox_events WHERE aggregate_id IN ($1, $2)`, [
          stalledId,
          activeId,
        ]);
        await client.query(`DELETE FROM distributions WHERE id IN ($1, $2)`, [stalledId, activeId]);
      });
    }
  });

  it("recovers a stalled distribution after a queue handler crash without DLQ intervention", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000054";
    const initialEventId = "automation-integration-stalled-initial";
    const retryEventId = "automation-integration-stalled-retry";
    try {
      await runSystemTransaction(env, async (client) => {
        // The publish attempt freezes its composition at claim, so the Post
        // must carry the canonical image attachment the pre-cutover
        // asset-scoped fixture implied.
        await seedDistributionPost(client, {
          postId: postIdForDistribution(distributionId),
          target: { platformAccountId: seededYouTubeAccountId },
        });
        await client.query(
          `INSERT INTO distributions
             (id, org_id, brand_profile_id, post_id, platform_account_id,
              platform, status)
           VALUES (
             $1, $2, $3,
             $4,
             '50000000-0000-4000-8000-000000000001',
             'youtube', 'queued'
           )`,
          [
            distributionId,
            organizationId,
            seededAlphaProfileId,
            postIdForDistribution(distributionId),
          ],
        );
      });

      let transactionCalls = 0;
      const failingOutcomeTransaction: typeof withSystemTransactionEffect = <A, E, R>(
        automationEnv: AutomationEnv,
        operation: (client: EffectTransactionClient) => Effect.Effect<A, E, R>,
      ) => {
        transactionCalls += 1;
        if (transactionCalls === 2) {
          // Prepare (call 1) committed 'processing' and attempt_count = 1 to real Postgres.
          // Outcome recording (call 2) dies to simulate an unhandled queue worker crash during execution.
          return Effect.die(new Error("unhandled queue worker crash"));
        }
        return withSystemTransactionEffect(automationEnv, operation);
      };

      const initialMessage = {
        ...outboxMessage(initialEventId, distributionId, "distribution.publish.requested"),
        payload: { distribution_id: distributionId },
      } as const;

      // First attempt fails during outcome recording, leaving durable processing state
      await expect(
        Effect.runPromise(
          processDistributionMessage(env, initialMessage, {
            decryptToken: async (stored) => `decrypted:${stored}`,
            mediaFor: async (request: { contentType: string; fileSize: number }) => ({
              contentType: request.contentType,
              fileSize: request.fileSize,
              mode: "remote_ingest" as const,
              url: "https://r2.example/signed-object?signature=private",
            }),
            providerRegistry: youtubeRegistry(
              vi.fn(async () => ({
                outcome: "confirmed_success" as const,
                providerOperationId: "initial-op-1",
                providerPostId: "initial-post-1",
                providerUrl: "https://provider.example/posts/initial-1",
              })),
            ),
            transaction: failingOutcomeTransaction,
          }),
        ),
      ).rejects.toThrow("unhandled queue worker crash");

      await runSystemTransaction(env, async (client) => {
        const row = await client.query<{
          status: string;
          attempt_count: number;
        }>("SELECT status, attempt_count FROM distributions WHERE id = $1", [distributionId]);
        expect(row.rows[0]).toEqual({ attempt_count: 1, status: "processing" });
      });

      // Within grace period, scheduled scan does NOT pick it up
      await expect(enqueueFixtureDistributions()).resolves.toBe(0);

      // Simulate time advancing past the grace period
      await runSystemTransaction(env, (client) =>
        client.query(
          "UPDATE distributions SET updated_at = now() - INTERVAL '6 minutes' WHERE id = $1",
          [distributionId],
        ),
      );

      // Stalled due scan picks it up and arms reconciliation — never a fresh
      // publish command, since the provider side effect is unknown (#256).
      await expect(enqueueFixtureDistributions()).resolves.toBe(1);

      await runSystemTransaction(env, async (client) => {
        const row = await client.query<{
          failure_code: string | null;
          status: string;
        }>("SELECT status, failure_code FROM distributions WHERE id = $1", [distributionId]);
        expect(row.rows[0]).toEqual({
          failure_code: "provider_outcome_ambiguous",
          status: "needs_reconciliation",
        });
        const events = await client.query<{
          dedupe_key: string;
          topic: string;
        }>(
          `SELECT dedupe_key, topic FROM outbox_events
           WHERE aggregate_id = $1`,
          [distributionId],
        );
        expect(events.rows).toEqual([
          {
            dedupe_key: `distribution:${distributionId}:reconcile:1`,
            topic: "distribution.reconcile.requested",
          },
        ]);
      });

      // Relay the reconcile trigger outbox event
      send.mockClear();
      youtubePublishSend.mockClear();
      await expect(runRelay(env, 10)).resolves.toMatchObject({
        failed: 0,
        published: 1,
      });

      // The reconciled message resolves through the provider lookup, never a
      // second publish. The crash dropped the operation identity before it was
      // persisted, so the lookup has no evidence and the row lands in a
      // terminal, actionable failure instead of reposting.
      const lookupPublication = vi.fn(async () => ({
        state: "not_found" as const,
      }));
      const republish = vi.fn(async () => ({
        outcome: "confirmed_success" as const,
        providerOperationId: "must-not-run",
        providerPostId: "must-not-run",
      }));

      const reconcileMessage = {
        ...outboxMessage(retryEventId, distributionId, "distribution.reconcile.requested"),
        payload: { distribution_id: distributionId },
      } as const;

      await expect(
        Effect.runPromise(
          processDistributionMessage(env, reconcileMessage, {
            decryptToken: async (stored) => `decrypted:${stored}`,
            providerRegistry: youtubeRegistry(republish, undefined, lookupPublication),
          }),
        ),
      ).resolves.toBe("processed");

      expect(republish).not.toHaveBeenCalled();
      expect(lookupPublication).not.toHaveBeenCalled();
      await runSystemTransaction(env, async (client) => {
        const result = await client.query<{
          attempt_count: number;
          failure_code: string | null;
          failure_retryable: boolean | null;
          next_attempt_at: Date | null;
          status: string;
        }>(
          `SELECT status, attempt_count, failure_code, failure_retryable,
                  next_attempt_at
           FROM distributions WHERE id = $1`,
          [distributionId],
        );
        expect(result.rows[0]).toEqual({
          attempt_count: 1,
          failure_code: "provider_lookup_evidence_unavailable",
          failure_retryable: false,
          next_attempt_at: null,
          status: "failed",
        });
      });
    } finally {
      await runSystemTransaction(env, async (client) => {
        await client.query(`DELETE FROM outbox_events WHERE aggregate_id = $1`, [distributionId]);
        await client.query(`DELETE FROM provider_operations WHERE distribution_id = $1`, [
          distributionId,
        ]);
        await client.query(`DELETE FROM async_job_events WHERE event_key IN ($1, $2)`, [
          `outbox:${initialEventId}`,
          `outbox:${retryEventId}`,
        ]);
        await client.query(`DELETE FROM distributions WHERE id = $1`, [distributionId]);
      });
    }
  });

  it("makes reschedule and due-claim outcomes mutually exclusive", async () => {
    const rescheduleWinsId = "93000000-0000-4000-8000-000000000002";
    const claimWinsId = "93000000-0000-4000-8000-000000000003";
    await runSystemTransaction(env, async (client) => {
      // Two scheduled rows on the same Channel need distinct Posts; each
      // composes the canonical image exactly like the old asset fixture.
      for (const distributionId of [rescheduleWinsId, claimWinsId]) {
        await seedDistributionPost(client, {
          postId: postIdForDistribution(distributionId),
          target: { platformAccountId: seededYouTubeAccountId },
        });
      }
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, scheduled_at)
         VALUES
           ($1, $3, $4,
            $5,
            '50000000-0000-4000-8000-000000000001',
            'youtube', 'scheduled', now() - INTERVAL '1 minute'),
           ($2, $3, $4,
            $6,
            '50000000-0000-4000-8000-000000000001',
            'youtube', 'scheduled', now() - INTERVAL '1 minute')`,
        [
          rescheduleWinsId,
          claimWinsId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(rescheduleWinsId),
          postIdForDistribution(claimWinsId),
        ],
      );
    });

    const rescheduled = await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET scheduled_at = now() + INTERVAL '1 day', updated_at = now()
         WHERE id = $1 AND status = 'scheduled'
         RETURNING id`,
        [rescheduleWinsId],
      ),
    );
    expect(rescheduled.rowCount).toBe(1);

    await expect(enqueueFixtureDistributions()).resolves.toBe(1);

    const staleReschedule = await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET scheduled_at = now() + INTERVAL '2 days', updated_at = now()
         WHERE id = $1 AND status = 'scheduled'
         RETURNING id`,
        [claimWinsId],
      ),
    );
    expect(staleReschedule.rowCount).toBe(0);

    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        id: string;
        outbox_count: string;
        status: string;
      }>(
        `SELECT distribution.id,
                distribution.status,
                COUNT(event.id)::text AS outbox_count
         FROM distributions AS distribution
         LEFT JOIN outbox_events AS event
           ON event.aggregate_id = distribution.id
          AND event.topic = 'distribution.publish.requested'
         WHERE distribution.id IN ($1, $2)
         GROUP BY distribution.id, distribution.status
         ORDER BY distribution.id`,
        [rescheduleWinsId, claimWinsId],
      );
      expect(result.rows).toEqual([
        {
          id: rescheduleWinsId,
          outbox_count: "0",
          status: "scheduled",
        },
        { id: claimWinsId, outbox_count: "1", status: "queued" },
      ]);
    });
  });

  it("recovers unsent beyond-horizon and overdue lost distributions without duplicating active work", async () => {
    const beyondHorizonId = "93000000-0000-4000-8000-000000000061";
    const overdueLostId = "93000000-0000-4000-8000-000000000062";
    const activePendingId = "93000000-0000-4000-8000-000000000063";
    const activeLeasedId = "93000000-0000-4000-8000-000000000064";
    const futureProtectedId = "93000000-0000-4000-8000-000000000065";
    const testIds = [
      beyondHorizonId,
      overdueLostId,
      activePendingId,
      activeLeasedId,
      futureProtectedId,
    ];

    try {
      await runSystemTransaction(env, async (client) => {
        // Five scheduled rows on the seeded Channel need five Posts under the
        // (post_id, platform_account_id) uniqueness; each composes the
        // canonical image like the old asset fixture.
        for (const distributionId of testIds) {
          await seedDistributionPost(client, {
            postId: postIdForDistribution(distributionId),
            target: { platformAccountId: seededYouTubeAccountId },
          });
        }
        await client.query(
          `INSERT INTO distributions
             (id, org_id, brand_profile_id, post_id, platform_account_id,
              platform, status, scheduled_at, updated_at)
           VALUES
             ($1, $6, $7,
              $8,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'scheduled', now() + INTERVAL '12 hours', now()),
             ($2, $6, $7,
              $9,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'scheduled', now() - INTERVAL '10 minutes', now() - INTERVAL '10 minutes'),
             ($3, $6, $7,
              $10,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'scheduled', now() - INTERVAL '10 minutes', now() - INTERVAL '10 minutes'),
             ($4, $6, $7,
              $11,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'scheduled', now() - INTERVAL '10 minutes', now() - INTERVAL '10 minutes'),
             ($5, $6, $7,
              $12,
              '50000000-0000-4000-8000-000000000001',
              'youtube', 'scheduled', now() + INTERVAL '2 hours', now())`,
          [
            beyondHorizonId,
            overdueLostId,
            activePendingId,
            activeLeasedId,
            futureProtectedId,
            organizationId,
            seededAlphaProfileId,
            postIdForDistribution(beyondHorizonId),
            postIdForDistribution(overdueLostId),
            postIdForDistribution(activePendingId),
            postIdForDistribution(activeLeasedId),
            postIdForDistribution(futureProtectedId),
          ],
        );

        // Pre-create outbox events:
        // overdueLostId: prior published event whose delivery was lost
        // activePendingId: active pending event
        // activeLeasedId: active leased event
        // futureProtectedId: active published event for future instant
        await client.query(
          `INSERT INTO outbox_events
             (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload, state, published_at)
           VALUES
             ($2, 'distribution.publish.requested', 'distribution', $1,
              (SELECT concat('distribution:', id::text, ':distribution.publish.requested:at:', floor(extract(epoch from scheduled_at) * 1000)::bigint::text) FROM distributions WHERE id = $1),
              jsonb_build_object('distribution_id', $1, 'version', 1),
              'published', now() - INTERVAL '10 minutes')`,
          [overdueLostId, organizationId],
        );
        await client.query(
          `INSERT INTO outbox_events
             (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload, state)
           VALUES
             ($2, 'distribution.publish.requested', 'distribution', $1,
              (SELECT concat('distribution:', id::text, ':distribution.publish.requested:at:', floor(extract(epoch from scheduled_at) * 1000)::bigint::text) FROM distributions WHERE id = $1),
              jsonb_build_object('distribution_id', $1, 'version', 1),
              'pending')`,
          [activePendingId, organizationId],
        );
        await client.query(
          `INSERT INTO outbox_events
             (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload, state)
           VALUES
             ($2, 'distribution.publish.requested', 'distribution', $1,
              (SELECT concat('distribution:', id::text, ':distribution.publish.requested:at:', floor(extract(epoch from scheduled_at) * 1000)::bigint::text) FROM distributions WHERE id = $1),
              jsonb_build_object('distribution_id', $1, 'version', 1),
              'leased')`,
          [activeLeasedId, organizationId],
        );
        await client.query(
          `INSERT INTO outbox_events
             (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload, state, published_at)
           VALUES
             ($2, 'distribution.publish.requested', 'distribution', $1,
              (SELECT concat('distribution:', id::text, ':distribution.publish.requested:at:', floor(extract(epoch from scheduled_at) * 1000)::bigint::text) FROM distributions WHERE id = $1),
              jsonb_build_object('distribution_id', $1, 'version', 1),
              'published', now())`,
          [futureProtectedId, organizationId],
        );
      });

      await Effect.runPromise(sweepDueDistributions(env));

      await runSystemTransaction(env, async (client) => {
        // beyondHorizonId: exactly 1 new pending event emitted with instant dedupe key
        const beyondHorizonEvents = await client.query<{
          dedupe_key: string;
          payload: { distribution_id: string; version: number };
          state: string;
          topic: string;
        }>(
          `SELECT dedupe_key, payload, state, topic
           FROM outbox_events
           WHERE aggregate_id = $1
           ORDER BY created_at`,
          [beyondHorizonId],
        );
        expect(beyondHorizonEvents.rows).toHaveLength(1);
        expect(beyondHorizonEvents.rows[0]).toMatchObject({
          payload: { distribution_id: beyondHorizonId, version: 1 },
          state: "pending",
          topic: "distribution.publish.requested",
        });
        expect(beyondHorizonEvents.rows[0]?.dedupe_key).toMatch(
          new RegExp(
            `^distribution:${beyondHorizonId}:distribution\\.publish\\.requested:at:\\d+$`,
          ),
        );

        // overdueLostId: 2 events total (original published + new recovery event with :recovery suffix)
        const overdueLostEvents = await client.query<{
          dedupe_key: string;
          payload: { distribution_id: string; version: number };
          state: string;
          topic: string;
        }>(
          `SELECT dedupe_key, payload, state, topic
           FROM outbox_events
           WHERE aggregate_id = $1
           ORDER BY created_at`,
          [overdueLostId],
        );
        expect(overdueLostEvents.rows).toHaveLength(2);
        expect(overdueLostEvents.rows[0]?.state).toBe("published");
        expect(overdueLostEvents.rows[1]).toMatchObject({
          payload: { distribution_id: overdueLostId, version: 1 },
          state: "pending",
          topic: "distribution.publish.requested",
        });
        expect(overdueLostEvents.rows[1]?.dedupe_key).toMatch(
          new RegExp(
            `^distribution:${overdueLostId}:distribution\\.publish\\.requested:at:\\d+:recovery:\\d+$`,
          ),
        );

        // activePendingId: unchanged, exactly 1 event (no duplicate created)
        const activePendingEvents = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM outbox_events WHERE aggregate_id = $1`,
          [activePendingId],
        );
        expect(activePendingEvents.rows[0]?.count).toBe("1");

        // activeLeasedId: unchanged, exactly 1 event (no duplicate created)
        const activeLeasedEvents = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM outbox_events WHERE aggregate_id = $1`,
          [activeLeasedId],
        );
        expect(activeLeasedEvents.rows[0]?.count).toBe("1");

        // futureProtectedId: unchanged, exactly 1 event (no duplicate created)
        const futureProtectedEvents = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM outbox_events WHERE aggregate_id = $1`,
          [futureProtectedId],
        );
        expect(futureProtectedEvents.rows[0]?.count).toBe("1");

        // Durable distributions state: all 5 remain 'scheduled'
        const distributionsState = await client.query<{
          id: string;
          status: string;
        }>(
          `SELECT id, status
           FROM distributions
           WHERE id = ANY($1::uuid[])
           ORDER BY id`,
          [testIds],
        );
        expect(distributionsState.rows).toEqual([
          { id: beyondHorizonId, status: "scheduled" },
          { id: overdueLostId, status: "scheduled" },
          { id: activePendingId, status: "scheduled" },
          { id: activeLeasedId, status: "scheduled" },
          { id: futureProtectedId, status: "scheduled" },
        ]);
      });

      await Effect.runPromise(sweepDueDistributions(env));

      await runSystemTransaction(env, async (client) => {
        const totalEvents = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM outbox_events
           WHERE aggregate_id = ANY($1::uuid[])`,
          [testIds],
        );
        expect(totalEvents.rows[0]?.count).toBe("6");
      });
    } finally {
      await runSystemTransaction(env, async (client) => {
        await client.query(`DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])`, [
          testIds,
        ]);
        await client.query(`DELETE FROM distributions WHERE id = ANY($1::uuid[])`, [testIds]);
      });
    }
  });

  it("keeps due retry and reconciliation work retryable when outbox insertion dedupes", async () => {
    const retryId = "93000000-0000-4000-8000-000000000036";
    const reconciliationId = "93000000-0000-4000-8000-000000000037";
    await runSystemTransaction(env, async (client) => {
      // The retry and reconciliation rows share one Channel, so each needs
      // its own Post composing the canonical image.
      for (const distributionId of [retryId, reconciliationId]) {
        await seedDistributionPost(client, {
          postId: postIdForDistribution(distributionId),
          target: { platformAccountId: seededYouTubeAccountId },
        });
      }
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, attempt_count, next_attempt_at, failure_code,
            failure_retryable, error_message, reconciliation_attempt_count)
         VALUES
           ($1, $3, $4,
            $5,
            '50000000-0000-4000-8000-000000000001',
            'youtube', 'failed', 2, now() - INTERVAL '1 minute',
            'rate_limited', true, 'retry me', 0),
           ($2, $3, $4,
            $6,
            '50000000-0000-4000-8000-000000000001',
            'youtube', 'awaiting_provider', 1, now() - INTERVAL '1 minute',
            NULL, NULL, NULL, 1)`,
        [
          retryId,
          reconciliationId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(retryId),
          postIdForDistribution(reconciliationId),
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
           (org_id, topic, aggregate_type, aggregate_id, dedupe_key, payload)
         VALUES
           ($1::uuid, 'distribution.publish.requested', 'distribution', $2::uuid, $3,
            jsonb_build_object('distribution_id', $2::text, 'version', 1)),
           ($1::uuid, 'distribution.reconcile.requested', 'distribution', $4::uuid, $5,
            jsonb_build_object('distribution_id', $4::text, 'version', 1))`,
        [
          organizationId,
          retryId,
          `distribution:${retryId}:automatic-retry:3`,
          reconciliationId,
          `distribution:${reconciliationId}:reconcile:2`,
        ],
      );
    });

    await expect(enqueueFixtureDistributions(2)).resolves.toBe(0);
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        failure_code: string | null;
        failure_retryable: boolean | null;
        id: string;
        next_attempt_at: Date | null;
        status: string;
      }>(
        `SELECT id, status, next_attempt_at, failure_code, failure_retryable
         FROM distributions
         WHERE id IN ($1, $2)
         ORDER BY id`,
        [retryId, reconciliationId],
      );
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toMatchObject({
        failure_code: "rate_limited",
        failure_retryable: true,
        id: retryId,
        status: "failed",
      });
      expect(result.rows[0]!.next_attempt_at).toBeInstanceOf(Date);
      expect(result.rows[1]).toMatchObject({
        failure_code: null,
        failure_retryable: null,
        id: reconciliationId,
        status: "awaiting_provider",
      });
      expect(result.rows[1]!.next_attempt_at).toBeInstanceOf(Date);
    });
  });

  it("processes a delayed unavailable-provider delivery once across duplicate delivery", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000004";
    const eventId = "automation-integration-distribution";
    await runSystemTransaction(env, async (client) => {
      // The claim resolves media through the Post, so the queued row needs a
      // Post composing the canonical image over the seeded YouTube Channel.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: seededYouTubeAccountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, next_attempt_at)
         VALUES (
           $1, $2, $3,
           $4,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'queued', now() - INTERVAL '1 day'
         )`,
        [
          distributionId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
    });
    const message = {
      ...outboxMessage(eventId, distributionId, "distribution.publish.requested"),
      attempt: 9,
      payload: { distribution_id: distributionId },
    } as const;

    await expect(Effect.runPromise(processDistributionMessage(env, message))).resolves.toBe(
      "processed",
    );
    await expect(Effect.runPromise(processDistributionMessage(env, message))).resolves.toBe(
      "skipped",
    );
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        event_outcome: string;
        failure_code: string;
        failure_retryable: boolean;
        operation_count: string;
        status: string;
      }>(
        `SELECT distribution.status,
                distribution.failure_code,
                distribution.failure_retryable,
                event.outcome AS event_outcome,
                COUNT(operation.id)::text AS operation_count
         FROM distributions AS distribution
         JOIN async_job_events AS event ON event.event_key = $2
         LEFT JOIN provider_operations AS operation
           ON operation.distribution_id = distribution.id
          AND operation.idempotency_key = $3
         WHERE distribution.id = $1
         GROUP BY distribution.id, event.outcome`,
        [distributionId, `outbox:${eventId}`, `queue:${eventId}`],
      );
      expect(result.rows[0]).toEqual({
        event_outcome: "succeeded",
        failure_code: "provider_unavailable",
        failure_retryable: false,
        operation_count: "1",
        status: "failed",
      });
    });
  });

  it("schedules only bounded safe provider retries with provider backoff", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000008";
    await runSystemTransaction(env, async (client) => {
      // The rate-limited publish still claims and freezes its composition, so
      // the queued row's Post must carry the canonical image attachment.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: seededYouTubeAccountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status)
         VALUES (
           $1, $2, $3,
           $4,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'queued'
         )`,
        [
          distributionId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
    });
    const publish = vi.fn(async () => {
      throw new ProviderAdapterError(
        classifyProviderFailure({
          code: "rate_limited",
          retryAfterSeconds: 30,
          status: 429,
        }),
      );
    });
    const dependencies = {
      decryptToken: async (stored: string) => stored,
      mediaFor: async (request: { contentType: string; fileSize: number }) => ({
        contentType: request.contentType,
        fileSize: request.fileSize,
        mode: "remote_ingest" as const,
        url: "https://r2.example/signed-object",
      }),
      providerRegistry: youtubeRegistry(publish),
      random: () => 1,
    };
    const firstMessage = {
      ...outboxMessage(
        "automation-integration-provider-rate-limit-1",
        distributionId,
        "distribution.publish.requested",
      ),
      payload: { distribution_id: distributionId },
    } as const;

    await expect(
      Effect.runPromise(processDistributionMessage(env, firstMessage, dependencies)),
    ).resolves.toBe("processed");
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        attempt_count: number;
        failure_retryable: boolean;
        retry_in_seconds: number;
        status: string;
      }>(
        `SELECT status, attempt_count, failure_retryable,
                EXTRACT(EPOCH FROM (next_attempt_at - now()))::integer
                  AS retry_in_seconds
         FROM distributions WHERE id = $1`,
        [distributionId],
      );
      expect(result.rows[0]).toMatchObject({
        attempt_count: 1,
        failure_retryable: true,
        status: "failed",
      });
      expect(result.rows[0]!.retry_in_seconds).toBeGreaterThanOrEqual(28);
      expect(result.rows[0]!.retry_in_seconds).toBeLessThanOrEqual(30);
    });
    await expect(enqueueFixtureDistributions()).resolves.toBe(0);

    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET next_attempt_at = now() - INTERVAL '1 second'
         WHERE id = $1`,
        [distributionId],
      ),
    );
    await expect(enqueueFixtureDistributions()).resolves.toBe(1);
    await expect(enqueueFixtureDistributions()).resolves.toBe(0);
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        dedupe_key: string;
        failure_code: string | null;
        next_attempt_at: Date | null;
        status: string;
      }>(
        `SELECT distribution.status, distribution.failure_code,
                distribution.next_attempt_at, event.dedupe_key
         FROM distributions AS distribution
         JOIN outbox_events AS event
           ON event.aggregate_id = distribution.id
          AND event.topic = 'distribution.publish.requested'
         WHERE distribution.id = $1`,
        [distributionId],
      );
      expect(result.rows).toEqual([
        {
          dedupe_key: `distribution:${distributionId}:automatic-retry:2`,
          failure_code: null,
          next_attempt_at: null,
          status: "queued",
        },
      ]);
      await client.query("UPDATE distributions SET attempt_count = 4 WHERE id = $1", [
        distributionId,
      ]);
      await client.query(
        "DELETE FROM rate_limit_budgets WHERE platform = 'youtube' AND account_id = 'local-youtube-alpha'",
      );
    });

    const finalMessage = {
      ...firstMessage,
      event_id: "automation-integration-provider-rate-limit-5",
    };
    await expect(
      Effect.runPromise(processDistributionMessage(env, finalMessage, dependencies)),
    ).resolves.toBe("processed");
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        attempt_count: number;
        failure_retryable: boolean;
        next_attempt_at: Date | null;
        status: string;
      }>(
        `SELECT status, attempt_count, failure_retryable, next_attempt_at
         FROM distributions WHERE id = $1`,
        [distributionId],
      );
      expect(result.rows[0]).toEqual({
        attempt_count: 5,
        failure_retryable: true,
        next_attempt_at: null,
        status: "failed",
      });
      await client.query("DELETE FROM rate_limit_budgets");
    });
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("publishes through an accepted adapter and commits provider evidence atomically", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000005";
    const eventId = "automation-integration-provider-success";
    await runSystemTransaction(env, async (client) => {
      // The published caption comes from schedule-time overrides frozen on the
      // Distribution; the saved target mirrors them so the fixture matches the
      // state the schedule path would have left behind.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: {
          descriptionOverride: "Release description",
          hashtags: ["launch"],
          platformAccountId: seededYouTubeAccountId,
          titleOverride: "Release title",
        },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, title_override, description_override, hashtags)
         VALUES (
           $1, $2, $3,
           $4,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'queued', 'Release title', 'Release description',
           ARRAY['launch']::text[]
         )`,
        [
          distributionId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
    });
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerOperationId: "operation-1",
      providerPostId: "post-1",
      providerUrl: "https://provider.example/posts/1?access_token=must-not-persist",
    }));
    const registry = youtubeRegistry(publish);
    const message = {
      ...outboxMessage(eventId, distributionId, "distribution.publish.requested"),
      payload: { distribution_id: distributionId },
    } as const;

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, message, {
          decryptToken: async (stored) => `decrypted:${stored}`,
          mediaFor: async (request) => ({
            contentType: request.contentType,
            fileSize: request.fileSize,
            mode: "remote_ingest",
            url: "https://r2.example/signed-object?signature=private",
          }),
          providerRegistry: registry,
        }),
      ),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(
        processDistributionMessage(env, message, {
          decryptToken: async (stored) => `decrypted:${stored}`,
          providerRegistry: registry,
        }),
      ),
    ).resolves.toBe("skipped");

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: `queue:${eventId}` }),
      {
        accessToken: "decrypted:local-only-not-a-provider-credential",
        accountId: "local-youtube-alpha",
      },
      expect.objectContaining({
        caption: "Release title\n\nRelease description\n\n#launch",
        idempotencyKey: `queue:${eventId}`,
        // `PublishInput.media` is the Post's ORDERED attachment list, so the
        // frozen image rides at index 0 rather than as a single sibling object
        // (packages/providers/src/types.ts: `media: ProviderMedia[]`, index =
        // attachment position). One attached Asset therefore means exactly one
        // remote_ingest descriptor here, and its verified geometry travels on
        // the item's own `metadata`, not beside it.
        media: [expect.objectContaining({ mode: "remote_ingest" })],
      }),
    );
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        analytics_next_sync_at: Date;
        comments_next_sync_at: Date;
        event_outcome: string;
        operation_status: string;
        platform_post_id: string;
        platform_url: string;
        provider_operation_id: string;
        status: string;
      }>(
        `SELECT distribution.status, distribution.platform_post_id,
                distribution.platform_url, distribution.provider_operation_id,
                distribution.analytics_next_sync_at,
                distribution.comments_next_sync_at,
                operation.status AS operation_status,
                event.outcome AS event_outcome
         FROM distributions AS distribution
         JOIN provider_operations AS operation
           ON operation.distribution_id = distribution.id
         JOIN async_job_events AS event
           ON event.event_key = $2
         WHERE distribution.id = $1`,
        [distributionId, `outbox:${eventId}`],
      );
      expect(result.rows[0]).toMatchObject({
        event_outcome: "succeeded",
        operation_status: "succeeded",
        platform_post_id: "post-1",
        platform_url: "https://provider.example/posts/1",
        provider_operation_id: "operation-1",
        status: "published",
      });
      expect(result.rows[0]!.analytics_next_sync_at).toBeInstanceOf(Date);
      expect(result.rows[0]!.comments_next_sync_at).toBeInstanceOf(Date);
    });
  });

  it("retries an active provider intent then reconciles it after lease expiry without reposting", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000006";
    const eventId = "automation-integration-provider-crash";
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "must-not-be-called",
    }));
    await runSystemTransaction(env, async (client) => {
      // A mid-attempt row still carries its Post-owned composition so the
      // reconcile path reads the same frozen media the publish attempt used.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: seededYouTubeAccountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status)
         VALUES (
           $1, $2, $3,
           $4,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'processing'
         )`,
        [
          distributionId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
      await client.query(
        `INSERT INTO async_job_events
           (event_key, job_type, aggregate_id, outcome, lease_expires_at,
            org_id, aggregate_type)
         VALUES ($1, 'distribution.publish.requested', $2, 'processing',
                 now() + INTERVAL '5 minutes', $3, 'distribution')`,
        [`outbox:${eventId}`, distributionId, organizationId],
      );
      await client.query(
        `INSERT INTO provider_operations
           (org_id, distribution_id, operation, idempotency_key, status)
         VALUES ($1, $2, 'publish', $3, 'started')`,
        [organizationId, distributionId, `queue:${eventId}`],
      );
    });
    const message = {
      ...outboxMessage(eventId, distributionId, "distribution.publish.requested"),
      payload: { distribution_id: distributionId },
    } as const;

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, message, {
          decryptToken: async (stored) => stored,
          providerRegistry: youtubeRegistry(publish),
        }),
      ),
    ).rejects.toThrow("distribution event lease is still active");
    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE async_job_events
         SET lease_expires_at = now() - INTERVAL '1 second'
         WHERE event_key = $1`,
        [`outbox:${eventId}`],
      ),
    );
    // The redelivered publish must not run again: the row is still processing,
    // so the delivery no-ops and recovery is left to the stalled-processing
    // Due scan (#256).
    await expect(
      Effect.runPromise(
        processDistributionMessage(env, message, {
          decryptToken: async (stored) => stored,
          providerRegistry: youtubeRegistry(publish),
        }),
      ),
    ).resolves.toBe("skipped");
    expect(publish).not.toHaveBeenCalled();

    // Once the processing grace period lapses the scan moves the row to
    // needs_reconciliation and arms the reconcile trigger.
    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET updated_at = now() - INTERVAL '6 minutes'
         WHERE id = $1`,
        [distributionId],
      ),
    );
    await expect(enqueueFixtureDistributions()).resolves.toBe(1);

    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        event_outcome: string;
        failure_code: string;
        operation_status: string;
        status: string;
      }>(
        `SELECT distribution.status, distribution.failure_code,
                operation.status AS operation_status,
                event.outcome AS event_outcome
         FROM distributions AS distribution
         JOIN provider_operations AS operation
           ON operation.distribution_id = distribution.id
         JOIN async_job_events AS event
           ON event.event_key = $2
         WHERE distribution.id = $1`,
        [distributionId, `outbox:${eventId}`],
      );
      expect(result.rows[0]).toEqual({
        event_outcome: "skipped",
        failure_code: "provider_outcome_ambiguous",
        operation_status: "started",
        status: "needs_reconciliation",
      });
      const events = await client.query<{
        dedupe_key: string;
        topic: string;
      }>(
        `SELECT dedupe_key, topic FROM outbox_events
         WHERE aggregate_id = $1`,
        [distributionId],
      );
      expect(events.rows).toEqual([
        {
          dedupe_key: `distribution:${distributionId}:reconcile:1`,
          topic: "distribution.reconcile.requested",
        },
      ]);
    });
  });

  it("keeps an in-flight cancellation non-terminal without a provider cancel adapter", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000007";
    const eventId = "automation-integration-provider-cancel";
    await runSystemTransaction(env, async (client) => {
      // A cancel claim joins the Post for its composition, so the
      // cancel-requested row needs a real Post on the seeded Channel.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: seededYouTubeAccountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, cancel_requested_at)
         VALUES (
           $1, $2, $3,
           $4,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'cancel_requested', now()
         )`,
        [
          distributionId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
    });
    const message = {
      ...outboxMessage(eventId, distributionId, "distribution.cancel.requested"),
      payload: { distribution_id: distributionId },
    } as const;

    await expect(Effect.runPromise(processDistributionMessage(env, message))).resolves.toBe(
      "processed",
    );
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        event_outcome: string;
        failure_code: string;
        operation_status: string;
        status: string;
      }>(
        `SELECT distribution.status, distribution.failure_code,
                operation.status AS operation_status,
                event.outcome AS event_outcome
         FROM distributions AS distribution
         JOIN provider_operations AS operation
           ON operation.distribution_id = distribution.id
         JOIN async_job_events AS event
           ON event.event_key = $2
         WHERE distribution.id = $1`,
        [distributionId, `outbox:${eventId}`],
      );
      expect(result.rows[0]).toEqual({
        event_outcome: "succeeded",
        failure_code: "provider_cancel_unavailable",
        operation_status: "needs_reconciliation",
        status: "needs_reconciliation",
      });
    });
  });

  it("commits a confirmed provider cancellation through the accepted adapter", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000009";
    const eventId = "automation-integration-provider-cancel-success";
    await runSystemTransaction(env, async (client) => {
      // The cancel adapter path still claims through the Post composition, so
      // the row keeps its Post and saved target on the seeded Channel.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: seededYouTubeAccountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, provider_operation_id, platform_post_id,
            cancel_requested_at)
         VALUES (
           $1, $2, $3,
           $4,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'cancel_requested', 'publish-operation-1', 'post-1', now()
         )`,
        [
          distributionId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
    });
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerPostId: "must-not-publish",
    }));
    const cancelPublication = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerOperationId: "cancel-operation-1",
    }));
    const message = {
      ...outboxMessage(eventId, distributionId, "distribution.cancel.requested"),
      payload: { distribution_id: distributionId },
    } as const;

    await expect(
      Effect.runPromise(
        processDistributionMessage(env, message, {
          decryptToken: async (stored) => `decrypted:${stored}`,
          providerRegistry: youtubeRegistry(publish, cancelPublication),
        }),
      ),
    ).resolves.toBe("processed");
    expect(publish).not.toHaveBeenCalled();
    expect(cancelPublication).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: `queue:${eventId}` }),
      {
        accessToken: "decrypted:local-only-not-a-provider-credential",
        accountId: "local-youtube-alpha",
      },
      {
        providerOperationId: "publish-operation-1",
        providerPostId: "post-1",
      },
    );
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        event_outcome: string;
        failure_code: string | null;
        operation_status: string;
        provider_operation_id: string;
        status: string;
      }>(
        `SELECT distribution.status, distribution.failure_code,
                operation.status AS operation_status,
                operation.provider_operation_id,
                event.outcome AS event_outcome
         FROM distributions AS distribution
         JOIN provider_operations AS operation
           ON operation.distribution_id = distribution.id
          AND operation.operation = 'cancel'
         JOIN async_job_events AS event
           ON event.event_key = $2
         WHERE distribution.id = $1`,
        [distributionId, `outbox:${eventId}`],
      );
      expect(result.rows[0]).toEqual({
        event_outcome: "succeeded",
        failure_code: null,
        operation_status: "succeeded",
        provider_operation_id: "cancel-operation-1",
        status: "cancelled",
      });
    });
  });

  it("preserves confirmed publish evidence when cancellation completes during an in-flight publish", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000038";
    const publishEventId = "automation-integration-provider-cancel-race-publish";
    const cancelEventId = "automation-integration-provider-cancel-race-cancel";
    await runSystemTransaction(env, async (client) => {
      // The publish-under-cancel race freezes media at claim, so the queued
      // row's Post carries the canonical image attachment.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: seededYouTubeAccountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status)
         VALUES (
           $1, $2, $3,
           $4,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'queued'
         )`,
        [
          distributionId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
    });

    let releasePublish!: (result: {
      outcome: "confirmed_success";
      providerOperationId: string;
      providerPostId: string;
      providerUrl: string;
    }) => void;
    const publish = vi.fn(
      () =>
        new Promise<{
          outcome: "confirmed_success";
          providerOperationId: string;
          providerPostId: string;
          providerUrl: string;
        }>((resolve) => {
          releasePublish = resolve;
        }),
    );
    const cancelPublication = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerOperationId: "cancel-operation-race",
    }));
    const registry = youtubeRegistry(publish, cancelPublication);
    const dependencies = {
      decryptToken: async (stored: string) => `decrypted:${stored}`,
      mediaFor: async (request: { contentType: string; fileSize: number }) => ({
        contentType: request.contentType,
        fileSize: request.fileSize,
        mode: "remote_ingest" as const,
        url: "https://r2.example/signed-object",
      }),
      providerRegistry: registry,
    };
    const publishMessage = {
      ...outboxMessage(publishEventId, distributionId, "distribution.publish.requested"),
      payload: { distribution_id: distributionId },
    } as const;

    const publishPromise = Effect.runPromise(
      processDistributionMessage(env, publishMessage, dependencies),
    );
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());

    await runSystemTransaction(env, (client) =>
      client.query(
        `UPDATE distributions
         SET status = 'cancel_requested', cancel_requested_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [distributionId],
      ),
    );
    const cancelMessage = {
      ...outboxMessage(cancelEventId, distributionId, "distribution.cancel.requested"),
      payload: { distribution_id: distributionId },
    } as const;
    await expect(
      Effect.runPromise(processDistributionMessage(env, cancelMessage, dependencies)),
    ).resolves.toBe("processed");
    expect(cancelPublication).not.toHaveBeenCalled();

    releasePublish({
      outcome: "confirmed_success",
      providerOperationId: "publish-operation-race",
      providerPostId: "post-race",
      providerUrl: "https://provider.example/posts/race?access_token=private",
    });
    await expect(publishPromise).resolves.toBe("processed");

    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        platform_post_id: string | null;
        platform_url: string | null;
        published_at: Date | null;
        publish_operation_status: string;
        status: string;
      }>(
        `SELECT distribution.status, distribution.platform_post_id,
                distribution.platform_url, distribution.published_at,
                publish.status AS publish_operation_status
         FROM distributions AS distribution
         JOIN provider_operations AS publish
           ON publish.distribution_id = distribution.id
          AND publish.operation = 'publish'
         WHERE distribution.id = $1`,
        [distributionId],
      );
      expect(result.rows[0]).toMatchObject({
        platform_post_id: "post-race",
        platform_url: "https://provider.example/posts/race",
        publish_operation_status: "succeeded",
        status: "published",
      });
      expect(result.rows[0]!.published_at).toBeInstanceOf(Date);
    });
  });

  it("polls provider publication status to a confirmed durable result", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000010";
    await runSystemTransaction(env, async (client) => {
      // The pending-outcome publish claim freezes the Post's media, so the
      // queued row keeps the canonical image attachment on its Post.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: seededYouTubeAccountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status)
         VALUES (
           $1, $2, $3,
           $4,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'queued'
         )`,
        [
          distributionId,
          organizationId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
    });
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerOperationId: "publish-operation-10",
    }));
    const lookupPublication = vi
      .fn()
      .mockResolvedValueOnce({
        providerOperationId: "publish-operation-10",
        state: "processing" as const,
      })
      .mockResolvedValueOnce({
        result: {
          outcome: "confirmed_success" as const,
          providerOperationId: "publish-operation-10",
          providerPostId: "post-10",
          providerUrl: "https://provider.example/posts/10?access_token=must-not-persist",
        },
        state: "published" as const,
      });
    const registry = youtubeRegistry(publish, undefined, lookupPublication);

    const dependencies = {
      decryptToken: async (stored: string) => `decrypted:${stored}`,
      mediaFor: async (request: { contentType: string; fileSize: number }) => ({
        contentType: request.contentType,
        fileSize: request.fileSize,
        mode: "remote_ingest" as const,
        url: "https://r2.example/signed-object",
      }),
      providerRegistry: registry,
      random: () => 1,
    };
    const publishMessage = {
      ...outboxMessage(
        "automation-integration-provider-pending",
        distributionId,
        "distribution.publish.requested",
      ),
      payload: { distribution_id: distributionId },
    } as const;
    await expect(
      Effect.runPromise(processDistributionMessage(env, publishMessage, dependencies)),
    ).resolves.toBe("processed");
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        poll_delay_seconds: number | null;
        provider_operation_id: string;
        provider_poll_attempts: number;
        reconciliation_attempt_count: number;
        status: string;
      }>(
        `SELECT status, provider_operation_id,
                reconciliation_attempt_count, provider_poll_attempts,
                extract(epoch FROM (next_attempt_at - updated_at))::int
                  AS poll_delay_seconds
         FROM distributions WHERE id = $1`,
        [distributionId],
      );
      // The fixed poll interval, not the adapter's 15s exponential base.
      expect(result.rows[0]).toMatchObject({
        poll_delay_seconds: providerPollIntervalSeconds,
        provider_operation_id: "publish-operation-10",
        provider_poll_attempts: 0,
        reconciliation_attempt_count: 0,
        status: "awaiting_provider",
      });
      await client.query(
        `UPDATE distributions
         SET next_attempt_at = now() - INTERVAL '1 second'
         WHERE id = $1`,
        [distributionId],
      );
    });

    await expect(enqueueFixtureDistributions()).resolves.toBe(0);
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        dedupe_key: string;
        next_attempt_at: Date | null;
        status: string;
        topic: string;
      }>(
        `SELECT distribution.status, distribution.next_attempt_at,
                event.topic, event.dedupe_key
         FROM distributions AS distribution
         JOIN outbox_events AS event ON event.aggregate_id = distribution.id
         WHERE distribution.id = $1`,
        [distributionId],
      );
      expect(result.rows).toEqual([
        {
          dedupe_key: `distribution:${distributionId}:reconcile:1`,
          next_attempt_at: expect.any(Date),
          status: "awaiting_provider",
          topic: "distribution.reconcile.requested",
        },
      ]);
    });
    const firstMessage = {
      ...outboxMessage(
        "automation-integration-provider-reconcile-1",
        distributionId,
        "distribution.reconcile.requested",
      ),
      payload: { distribution_id: distributionId },
    } as const;
    await expect(
      Effect.runPromise(processDistributionMessage(env, firstMessage, dependencies)),
    ).resolves.toBe("processed");
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        poll_delay_seconds: number | null;
        provider_poll_attempts: number;
        reconciliation_attempt_count: number;
        status: string;
      }>(
        `SELECT status, reconciliation_attempt_count, provider_poll_attempts,
                extract(epoch FROM (next_attempt_at - updated_at))::int
                  AS poll_delay_seconds
         FROM distributions WHERE id = $1`,
        [distributionId],
      );
      // A still-processing provider is re-polled on the same fixed interval,
      // counted against its own budget rather than the reconciliation ladder.
      expect(result.rows[0]).toMatchObject({
        poll_delay_seconds: providerPollIntervalSeconds,
        provider_poll_attempts: 1,
        reconciliation_attempt_count: 1,
        status: "awaiting_provider",
      });
      await client.query(
        `UPDATE distributions
         SET next_attempt_at = now() - INTERVAL '1 second'
         WHERE id = $1`,
        [distributionId],
      );
    });

    // recordReconciliationOutcome already armed the live reconcile:2 event.
    // The scanner must not create a duplicate claim merely because the due
    // timestamp elapsed before that event's queue delivery completes.
    await expect(enqueueFixtureDistributions()).resolves.toBe(0);
    const secondMessage = {
      ...firstMessage,
      event_id: "automation-integration-provider-reconcile-2",
    };
    await expect(
      Effect.runPromise(processDistributionMessage(env, secondMessage, dependencies)),
    ).resolves.toBe("processed");
    expect(publish).toHaveBeenCalledOnce();
    expect(lookupPublication).toHaveBeenCalledTimes(2);
    expect(lookupPublication).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: expect.any(String) }),
      {
        accessToken: "decrypted:local-only-not-a-provider-credential",
        accountId: "local-youtube-alpha",
      },
      { providerOperationId: "publish-operation-10" },
    );
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        next_attempt_at: Date | null;
        platform_post_id: string;
        platform_url: string;
        provider_poll_attempts: number;
        reconciliation_attempt_count: number;
        status: string;
      }>(
        `SELECT status, reconciliation_attempt_count, next_attempt_at,
                provider_poll_attempts, platform_post_id, platform_url
         FROM distributions WHERE id = $1`,
        [distributionId],
      );
      expect(result.rows[0]).toEqual({
        next_attempt_at: null,
        platform_post_id: "post-10",
        platform_url: "https://provider.example/posts/10",
        provider_poll_attempts: 1,
        reconciliation_attempt_count: 2,
        status: "published",
      });
    });
  });

  it("fails an unfinished provider publication once its poll budget is spent", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000011";
    await runSystemTransaction(env, async (client) => {
      // The awaiting-provider row's Post supplies the frozen publish
      // composition the reconcile continuation replays.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: seededYouTubeAccountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, provider_operation_id,
            reconciliation_attempt_count, provider_poll_attempts,
            next_attempt_at)
         VALUES (
           $1, $2, $5,
           $6,
           '50000000-0000-4000-8000-000000000001',
           'youtube', 'awaiting_provider', 'publish-operation-11', $3, $4,
           now() - INTERVAL '1 second'
         )`,
        [
          distributionId,
          organizationId,
          maximumProviderPollAttempts - 1,
          maximumProviderPollAttempts - 1,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
    });
    const lookupPublication = vi.fn(async () => ({
      providerOperationId: "publish-operation-11",
      state: "processing" as const,
    }));
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerOperationId: "publish-operation-11",
    }));

    await expect(
      Effect.runPromise(
        processDistributionMessage(
          env,
          {
            ...outboxMessage(
              "automation-integration-provider-poll-budget",
              distributionId,
              "distribution.reconcile.requested",
            ),
            payload: { distribution_id: distributionId },
          },
          {
            decryptToken: async (stored: string) => `decrypted:${stored}`,
            providerRegistry: youtubeRegistry(publish, undefined, lookupPublication),
            random: () => 1,
          },
        ),
      ),
    ).resolves.toBe("processed");
    expect(lookupPublication).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();

    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        failure_code: string | null;
        failure_retryable: boolean | null;
        next_attempt_at: Date | null;
        provider_poll_attempts: number;
        status: string;
      }>(
        `SELECT status, failure_code, failure_retryable, next_attempt_at,
                provider_poll_attempts
         FROM distributions WHERE id = $1`,
        [distributionId],
      );
      // The spent budget stops the poll loop permanently: the row lands in a
      // terminal failed state with a safe, actionable code (#256).
      expect(result.rows[0]).toEqual({
        failure_code: "provider_poll_budget_exhausted",
        failure_retryable: false,
        next_attempt_at: null,
        provider_poll_attempts: maximumProviderPollAttempts,
        status: "failed",
      });
    });
  });
  // The ambiguous-outcome path uses seeded rows from one Brand Profile so the
  // worker can exercise reconciliation without weakening ownership constraints.
  it("arms an immediate reconcile trigger for an ambiguous publish outcome without provider evidence", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000055";
    const publishEventId = "automation-integration-ambiguous-publish";
    const reconcileEventId = "automation-integration-ambiguous-reconcile";
    try {
      await runSystemTransaction(env, async (client) => {
        // The ambiguous publish still freezes the Post's media at claim, so
        // the queued row keeps the canonical image attachment.
        await seedDistributionPost(client, {
          postId: postIdForDistribution(distributionId),
          target: { platformAccountId: seededYouTubeAccountId },
        });
        await client.query(
          `INSERT INTO distributions
             (id, org_id, brand_profile_id, post_id, platform_account_id,
              platform, status)
           VALUES (
             $1, $2, $3,
             $4,
             '50000000-0000-4000-8000-000000000001',
             'youtube', 'queued'
           )`,
          [
            distributionId,
            organizationId,
            seededAlphaProfileId,
            postIdForDistribution(distributionId),
          ],
        );
      });

      // The provider call may have had a side effect but returned no durable
      // operation identity: the outcome must still arm a deterministic
      // reconciliation trigger instead of stranding the row (#256).
      const publish = vi.fn(async () => ({
        failure: {
          classification: "ambiguous" as const,
          code: "provider_timeout",
          message: "The provider outcome could not be confirmed.",
          retryable: false,
        },
        outcome: "unknown" as const,
      }));
      await expect(
        Effect.runPromise(
          processDistributionMessage(
            env,
            {
              ...outboxMessage(publishEventId, distributionId, "distribution.publish.requested"),
              payload: { distribution_id: distributionId },
            },
            {
              decryptToken: async (stored) => `decrypted:${stored}`,
              mediaFor: async (request: { contentType: string; fileSize: number }) => ({
                contentType: request.contentType,
                fileSize: request.fileSize,
                mode: "remote_ingest" as const,
                url: "https://r2.example/signed-object",
              }),
              providerRegistry: youtubeRegistry(publish),
              random: () => 1,
            },
          ),
        ),
      ).resolves.toBe("processed");

      await runSystemTransaction(env, async (client) => {
        const result = await client.query<{
          dedupe_key: string;
          failure_code: string | null;
          next_attempt_at: Date | null;
          status: string;
          topic: string;
        }>(
          `SELECT distribution.status, distribution.failure_code,
                  distribution.next_attempt_at, event.topic, event.dedupe_key
           FROM distributions AS distribution
           JOIN outbox_events AS event ON event.aggregate_id = distribution.id
           WHERE distribution.id = $1`,
          [distributionId],
        );
        expect(result.rows).toEqual([
          {
            dedupe_key: `distribution:${distributionId}:reconcile:1`,
            failure_code: "provider_timeout",
            next_attempt_at: expect.any(Date),
            status: "needs_reconciliation",
            topic: "distribution.reconcile.requested",
          },
        ]);
      });

      // The armed reconcile resolves to a terminal, actionable failure because
      // no provider evidence was ever persisted.
      const lookupPublication = vi.fn(async () => ({
        state: "not_found" as const,
      }));
      await expect(
        Effect.runPromise(
          processDistributionMessage(
            env,
            {
              ...outboxMessage(
                reconcileEventId,
                distributionId,
                "distribution.reconcile.requested",
              ),
              payload: { distribution_id: distributionId },
            },
            {
              decryptToken: async (stored) => `decrypted:${stored}`,
              providerRegistry: youtubeRegistry(publish, undefined, lookupPublication),
              random: () => 1,
            },
          ),
        ),
      ).resolves.toBe("processed");

      expect(publish).toHaveBeenCalledTimes(1);
      expect(lookupPublication).not.toHaveBeenCalled();
      await runSystemTransaction(env, async (client) => {
        const result = await client.query<{
          failure_code: string | null;
          failure_retryable: boolean | null;
          next_attempt_at: Date | null;
          status: string;
        }>(
          `SELECT status, failure_code, failure_retryable, next_attempt_at
           FROM distributions WHERE id = $1`,
          [distributionId],
        );
        expect(result.rows[0]).toEqual({
          failure_code: "provider_lookup_evidence_unavailable",
          failure_retryable: false,
          next_attempt_at: null,
          status: "failed",
        });
      });
    } finally {
      await runSystemTransaction(env, async (client) => {
        await client.query(`DELETE FROM outbox_events WHERE aggregate_id = $1`, [distributionId]);
        await client.query(`DELETE FROM provider_operations WHERE distribution_id = $1`, [
          distributionId,
        ]);
        await client.query(`DELETE FROM async_job_events WHERE event_key IN ($1, $2)`, [
          `outbox:${publishEventId}`,
          `outbox:${reconcileEventId}`,
        ]);
        await client.query(`DELETE FROM distributions WHERE id = $1`, [distributionId]);
      });
    }
  });

  // The terminal reconciliation case keeps the seeded Post, Asset, and Channel
  // under their shared Brand Profile to satisfy the production composite keys.
  it("fails a distribution terminally once the reconciliation budget is exhausted", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000056";
    const reconcileEventId = "automation-integration-reconcile-exhausted";
    try {
      await runSystemTransaction(env, async (client) => {
        await seedDistributionPost(client, {
          postId: postIdForDistribution(distributionId),
          target: { platformAccountId: seededYouTubeAccountId },
        });
        await client.query(
          `INSERT INTO distributions
             (id, org_id, brand_profile_id, post_id, platform_account_id,
              platform, status, provider_operation_id,
              reconciliation_attempt_count, next_attempt_at)
           VALUES (
             $1, $2, $3,
             $4,
             '50000000-0000-4000-8000-000000000001',
             'youtube', 'needs_reconciliation', 'publish-operation-56', $5,
             now() - INTERVAL '1 second'
           )`,
          [
            distributionId,
            organizationId,
            seededAlphaProfileId,
            postIdForDistribution(distributionId),
            maximumReconciliationAttempts - 1,
          ],
        );
      });

      // The lookup stays ambiguous on the final allowed attempt: the row must
      // land in a terminal failed state instead of re-arming forever (#256).
      const lookupPublication = vi.fn(async () => ({
        result: {
          failure: {
            classification: "ambiguous" as const,
            code: "provider_outcome_unknown",
            message: "The provider outcome could not be confirmed.",
            retryable: false,
          },
          outcome: "unknown" as const,
          providerOperationId: "publish-operation-56",
        },
        state: "unknown" as const,
      }));
      const publish = vi.fn(async () => ({
        outcome: "confirmed_success" as const,
        providerPostId: "must-not-run",
      }));

      await expect(
        Effect.runPromise(
          processDistributionMessage(
            env,
            {
              ...outboxMessage(
                reconcileEventId,
                distributionId,
                "distribution.reconcile.requested",
              ),
              payload: { distribution_id: distributionId },
            },
            {
              decryptToken: async (stored) => `decrypted:${stored}`,
              providerRegistry: youtubeRegistry(publish, undefined, lookupPublication, {
                baseDelaySeconds: 15,
                maxAttempts: maximumReconciliationAttempts,
                maxDelaySeconds: 300,
              }),
              random: () => 1,
            },
          ),
        ),
      ).resolves.toBe("processed");

      expect(lookupPublication).toHaveBeenCalledOnce();
      expect(publish).not.toHaveBeenCalled();
      await runSystemTransaction(env, async (client) => {
        const result = await client.query<{
          failure_code: string | null;
          failure_retryable: boolean | null;
          next_attempt_at: Date | null;
          status: string;
        }>(
          `SELECT status, failure_code, failure_retryable, next_attempt_at
           FROM distributions WHERE id = $1`,
          [distributionId],
        );
        expect(result.rows[0]).toEqual({
          failure_code: "provider_outcome_unknown",
          failure_retryable: false,
          next_attempt_at: null,
          status: "failed",
        });
        const events = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM outbox_events
           WHERE aggregate_id = $1`,
          [distributionId],
        );
        // No further reconcile trigger is armed once the budget is spent.
        expect(events.rows[0]?.count).toBe("0");
      });
    } finally {
      await runSystemTransaction(env, async (client) => {
        await client.query(`DELETE FROM outbox_events WHERE aggregate_id = $1`, [distributionId]);
        await client.query(`DELETE FROM provider_operations WHERE distribution_id = $1`, [
          distributionId,
        ]);
        await client.query(`DELETE FROM async_job_events WHERE event_key = $1`, [
          `outbox:${reconcileEventId}`,
        ]);
        await client.query(`DELETE FROM distributions WHERE id = $1`, [distributionId]);
      });
    }
  });

  it("leases due provider sync work and persists checkpoints atomically", async () => {
    const distributionId = "60000000-0000-4000-8000-000000000001";
    const accountId = "50000000-0000-4000-8000-000000000001";
    const now = new Date("2026-07-19T12:00:00Z");
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `DELETE FROM comments
         WHERE distribution_id = $1
           AND platform_comment_id LIKE 'automation-sync-%'`,
        [distributionId],
      );
      await client.query(
        `DELETE FROM analytics_snapshots
         WHERE distribution_id = $1 AND snapshot_at = $2`,
        [distributionId, now],
      );
      await client.query(
        `UPDATE distributions
         SET analytics_next_sync_at = NULL,
             comments_next_sync_at = NULL
         WHERE id <> $1`,
        [distributionId],
      );
      await client.query(
        `UPDATE distributions
         SET status = 'published', platform_post_id = 'local-post-alpha',
             analytics_cursor = NULL,
             analytics_next_sync_at = now() - INTERVAL '1 second',
             analytics_lease_expires_at = NULL,
             analytics_sync_event_id = NULL, analytics_attempt_count = 0,
             comments_cursor = NULL,
             comments_next_sync_at = now() - INTERVAL '1 second',
             comments_lease_expires_at = NULL,
             comments_sync_event_id = NULL, comments_attempt_count = 0,
             updated_at = now()
         WHERE id = $1`,
        [distributionId],
      );
      await client.query(
        `UPDATE platform_accounts
         SET access_token = 'sync-access-old',
             refresh_token = 'sync-refresh-old',
             token_expires_at = now() + INTERVAL '1 day',
             scopes = ARRAY['old-scope'], connection_status = 'connected',
             token_refresh_next_attempt_at = now() - INTERVAL '1 second',
             token_refresh_lease_expires_at = NULL,
             token_refresh_event_id = NULL,
             token_refresh_attempt_count = 0,
             token_refresh_last_error = NULL, reconnect_notified_at = NULL,
             updated_at = now()
         WHERE id = $1`,
        [accountId],
      );
    });

    const listAnalytics = vi.fn(async () => ({
      items: [
        {
          comments: 12,
          impressions: 0,
          likes: 90,
          providerPostId: "local-post-alpha",
          reach: 0,
          recordedAt: "2026-07-19T11:59:00Z",
          shares: 15,
          views: 1_500,
          watchTimeSeconds: 0,
        },
      ],
    }));
    const listComments = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          {
            authorDisplayName: "First Viewer",
            body: "First synchronized comment",
            commentedAt: "2026-07-19T11:50:00Z",
            providerCommentId: "automation-sync-comment-1",
            providerPostId: "local-post-alpha",
          },
        ],
        nextCursor: "comments-page-2",
      })
      .mockResolvedValueOnce({
        items: [
          {
            authorDisplayName: "Second Viewer",
            body: "Second synchronized comment",
            commentedAt: "2026-07-19T11:55:00Z",
            providerCommentId: "automation-sync-comment-2",
            providerPostId: "local-post-alpha",
          },
        ],
      });
    const refreshAccessToken = vi.fn(async () => ({
      accessToken: "sync-access-new",
      expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      refreshToken: "sync-refresh-new",
      scopes: ["new-scope"],
    }));
    const registry = youtubeSyncRegistry(listAnalytics, listComments, refreshAccessToken);
    const analyticsMessages: unknown[] = [];
    const commentsMessages: unknown[] = [];
    const tokenMessages: unknown[] = [];
    const queue = (messages: unknown[]) =>
      ({
        sendBatch: vi.fn(async (batch: { body: unknown }[]) => {
          for (const entry of batch) messages.push(entry.body);
        }),
      }) as unknown as Queue<unknown>;
    const syncEnv = {
      ...env,
      ANALYTICS_QUEUE: queue(analyticsMessages),
      COMMENTS_QUEUE: queue(commentsMessages),
      TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      TOKEN_REFRESH_QUEUE: queue(tokenMessages),
    } satisfies AutomationEnv;
    const decryptToken = (value: string) => tokenCipherFor(syncEnv).decrypt(value);

    await expect(
      Effect.runPromise(
        Effect.provide(
          sweepDueProviderJobs(syncEnv, { providerRegistry: registry }),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toEqual({ analytics: 1, comments: 1, token_refresh: 1 });
    const analyticsMessage = analyticsMessages[0] as Parameters<
      typeof processProviderSyncMessage
    >[1];
    const commentsMessage = commentsMessages[0] as Parameters<typeof processProviderSyncMessage>[1];
    const tokenMessage = tokenMessages[0] as Parameters<typeof processProviderSyncMessage>[1];
    const dependencies = {
      decryptToken,
      now: () => now,
      providerRegistry: registry,
      random: () => 1,
    };

    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(syncEnv, analyticsMessage, dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(syncEnv, commentsMessage, dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(syncEnv, tokenMessage, dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");
    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(syncEnv, analyticsMessage, dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("skipped");

    // A comments page with a cursor arms its continuation by delayed delivery,
    // so the next page needs no sweep to be discovered.
    const nextCommentsMessage = commentsMessages[1] as Parameters<
      typeof processProviderSyncMessage
    >[1];
    expect(nextCommentsMessage).toBeDefined();
    await expect(
      Effect.runPromise(
        Effect.provide(
          sweepDueProviderJobs(syncEnv, { providerRegistry: registry }),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toEqual({ analytics: 0, comments: 0, token_refresh: 0 });
    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(syncEnv, nextCommentsMessage, dependencies),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");

    expect(listAnalytics).toHaveBeenCalledOnce();
    expect(listComments).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      {
        accessToken: "sync-access-new",
        accountId: "local-youtube-alpha",
      },
      { providerPostId: "local-post-alpha" },
      { cursor: "comments-page-2", limit: 100 },
    );
    expect(refreshAccessToken).toHaveBeenCalledWith(expect.any(Object), "sync-refresh-old");
    await runSystemTransaction(env, async (client) => {
      const analytics = await client.query<{
        count: number;
        likes: number | string;
        views: number | string;
      }>(
        `SELECT COUNT(*)::int AS count, MAX(views) AS views, MAX(likes) AS likes
         FROM analytics_snapshots
         WHERE distribution_id = $1 AND snapshot_at = $2`,
        [distributionId, now],
      );
      expect(analytics.rows[0]).toEqual({
        count: 1,
        likes: "90",
        views: "1500",
      });
      const comments = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM comments
         WHERE distribution_id = $1
           AND platform_comment_id LIKE 'automation-sync-%'`,
        [distributionId],
      );
      expect(comments.rows[0]?.count).toBe(2);
      const distribution = await client.query<{
        analytics_attempt_count: number;
        analytics_next_sync_at: Date;
        comments_attempt_count: number;
        comments_cursor: string | null;
        comments_next_sync_at: Date;
      }>(
        `SELECT analytics_attempt_count, analytics_next_sync_at,
                comments_attempt_count, comments_cursor,
                comments_next_sync_at
         FROM distributions WHERE id = $1`,
        [distributionId],
      );
      expect(distribution.rows[0]).toMatchObject({
        analytics_attempt_count: 0,
        comments_attempt_count: 0,
        comments_cursor: null,
      });
      expect(distribution.rows[0]!.analytics_next_sync_at).toBeInstanceOf(Date);
      expect(distribution.rows[0]!.comments_next_sync_at).toBeInstanceOf(Date);
      const account = await client.query<{
        access_token: string;
        connection_status: string;
        refresh_token: string;
        scopes: string[];
        token_refresh_attempt_count: number;
        token_refresh_next_attempt_at: Date;
      }>(
        `SELECT access_token, refresh_token, scopes, connection_status,
                token_refresh_attempt_count, token_refresh_next_attempt_at
         FROM platform_accounts WHERE id = $1`,
        [accountId],
      );
      expect(account.rows[0]).toMatchObject({
        connection_status: "connected",
        scopes: ["new-scope"],
        token_refresh_attempt_count: 0,
      });
      await expect(tokenCipherFor(syncEnv).decrypt(account.rows[0]!.access_token)).resolves.toBe(
        "sync-access-new",
      );
      await expect(tokenCipherFor(syncEnv).decrypt(account.rows[0]!.refresh_token)).resolves.toBe(
        "sync-refresh-new",
      );
      expect(account.rows[0]!.token_refresh_next_attempt_at).toBeInstanceOf(Date);
    });
  });

  it("releases a provider-sync lease when Queue publication fails", async () => {
    const distributionId = "60000000-0000-4000-8000-000000000001";
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE distributions
         SET analytics_next_sync_at = NULL, comments_next_sync_at = NULL
         WHERE id <> $1`,
        [distributionId],
      );
      await client.query(
        `UPDATE distributions
         SET analytics_next_sync_at = now() - INTERVAL '1 second',
             analytics_sync_event_id = NULL,
             analytics_lease_expires_at = NULL,
             analytics_attempt_count = 0,
             comments_next_sync_at = NULL, updated_at = now()
         WHERE id = $1`,
        [distributionId],
      );
      await client.query(
        `UPDATE platform_accounts
         SET connection_status = 'connected',
             token_expires_at = now() + INTERVAL '1 day',
             token_refresh_next_attempt_at = NULL
         WHERE id = '50000000-0000-4000-8000-000000000001'`,
      );
    });
    const registry = youtubeSyncRegistry(
      async () => ({ items: [] }),
      async () => ({ items: [] }),
      async () => ({
        accessToken: "unused",
        expiresAt: "2026-09-19T12:00:00Z",
        scopes: [],
      }),
    );
    const failingEnv = {
      ...env,
      ANALYTICS_QUEUE: {
        sendBatch: vi.fn(async () => {
          throw new Error("queue failed at https://signed.example/private");
        }),
      } as unknown as Queue<unknown>,
    } satisfies AutomationEnv;

    await expect(
      Effect.runPromise(
        Effect.provide(
          sweepDueProviderJobs(failingEnv, { providerRegistry: registry }),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toEqual({ analytics: 0, comments: 0, token_refresh: 0 });
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        analytics_last_error: string;
        analytics_lease_expires_at: Date | null;
        analytics_next_sync_at: Date;
        analytics_sync_event_id: string | null;
      }>(
        `SELECT analytics_last_error, analytics_lease_expires_at,
                analytics_next_sync_at, analytics_sync_event_id
         FROM distributions WHERE id = $1`,
        [distributionId],
      );
      expect(result.rows[0]).toMatchObject({
        analytics_lease_expires_at: null,
        analytics_sync_event_id: null,
      });
      expect(result.rows[0]!.analytics_next_sync_at).toBeInstanceOf(Date);
      expect(result.rows[0]!.analytics_last_error).toContain("[REDACTED_URL]");
      expect(result.rows[0]!.analytics_last_error).not.toContain("private");
    });
  });

  it("marks invalid-grant refreshes for one reconnect notification", async () => {
    const accountId = "50000000-0000-4000-8000-000000000001";
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE distributions
         SET analytics_next_sync_at = NULL, comments_next_sync_at = NULL`,
      );
      await client.query(
        `UPDATE platform_accounts
         SET access_token = 'refresh-access-old',
             refresh_token = 'refresh-secret-old',
             token_expires_at = now() + INTERVAL '1 day',
             connection_status = 'connected',
             token_refresh_next_attempt_at = now() - INTERVAL '1 second',
             token_refresh_event_id = NULL,
             token_refresh_lease_expires_at = NULL,
             token_refresh_attempt_count = 0,
             reconnect_notified_at = NULL, updated_at = now()
         WHERE id = $1`,
        [accountId],
      );
    });
    const registry = youtubeSyncRegistry(
      async () => ({ items: [] }),
      async () => ({ items: [] }),
      async () => {
        throw new ProviderAdapterError(
          classifyProviderFailure({ code: "invalid_grant", status: 401 }),
        );
      },
    );
    const tokenMessages: unknown[] = [];
    const refreshEnv = {
      ...env,
      TOKEN_REFRESH_QUEUE: {
        sendBatch: vi.fn(async (batch: { body: unknown }[]) => {
          for (const entry of batch) tokenMessages.push(entry.body);
        }),
      } as unknown as Queue<unknown>,
    } satisfies AutomationEnv;

    await expect(
      Effect.runPromise(
        Effect.provide(
          sweepDueProviderJobs(refreshEnv, { providerRegistry: registry }),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toEqual({ analytics: 0, comments: 0, token_refresh: 1 });
    await expect(
      Effect.runPromise(
        Effect.provide(
          processProviderSyncMessage(
            refreshEnv,
            tokenMessages[0] as Parameters<typeof processProviderSyncMessage>[1],
            {
              decryptToken: async (value) => value,
              now: () => new Date(),
              providerRegistry: registry,
              random: () => 1,
            },
          ),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toBe("processed");
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        connection_status: string;
        reconnect_notified_at: Date;
        token_refresh_last_error: string;
        token_refresh_next_attempt_at: Date | null;
      }>(
        `SELECT connection_status, reconnect_notified_at,
                token_refresh_last_error, token_refresh_next_attempt_at
         FROM platform_accounts WHERE id = $1`,
        [accountId],
      );
      expect(result.rows[0]).toMatchObject({
        connection_status: "reconnect_required",
        token_refresh_last_error: "auth:invalid_grant",
        token_refresh_next_attempt_at: null,
      });
      expect(result.rows[0]!.reconnect_notified_at).toBeInstanceOf(Date);
      await client.query(
        `UPDATE platform_accounts
         SET access_token = 'local-only-not-a-provider-credential',
             refresh_token = NULL, token_expires_at = NULL,
             connection_status = 'connected',
             token_refresh_next_attempt_at = NULL,
             token_refresh_event_id = NULL,
             token_refresh_lease_expires_at = NULL,
             token_refresh_attempt_count = 0,
             token_refresh_last_error = NULL,
             reconnect_notified_at = NULL, updated_at = now()
         WHERE id = $1`,
        [accountId],
      );
    });
  });
  it("recovers lost and beyond-horizon provider sync triggers through hourly sweep", async () => {
    const distributionId = "93000000-0000-4000-8000-000000000091";
    const accountId = "50000000-0000-4000-8000-000000000001";
    await runSystemTransaction(env, async (client) => {
      // The published row only needs a durable Post reference for the sync
      // sweeps; the Post still composes the canonical image on the Channel.
      await seedDistributionPost(client, {
        postId: postIdForDistribution(distributionId),
        target: { platformAccountId: accountId },
      });
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, platform_post_id, published_at,
            analytics_next_sync_at, analytics_sync_event_id,
            comments_next_sync_at, comments_sync_event_id,
            updated_at)
         VALUES
           ($1, $2, $4,
            $5,
            $3, 'youtube', 'published', 'yt-post-91', now() - INTERVAL '1 day',
            now() - INTERVAL '10 minutes', '00000000-0000-4000-8000-000000000092',
            now() + INTERVAL '2 hours', NULL,
            now())
         ON CONFLICT (id) DO UPDATE
         SET status = 'published', platform_post_id = 'yt-post-91',
             analytics_next_sync_at = now() - INTERVAL '10 minutes',
             analytics_sync_event_id = '00000000-0000-4000-8000-000000000092',
             analytics_lease_expires_at = NULL,
             comments_next_sync_at = now() + INTERVAL '2 hours',
             comments_sync_event_id = NULL,
             comments_lease_expires_at = NULL,
             updated_at = now()`,
        [
          distributionId,
          organizationId,
          accountId,
          seededAlphaProfileId,
          postIdForDistribution(distributionId),
        ],
      );
      await client.query(
        `UPDATE platform_accounts
         SET access_token = 'enc-token',
             token_expires_at = now() + INTERVAL '10 days',
             connection_status = 'connected',
             token_refresh_next_attempt_at = now() - INTERVAL '10 minutes',
             token_refresh_event_id = '00000000-0000-4000-8000-000000000093',
             token_refresh_lease_expires_at = NULL,
             token_refresh_attempt_count = 0,
             updated_at = now()
         WHERE id = $1`,
        [accountId],
      );
    });

    const analyticsBatches: unknown[] = [];
    const commentsBatches: unknown[] = [];
    const tokenBatches: unknown[] = [];
    const sweepEnv = {
      ...env,
      ANALYTICS_QUEUE: {
        sendBatch: vi.fn(async (batch: unknown[]) => {
          analyticsBatches.push(...batch);
        }),
      } as unknown as Queue<unknown>,
      COMMENTS_QUEUE: {
        sendBatch: vi.fn(async (batch: unknown[]) => {
          commentsBatches.push(...batch);
        }),
      } as unknown as Queue<unknown>,
      TOKEN_REFRESH_QUEUE: {
        sendBatch: vi.fn(async (batch: unknown[]) => {
          tokenBatches.push(...batch);
        }),
      } as unknown as Queue<unknown>,
    } satisfies AutomationEnv;

    const registry = youtubeSyncRegistry(
      async () => ({ items: [] }),
      async () => ({ items: [] }),
      async () => ({
        accessToken: "new-access",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        refreshToken: "new-refresh",
        scopes: [],
      }),
    );

    // Run hourly sweep
    const sweepResult = await Effect.runPromise(
      Effect.provide(
        sweepDueProviderJobs(sweepEnv, { providerRegistry: registry }),
        queuePublisherLayer,
      ),
    );

    expect(sweepResult.analytics).toBeGreaterThanOrEqual(1);
    expect(sweepResult.comments).toBeGreaterThanOrEqual(1);
    expect(sweepResult.token_refresh).toBeGreaterThanOrEqual(1);

    // Overdue analytics job was recovered with a fresh event ID
    expect(analyticsBatches.length).toBeGreaterThanOrEqual(1);
    const analyticsItem = analyticsBatches[0] as {
      body: { event_id: string; target_id: string; workload: string };
      delaySeconds?: number;
    };
    expect(analyticsItem.body.workload).toBe("analytics");
    expect(analyticsItem.body.target_id).toBe(distributionId);
    expect(analyticsItem.body.event_id).not.toBe("00000000-0000-4000-8000-000000000092");

    // Beyond-horizon/unarmed comments job was scheduled with a bounded delay (~2 hours)
    expect(commentsBatches.length).toBeGreaterThanOrEqual(1);
    const commentsItem = commentsBatches[0] as {
      body: { event_id: string; target_id: string; workload: string };
      delaySeconds?: number;
    };
    expect(commentsItem.body.workload).toBe("comments");
    expect(commentsItem.body.target_id).toBe(distributionId);
    expect(commentsItem.delaySeconds).toBeGreaterThan(0);
    expect(commentsItem.delaySeconds).toBeLessThanOrEqual(86_400);

    // Cleanup
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM distributions WHERE id = $1", [distributionId]);
    });
  });

  it("stops scheduling analytics past the terminal age while keeping recent work and collected snapshots", async () => {
    const pastThresholdId = "93000000-0000-4000-8000-000000000148";
    const recentId = "93000000-0000-4000-8000-000000000149";
    const accountId = "50000000-0000-4000-8000-000000000001";
    const terminalAgeDays = `${analyticsTerminalAgeSeconds / 86_400} days`;
    await runSystemTransaction(env, async (client) => {
      await client.query(
        `UPDATE distributions
         SET analytics_next_sync_at = NULL, comments_next_sync_at = NULL`,
      );
      // Both rows are armed and due, exactly as a pre-migration row would be.
      // Each publishes its own Post (one per Channel under the unique
      // (post_id, platform_account_id)) composing the canonical image.
      for (const distributionId of [pastThresholdId, recentId]) {
        await seedDistributionPost(client, {
          postId: postIdForDistribution(distributionId),
          target: { platformAccountId: accountId },
        });
      }
      await client.query(
        `INSERT INTO distributions
           (id, org_id, brand_profile_id, post_id, platform_account_id,
            platform, status, platform_post_id, published_at,
            analytics_next_sync_at, analytics_sync_event_id,
            analytics_attempt_count, comments_next_sync_at, updated_at)
         SELECT input.id, $1, $6,
                input.post,
                $2, 'youtube', 'published', input.platform_post,
                now() - input.age, now() - INTERVAL '1 second',
                NULL, 0, NULL, now()
         FROM (VALUES
                 ($3::uuid, 'yt-post-148', ($5::interval + INTERVAL '1 day'), $7::uuid),
                 ($4::uuid, 'yt-post-149', INTERVAL '2 hours', $8::uuid)
               ) AS input(id, platform_post, age, post)
         ON CONFLICT (id) DO UPDATE
         SET status = 'published',
             platform_post_id = EXCLUDED.platform_post_id,
             published_at = EXCLUDED.published_at,
             analytics_cursor = NULL,
             analytics_next_sync_at = EXCLUDED.analytics_next_sync_at,
             analytics_sync_event_id = NULL,
             analytics_lease_expires_at = NULL,
             analytics_attempt_count = 0,
             comments_next_sync_at = NULL,
             updated_at = now()`,
        [
          organizationId,
          accountId,
          pastThresholdId,
          recentId,
          terminalAgeDays,
          seededAlphaProfileId,
          postIdForDistribution(pastThresholdId),
          postIdForDistribution(recentId),
        ],
      );
      await client.query(
        `UPDATE platform_accounts
         SET access_token = 'enc-token', connection_status = 'connected',
             token_expires_at = now() + INTERVAL '10 days',
             token_refresh_next_attempt_at = NULL, updated_at = now()
         WHERE id = $1`,
        [accountId],
      );
      await client.query(
        `UPDATE platform_accounts SET token_refresh_next_attempt_at = NULL
         WHERE id <> $1`,
        [accountId],
      );
    });

    const analyticsMessages: Parameters<typeof processProviderSyncMessage>[1][] = [];
    const syncEnv = {
      ...env,
      ANALYTICS_QUEUE: {
        sendBatch: vi.fn(async (batch: { body: unknown }[]) => {
          for (const entry of batch) {
            analyticsMessages.push(entry.body as Parameters<typeof processProviderSyncMessage>[1]);
          }
        }),
      } as unknown as Queue<unknown>,
    } satisfies AutomationEnv;
    const registry = youtubeSyncRegistry(
      async (_context, _credentials, lookup) => ({
        items: [
          {
            comments: 4,
            impressions: 0,
            likes: 40,
            providerPostId: lookup.providerPostId ?? "",
            reach: 0,
            recordedAt: new Date().toISOString(),
            shares: 5,
            views: 500,
            watchTimeSeconds: 0,
          },
        ],
      }),
      async () => ({ items: [] }),
      async () => ({
        accessToken: "unused",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: [],
      }),
    );
    const dependencies = {
      decryptToken: async () => "provider-access",
      now: () => new Date(),
      providerRegistry: registry,
      random: () => 1,
    };

    // Before the terminal transition both rows are still claimed and polled.
    await expect(
      Effect.runPromise(
        Effect.provide(
          sweepDueProviderJobs(syncEnv, { providerRegistry: registry }),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toMatchObject({ analytics: 2 });
    const claimed = analyticsMessages.splice(0);
    expect(claimed).toHaveLength(2);
    for (const message of claimed) {
      await expect(
        Effect.runPromise(
          Effect.provide(
            processProviderSyncMessage(syncEnv, message, dependencies),
            queuePublisherLayer,
          ),
        ),
      ).resolves.toBe("processed");
    }

    // Only the recent Distribution arms a follow-up trigger; the
    // past-threshold one sends nothing.
    expect(analyticsMessages.map((message) => message.target_id)).toEqual([recentId]);

    await runSystemTransaction(env, async (client) => {
      const rows = await client.query<{
        analytics_last_synced_at: Date | null;
        analytics_lease_expires_at: Date | null;
        analytics_next_sync_at: Date | null;
        analytics_sync_event_id: string | null;
        id: string;
        snapshots: number;
      }>(
        `SELECT distribution.id, distribution.analytics_next_sync_at,
                distribution.analytics_sync_event_id::text
                  AS analytics_sync_event_id,
                distribution.analytics_lease_expires_at,
                distribution.analytics_last_synced_at,
                (SELECT COUNT(*)::int FROM analytics_snapshots AS snapshot
                  WHERE snapshot.distribution_id = distribution.id) AS snapshots
         FROM distributions AS distribution
         WHERE distribution.id = ANY($1::uuid[])
         ORDER BY distribution.id`,
        [[pastThresholdId, recentId]],
      );
      const [pastThreshold, recent] = rows.rows;
      // Past the threshold: unscheduled and unarmed, with its collected
      // snapshot still readable.
      expect(pastThreshold).toMatchObject({
        analytics_lease_expires_at: null,
        analytics_next_sync_at: null,
        analytics_sync_event_id: null,
        id: pastThresholdId,
        snapshots: 1,
      });
      expect(pastThreshold?.analytics_last_synced_at).toBeInstanceOf(Date);
      // Recent Distributions keep their cadence.
      expect(recent).toMatchObject({ id: recentId, snapshots: 1 });
      expect(recent?.analytics_next_sync_at).toBeInstanceOf(Date);
      expect(recent?.analytics_sync_event_id).toEqual(expect.any(String));
    });

    // An absent next sync moment is excluded by the sweep's due comparison, so
    // no later scan re-arms the past-threshold row.
    analyticsMessages.splice(0);
    await expect(
      Effect.runPromise(
        Effect.provide(
          sweepDueProviderJobs(syncEnv, { providerRegistry: registry }),
          queuePublisherLayer,
        ),
      ),
    ).resolves.toMatchObject({ analytics: 0 });
    expect(analyticsMessages).toHaveLength(0);

    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [
        [pastThresholdId, recentId],
      ]);
    });
  });

  it("records provider reply evidence and deduplicates delivery", async () => {
    const eventId = "automation-integration-reply-success";
    const commentId = "80000000-0000-4000-8000-000000000001";
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM provider_operations WHERE comment_id = $1", [commentId]);
      await client.query("DELETE FROM async_job_events WHERE event_key = $1", [
        `outbox:${eventId}`,
      ]);
      await client.query(
        `UPDATE comments
         SET reply_text = 'Integration reply', reply_status = 'queued',
             replied = false, reply_error = NULL, reply_attempted_at = now(),
             reply_provider_operation_id = NULL,
             reply_provider_post_id = NULL, reply_attempt_count = 0,
             reply_reconciliation_attempt_count = 0,
             reply_lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND org_id = $2`,
        [commentId, organizationId],
      );
    });
    const message = {
      ...outboxMessage(eventId, commentId, "comment.reply.requested"),
      payload: { comment_id: commentId },
    } as const;
    const reply = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerOperationId: "reply-container-success",
      providerPostId: "reply-post-success",
    }));
    const dependencies = {
      decryptToken: async (value: string) => `decrypted:${value}`,
      providerRegistry: youtubeReplyRegistry(reply),
    };

    await expect(Effect.runPromise(processReplyMessage(env, message, dependencies))).resolves.toBe(
      "processed",
    );
    await expect(Effect.runPromise(processReplyMessage(env, message, dependencies))).resolves.toBe(
      "skipped",
    );
    expect(reply).toHaveBeenCalledOnce();
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        event_outcome: string;
        operation_status: string;
        provider_operation_id: string;
        provider_post_id: string;
        replied: boolean;
        reply_error: string | null;
        reply_status: string;
      }>(
        `SELECT comment.replied, comment.reply_status,
                comment.reply_error,
                comment.reply_provider_operation_id AS provider_operation_id,
                comment.reply_provider_post_id AS provider_post_id,
                event.outcome AS event_outcome,
                operation.status AS operation_status
         FROM comments AS comment
         JOIN async_job_events AS event
           ON event.event_key = $2
         JOIN provider_operations AS operation
           ON operation.comment_id = comment.id
         WHERE comment.id = $1`,
        [commentId, `outbox:${eventId}`],
      );
      expect(result.rows[0]).toEqual({
        event_outcome: "succeeded",
        operation_status: "succeeded",
        provider_operation_id: "reply-container-success",
        provider_post_id: "reply-post-success",
        replied: true,
        reply_error: null,
        reply_status: "succeeded",
      });
    });
  });

  it("reconciles an ambiguous reply without posting twice", async () => {
    const eventId = "automation-integration-reply-reconcile";
    const commentId = "80000000-0000-4000-8000-000000000001";
    await runSystemTransaction(env, async (client) => {
      await client.query("DELETE FROM provider_operations WHERE comment_id = $1", [commentId]);
      await client.query("DELETE FROM async_job_events WHERE event_key = $1", [
        `outbox:${eventId}`,
      ]);
      await client.query(
        `UPDATE comments
         SET reply_text = 'Ambiguous integration reply',
             reply_status = 'queued', replied = false, reply_error = NULL,
             reply_provider_operation_id = NULL,
             reply_provider_post_id = NULL, reply_attempt_count = 0,
             reply_reconciliation_attempt_count = 0,
             reply_lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND org_id = $2`,
        [commentId, organizationId],
      );
    });
    const message = {
      ...outboxMessage(eventId, commentId, "comment.reply.requested"),
      payload: { comment_id: commentId },
    } as const;
    const reply = vi.fn(async () => ({
      failure: {
        classification: "ambiguous" as const,
        code: "reply_publish_ambiguous",
        message: "safe placeholder",
        retryable: false,
      },
      outcome: "unknown" as const,
      providerOperationId: "reply-container-reconcile",
    }));
    const lookupPublication = vi.fn(async () => ({
      result: {
        outcome: "confirmed_success" as const,
        providerOperationId: "reply-container-reconcile",
        providerPostId: "reply-post-reconciled",
      },
      state: "published" as const,
    }));
    const dependencies = {
      decryptToken: async (value: string) => `decrypted:${value}`,
      providerRegistry: youtubeReplyRegistry(reply, lookupPublication),
    };

    // The retryable reply failure surfaces as a classified AutomationJobError:
    // RetryableJobError keeps the original error name on its `cause` field.
    const failure = await Effect.runPromise(
      Effect.flip(processReplyMessage(env, message, dependencies)),
    );
    expect(failure).toBeInstanceOf(RetryableJobError);
    expect(failure).toMatchObject({ cause: "RetryableReplyError" });
    await expect(Effect.runPromise(processReplyMessage(env, message, dependencies))).resolves.toBe(
      "processed",
    );
    expect(reply).toHaveBeenCalledOnce();
    expect(lookupPublication).toHaveBeenCalledOnce();
    await runSystemTransaction(env, async (client) => {
      const result = await client.query<{
        reply_attempt_count: number;
        reply_provider_post_id: string;
        reply_reconciliation_attempt_count: number;
        reply_status: string;
      }>(
        `SELECT reply_status, reply_provider_post_id,
                reply_attempt_count, reply_reconciliation_attempt_count
         FROM comments WHERE id = $1`,
        [commentId],
      );
      expect(result.rows[0]).toEqual({
        reply_attempt_count: 1,
        reply_provider_post_id: "reply-post-reconciled",
        reply_reconciliation_attempt_count: 1,
        reply_status: "succeeded",
      });
    });
  });

  // Scheduling a real authenticated Post must publish that Distribution and
  // durable outcome, regardless of unrelated due events or global relay order.
  it("publishes from the authenticated API through PostgreSQL and the outbox Queue", async () => {
    const idempotencyKey = "automation-integration-black-box-publish";
    const queuedMessages: OutboxMessage[] = [];
    const queueSend = vi.fn(async (batch: { body: unknown }[]) => {
      for (const entry of batch) queuedMessages.push(entry.body as OutboxMessage);
    });
    const publish = vi.fn(async () => ({
      outcome: "confirmed_success" as const,
      providerOperationId: "black-box-operation",
      providerPostId: "black-box-post",
      providerUrl: "https://provider.example/posts/black-box-post",
    }));
    const registry = youtubeRegistry(publish);
    const app = createApiApp({
      coreService: createCoreApiService(registry.capabilities()),
      providerRegistry: registry,
      // The seeded Alpha actor: subject is the Better Auth user id, claims carry
      // the internal workspace UUID + admin role that tenant RLS consumes.
      resolveActor: async () => ({
        authUserId: "auth_user_local_alpha",
        claims: {
          organizationId,
          organizationRole: "admin",
          subject: "auth_user_local_alpha",
          userId,
        },
        displayName: "Alpha Creator",
        email: "alpha@meltiply.local",
        isInstallationOwner: false,
        role: "admin",
        userId,
        workspace: {
          id: organizationId,
          name: "Alpha Studio",
          slug: "alpha-studio",
        },
      }),
      verifyJwtToken: async () => alphaIdentity,
    });
    const automationEnv = {
      ...env,
      YOUTUBE_PUBLISH_QUEUE: {
        sendBatch: queueSend,
      } as unknown as Queue<unknown>,
    } satisfies AutomationEnv;
    let distributionId: string | undefined;
    let postId: string | undefined;

    try {
      // The Post-owned API composes before it schedules: create attaches the
      // canonical image to a new Post, then scheduling targets the seeded
      // YouTube Channel with the same per-Channel overrides the retired
      // asset-scoped create accepted.
      const created = await app.request(
        "/api/v1/posts",
        {
          body: JSON.stringify({
            attachment_ids: [seededAlphaAssetId],
            brand_profile_id: seededAlphaProfileId,
            default_text: "Black-box integration caption",
            title: "Black-box integration post",
          }),
          headers: {
            Authorization: bearerAuthorization,
            "Content-Type": "application/json",
            "Idempotency-Key": `${idempotencyKey}-post`,
          },
          method: "POST",
        },
        apiEnv,
      );
      expect(created.status).toBe(201);
      const createdPost = (await created.json()) as { id: string };
      postId = createdPost.id;

      const accepted = await app.request(
        `/api/v1/posts/${postId}/schedule`,
        {
          body: JSON.stringify({
            brand_profile_id: seededAlphaProfileId,
            scheduled_at: null,
            targets: [
              {
                attachment_ids: [seededAlphaAssetId],
                description_override: "Black-box integration description",
                hashtags: ["blackbox"],
                platform_account_id: "50000000-0000-4000-8000-000000000001",
                title_override: "Black-box integration title",
              },
            ],
          }),
          headers: {
            Authorization: bearerAuthorization,
            "Content-Type": "application/json",
            "Idempotency-Key": `${idempotencyKey}-schedule`,
            "X-Request-ID": "black-box-request",
          },
          method: "POST",
        },
        apiEnv,
      );
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("X-Request-ID")).toBe("black-box-request");
      const scheduledPost = (await accepted.json()) as {
        distributions: { id: string; status: string }[];
      };
      const scheduled = scheduledPost.distributions[0];
      expect(scheduled?.status).toBe("queued");
      distributionId = scheduled?.id;

      await runSystemTransaction(env, (client) =>
        client.query(
          `UPDATE outbox_events
           SET available_at = '2000-01-01T00:00:00Z'
           WHERE aggregate_id = $1
             AND topic = 'distribution.publish.requested'`,
          [distributionId],
        ),
      );
      await runRelay(automationEnv, 100);
      const publicationMessage = queuedMessages.find(
        (message) => message.aggregate_id === distributionId,
      );
      if (!publicationMessage) {
        throw new Error("The scheduled Distribution did not reach its publish Queue");
      }

      await expect(
        Effect.runPromise(
          processDistributionMessage(automationEnv, publicationMessage, {
            decryptToken: async () => "black-box-access-token",
            mediaFor: async (request) => ({
              contentType: request.contentType,
              fileSize: request.fileSize,
              mode: "remote_ingest",
              url: "https://r2.example/black-box-signed-object",
            }),
            providerRegistry: registry,
          }),
        ),
      ).resolves.toBe("processed");
      expect(publish).toHaveBeenCalledOnce();

      const completed = await app.request(
        `/api/v1/distributions/${distributionId}`,
        {
          headers: { Authorization: bearerAuthorization },
        },
        apiEnv,
      );
      expect(completed.status).toBe(200);
      await expect(completed.json()).resolves.toMatchObject({
        id: distributionId,
        platform_post_id: "black-box-post",
        platform_url: "https://provider.example/posts/black-box-post",
        status: "published",
      });

      const durableEvidence = await runSystemTransaction(env, (client) =>
        client.query<{
          event_outcome: string;
          operation_status: string;
          outbox_state: string;
        }>(
          `SELECT event.outcome AS event_outcome,
                  operation.status AS operation_status,
                  outbox.state AS outbox_state
           FROM outbox_events AS outbox
           JOIN async_job_events AS event
             ON event.event_key = 'outbox:' || outbox.id::text
           JOIN provider_operations AS operation
             ON operation.distribution_id = outbox.aggregate_id
           WHERE outbox.aggregate_id = $1`,
          [distributionId],
        ),
      );
      expect(durableEvidence.rows).toEqual([
        {
          event_outcome: "succeeded",
          operation_status: "succeeded",
          outbox_state: "published",
        },
      ]);
    } finally {
      await runSystemTransaction(env, async (client) => {
        // The create and schedule calls each reserved an idempotency key whose
        // recorded response holds the ids cleanup needs on a partial failure:
        // the Post id on the create response and the materialized Distribution
        // id on the schedule response's distributions list.
        const resolvedPostId =
          postId ??
          (
            await client.query<{ id: string | null }>(
              `SELECT response_body->>'id' AS id
               FROM idempotency_keys
               WHERE idempotency_key = $1`,
              [`${idempotencyKey}-post`],
            )
          ).rows[0]?.id;
        const ids = distributionId
          ? [distributionId]
          : (
              await client.query<{ id: string | null }>(
                `SELECT (response_body->'distributions'->0)->>'id' AS id
                 FROM idempotency_keys
                 WHERE idempotency_key = $1`,
                [`${idempotencyKey}-schedule`],
              )
            ).rows
              .map((row) => row.id)
              .filter((id): id is string => id !== null);
        if (ids.length > 0) {
          await client.query("DELETE FROM async_job_events WHERE aggregate_id = ANY($1::uuid[])", [
            ids,
          ]);
          await client.query(
            "DELETE FROM provider_operations WHERE distribution_id = ANY($1::uuid[])",
            [ids],
          );
          await client.query("DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])", [
            ids,
          ]);
          await client.query("DELETE FROM distributions WHERE id = ANY($1::uuid[])", [ids]);
          await client.query(
            `UPDATE usage_records
             SET distributions = GREATEST(distributions - $2, 0),
                 updated_at = now()
             WHERE org_id = $1 AND period = to_char(now(), 'YYYY-MM')`,
            [organizationId, ids.length],
          );
        }
        if (resolvedPostId) {
          await client.query("DELETE FROM posts WHERE id = $1", [resolvedPostId]);
        }
        const cleanupKeys = [
          idempotencyKey,
          `${idempotencyKey}-post`,
          `${idempotencyKey}-schedule`,
        ];
        await client.query("DELETE FROM idempotency_keys WHERE idempotency_key = ANY($1::text[])", [
          cleanupKeys,
        ]);
      });
    }
  });
});
