const sha256Pattern = /^[0-9a-fA-F]{64}$/;

const ACCEPTED_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

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

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

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

function boundedInt(raw, fallback, minimum, maximum) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) return fallback;
  return value;
}

const DEFAULT_LIMITS = {
  jobTimeoutMs: 540_000,
  maxInputBytes: 550 * 1024 * 1024,
  maxOutputBytes: 512 * 1024 * 1024,
};

function deadlineMsFor(job, limits = DEFAULT_LIMITS) {
  const requested =
    typeof job.deadline_seconds === "number" && Number.isFinite(job.deadline_seconds)
      ? Math.round(job.deadline_seconds * 1000)
      : limits.jobTimeoutMs;
  return Math.max(5_000, Math.min(limits.jobTimeoutMs, requested));
}

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
  return {
    ...job,
    profile: { ...profile, allowed_content_types: allowedContentTypes },
  };
}

export { ERRORS, EngineError, boundedInt, deadlineMsFor, parseJob, readConfig };
