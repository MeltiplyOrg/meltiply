// Job admission surface of the native media processor engine (issue #284).
//
// This module owns everything needed to turn an untrusted POST /process body
// into a validated job: environment configuration, the error taxonomy the HTTP
// layer renders, and the request validators. It is deliberately free of
// server/process/fs side effects so the validation rules can be unit-tested
// without booting ffmpeg, vips, or the HTTP listener; `server.mjs` imports it.

const sha256Pattern = /^[0-9a-fA-F]{64}$/;

/** Media formats accepted by the current upload surface (issue #284 decision 8). */
const ACCEPTED_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

/**
 * Error taxonomy shared with the Worker adapter. `status` is the HTTP status the
 * engine answers with; `retryable` tells the adapter whether a queue redelivery
 * can fix the failure. Codes are stable identifiers for durable failure storage.
 */
const ERRORS = {
  busy: { retryable: true, status: 429 },
  checksum_mismatch: { retryable: false, status: 422 },
  corrupt_media: { retryable: false, status: 422 },
  engine_error: { retryable: true, status: 500 },
  engine_timeout: { retryable: true, status: 504 },
  input_fetch_failed: { retryable: true, status: 502 },
  input_unavailable: { retryable: true, status: 502 },
  input_size_mismatch: { retryable: false, status: 422 },
  input_too_large: { retryable: false, status: 413 },
  invalid_request: { retryable: false, status: 400 },
  output_too_large: { retryable: false, status: 422 },
  output_upload_failed: { retryable: true, status: 502 },
  output_exists: { retryable: false, status: 412 },
  unauthorized: { retryable: false, status: 401 },
  unsupported_media: { retryable: false, status: 422 },
};

/** Failure carrying an engine error code; the HTTP layer renders it as JSON. */
class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Reads and validates engine configuration from the environment, failing fast
 * on a missing job secret: an engine that cannot authenticate anyone must not
 * accept jobs at all.
 */
function readConfig(env) {
  const token = env.PROCESSOR_JOB_TOKEN;
  if (!token || token.length < 16) {
    throw new Error("PROCESSOR_JOB_TOKEN must be set to at least 16 characters");
  }
  return {
    ffmpegThreads: boundedInt(env.PROCESSOR_FFMPEG_THREADS, 2, 1, 16),
    jobTimeoutMs: boundedInt(env.PROCESSOR_JOB_TIMEOUT_MS, 540_000, 5_000, 900_000),
    maxInputBytes: boundedInt(
      env.PROCESSOR_MAX_INPUT_BYTES,
      550 * 1024 * 1024,
      1024,
      550 * 1024 * 1024,
    ),
    maxOutputBytes: boundedInt(
      env.PROCESSOR_MAX_OUTPUT_BYTES,
      512 * 1024 * 1024,
      1024,
      4 * 1024 * 1024 * 1024,
    ),
    maxPendingJobs: boundedInt(env.PROCESSOR_MAX_PENDING_JOBS, 1, 0, 8),
    port: boundedInt(env.PROCESSOR_PORT ?? env.PORT, 8080, 1, 65_535),
    token,
    workDir: env.PROCESSOR_WORK_DIR ?? "/tmp/meltiply-processor",
  };
}

/**
 * Parses a bounded integer environment override, falling back when unset or
 * unusable so a typo cannot silently disable a resource bound.
 */
function boundedInt(raw, fallback, minimum, maximum) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) return fallback;
  return value;
}

/**
 * Default bounds used when validating jobs without a full process config (for
 * example in unit tests that do not supply `PROCESSOR_JOB_TOKEN`). Mirrors
 * `readConfig`'s defaults so tests and production enforce identical limits.
 */
const DEFAULT_LIMITS = {
  jobTimeoutMs: 540_000,
  maxInputBytes: 550 * 1024 * 1024,
  maxOutputBytes: 512 * 1024 * 1024,
};

/**
 * Returns the effective per-job deadline in milliseconds, clamped to the engine
 * ceiling so a caller cannot request unbounded compute.
 *
 * @param {Record<string, unknown>} job - Validated job payload.
 * @param {{ jobTimeoutMs: number }} [limits] - Engine timeout ceiling; defaults to `DEFAULT_LIMITS`.
 * @returns {number} Bounded deadline in milliseconds.
 */
function deadlineMsFor(job, limits = DEFAULT_LIMITS) {
  const requested =
    typeof job.deadline_seconds === "number" && Number.isFinite(job.deadline_seconds)
      ? Math.round(job.deadline_seconds * 1000)
      : limits.jobTimeoutMs;
  return Math.max(5_000, Math.min(limits.jobTimeoutMs, requested));
}

/**
 * Validates and narrows an untrusted request body into a job, rejecting unknown
 * shapes outright so a malformed payload can never reach the media pipeline.
 * Returns a fresh job object: the parsed body is never mutated, so a replayed or
 * inspected request keeps exactly what the caller sent.
 *
 * @param {unknown} body - Untrusted decoded JSON payload.
 * @param {{ maxInputBytes: number; maxOutputBytes: number }} [limits] - Engine size bounds; defaults to `DEFAULT_LIMITS`.
 * @returns {Record<string, unknown>} Fresh validated job object.
 */
function parseJob(body, limits = DEFAULT_LIMITS) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EngineError("invalid_request", "The request body must be a JSON object.");
  }
  const job = body;
  const requireString = (value, field, maxLength) => {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
      throw new EngineError(
        "invalid_request",
        `Field "${field}" must be a non-empty string of at most ${maxLength} characters.`,
      );
    }
    return value;
  };
  requireString(job.job_id, "job_id", 200);
  requireString(job.asset_id, "asset_id", 128);
  const declared = requireString(
    job.declared_content_type,
    "declared_content_type",
    128,
  ).toLowerCase();
  if (!ACCEPTED_CONTENT_TYPES.has(declared)) {
    throw new EngineError(
      "unsupported_media",
      `Declared content type "${declared}" is outside the accepted upload formats.`,
    );
  }
  for (const field of ["input_url", "output_url"]) {
    let parsed;
    try {
      parsed = new URL(requireString(job[field], field, 4096));
    } catch {
      throw new EngineError("invalid_request", `Field "${field}" must be an absolute URL.`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new EngineError("invalid_request", `Field "${field}" must use HTTP or HTTPS.`);
    }
    if (parsed.username || parsed.password) {
      throw new EngineError("invalid_request", `Field "${field}" must not embed credentials.`);
    }
  }
  if (
    !Number.isInteger(job.expected_size) ||
    job.expected_size <= 0 ||
    job.expected_size > limits.maxInputBytes
  ) {
    throw new EngineError(
      "input_too_large",
      `expected_size must be between 1 and ${limits.maxInputBytes} bytes.`,
    );
  }
  if (job.expected_checksum !== undefined && job.expected_checksum !== null) {
    if (typeof job.expected_checksum !== "string" || !sha256Pattern.test(job.expected_checksum)) {
      throw new EngineError(
        "invalid_request",
        'Field "expected_checksum" must be a sha256 hex digest.',
      );
    }
  }
  if (!Number.isInteger(job.maximum_output_bytes) || job.maximum_output_bytes <= 0) {
    throw new EngineError("invalid_request", "maximum_output_bytes must be a positive integer.");
  }
  if (job.maximum_output_bytes > limits.maxOutputBytes) {
    throw new EngineError(
      "invalid_request",
      `maximum_output_bytes may not exceed the engine ceiling of ${limits.maxOutputBytes} bytes.`,
    );
  }
  // An explicit deadline must be a real number inside the engine's own
  // [5s, 540s] compute window: anything else — a string, a boolean, NaN, or a
  // value outside the window — is a malformed request, not a deadline to
  // silently clamp. Absent or null means the configured job timeout applies.
  if (
    job.deadline_seconds !== undefined &&
    job.deadline_seconds !== null &&
    (typeof job.deadline_seconds !== "number" ||
      !Number.isFinite(job.deadline_seconds) ||
      job.deadline_seconds < 5 ||
      job.deadline_seconds > 540)
  ) {
    throw new EngineError(
      "invalid_request",
      "deadline_seconds must be a number between 5 and 540 when present.",
    );
  }
  const profile = job.profile;
  if (
    !profile ||
    typeof profile !== "object" ||
    (profile.kind !== "image" && profile.kind !== "video")
  ) {
    throw new EngineError(
      "invalid_request",
      'Field "profile" must be an object whose kind is "image" or "video".',
    );
  }
  requireString(profile.name, "profile.name", 120);
  if (!Array.isArray(profile.allowed_content_types) || profile.allowed_content_types.length === 0) {
    throw new EngineError(
      "invalid_request",
      "profile.allowed_content_types must list at least one output type.",
    );
  }
  const allowedContentTypes = profile.allowed_content_types.map((entry) => {
    if (typeof entry !== "string" || !ACCEPTED_CONTENT_TYPES.has(entry.toLowerCase())) {
      throw new EngineError(
        "unsupported_media",
        `Profile output type "${entry}" is outside the accepted formats.`,
      );
    }
    return entry.toLowerCase();
  });
  if (profile.kind === "video" && !allowedContentTypes.includes("video/mp4")) {
    throw new EngineError("unsupported_media", "A video profile must allow video/mp4 output.");
  }
  for (const field of ["max_width", "max_height", "max_duration_seconds", "quality", "effort"]) {
    const value = profile[field];
    if (value !== undefined && value !== null && (!Number.isFinite(value) || value <= 0)) {
      throw new EngineError(
        "invalid_request",
        `profile.${field} must be a positive number when present.`,
      );
    }
  }
  // The validated job is a fresh object: allowed_content_types is normalized
  // into lowercase on the copy, so the raw request body is never mutated.
  return {
    ...job,
    profile: { ...profile, allowed_content_types: allowedContentTypes },
  };
}

export { ERRORS, EngineError, boundedInt, deadlineMsFor, parseJob, readConfig };
