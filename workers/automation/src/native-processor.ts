import { errorMessage } from "@meltiply/domain";
import { Effect } from "effect";
import { createObjectUrlSignerFromEnv } from "@meltiply/storage";

import type { AutomationEnv } from "./env";

const sha256Pattern = /^[0-9a-f]{64}$/i;
const profileNamePattern = /^[a-z0-9_]{1,64}$/;

export const PROCESSOR_ENGINE_PORT = 8080;

export const PROCESSOR_CONTAINER_TIMEOUT_MS = 600_000;

export const PROCESSOR_READY_TIMEOUT_MS = 90_000;

export const PROCESSOR_INACTIVITY_TIMEOUT_MS = 120_000;

export const PROCESSOR_CAPABILITY_TTL_SECONDS = 900;

export const PROCESSOR_TOKEN_KEY = "processor:job-token";

export interface NativeProcessorProfile {
  allowed_content_types: string[];
  effort: number | null;
  kind: "image" | "video";
  max_duration_seconds: number | null;
  max_height: number | null;
  max_width: number | null;
  name: string;
  quality: number | null;
}

export interface NativeProcessorJob {
  asset_id: string;
  declared_content_type: string;
  deadline_seconds?: number | null;
  expected_checksum?: string | null;
  expected_size: number;
  input_url: string;
  job_id: string;
  maximum_output_bytes: number;
  output_url: string;
  profile: NativeProcessorProfile;
}

interface NativeProcessorInput {
  bytes: number;
  sha256: string;
}

interface NativeProcessorOutput {
  bytes: number;
  content_type: string;
  etag: string | null;
  sha256: string;
}

interface NativeProcessorMedia {
  animated: boolean;
  content_type: string;
  duration_seconds: number | null;
  frame_count: number | null;
  has_audio: boolean;
  height: number | null;
  width: number | null;
}

interface NativeProcessorEngineInfo {
  duration_ms: number;
  ffmpeg: string;
  vips: string;
}

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

export type MediaProcessorRpcOutcome =
  | { error: NativeProcessorFailure; ok: false }
  | { ok: true; result: NativeProcessorSuccess };

export interface NativeProcessorFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProcessorJobUrls {
  input_url: string;
  output_url: string;
}

export class NativeProcessorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NativeProcessorError";
  }
}

export function processorJobUrlsEffect(
  env: AutomationEnv,
  request: {
    expiresInSeconds?: number;
    inputKey: string;
    outputContentType?: string;
    outputKey: string;
    outputExpiresAt: Date;
  },
): Effect.Effect<ProcessorJobUrls, NativeProcessorError> {
  return Effect.gen(function* () {
    const signer = yield* Effect.try({
      catch: (cause) =>
        new NativeProcessorError(
          "processor_unavailable",
          errorMessage(cause, "Object storage signing is unavailable."),
          true,
        ),
      try: () => createObjectUrlSignerFromEnv(env),
    });
    const expiresInSeconds = request.expiresInSeconds ?? PROCESSOR_CAPABILITY_TTL_SECONDS;
    const inputUrl = yield* Effect.tryPromise({
      catch: (cause) =>
        new NativeProcessorError(
          "processor_unavailable",
          errorMessage(cause, "The input capability could not be signed."),
          true,
        ),
      try: () => signer.signDownload({ expiresInSeconds, key: request.inputKey }),
    });
    const outputUrl = yield* Effect.tryPromise({
      catch: (cause) =>
        new NativeProcessorError(
          "processor_unavailable",
          errorMessage(cause, "The output capability could not be signed."),
          true,
        ),
      try: () =>
        signer.signObjectWrite({
          ...(request.outputContentType ? { contentType: request.outputContentType } : {}),
          expiresAt: request.outputExpiresAt,
          expiresInSeconds: PROCESSOR_CAPABILITY_TTL_SECONDS,
          key: request.outputKey,
          requiredHeaders: { "if-none-match": "*" },
        }),
    });
    return { input_url: inputUrl, output_url: outputUrl };
  });
}

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
    if (!sha256Pattern.test(job.expected_checksum)) {
      return "expected_checksum must be a sha256 hex digest.";
    }
  }
  const profile = job.profile;
  if (!profile || (profile.kind !== "image" && profile.kind !== "video")) {
    return 'profile.kind must be "image" or "video".';
  }
  if (!profileNamePattern.test(profile.name)) {
    return "profile.name must match ^[a-z0-9_]{1,64}$ for rendition identity.";
  }
  if (!Array.isArray(profile.allowed_content_types) || profile.allowed_content_types.length === 0) {
    return "profile.allowed_content_types must list at least one output type.";
  }
  return null;
}
