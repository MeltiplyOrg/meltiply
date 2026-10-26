// Private Container adapter: jobs receive exact-object signed capabilities, never
// bucket credentials. Native compute stays in FFmpeg/libvips; the Container host
// lives separately so this adapter also loads in Node integration tests.
import { Effect } from "effect";
import { createObjectUrlSignerFromEnv } from "@meltiply/storage";

import type { AutomationEnv } from "./env";

/** Port the container engine listens on; mirrors the Dockerfile EXPOSE. */
export const PROCESSOR_ENGINE_PORT = 8080;

/** RPC ceiling covering container start, job execution and the response. */
export const PROCESSOR_CONTAINER_TIMEOUT_MS = 600_000;

/** Readiness budget for a cold container start before the job is attempted. */
export const PROCESSOR_READY_TIMEOUT_MS = 90_000;

/** Two-minute park window after the owning DO becomes inactive, never during an active RPC. */
export const PROCESSOR_INACTIVITY_TIMEOUT_MS = 120_000;

/**
 * Signed capability lifetime: long enough to outlast one job, short enough to
 * expire promptly.
 *
 * It is also the write hold the Asset processing module persists on the
 * staging output row before minting a capability, so a late engine PUT can
 * only ever land on a key that is still inventoried and charged.
 */
export const PROCESSOR_CAPABILITY_TTL_SECONDS = 900;

/** Durable Object storage key holding this instance's generated job token. */
export const PROCESSOR_TOKEN_KEY = "processor:job-token";

/**
 * Bounds the engine must honour for one rendition. `max_width`/`max_height`
 * downscale only (never upscale, never crop) and `max_duration_seconds` is a
 * ceiling, never a trim target: duration and audio are preserved whatever the
 * bound, so a source longer than the ceiling fails rather than being cut.
 */
export interface NativeProcessorProfile {
  allowed_content_types: string[];
  effort: number | null;
  kind: "image" | "video";
  max_duration_seconds: number | null;
  max_height: number | null;
  max_width: number | null;
  /** Stored verbatim as the rendition profile, so it must match `^[a-z0-9_]{1,64}$`. */
  name: string;
  quality: number | null;
}

/**
 * One processing job. Field names are the engine's wire body exactly, so there
 * is no mapping layer to drift. `input_url` and `output_url` are the only
 * capabilities the engine receives.
 */
export interface NativeProcessorJob {
  asset_id: string;
  declared_content_type: string;
  deadline_seconds?: number | null;
  expected_checksum?: string | null;
  expected_size: number;
  input_url: string;
  /** Deterministic per-(asset, profile) identity used for engine-side replay dedupe. */
  job_id: string;
  maximum_output_bytes: number;
  output_url: string;
  profile: NativeProcessorProfile;
}

/** Verified source facts the engine observed while decoding the input. */
interface NativeProcessorInput {
  bytes: number;
  sha256: string;
}

/** Verified rendition facts; the Worker re-checks size and digest before committing. */
interface NativeProcessorOutput {
  bytes: number;
  content_type: string;
  etag: string | null;
  sha256: string;
}

/**
 * Verified media facts of the rendition (or of the original for a no-benefit
 * result). Width/height are display-oriented, so orientation is reported as the
 * viewer sees it rather than as a container rotation tag.
 */
interface NativeProcessorMedia {
  animated: boolean;
  content_type: string;
  duration_seconds: number | null;
  frame_count: number | null;
  has_audio: boolean;
  height: number | null;
  width: number | null;
}

/** Evidence that real native tooling ran, plus how long the job took. */
interface NativeProcessorEngineInfo {
  duration_ms: number;
  ffmpeg: string;
  vips: string;
}

/**
 * Successful job outcome. `result` is `optimized` when a rendition was uploaded
 * to `output_url`, and `original_compatible` when the engine verified the
 * original already satisfied the profile and uploaded nothing.
 */
export interface NativeProcessorSuccess {
  engine: NativeProcessorEngineInfo;
  input: NativeProcessorInput;
  job_id: string;
  media: NativeProcessorMedia;
  output: NativeProcessorOutput | null;
  replayed?: boolean;
  result: "optimized" | "original_compatible";
  status: "succeeded";
}

/**
 * Durable-object RPC outcome. RPC transports a discriminated union rather than
 * throwing, so an engine failure arrives as data the adapter can classify.
 */
export type MediaProcessorRpcOutcome =
  | { error: NativeProcessorFailure; ok: false }
  | { ok: true; result: NativeProcessorSuccess };

/** Engine failure as reported across the RPC boundary. */
export interface NativeProcessorFailure {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * The two signed capabilities one job runs on: a read of exactly one object and
 * a create-only write of exactly one other object.
 */
export interface ProcessorJobUrls {
  input_url: string;
  output_url: string;
}

/**
 * Failure of a processor invocation. `code` is a stable identifier for durable
 * storage, `retryable` decides between queue redelivery and a permanent
 * per-Asset failure, and `message` is creator-actionable prose from the engine.
 */
export class NativeProcessorError extends Error {
  /**
   * Creates a processor failure carrying its stable code and retry semantics.
   *
   * @param code - Stable error code, e.g. `corrupt_media` or `busy`.
   * @param message - Actionable explanation safe to surface to the creator.
   * @param retryable - True when a redelivered queue message can still succeed.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NativeProcessorError";
  }
}

/**
 * Signs an exact-object GET (900 seconds by default) and create-only PUT.
 * The caller must first persist outputExpiresAt as the inventory write hold:
 * delayed signing cannot extend it, and elapsed holds fail as retryable
 * processor_unavailable errors. Output size is unknown, so no length is signed.
 */
export function processorJobUrlsEffect(
  env: AutomationEnv,
  request: {
    /** Lifetime of the read capability; defaults to the adapter's capability TTL. */
    expiresInSeconds?: number;
    inputKey: string;
    outputContentType?: string;
    outputKey: string;
    /** Persisted inventory write hold; the output grant must not outlive it. */
    outputExpiresAt: Date;
  },
): Effect.Effect<ProcessorJobUrls, NativeProcessorError> {
  return Effect.gen(function* () {
    const signer = yield* Effect.try({
      catch: (cause) =>
        new NativeProcessorError(
          "processor_unavailable",
          cause instanceof Error ? cause.message : "Object storage signing is unavailable.",
          true,
        ),
      try: () => createObjectUrlSignerFromEnv(env),
    });
    const expiresInSeconds = request.expiresInSeconds ?? PROCESSOR_CAPABILITY_TTL_SECONDS;
    const inputUrl = yield* Effect.tryPromise({
      catch: (cause) =>
        new NativeProcessorError(
          "processor_unavailable",
          cause instanceof Error ? cause.message : "The input capability could not be signed.",
          true,
        ),
      try: () => signer.signDownload({ expiresInSeconds, key: request.inputKey }),
    });
    const outputUrl = yield* Effect.tryPromise({
      catch: (cause) =>
        new NativeProcessorError(
          "processor_unavailable",
          cause instanceof Error ? cause.message : "The output capability could not be signed.",
          true,
        ),
      try: () =>
        signer.signObjectWrite({
          ...(request.outputContentType ? { contentType: request.outputContentType } : {}),
          // Clamp delayed signing to the persisted, charged writer hold.
          expiresAt: request.outputExpiresAt,
          expiresInSeconds: PROCESSOR_CAPABILITY_TTL_SECONDS,
          key: request.outputKey,
          requiredHeaders: { "if-none-match": "*" },
        }),
    });
    return { input_url: inputUrl, output_url: outputUrl };
  });
}

/**
 * Sends one validated job through the private binding, addressed by Asset so
 * retries share the engine's job-id replay guard. Returns verified output;
 * malformed jobs fail terminally, unavailable bindings/RPC fail retryably,
 * and engine rejections retain their code, message, and retry classification.
 */
export function invokeNativeProcessorEffect(
  env: AutomationEnv,
  job: NativeProcessorJob,
): Effect.Effect<NativeProcessorSuccess, NativeProcessorError> {
  return Effect.gen(function* () {
    const invalid = validateJob(job);
    if (invalid) {
      return yield* Effect.fail(new NativeProcessorError("invalid_request", invalid, false));
    }
    const namespace = env.MEDIA_PROCESSOR;
    if (!namespace) {
      return yield* Effect.fail(
        new NativeProcessorError(
          "processor_unavailable",
          "The native media processor binding is not configured for this environment.",
          true,
        ),
      );
    }
    const stub = namespace.get(namespace.idFromName(`asset-${job.asset_id}`));
    // Explicit generics unwrap Cloudflare's Rpc.Result without casting.
    const outcome = yield* Effect.tryPromise<MediaProcessorRpcOutcome, NativeProcessorError>({
      catch: (cause) =>
        new NativeProcessorError(
          "engine_error",
          cause instanceof Error
            ? `The media processor could not be reached: ${cause.message}`
            : "The media processor could not be reached.",
          true,
        ),
      try: () => stub.process(job),
    });
    if (!outcome.ok) {
      return yield* Effect.fail(
        new NativeProcessorError(
          outcome.error.code,
          outcome.error.message,
          outcome.error.retryable,
        ),
      );
    }
    return outcome.result;
  });
}

/**
 * Returns an actionable rejection reason for malformed job fields, otherwise
 * null. Shared with the Container host to reject before paying for startup;
 * profile names must be safe deterministic rendition identifiers.
 */
export function validateJob(job: NativeProcessorJob): string | null {
  if (!job || typeof job !== "object") return "A job payload is required.";
  for (const field of [
    "asset_id",
    "declared_content_type",
    "input_url",
    "job_id",
    "output_url",
  ] as const) {
    if (typeof job[field] !== "string" || job[field].length === 0) {
      return `Field "${field}" must be a non-empty string.`;
    }
  }
  if (!Number.isInteger(job.expected_size) || job.expected_size <= 0) {
    return "expected_size must be a positive integer.";
  }
  if (!Number.isInteger(job.maximum_output_bytes) || job.maximum_output_bytes <= 0) {
    return "maximum_output_bytes must be a positive integer reservation.";
  }
  if (job.expected_checksum !== undefined && job.expected_checksum !== null) {
    if (!/^[0-9a-f]{64}$/i.test(job.expected_checksum)) {
      return "expected_checksum must be a sha256 hex digest.";
    }
  }
  const profile = job.profile;
  if (!profile || (profile.kind !== "image" && profile.kind !== "video")) {
    return 'profile.kind must be "image" or "video".';
  }
  if (!/^[a-z0-9_]{1,64}$/.test(profile.name)) {
    return "profile.name must match ^[a-z0-9_]{1,64}$ for rendition identity.";
  }
  if (!Array.isArray(profile.allowed_content_types) || profile.allowed_content_types.length === 0) {
    return "profile.allowed_content_types must list at least one output type.";
  }
  return null;
}
