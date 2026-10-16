// Workspace storage Entitlement accounting for issue #284, proven through the
// consumer-visible seams only: the authenticated API app (upload sessions,
// finalization, Post drafts and scheduling) and the automation AssetJobProcessor
// (output-capacity reservation, orphan reclamation, usage reconciliation), both
// against the real PostgreSQL schema and one bucket double that holds real
// bytes.
//
// Every case drives a real transition and reads the outcome back through the
// HTTP status/error envelope, the public `GET /api/v1/billing/usage` counters,
// and durable storage accounting. No SQL text, source text, or echoed request is
// asserted. Byte arithmetic is exact on purpose: the plan cap is known and every
// fixture size is chosen to land on a boundary, so a case proves *which* bytes
// are charged instead of only proving that something is non-zero.
//
// Isolation: both workspaces are created by this file and dropped in `afterAll`,
// so no seeded organization is mutated by these cases. The maintenance sweep is
// global by design, so the one seeded row another suite deliberately leaves due
// for it is snapshotted and restored here as well.
//
// The native media engine is replaced only at its documented external boundary
// (`env.MEDIA_PROCESSOR`). The double performs no media optimization and reports
// only facts measured from the bytes actually stored, so capacity accounting can
// be observed without asserting anything about optimization quality.
import { createHash } from "node:crypto";

import type { JwtIdentity } from "@meltiply/auth";
import type { components } from "@meltiply/contracts/schema";
import type { Queryable } from "@meltiply/database";
import {
  ASSET_UPLOAD_POLICY,
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
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

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
type UsageResponse = Schemas["BillingSummary"];

const connectionString = process.env.MELTIPLY_DATABASE_TEST_URL;
if (!connectionString) {
  throw new Error("MELTIPLY_DATABASE_TEST_URL is required for PostgreSQL integration suites");
}
const describeIntegration = describe;

// The seeded local user is only the uploader identity on fixture rows; the
// workspaces themselves belong to this file.
const seededUserId = "10000000-0000-4000-8000-000000000001";

/**
 * The plan limit every case here is measured against. `free` is the smallest
 * Entitlement set the product defines, and the fixture workspaces run on that
 * plan with an active billing status, so the enforced numbers are the plan's
 * own rather than an invented quota.
 *
 * The plan exposes a nullable cap: `null` means unmetered. The boundary cases
 * only mean anything against a finite limit, so this module declares the
 * prerequisite it actually needs and fails the suite loudly rather than
 * measuring against a cap that does not exist.
 */
const storageCap = (() => {
  const cap = COMMUNITY_LIMITS.max_storage_bytes;
  if (cap === null || !Number.isFinite(cap) || cap <= 0) {
    throw new Error("the free plan must define a finite storage cap for the quota boundary cases");
  }
  return cap;
})();

/** Real payload size used by every probe upload. */
const probeBytes = 8192;

/**
 * The per-media-type upload ceiling the product accepts, read from the same
 * media rules the upload and processing paths enforce. Normalization can
 * legitimately produce larger bytes, so a processing run reserves this ceiling
 * rather than the uploaded size, and the concurrency case needs the real number
 * rather than a hardcoded one.
 */
function mediaCeiling(contentType: string): number {
  const ceiling = mediaUploadMaximum(contentType);
  if (ceiling === null) {
    throw new Error(`${contentType} must declare an upload ceiling`);
  }
  return ceiling;
}

/** Largest accepted image, used to fill a baseline and to size a reservation. */
const imageCeilingBytes = mediaCeiling("image/png");

const apiEnv = {
  ALLOWED_ORIGINS: "http://localhost:3000",
  DB_AUTHENTICATED: { connectionString } as Hyperdrive,
  DB_SYSTEM: {
    connectionString:
      "postgres://meltiply_system:meltiply-system-local@127.0.0.1:5433/meltiply?sslmode=disable",
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

/**
 * Platform capabilities this workspace schedules against.
 *
 * Scheduling validates the resolved media against the target Platform's
 * capability before it accepts a Distribution, and an unconfigured registry
 * reports every Platform as `publish: false`. Scheduling is therefore measured
 * against the Threads capability the Channel actually owns — the real one,
 * not the unconfigured stub — so a refused schedule proves what the
 * attachment's media was worth rather than which Platforms are configured.
 */
const capabilities = new ProviderRegistry()
  .capabilities()
  .map((capability) =>
    capability.platform === "threads" ? { ...capability, publish: true } : capability,
  );

/**
 * Real SigV4 signer for upload capabilities. The cases below parse the minted
 * URLs — the signature timestamp and X-Amz-Expires must be real SigV4 output,
 * not a doubled string, or a deadline claim could never outlive a persisted
 * `write_hold_until` without this suite noticing.
 */
const uploadSigner = new R2SigV4Signer({
  accessKeyId: "quota-test-access-key",
  accountId: "quota-test-account",
  bucket: r2BucketName,
  secretAccessKey: "quota-test-secret-key",
});

/**
 * One deferred sign boundary a case can hold open: the next capability mint
 * reports `entered` and then waits for `release` before the real signer runs.
 *
 * The latch models the async gap between the API deciding to issue a grant
 * and the signature actually being computed — the interval in which a stale
 * read or a cancelled session used to mint a URL past its recorded deadline.
 * One gate exists at a time because specs run serially.
 */
interface SignGate {
  entered: Promise<void>;
  release(): void;
}

let pausedSign: { notify(): void; wait: Promise<void> } | undefined;

/** Pauses the next upload capability mint until the returned gate is released. */
function pauseNextUploadSign(): SignGate {
  if (pausedSign) {
    throw new Error("a deferred sign gate is already armed");
  }
  // The repository compiles against lib ES2023, so the deferred pattern is
  // spelled out rather than using Promise.withResolvers.
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

/** Applies the armed deferral latch before the real signer runs. */
async function gateUploadSign(): Promise<void> {
  const gate = pausedSign;
  pausedSign = undefined;
  if (gate) {
    gate.notify();
    await gate.wait;
  }
}

/**
 * Runs one real signing call behind the deferral latch, mapping signer
 * rejections onto the typed error channel the production boundary maps to.
 */
function signedUploadCall<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({
    catch: (cause) =>
      cause instanceof InvalidRequestError
        ? cause
        : new InvalidRequestError({
            message: cause instanceof Error ? cause.message : "Failed to sign an upload capability",
          }),
    try: async () => {
      await gateUploadSign();
      return operation();
    },
  });
}

/**
 * Waits on the real platform clock for a bounded, deliberate interval.
 *
 * Deterministic time control cannot work here: the API computes `expires_at`
 * and PostgreSQL persists `write_hold_until` from the platform clock inside
 * code paths this suite cannot inject a clock into. A late signature must
 * therefore be genuinely late — the pause is what makes a relative-TTL mint
 * observably outlive the declared deadline instead of differing by an
 * unmeasurable millisecond.
 */
function platformDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Reads the absolute expiry a real SigV4 URL commits to: the signature's own
 * timestamp plus its X-Amz-Expires seconds.
 */
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

/**
 * The absolute deadline a signed upload capability commits to, bounded on both
 * sides around the `expires_at` the API declared for that grant.
 *
 * SigV4 has no millisecond resolution, so a URL's deadline is quantized twice:
 * `X-Amz-Date` is truncated to whole seconds, and the signer floors
 * `X-Amz-Expires` against the deadline it was handed. Both quantizations only
 * ever move the URL's deadline *earlier*, so a URL can never outlive the
 * declared expiry — which is exactly what the durable write hold relies on.
 * Being earlier is not free, though: the gap between the two instants is the
 * two truncations plus whatever elapsed between recording the deadline and
 * running the signature, so it is bounded below by quantization and above by
 * quantization plus scheduling delay, never by zero.
 *
 * Asserting a signed deadline equal the declared expiry would therefore be
 * asserting that millisecond arithmetic survives a whole-second protocol. These
 * bounds keep the assertion meaningful in both directions: the grant must
 * never outlive the expiry the API persisted, and it must never be shortened
 * past the point where it can no longer represent the recorded window.
 *
 * @param url - Signed upload capability to parse.
 * @param declaredExpiresAtMs - `expires_at` the API declared for the grant.
 * @returns The deadline the URL commits to, in milliseconds.
 */
function signedGrantDeadlineMs(url: string, declaredExpiresAtMs: number): number {
  const deadline = signedUrlDeadlineMs(url);
  expect(deadline).toBeLessThanOrEqual(declaredExpiresAtMs);
  expect(deadline).toBeGreaterThan(declaredExpiresAtMs - 2_000);
  return deadline;
}

/**
 * Runs one bucket-double operation behind the storage service, failing on the
 * typed channel the real storage service uses.
 *
 * The production driver maps every bucket rejection onto a typed
 * `StorageUnavailableError` — `wrapMultipartUpload` does exactly that for the
 * multipart operations — and the API branches on that type rather than on
 * "something went wrong": a multipart abort the bucket never confirmed is an
 * ambiguous outcome that keeps its writer hold and still answers 204, while
 * only a missing signer is a hard failure. Modelling an injected abort
 * rejection as a defect would instead let it escape as a 500 and misattribute
 * a deliberately injected, expected outcome to a crash.
 */
function bucketOperation<A>(
  operation: () => Promise<A>,
): Effect.Effect<A, StorageUnavailableError> {
  return Effect.tryPromise({
    catch: (cause) =>
      new StorageUnavailableError({
        message:
          cause instanceof Error
            ? cause.message
            : "The object storage operation could not be completed.",
      }),
    try: operation,
  });
}

/**
 * Storage layer shared by the API worker, backed by the same bucket double the
 * automation worker uses, so bytes written through one seam are immediately
 * observable through the other.
 */
const storageServiceLayer = createStorageServiceTest({
  createMultipartUpload: (key, contentType) =>
    Effect.sync(() => {
      // The native upload id must be the same one the part/abort closures
      // address and the test injects failures for: the API persists this
      // property as `multipart_upload_id`, so a missing or divergent value
      // would leave the session row violating its own shape constraint.
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
  // The write capabilities are minted by the real SigV4 signer so their
  // X-Amz-Date/X-Amz-Expires deadline can be compared against the durable
  // write hold; the latch can pause one mint to make a late signature
  // genuinely late rather than a microsecond of scheduling noise.
  signMultipartPart: (request) => signedUploadCall(() => uploadSigner.signMultipartPart(request)),
  signUpload: (request) => signedUploadCall(() => uploadSigner.signUpload(request)),
});

const assetService = createAssetApiService({ storageServiceLayer });
const coreService = createCoreApiService(capabilities);
const postService = createPostApiService(capabilities);

// ---------------------------------------------------------------------------
// Bucket double
// ---------------------------------------------------------------------------

/** One stored object: real bytes plus the media type a real HEAD would report. */
interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

const objects = new Map<string, StoredObject>();
const deletedKeys: string[] = [];
const abortedUploads: string[] = [];
const deleteFailures = new Set<string>();
/** Native upload ids whose abort call must fail, modelling an unconfirmed external abort. */
const abortFailures = new Set<string>();

/** Hex SHA-256 of stored bytes, the digest object storage reports for a write. */
function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic ETag derived from the real payload identity. */
function etagOf(bytes: Uint8Array): string {
  return `"${bytes.length.toString(16)}-${digestOf(bytes).slice(0, 16)}"`;
}

/**
 * Live metadata for one key, or null when the object is genuinely absent.
 *
 * Object availability is always answered from the byte map, so a claim that
 * bytes were reclaimed is checkable against the same map both workers write.
 */
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

/** Writes real bytes into the bucket double. */
function putObject(key: string, bytes: Uint8Array, contentType: string): void {
  objects.set(key, { bytes, contentType });
}

/**
 * Conditional copy inside the bucket double.
 *
 * Both guards behave as object storage does: a source ETag that no longer
 * matches, and a destination that already exists, both decline the copy and
 * return null, which is what lets a replayed promotion adopt the existing object
 * instead of rewriting it.
 */
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

/** Removes an object, recording the attempt unless a failure is injected. */
function removeObject(key: string): void {
  if (deleteFailures.has(key)) {
    throw new Error(`injected delete failure for ${key}`);
  }
  deletedKeys.push(key);
  objects.delete(key);
}

/** Uploaded part ranges per staging key, shared across handles of one upload. */
const multipartParts = new Map<string, Map<number, Uint8Array>>();

/**
 * Multipart upload over the byte map. Parts are real byte ranges, `complete`
 * assembles them into one real object, and `abort` records that the parts were
 * reclaimed in the bucket rather than merely forgotten by the database. An
 * upload id listed in `abortFailures` rejects instead of confirming, so a
 * cancelled upload whose external abort never landed is observable as a
 * retained charge rather than a released one.
 */
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

/**
 * Promise-shaped ObjectStore for the automation worker, sharing the byte map
 * with the API's storage layer.
 */
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

// ---------------------------------------------------------------------------
// Native processor boundary double
// ---------------------------------------------------------------------------

/**
 * How the engine boundary behaves for one case. `original_compatible` reports a
 * verified no-benefit verdict measured from the stored bytes, so no second copy
 * of the media is fabricated and nothing is stored; `retryable_failure` reports a
 * transient container failure, which leaves the reserved output capacity
 * inventoried so a competing claim can be observed against it.
 */
type EngineMode = "original_compatible" | "retryable_failure";

let engineMode: EngineMode = "original_compatible";
const engineInvocations: string[] = [];

/**
 * Absolute deadline each minted output capability committed to, parsed from the
 * URL the engine boundary actually received. The grant is what the inventory
 * row's `write_hold_until` must bound, so the case compares the real signed
 * deadline against the persisted hold rather than trusting a planned TTL.
 */
const engineOutputDeadlines: number[] = [];

/**
 * Native processor boundary double.
 *
 * It receives exactly the two signed capabilities the production adapter mints,
 * reads the input grant, and reports a verdict built from the bytes it actually
 * read. Real FFmpeg/libvips proof is a separate concern; nothing in this file
 * depends on an optimization claim.
 */
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

const mediaProcessorNamespace = {
  get: () => ({ process: (job: NativeProcessorJob) => runEngine(job) }),
  idFromName: (name: string) => name,
} as unknown as AutomationEnv["MEDIA_PROCESSOR"];

const assetProcessor = createAssetJobProcessor(
  { ...automationEnv, MEDIA_PROCESSOR: mediaProcessorNamespace },
  automationObjectStore,
);

// ---------------------------------------------------------------------------
// Workspaces owned by this file
// ---------------------------------------------------------------------------

/** One isolated workspace: identity, Brand Profile, Channel, and its app. */
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

/**
 * Builds one isolated workspace and the API app that authenticates as its admin.
 *
 * Each studio owns its durable identity, so no seeded organization is read or
 * written by these cases; the whole workspace (assets, reservations, usage rows,
 * posts) is removed again in `afterAll`.
 */
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
        role: "admin",
        userId: seededUserId,
        workspace: {
          id: organizationId,
          isPersonal: false,
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

/**
 * Durable rows that make a studio a real, usable workspace: the organization on
 * the plan under test, its admin membership, its Brand Profile, and (for the
 * lifecycle studio) one connected Channel to schedule at.
 */
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
    // Usage reconciliation is driven by this table; starting it already due lets
    // the maintenance sweep reconcile this workspace on demand.
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

// ---------------------------------------------------------------------------
// Database and HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Runs a Promise-style fixture body inside the Effect system transaction.
 *
 * The Effect client's `query` is unwrapped to a `Queryable` facade so bodies keep
 * their natural shape while the transaction lifecycle stays on
 * `withSystemTransactionEffect`.
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
  replayed: boolean;
  status: number;
}

let requestCounter = 0;

/** Unique idempotency key so repeated cases never replay one another's response. */
function nextKey(prefix: string): string {
  requestCounter += 1;
  return `upload-quota-${prefix}-${requestCounter}`;
}

/** Calls one studio as its actor; returns status/replay evidence and untrusted JSON, or null for a non-JSON body. */
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

/** Reads the canonical error envelope's code and message. */
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

/** Reads the ordered attachment ids out of a Post projection. */
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

/** Public usage counters and limits as a creator's billing view would read them. */
async function publicUsage(studio: Studio): Promise<UsageResponse> {
  const response = await api(studio, "/api/v1/billing/usage");
  expect(response.status).toBe(200);
  return response.body as UsageResponse;
}

// ---------------------------------------------------------------------------
// Storage accounting observations
// ---------------------------------------------------------------------------

/**
 * Bytes a workspace currently owes storage for, using the same authoritative
 * rule the API charges, `reserveOutputs` reserves against, and the settlement
 * releases: every non-deleted object row contributes
 * `GREATEST(COALESCE(bytes, 0), COALESCE(reserved_bytes, 0))`, plus every live
 * upload reservation.
 *
 * GREATEST and not a sum because one physical key cannot hold its old and its
 * replacement bytes simultaneously: a row that recorded measured output while
 * still holding its planned reservation stays charged at the larger of the two
 * until promotion or settlement releases it.
 *
 * A cancelled, expired, or rejected upload therefore stays charged here until
 * its external delete settles — the bytes move from the reservation onto the
 * staged row rather than disappearing — which is exactly the continuity this
 * suite asserts.
 *
 * Read alongside a behavioral assertion (a refusal at a known boundary, or a
 * public counter transition) rather than instead of one.
 */
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

/** Live upload reservations of one workspace, oldest first. */
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

/** Durable lifecycle facts of one Asset. */
async function assetState(assetId: string) {
  return systemTransaction(async (client) => {
    const result = await client.query<{
      failure_code: string | null;
      status: string;
    }>("SELECT status, failure_code FROM assets WHERE id = $1", [assetId]);
    return result.rows[0]!;
  });
}

/** Every inventoried object row of one Asset, ordered for stable comparison. */
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A genuine PNG payload of an exact byte length: signature, IHDR with real
 * dimensions, and filler, so a real decoder sees a valid image header and the
 * bucket reports the size the session reserved.
 */
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

/** Durable identities of one created upload session. */
interface BegunUpload {
  assetId: string;
  /** Deadline the API declared for the issued PUT grant; null for multipart. */
  grantExpiresAt: Date | null;
  /** Real signed PUT URL returned to the client; null for multipart sessions. */
  grantUrl: string | null;
  objectKey: string;
  sessionId: string;
  /** The strategy the route committed the session to, per UploadSession. */
  strategy: "single" | "multipart";
}

/** Body of one upload-session request, shaped as the public route accepts it. */
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

/** Requests one upload session without asserting the outcome. */
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

/**
 * Creates an upload session through the public route and returns its durable
 * identities. No bytes are written yet, so the case decides when (and whether)
 * the object lands.
 */
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

/** Uploads real bytes at the session's staging key, exactly as a client would. */
function landBytes(upload: BegunUpload, bytes: Uint8Array): void {
  putObject(upload.objectKey, bytes, "image/png");
}

/** Finalizes a session through the public route. */
function finalizeUpload(studio: Studio, upload: BegunUpload): Promise<ApiResponse> {
  return api(studio, `/api/v1/asset-upload-sessions/${upload.sessionId}/complete`, {
    body: {},
    idempotencyKey: nextKey("complete"),
    method: "POST",
  });
}

/**
 * Uploads, lands real bytes, and finalizes one image, so a case starts from an
 * Asset whose real storage is already charged.
 */
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

/** Reads the durable outbox event id written for one Asset lifecycle transition. */
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

/** Builds the queue message the relay would deliver for one outbox event. */
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

/** Delivers one Asset lifecycle event and reports how the delivery ended. */
async function deliver(message: OutboxMessage): Promise<"failed" | "processed" | "skipped"> {
  const exit = await Effect.runPromiseExit(assetProcessor.process(message));
  return Exit.isSuccess(exit) ? exit.value : "failed";
}

/** Delivers the processing event the upload finalization enqueued. */
async function deliverProcessing(studio: Studio, assetId: string) {
  const eventId = await lifecycleEventId(assetId, "asset.processing.requested");
  return deliver(
    outboxMessage(eventId, assetId, studio.organizationId, "asset.processing.requested"),
  );
}

/** Delivers the deletion event the ownership-aware sweep armed. */
async function deliverDeletion(studio: Studio, assetId: string) {
  const eventId = await lifecycleEventId(assetId, "asset.deletion.requested");
  return deliver(
    outboxMessage(eventId, assetId, studio.organizationId, "asset.deletion.requested"),
  );
}

/** Runs the automation maintenance sweep (orphan claim, reclamation, usage). */
function runMaintenance() {
  return Effect.runPromise(assetProcessor.runMaintenance());
}

/** Resident bytes installed per object kind, so each kind's charge is checkable. */
interface ResidentInventory {
  original: number;
  rendition: number;
  thumbnail: number;
}

/**
 * Fills a workspace's resident storage to an exact byte total.
 *
 * The rows are ordinary originals, thumbnails, and renditions on dedicated
 * fixture Assets: they are the durable inventory the Entitlement check reads, so
 * a case can place the workspace a known number of bytes below its plan limit
 * and observe exactly where the next reservation is refused. Seeded rows carry
 * no bucket bytes and no case here makes an object-availability claim about
 * them; every availability claim is about bytes this file uploaded itself.
 *
 * @param studio - Workspace to fill.
 * @param totalBytes - Exact number of resident bytes to install.
 * @returns Per-kind byte totals actually installed.
 */
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

/**
 * Removes everything one studio owns and reinstalls an exact resident baseline,
 * so the next case starts from a known distance below the plan limit without
 * touching any other workspace.
 */
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

/**
 * Reclaims one seeded derived object and reports the bytes its removal released.
 *
 * A derived object is ordinary inventory, so reclaiming it must free exactly its
 * own size and nothing else: that is what distinguishes a real per-object charge
 * from a row that merely exists.
 */
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

/**
 * Moves an Asset's seven-day orphan deadline into the past so the
 * ownership-aware sweep considers it, without waiting seven real days.
 */
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

/**
 * Moves a session's expiry into the past. Expiry is the only clock the session
 * expiry sweep compares against, so this is its deterministic control.
 */
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

/** Reads a session's own expiry: the deadline that is not a signed grant's. */
async function sessionExpiry(sessionId: string): Promise<Date> {
  return systemTransaction(async (client) => {
    const result = await client.query<{ expires_at: Date }>(
      "SELECT expires_at FROM asset_upload_sessions WHERE id = $1",
      [sessionId],
    );
    return result.rows[0]!.expires_at;
  });
}

/** Makes a workspace due for usage reconciliation again. */
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

/**
 * Closes the writer window a cancelled upload's still-valid signed grant has.
 *
 * Reclamation is deliberately not due while that window is open: the durable
 * hold an upload leaves behind runs to its session's own expiry, which is the
 * last instant a signed PUT can fire. Both durable markers of that hold are moved
 * into the past here, expressing "the writer window has closed" without
 * restating any specific grant lifetime.
 */
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

// The seeded abandoned upload another suite leaves due for the orphan sweep. The
// maintenance sweep is global, so its state is restored after this suite runs.
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

  // Remove only this suite's workspaces and restore the seeded sweep candidate,
  // binding the two organization ids as one PostgreSQL UUID-array parameter.
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

    // Two reservations of one payload each reach the plan limit exactly. The
    // staging inventory rows carry no bytes of their own, so the same two uploads
    // would already have been refused had the reservation been charged twice.
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
    expect(errorOf(refused.body).message).toMatch(/storage limit/i);

    // The refusal is stable: repeating it grants nothing and changes nothing.
    const repeated = await requestUpload(reservationStudio, {
      fileSize: probeBytes,
      title: "One payload too many again",
    });
    expect(repeated.status).toBe(422);
    expect(errorOf(repeated.body)).toEqual(errorOf(refused.body));
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(BigInt(storageCap));
    expect((await liveReservations(reservationStudio.organizationId)).length).toBe(2);

    // Derived objects are charged storage, not just inventory: reclaiming one
    // thumbnail frees exactly its own bytes, which is precisely what turns a
    // previously refused upload into an admitted one.
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
    // Only the thumbnail's own bytes came back, so only a payload of that size
    // fits again: the workspace returns to exactly the plan limit.
    const afterReclaim = await requestUpload(reservationStudio, {
      fileSize: baseline.thumbnail,
      title: "Fits once the thumbnail is reclaimed",
    });
    expect(afterReclaim.status).toBe(201);
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(BigInt(storageCap));
  });

  it("admits exactly one of two concurrent reservations at the plan limit", async () => {
    await resetStudio(reservationStudio, storageCap - probeBytes);

    // Two creators racing for the last payload of the plan. Serialized accounting
    // admits one; unsynchronized accounting would admit both and oversubscribe
    // Entitlements by a whole payload.
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

    // Exactly one claim survives: one live reservation, and the refused attempt
    // inserted no Asset or session at all.
    const reservations = await liveReservations(reservationStudio.organizationId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.state).toBe("reserved");
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(BigInt(storageCap));

    // The admitted reservation is a real capacity claim: the winner can land and
    // finalize its bytes.
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

    // Settlement moves the same bytes from reservation to resident storage: the
    // charge is unchanged and never counted twice.
    expect(await chargedBytes(reservationStudio.organizationId)).toBe(BigInt(storageCap));
    expect((await liveReservations(reservationStudio.organizationId)).length).toBe(0);

    // With the plan exactly full, the next payload is still refused.
    const afterFull = await requestUpload(reservationStudio, {
      fileSize: 1,
      title: "Nothing left",
    });
    expect(afterFull.status).toBe(422);
    expect(errorOf(afterFull.body).code).toBe("quota_exceeded");
  });

  it("keeps a saved draft's ready media charged under the same plan limit", async () => {
    // A processed Asset holds three charges for one uploaded file: the retired
    // staging copy, the protected original copied out of it, and the media
    // type's own upload ceiling, which the output reservation keeps charged for
    // the window its create-only write grant is still live — normalization can
    // legitimately produce more bytes than were uploaded, so the reservation is
    // the ceiling rather than the payload. The baseline therefore leaves room
    // for two payloads plus a full ceiling, and one extra payload is the
    // headroom this case then spends to the byte: with the ceiling claimed
    // exactly, what remains is what the creator can still store.
    await resetStudio(lifecycleStudio, storageCap - 3 * probeBytes - imageCeilingBytes);

    const usageBefore = await publicUsage(lifecycleStudio);
    const ready = await uploadReadyImage(lifecycleStudio, "Draft attachment");

    // Finalization is a real accounting transition the billing view can see: the
    // verified bytes are counted for the period they landed in.
    const usageAfterUpload = await publicUsage(lifecycleStudio);
    expect(usageAfterUpload.usage.storage_bytes).toBe(usageBefore.usage.storage_bytes + probeBytes);

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

    // The draft retains the bytes, and a saved draft is not an exemption: an
    // upload that only fits if the attachment were free is refused.
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedWithAttachment);
    const refused = await requestUpload(lifecycleStudio, {
      fileSize: headroom + 1,
      title: "Draft exempt attempt",
    });
    expect(refused.status).toBe(422);
    expect(errorOf(refused.body).code).toBe("quota_exceeded");

    // Exactly the remaining headroom fills the plan to the byte.
    const exactFit = await beginUpload(lifecycleStudio, {
      fileSize: headroom,
      title: "Draft exact fit",
    });
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(storageCap));

    // The attachment survives a later save of the same draft and stays charged.
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

    // Cancelling the reservation does not free capacity while the signed grant
    // is still live: the bytes move onto the staged row's reclaim hold.
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

    // Only once the writer window has closed and the external delete settles is
    // the charge released; the draft's media is charged throughout.
    await closeGrantWindow(exactFit.assetId);
    await makeOrphanDue(exactFit.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, exactFit.assetId)).toBe("processed");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedWithAttachment);
    expect((await objectRows(ready.assetId)).some((row) => row.kind === "original")).toBe(true);
  });

  it("reserves output capacity atomically for concurrent processors", async () => {
    // Each processing run promotes its staged upload into the protected
    // original key: the retired staging copy and the promoted original are both
    // charged until the writer window closes, so a promoted upload costs two
    // payloads. A run then reserves the media type's own upload ceiling —
    // normalization can legitimately produce more bytes than were uploaded —
    // which is exactly the capacity the baseline must leave free for one run
    // and must withhold from the second. The baseline therefore covers those
    // two promotions on top of the ceiling.
    await resetStudio(lifecycleStudio, storageCap - 4 * probeBytes - imageCeilingBytes);
    const left = await uploadReadyImage(lifecycleStudio, "Processing left");
    const right = await uploadReadyImage(lifecycleStudio, "Processing right");
    // Promotion has not happened yet: finalization settles each upload's
    // verified bytes onto its staging row, and that row is the only
    // still-writable copy. Two finalized uploads are therefore charged exactly
    // two payloads here, and the whole media ceiling is still free — which is
    // what the first run will claim and the second must be refused for.
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(
      BigInt(storageCap - 2 * probeBytes - imageCeilingBytes),
    );

    // A transient engine failure keeps the reserved output capacity inventoried
    // (the delivery ends "failed" and stays retryable), while the run that could
    // not claim capacity ends durably "processed" with the asset marked failed:
    // a permanent refusal is recorded, not retried forever.
    engineMode = "retryable_failure";
    engineInvocations.length = 0;
    const outcomes = await Promise.all([
      deliverProcessing(lifecycleStudio, left.assetId),
      deliverProcessing(lifecycleStudio, right.assetId),
    ]);
    expect([...outcomes].sort()).toEqual(["failed", "processed"]);

    // Only the run that won the capacity claim invoked the engine.
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
    // The held row is still purely a claim: nothing was produced, so it carries
    // the reservation and no settled bytes. That is what makes the reservation
    // the whole of the charge in this case — and what keeps the two charged-byte
    // expressions in agreement here.
    const heldRow = held[0]!.rows[0]!;
    expect(BigInt(heldRow.reserved_bytes ?? "0")).toBe(BigInt(imageCeilingBytes));
    expect(heldRow.bytes).toBeNull();
    // The output capability the engine actually received commits to the
    // persisted write hold as its absolute deadline: the URL's own signature
    // instant plus X-Amz-Expires can never outlive the window its bytes stay
    // inventoried and charged for.
    expect(engineOutputDeadlines).toHaveLength(1);
    expect(heldRow.write_hold_until).not.toBeNull();
    const outputGrantDeadline = engineOutputDeadlines[0]!;
    expect(outputGrantDeadline).toBeLessThanOrEqual(heldRow.write_hold_until!.getTime() + 1_000);
    expect(heldRow.write_hold_until!.getTime() - outputGrantDeadline).toBeLessThan(10_000);

    // The loser carries the creator-actionable reason instead of retrying
    // forever, and no capacity beyond the plan was ever claimed.
    const loser = await assetState(refused[0]!.assetId);
    expect(loser.status).toBe("failed");
    expect(loser.failure_code).toBe("storage_limit_reached");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(storageCap));

    // Redelivering the refused event changes nothing: the failure is durable and
    // the plan is never charged twice for the same output.
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

    // A rejected save: emptying the Post of both text and attachments is refused
    // and leaves the stored composition untouched.
    const emptied = await api(lifecycleStudio, `/api/v1/posts/${postId}`, {
      body: {
        attachment_ids: [],
        brand_profile_id: lifecycleStudio.profileId,
        default_text: "",
      },
      idempotencyKey: nextKey("authoritative-empty"),
      method: "PATCH",
    });
    expect(emptied.status).toBeGreaterThanOrEqual(400);
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedBefore);

    // A rejected finalization: bytes that do not match the reserved size are
    // not the approved media. The upload fails and its reservation moves onto
    // the staged row's reclaim hold — the object may physically exist, so it
    // stays charged until the external delete settles.
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
    // The landed bytes are physically still in the bucket, which is exactly
    // why their charge is held rather than released at refusal time. The hold
    // is the deadline the issued PUT grant was signed with — the URL can still
    // legally write until then — not the session's longer expiry.
    expect(objects.has(mismatched.objectKey)).toBe(true);
    expect(rejectedRow.write_hold_until).not.toBeNull();
    expect(
      Math.abs(rejectedRow.write_hold_until!.getTime() - mismatched.grantExpiresAt!.getTime()),
    ).toBeLessThanOrEqual(1_000);

    // Reclamation after the writer window closes releases the held bytes, so a
    // rejected upload ends charged nothing at all.
    await closeGrantWindow(mismatched.assetId);
    await makeOrphanDue(mismatched.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, mismatched.assetId)).toBe("processed");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedBefore);
    expect(objects.has(mismatched.objectKey)).toBe(false);

    // A rejected schedule: an attachment with no verified media ready cannot be
    // published, and the refusal names the problem instead of half-scheduling.
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

    // Every rejection left the stored composition, its attachment order, and its
    // per-Channel settings exactly as they were.
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
    // Two real uploads fill the plan exactly, so the held charge of a cancelled
    // upload is observable as a refusal rather than an invisible reservation
    // transfer.
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

    // The bytes are really gone from the bucket, yet the capacity is not back:
    // the signed PUT grant already minted can still recreate them until the
    // deadline it was issued with, so the charge moves onto the staged row's
    // hold. A payload that would only fit if cancelling freed quota is refused.
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

    // Cancelling cannot revoke the minted URL: the hold is the deadline that
    // was actually signed — the ~15-minute grant window the URL itself
    // commits to — never the session's own day-long expiry. The signed deadline
    // is bounded against the declared expiry rather than required to equal it,
    // because SigV4 quantizes it to whole seconds: it may sit up to two seconds
    // earlier, but it must never sit later, since a later deadline is a URL
    // that can outlive the hold its bytes are inventoried under.
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

    // Cancelling again with a fresh request releases nothing a second time.
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

    // The cancelled Asset is durably failed with its actionable reason.
    const cancelledState = await assetState(cancelled.assetId);
    expect(cancelledState.status).toBe("failed");
    expect(cancelledState.failure_code).toBe("upload_aborted");

    // Once the writer window is closed the sweep settles the hold exactly
    // once: the capacity comes back and a new upload takes it.
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

    // A failed remote delete keeps the bytes in the bucket, and the durable
    // reclaim removes them after the writer window has closed — the sibling
    // upload's own reservation is untouched throughout. The grant was minted
    // and never revoked, so the failed cleanup retains the recorded ~15-minute
    // deadline rather than parking the charge for the session's day.
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

    // The read refreshes the PUT grant: it finds the session active, decides a
    // deadline, and then its signing pauses on the latch. The cancel commits in
    // the gap — the exact race a relative TTL would resolve against the later
    // clock — and a real platform-clock delay makes the mint observably late.
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
      // The revalidation under the session lock saw the committed cancel, so
      // the stale read reports the terminal state and exposes no grant at all.
      expect(refreshed).toBeNull();
    } else {
      // The read's deadline was durably recorded before the cancel committed:
      // its mint is bounded by that recorded instant, not extended by how long
      // the signature took — a relative TTL computed at decision time would
      // land ~1.2s beyond the declared expiry.
      expect(refreshed).not.toBeNull();
      expect(signedUrlDeadlineMs(refreshed!.url)).toBeLessThanOrEqual(
        Date.parse(refreshed!.expires_at) + 1_000,
      );
      expect(Date.parse(refreshed!.expires_at)).toBeLessThan(sessionEnds.getTime() - 60_000);
    }

    // Whichever interleaving won, the cancelled upload stays charged for
    // exactly the window of the latest recorded grant — not for the session's
    // day-long expiry — and the sweep settles it exactly once.
    const stagedRow = (await objectRows(upload.assetId))[0]!;
    expect(stagedRow.status).toBe("deleting");
    expect(stagedRow.write_hold_until).not.toBeNull();
    expect(stagedRow.write_hold_until!.getTime()).toBeLessThan(sessionEnds.getTime() - 60_000);
    if (refreshed) {
      expect(signedUrlDeadlineMs(refreshed.url)).toBeLessThanOrEqual(
        stagedRow.write_hold_until!.getTime() + 1_000,
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
    // Two real uploads leave one payload of headroom, so the abandoned
    // session's held charge is observable as a refusal, not just a transfer.
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

    // Time control: the session's own expiry is written into the past, which is
    // the only clock the expiry sweep compares against.
    await expireSession(abandoned.sessionId);
    const next = await beginUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "After expiry",
    });
    expect(next.sessionId).not.toBe(abandoned.sessionId);

    // The expiry released the abandoned reservation — the new upload took its
    // place — but its landed bytes stay charged on the staged row's hold until
    // the external delete settles, so the workspace is still full.
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
    // Expiring the session does not revoke the PUT grant already signed: the
    // staged row's hold is the recorded ~15-minute grant deadline, which still
    // has minutes to run even though the session itself is overdue.
    expect(expiredRow.write_hold_until).not.toBeNull();
    expect(
      Math.abs(expiredRow.write_hold_until!.getTime() - abandoned.grantExpiresAt!.getTime()),
    ).toBeLessThanOrEqual(1_000);

    // The orphan sweep plus the external delete release the held charge — but
    // only once the issued grant's own window has lapsed.
    await closeGrantWindow(abandoned.assetId);
    await makeOrphanDue(abandoned.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, abandoned.assetId)).toBe("processed");
    expect(objects.has(abandoned.objectKey)).toBe(false);
    expect((await assetState(abandoned.assetId)).status).toBe("deleted");
    const chargedAfterReclaim = await chargedBytes(lifecycleStudio.organizationId);
    expect(chargedAfterReclaim).toBe(BigInt(storageCap - probeBytes));

    // Duplicate cleanup releases nothing twice, and the workspace's other
    // resident media is untouched.
    expect(await deliverDeletion(lifecycleStudio, abandoned.assetId)).toBe("skipped");
    await runMaintenance();
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(chargedAfterReclaim);
    expect((await objectRows(survivor.assetId))[0]!.status).toBe("writing");
    expect(objects.has(survivor.objectKey)).toBe(true);
  });

  it("reclaims a confirmed-abort multipart upload immediately while a failed abort retains the charge", async () => {
    await resetStudio(lifecycleStudio, 0);
    // One part plan above the real multipart threshold, sized from the same
    // policy the route consults rather than a number that could silently drift
    // under it: if the API ever answered 'single' here the abort assertions
    // below would be measuring single-PUT semantics while claiming to prove
    // multipart abort, which is exactly what the strategy checks rule out.
    const multipartBytes = ASSET_UPLOAD_POLICY.multipartThresholdBytes + 1;
    const session = await beginUpload(lifecycleStudio, {
      contentType: "video/mp4",
      fileSize: multipartBytes,
      title: "Abandoned multipart",
    });
    expect(session.strategy).toBe("multipart");
    // Mint real part grants first: the staging row records their ~15-minute
    // deadline, and that is the hold the confirmed abort gets to release.
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
    // The recorded deadline is the minted grant window, not the session's day.
    expect(partDeadline).toBeLessThan((await sessionExpiry(session.sessionId)).getTime() - 60_000);

    const abort = await api(lifecycleStudio, `/api/v1/asset-upload-sessions/${session.sessionId}`, {
      idempotencyKey: nextKey("multipart-abort"),
      method: "DELETE",
    });
    expect(abort.status).toBe(204);

    // The external abort confirmed at the bucket boundary: the upload id is
    // dead, so no signed part URL can write anymore and the writer window is
    // already closed — the bytes stay charged only until the settled delete.
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

    // Repeating the cancel releases nothing a second time.
    const duplicate = await api(
      lifecycleStudio,
      `/api/v1/asset-upload-sessions/${session.sessionId}`,
      { idempotencyKey: nextKey("multipart-abort-again"), method: "DELETE" },
    );
    expect(duplicate.status).toBe(204);
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(BigInt(multipartBytes));

    // Maintenance reclaims without waiting for the grant window: the confirmed
    // abort already ended every part writer.
    await makeOrphanDue(session.assetId);
    await runMaintenance();
    expect(await deliverDeletion(lifecycleStudio, session.assetId)).toBe("processed");
    expect(await chargedBytes(lifecycleStudio.organizationId)).toBe(0n);

    // The same cancel whose external abort never confirmed retains the charge
    // for the last grant deadline: the upload id may still be live, so nothing
    // is reclaimed yet.
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
    // The bucket never confirmed the abort, so the writer grant is still live
    // and the hold is the recorded deadline rather than a released window.
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

    // The reconciler first describes the period by its resident inventory.
    await makeUsageReconciliationDue(lifecycleStudio.organizationId);
    await runMaintenance();
    expect((await publicUsage(lifecycleStudio)).usage.storage_bytes).toBe(storageCap - probeBytes);

    // Then model the rollover: the new period starts with nothing recorded while
    // the very same bytes are still stored.
    await systemTransaction(async (client) => {
      await client.query(
        `UPDATE usage_records SET storage_bytes = 0
         WHERE org_id = $1 AND period = to_char(now(), 'YYYY-MM')`,
        [lifecycleStudio.organizationId],
      );
    });
    expect((await publicUsage(lifecycleStudio)).usage.storage_bytes).toBe(0);

    // A workspace that just rolled over must not look empty: an upload the reset
    // counter would happily accept is still refused.
    const refused = await requestUpload(lifecycleStudio, {
      fileSize: probeBytes,
      title: "Rollover attempt",
    });
    expect(refused.status).toBe(422);
    expect(errorOf(refused.body).code).toBe("quota_exceeded");

    // Reconciliation puts the resident bytes back into the period counter, so the
    // rollover hides nothing from the creator's own usage view.
    await makeUsageReconciliationDue(lifecycleStudio.organizationId);
    await runMaintenance();
    const afterRollover = await publicUsage(lifecycleStudio);
    expect(afterRollover.usage.storage_bytes).toBe(storageCap - probeBytes);
    expect(afterRollover.limits.max_storage_bytes).toBe(storageCap);
  });
});
