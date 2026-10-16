// Meltiply native media processor engine (issue #284).
//
// A private HTTP service that performs the actual FFmpeg/ffprobe/libvips work
// for Asset processing. It is reachable only through the MediaProcessorContainer
// Durable Object (private binding), never as a public arbitrary-job route, and
// every invocation must carry the per-instance bearer secret. A job grants
// nothing but two short-lived, exact-object signed capabilities (GET one, PUT
// one); this process never sees a bucket credential.
//
// Design invariants (issue #284 decisions 9/10):
// - Full decode before any verdict: corrupt or truncated input is rejected,
//   never silently re-encoded from partially readable data.
// - No cropping, truncation, frame dropping, audio stripping or orientation
//   change. Candidates must preserve duration, frame count, audio presence and
//   display aspect ratio — including sources whose pixels are not square — and
//   each candidate is decoded before it can be chosen.
// - Publishable format first: among verified candidates, the earliest
//   type in profile.allowed_content_types wins and byte size only breaks
//   ties inside it, so a smaller but platform-incompatible type (e.g. a
//   WebP still for Instagram) can never displace a publishable one.
// - "No benefit" is an explicit verified success, allowed only after the
//   original itself fully decoded and already satisfies the requested profile.
//   It is never a fallback after a failed optimization attempt.
// - Deterministic bytes: no timestamps or encoder strings are written, so the
//   same source plus profile yields the same rendition.
// - Bounded work: one job at a time plus a small wait queue, a per-job wall
//   clock, per-step subprocess timeouts, byte ceilings on input and output, and
//   a work directory removed after every job.
// - argv only. No shell, no string interpolation into a command line.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";

const ENGINE_ID = "meltiply-media-processor/1";

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

const config = readConfig(process.env);

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
 * Runs a binary with an argv array (never a shell string), capping captured
 * stderr so a chatty tool cannot exhaust memory, and killing the child when the
 * step exceeds its timeout.
 */
function run(argv, timeoutMs) {
  const { promise, reject, resolve } = Promise.withResolvers();
  const child = spawn(argv[0], argv.slice(1), {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  let stderr = "";
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve({ stderr, stdout: Buffer.concat(stdout).toString("utf8") });
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(
      new EngineError("engine_timeout", `${argv[0]} exceeded its ${timeoutMs}ms step budget.`),
    );
  }, timeoutMs);
  timer.unref?.();
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 32 * 1024) stderr += chunk.toString("utf8");
  });
  child.on("error", (error) =>
    finish(new EngineError("engine_error", `${argv[0]} could not be executed: ${error.message}`)),
  );
  child.on("close", (code) => {
    if (code === 0) finish();
    else finish(new Error(`${argv[0]} exited ${code}: ${stderr.trim().slice(0, 400)}`));
  });
  return promise;
}

/**
 * Runs a binary and hands each stdout chunk to `onChunk` as it arrives, never
 * buffering the stream. This is the runner for tools whose raw output is larger
 * than memory or disk should hold — an animation's decoded alpha plane expands
 * far beyond its compressed size — so the measurement is a bounded scan rather
 * than a copy. Timeout, stderr capping and SIGKILL conventions match `run`, and
 * the child is only settled on exit, so a consumer that finds its answer early
 * still waits for the full decode to finish rather than trusting a partial pass.
 * Input: an argv array, a chunk consumer, and the step budget. Output: resolves
 * once the process has exited; rejects on spawn failure, timeout or non-zero
 * exit exactly as `run` does.
 */
function runStreaming(argv, onChunk, timeoutMs) {
  const { promise, reject, resolve } = Promise.withResolvers();
  const child = spawn(argv[0], argv.slice(1), {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve({ stderr });
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(
      new EngineError("engine_timeout", `${argv[0]} exceeded its ${timeoutMs}ms step budget.`),
    );
  }, timeoutMs);
  timer.unref?.();
  child.stdout.on("data", (chunk) => onChunk(chunk));
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 32 * 1024) stderr += chunk.toString("utf8");
  });
  child.on("error", (error) =>
    finish(new EngineError("engine_error", `${argv[0]} could not be executed: ${error.message}`)),
  );
  child.on("close", (code) => {
    if (code === 0) finish();
    else finish(new Error(`${argv[0]} exited ${code}: ${stderr.trim().slice(0, 400)}`));
  });
  return promise;
}

/**
 * Probes a video file with ffprobe and reduces the decoded container facts to
 * the media facts this engine reports. Only the video path goes through here:
 * images are measured by libvips in `probeImage`, because FFmpeg cannot decode
 * an animated WebP and libvips is also the decoder that re-encodes them.
 * `countFrames` makes ffprobe decode and count every frame, which is the only
 * way to measure a frame count for formats that declare none.
 * Input: a path, and whether to count decoded frames. Output: the reduced media
 * facts; throws EngineError("corrupt_media") when the container cannot be read.
 */
async function probe(file, { countFrames = false, timeoutMs }) {
  const argv = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams"];
  if (countFrames) argv.push("-count_frames");
  argv.push(file);
  let stdout;
  try {
    ({ stdout } = await run(argv, timeoutMs));
  } catch (cause) {
    throw new EngineError(
      "corrupt_media",
      `The uploaded object could not be read: ${cause.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new EngineError(
      "corrupt_media",
      "The uploaded object produced unreadable media metadata.",
    );
  }
  return summarize(parsed, countFrames);
}

/**
 * Reduces ffprobe JSON to the verified media facts this engine reports and
 * rejects anything without a decodable picture stream, which is what every
 * accepted upload format must have. Dimensions are display-oriented, so an
 * orientation tag can never be mistaken for a preserved one.
 * The ISO container brand disambiguates MP4 from QuickTime; ffprobe reports
 * both through the same comma-separated demuxer family.
 */
function summarize(parsed, counted) {
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!video) {
    throw new EngineError(
      "unsupported_media",
      "The object has no decodable image or video stream.",
    );
  }
  const formatName = String(parsed.format?.format_name ?? "");
  const durationRaw = parsed.format?.duration ?? video.duration;
  // A counted decode is authoritative: formats like APNG report no declared
  // `nb_frames` at all, so falling back to the header field would read a real
  // measured stream as frame-less.
  const framesRaw = counted ? video.nb_read_frames : (video.nb_read_frames ?? video.nb_frames);
  const frameCount =
    framesRaw === undefined || framesRaw === "N/A" || !Number.isFinite(Number(framesRaw))
      ? null
      : Number(framesRaw);
  const codedWidth = Number(video.width);
  const codedHeight = Number(video.height);
  const quarterTurn = Math.abs(rotationOf(video)) % 180 === 90;
  // A quarter turn transposes the frame, so the pixel aspect inverts along with
  // the axes: square pixels stay square and an anamorphic ratio flips. Keeping
  // the sample aspect display-oriented lets every geometry comparison below use
  // the width/height pair in one coordinate system.
  const codedSampleAspect = parseSampleAspect(video.sample_aspect_ratio);
  const sampleAspect = quarterTurn ? 1 / codedSampleAspect : codedSampleAspect;
  const width = quarterTurn ? codedHeight : codedWidth;
  const height = quarterTurn ? codedWidth : codedHeight;
  return {
    // Animation is frame-count plus container capability: the frame timings
    // themselves are compared separately, because a renderer must reproduce
    // each frame's delay, not merely the number of frames.
    animated: isAnimatedContainer(formatName),
    audioChannels: audio ? Number(audio.channels ?? 0) : 0,
    codedHeight,
    codedWidth,
    contentType: contentTypeFor(
      formatName,
      String(video.codec_name ?? ""),
      String(parsed.format?.tags?.major_brand ?? ""),
    ),
    // Display-oriented dimensions: what a viewer actually sees. Orientation
    // must survive normalization, so every comparison uses these.
    displayAspect: (width * sampleAspect) / height,
    durationSeconds:
      durationRaw === undefined || durationRaw === "N/A" || Number.isNaN(Number(durationRaw))
        ? null
        : Number(durationRaw),
    formatName,
    frameCount,
    audioCodec: String(audio?.codec_name ?? ""),
    pixelFormat: String(video.pix_fmt ?? ""),
    hasAudio: Boolean(audio) && Number(audio.channels ?? 0) > 0,
    height,
    rotation: rotationOf(video),
    sampleAspect,
    videoCodec: String(video.codec_name ?? ""),
    width,
  };
}

/**
 * Reads the container's rotation in degrees so display orientation can be
 * compared independently of how a candidate baked it into pixels.
 */
function rotationOf(stream) {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  const tagged = sideData.find((entry) => entry.rotation !== undefined)?.rotation;
  const fromTag = stream.tags?.rotate;
  const raw = tagged ?? fromTag;
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? ((Math.round(value) % 360) + 360) % 360 : 0;
}

/**
 * Parses ffprobe's rational `sample_aspect_ratio` ("1:1", "15:16", "32:27") into
 * a finite positive number. The field is a ratio string, so `Number` yields NaN
 * for every non-square source and would silently report those pixels as square;
 * unknown markers ("0:1", "N/A", an absent field) resolve to 1 so the
 * comparison falls back to the coded pixel grid instead of failing the job.
 */
function parseSampleAspect(raw) {
  const [numerator, denominator = "1"] = String(raw ?? "").split(":");
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top <= 0 || bottom <= 0) return 1;
  return top / bottom;
}

/**
 * Maps decoded container facts to the supported MIME type, including pipe
 * demuxers. MP4/QuickTime share a format name: `qt` identifies QuickTime,
 * other branded ISO containers identify MP4, and unbranded legacy MOV stays
 * QuickTime. Classifying the container first preserves Motion-JPEG video.
 */
function contentTypeFor(formatName, codecName, majorBrand) {
  const formats = new Set(formatName.split(","));
  if (formats.has("mov") || formats.has("mp4")) {
    const brand = majorBrand.trim();
    return brand === "qt" || (!brand && formats.has("mov")) ? "video/quicktime" : "video/mp4";
  }
  if (formats.has("apng")) return "image/png";
  if (formats.has("gif")) return "image/gif";
  if (formats.has("webp") || formats.has("webp_pipe")) return "image/webp";
  if (formats.has("png_pipe") || formats.has("png")) return "image/png";
  if (formats.has("mjpeg") || codecName === "mjpeg") return "image/jpeg";
  if (formats.has("matroska") || formats.has("webm")) return "video/webm";
  return "application/octet-stream";
}

/**
 * Reports whether a container family is one that can hold animation, so an
 * already-decoded ffprobe stream is marked animated when the container supports
 * frames beyond the first. Only relevant on the video path: images are measured
 * by libvips, which reports a real frame count.
 */
function isAnimatedContainer(formatName) {
  const formats = new Set(formatName.split(","));
  return (
    formats.has("gif") ||
    formats.has("webp") ||
    formats.has("webp_pipe") ||
    formats.has("apng") ||
    formats.has("png_pipe")
  );
}

/**
 * Image loader names libvips can read, mapped to the MIME types the upload
 * surface accepts. The loader is authoritative because it is the decoder that
 * actually read the container: FFmpeg cannot decode an animated WebP at all
 * (it reports "image data not found" for a WebP libvips reads as a full
 * animation), so a format decision taken from FFmpeg would reject media this
 * engine can process and could never measure an animation's real frame timing.
 */
const IMAGE_CONTENT_TYPES = new Map([
  ["gifload", "image/gif"],
  ["jpegload", "image/jpeg"],
  ["pngload", "image/png"],
  ["webpload", "image/webp"],
]);

/**
 * Reads the `acTL` (animation control) chunk of a PNG file when one exists,
 * returning the animation's declared play count. The walk is a fixed
 * length/type/data/CRC stride over a bounded prefix, not a format parser, and
 * it exists because libvips' pngload cannot read animation: it decodes only
 * the first frame of an APNG as a still. The play count is the one animation
 * fact FFmpeg does not surface in stream metadata, and it is needed so the
 * rendition can keep the creator's loop setting. `null` means "not an APNG".
 */
async function apngPlayCount(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // PNG signature (8 bytes) then chunks as [length(4) type(4) data CRC(4)].
    for (let offset = 8; offset + 8 <= bytesRead;) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") {
        return length >= 8 && offset + 8 + length <= bytesRead
          ? buffer.readUInt32BE(offset + 12) // num_plays, 0 = forever
          : 0;
      }
      if (type === "IDAT" || type === "fdAT" || type === "IEND") return null;
      offset += 12 + length;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Measures per-frame durations of an APNG through FFmpeg, the only local
 * decoder that reads the animation. Frame `duration_time` is asked for first
 * (the demuxer's own frame timing, including the final frame's); when a
 * container leaves it unset, deltas of presentation timestamps are used. A
 * length one short of the measured frame count is completed by repeating the
 * last interval, matching the harness's own reconstruction, so the comparison
 * never fails on a reporting quirk alone. Missing timing is a failure rather
 * than a guess: an animation's pacing is content.
 */
async function apngFrameDelays(file, timeoutMs) {
  const { stdout } = await run(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=duration_time,pkt_duration_time,best_effort_timestamp_time,pkt_pts_time",
      "-of",
      "json",
      file,
    ],
    timeoutMs,
  );
  const frames = JSON.parse(stdout).frames ?? [];
  const durations = frames.map((frame) => Number(frame.duration_time ?? frame.pkt_duration_time));
  if (frames.length > 0 && durations.every((value) => Number.isFinite(value) && value > 0)) {
    return durations.map((value) => Math.round(value * 1000));
  }
  const starts = frames.map((frame) =>
    Number(frame.best_effort_timestamp_time ?? frame.pkt_pts_time),
  );
  if (frames.length < 2 || !starts.every(Number.isFinite)) return null;
  const deltas = starts
    .slice(1)
    .map((value, index) => Math.round((value - (starts[index] ?? value)) * 1000));
  return deltas.length >= frames.length - 1 ? deltas.slice(0, frames.length - 1) : null;
}

/**
 * Measures whether an APNG carries meaningful transparency by decoding every
 * frame once through FFmpeg's `alphaextract` filter and scanning the resulting
 * alpha plane as a stream: nothing is buffered and no intermediate file is
 * written, because a raw alpha plane expands orders of magnitude past its
 * compressed size and would fit neither memory nor scratch disk. 16-bit
 * little-endian samples keep faint alpha measurable — an 8-bit plane would
 * round it away — and a minimum sample of `0xffff` means fully opaque. The
 * decoded pixel format only decides whether extraction is attempted at all;
 * whether the animation is genuinely transparent is decided by these pixels,
 * which is what stops an opaque RGBA animation from being required to retain a
 * useless alpha band. The scan never stops early: the child is awaited to exit
 * so a truncated or corrupt frame still fails the full decode this pass is.
 * Input: an APNG path and the step budget. Output: whether any frame carries a
 * sample below opaque; throws `corrupt_media` if the decode cannot complete.
 */
async function apngHasAlpha(file, timeoutMs) {
  let minimum = 0xffff;
  let carry = null;
  try {
    await runStreaming(
      [
        "ffmpeg",
        "-v",
        "error",
        "-xerror",
        "-nostdin",
        "-i",
        file,
        "-vf",
        "alphaextract",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray16le",
        "-",
      ],
      (chunk) => {
        // Samples straddle chunk boundaries, so a trailing odd byte waits for
        // the next chunk to complete its pair.
        const bytes = carry === null ? chunk : Buffer.concat([carry, chunk]);
        for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
          const sample = bytes.readUInt16LE(offset);
          if (sample < minimum) minimum = sample;
        }
        carry = bytes.length % 2 === 1 ? bytes.subarray(bytes.length - 1) : null;
      },
      timeoutMs,
    );
  } catch (cause) {
    throw new EngineError("corrupt_media", `The APNG could not be fully decoded: ${cause.message}`);
  }
  return minimum < 0xffff;
}

/**
 * Probes an animated PNG: ffprobe supplies the verified frame count, decoded
 * geometry and pixel format, `acTL` supplies the loop count, per-frame timing
 * comes from the demuxer's frame durations, and transparency is measured from
 * decoded alpha pixels across every frame — for an alpha-capable stream that
 * extraction pass is also the full decode, while a stream with no alpha
 * channel at all is verified by the plain null decode instead. Returns the
 * same fact shape `probeImage` reports, plus `apng: true` so candidate building
 * knows to drive FFmpeg's APNG decoder rather than libvips, which reads only
 * the first frame.
 */
async function probeApng(file, timeoutMs, plays) {
  const media = await probe(file, { countFrames: true, timeoutMs });
  const alphaCapable = ![
    "rgb24",
    "bgr24",
    "gray",
    "gray16be",
    "gray16le",
    "gbrp",
    "yuv420p",
    "yuv444p",
  ].includes(media.pixelFormat);
  // The alpha pass is the full-frame decode for an alpha-capable stream; only a
  // channel-less stream falls back to a separate null decode.
  const alpha = alphaCapable
    ? await apngHasAlpha(file, timeoutMs)
    : (await verifyVideoFullDecode(file, timeoutMs), false);
  const frameDelays = await apngFrameDelays(file, timeoutMs);
  if (
    media.frameCount === null ||
    media.frameCount < 2 ||
    frameDelays === null ||
    frameDelays.length < media.frameCount - 1
  ) {
    throw new EngineError(
      "corrupt_media",
      "The APNG's frames or timing could not be measured, so its animation cannot be preserved.",
    );
  }
  if (frameDelays.length === media.frameCount - 1) {
    frameDelays.push(frameDelays[frameDelays.length - 1]);
  }
  return {
    ...media,
    animated: true,
    apng: true,
    contentType: "image/png",
    durationSeconds: frameDelays.reduce((total, delay) => total + delay, 0) / 1000,
    frameDelays,
    hasAlpha: alpha,
    loop: plays,
    // An APNG carries no EXIF orientation, so an absent field is normalized to
    // upright rather than left undefined, which would short-circuit every plan
    // on a strict `!== 1` comparison.
    orientation: media.orientation ?? 1,
  };
}

/**
 * Turns `vipsheader -a` output into a lower-cased field map. The fields this
 * engine reads are `vips-loader` (the decoder that read the file), `width` and
 * `height` (one frame's dimensions), `n-pages` (the real frame count), `delay`
 * (a millisecond array with one entry per frame, including the last), `loop`
 * and `orientation` (the EXIF orientation libvips resolved).
 * Input: the raw header text. Output: field name → trimmed value, last wins.
 */
function parseVipsHeader(text) {
  const fields = new Map();
  for (const line of text.split("\n")) {
    const match = /^([a-z0-9-]+):\s*(.*)$/i.exec(line);
    if (match) fields.set(match[1].toLowerCase(), match[2].trim());
  }
  return fields;
}

/**
 * Reads the decoded header of an image and checks that the file really is one of
 * the accepted image formats.
 * Input: the file on disk. Output: the field map from `parseVipsHeader`.
 * Errors: `unsupported_media` when libvips cannot identify the file as an
 * accepted image format at all (an unreadable or foreign container, which is a
 * format-level problem, not proof of corrupted pixels).
 */
async function readImageFields(file, timeoutMs) {
  let stdout;
  try {
    ({ stdout } = await run(["vipsheader", "-a", file], timeoutMs));
  } catch (cause) {
    throw new EngineError(
      "unsupported_media",
      `The stored object is not a readable image of an accepted format: ${cause.message}`,
    );
  }
  const fields = parseVipsHeader(stdout);
  if (!IMAGE_CONTENT_TYPES.has(fields.get("vips-loader") ?? "")) {
    throw new EngineError(
      "unsupported_media",
      `The stored object is a "${fields.get("vips-loader") ?? "unknown"}" image, which is outside the accepted upload formats.`,
    );
  }
  return fields;
}

/**
 * Parses libvips' space-separated millisecond frame delays into rounded
 * numbers. A GIF or animated WebP always carries one delay per frame; a still
 * or a container without timing metadata yields null, which callers treat as
 * "pacing cannot be proven" rather than as a zero-length animation.
 */
function parseFrameDelays(raw) {
  if (raw === undefined) return null;
  const delays = raw
    .split(/\s+/)
    .filter((entry) => entry.length > 0)
    .map(Number);
  if (delays.length === 0 || delays.some((delay) => !Number.isFinite(delay) || delay < 0))
    return null;
  return delays.map((delay) => Math.round(delay));
}

/**
 * Resolves an EXIF orientation tag (1-8) into how the pixels must be turned to
 * display correctly: values 5-8 transpose the frame, so display dimensions are
 * the page dimensions swapped. Values 2 and 4 mirror only, 1 is upright.
 */
function orientationOf(fields) {
  const raw = Number(fields.get("orientation") ?? 1);
  return Number.isInteger(raw) && raw >= 1 && raw <= 8 ? raw : 1;
}

/**
 * Probes an image with libvips, which is both the decoder this engine re-encodes
 * with and the only local reader that understands every accepted animation
 * format. Facts are the decoded header plus a full multi-frame decode:
 * - `contentType` comes from the loader, so a mislabelled upload is caught.
 * - `width`/`height` are display-oriented frame dimensions: an EXIF orientation
 *   tag is applied here, so a normalized rendition can be compared against what
 *   a viewer actually sees instead of against the stored pixel grid.
 * - `frameCount` is the measured number of frames and `frameDelays` their real
 *   per-frame timing, including the final frame's delay.
 * - `durationSeconds` is the sum of those delays, so an animation's length is a
 *   measurement rather than a container header claim.
 * Throws `corrupt_media` when the header parses but the pixels do not decode.
 */
async function probeImage(file, timeoutMs) {
  const fields = await readImageFields(file, timeoutMs);
  // Read without a page selector: only the animation-capable loaders accept
  // "[n=-1]", while every one of them reports `n-pages` and the full `delay`
  // array on the plain header. Width and height are one frame's dimensions,
  // which is what an animation's frames are written at.
  const codedWidth = Number(fields.get("width"));
  const codedHeight = Number(fields.get("height"));
  const frames = Number(fields.get("n-pages") ?? 1);
  if (
    !Number.isInteger(codedWidth) ||
    !Number.isInteger(codedHeight) ||
    codedWidth < 1 ||
    codedHeight < 1
  ) {
    throw new EngineError("corrupt_media", "The decoded image reports invalid frame geometry.");
  }
  const frameCount = Number.isInteger(frames) && frames > 0 ? frames : 1;
  const frameDelays = frameCount > 1 ? parseFrameDelays(fields.get("delay")) : null;
  // Full-pixel decode of every frame before any verdict: a truncated animation
  // is rejected here instead of being re-encoded from its readable frames.
  await verifyImageFullDecode(file, timeoutMs, frameCount > 1);
  if (frameCount > 1 && frameDelays === null) {
    throw new EngineError(
      "corrupt_media",
      "The animation carries no per-frame timing, so its pacing cannot be preserved or verified.",
    );
  }
  if (fields.get("vips-loader") === "pngload") {
    // pngload decodes only the first frame of an APNG; the acTL chunk routes
    // the file to FFmpeg's APNG decoder, which is probed and fully decoded for
    // real frame count, per-frame timing, alpha and loop before any verdict.
    const plays = await apngPlayCount(file);
    if (plays !== null) return probeApng(file, timeoutMs, plays);
  }
  const orientation = orientationOf(fields);
  // Display-oriented geometry: an EXIF orientation that transposes the frame
  // swaps the axes, so every comparison downstream is made in the coordinate
  // system a viewer actually sees.
  const transposed = orientation >= 5;
  const width = transposed ? codedHeight : codedWidth;
  const height = transposed ? codedWidth : codedHeight;
  return {
    animated: frameCount > 1,
    audioChannels: 0,
    codedHeight,
    codedWidth,
    contentType: IMAGE_CONTENT_TYPES.get(fields.get("vips-loader")),
    displayAspect: width / height,
    durationSeconds:
      frameDelays === null ? null : frameDelays.reduce((total, delay) => total + delay, 0) / 1000,
    formatName: fields.get("vips-loader"),
    frameCount,
    frameDelays,
    loop: Number(fields.get("loop") ?? 0),
    hasAlpha: false,
    hasAudio: false,
    height,
    orientation,
    rotation: 0,
    sampleAspect: 1,
    videoCodec: "",
    width,
  };
}

/**
 * Streams a signed input capability to disk while enforcing the declared size,
 * the engine ceiling and an optional sha256 expectation. Nothing beyond
 * `expectedSize` is ever written, so a lying object cannot fill the instance
 * disk. Returns the observed byte count and digest, which the Worker re-verifies
 * before committing a rendition.
 */
async function downloadInput(url, file, { expectedChecksum, expectedSize, signal }) {
  const hash = createHash("sha256");
  const handle = await open(file, "w");
  let written = 0;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new EngineError(
        response.status === 403 || response.status === 404
          ? "input_unavailable"
          : "input_fetch_failed",
        `Reading the input object failed with HTTP ${response.status}; the signed capability may have expired.`,
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 0 && declared !== expectedSize) {
      throw new EngineError(
        "input_size_mismatch",
        `The stored object is ${declared} bytes but ${expectedSize} bytes were expected. Re-upload the file.`,
      );
    }
    if (!response.body) {
      throw new EngineError("input_fetch_failed", "The input capability returned an empty body.");
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > expectedSize) {
        await reader.cancel();
        throw new EngineError(
          "input_size_mismatch",
          `The stored object is larger than the declared ${expectedSize} bytes. Re-upload the file.`,
        );
      }
      hash.update(value);
      await handle.write(value);
    }
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    throw new EngineError(
      "input_fetch_failed",
      `Reading the input object failed: ${cause.message}`,
    );
  } finally {
    await handle.close();
  }
  if (written !== expectedSize) {
    throw new EngineError(
      "input_size_mismatch",
      `The stored object is ${written} bytes but ${expectedSize} bytes were expected. Re-upload the file.`,
    );
  }
  const sha256 = hash.digest("hex");
  if (expectedChecksum && sha256 !== expectedChecksum.toLowerCase()) {
    throw new EngineError(
      "checksum_mismatch",
      "The stored object's bytes do not match its recorded checksum. The upload was altered; re-upload the file.",
    );
  }
  return { bytes: written, sha256 };
}

/**
 * Measures meaningful transparency rather than assuming every RGBA image has it:
 * fully opaque PNG images may normalize to JPEG, but transparent pixels must survive.
 * Libvips has no "has-alpha" metadata field. Inspect the decoded band layout and
 * reduce its alpha band across all animation pages; probe errors remain failures,
 * never a false "opaque" verdict that would permit destructive flattening.
 */
async function hasAlpha(file, timeoutMs) {
  const { stdout: header } = await run(["vipsheader", "-a", file], timeoutMs);
  const bands = Number(/^bands:\s*(\d+)/m.exec(header)?.[1]);
  const interpretation = /^interpretation:\s*(\S+)/m.exec(header)?.[1];
  const colourBands =
    interpretation === "cmyk" ? 4 : interpretation === "b-w" || interpretation === "grey16" ? 1 : 3;
  if (!Number.isInteger(bands) || bands < colourBands) {
    throw new EngineError("corrupt_media", "The decoded image has an invalid colour-band layout.");
  }
  if (bands === colourBands) return false;
  const pages = Number(/^n-pages:\s*(\d+)/m.exec(header)?.[1] ?? 1);
  const format = /^format:\s*(\S+)/m.exec(header)?.[1];
  const opaque = format === "ushort" ? 65535 : format === "float" || format === "double" ? 1 : 255;
  const alphaFile = `${file}.alpha.v`;
  try {
    await run(
      ["vips", "extract_band", pages > 1 ? `${file}[n=-1]` : file, alphaFile, String(bands - 1)],
      timeoutMs,
    );
    const { stdout } = await run(["vips", "min", alphaFile], timeoutMs);
    const minimum = Number(stdout.trim());
    if (!Number.isFinite(minimum)) {
      throw new EngineError("corrupt_media", "The decoded image has unreadable transparency.");
    }
    return minimum < opaque;
  } finally {
    await rm(alphaFile, { force: true });
  }
}

/**
 * Measures per-frame delays of a video in milliseconds. Frame count alone does
 * not prove an animation was preserved: a rendition can keep every frame while
 * changing the pacing, which is exactly the silent content change this engine
 * must not make. Returns deltas rather than absolute timestamps so a differing
 * start offset cannot mask a pacing change.
 */
async function videoFrameDeltas(file, timeoutMs) {
  const { stdout } = await run(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "csv=p=0",
      file,
    ],
    timeoutMs,
  );
  const times = stdout
    .split("\n")
    .map((line) => Number(line.replace(/,/g, "").trim()))
    .filter((value) => Number.isFinite(value));
  return times.slice(1).map((value, index) => Math.round((value - (times[index] ?? value)) * 1000));
}

/**
 * Compares measured animation pacing against the source. A tolerance of a few
 * milliseconds absorbs container time-base rounding without permitting a real
 * timing change. Both sides must exist and hold the same number of frames:
 * missing timing is a verification failure, never a pass.
 */
function sameFrameTiming(source, candidate) {
  if (!source || !candidate || source.length !== candidate.length) return false;
  return source.every((delta, index) => Math.abs((candidate[index] ?? 0) - delta) <= 4);
}

/**
 * Decodes every audio and video stream of a video to null output so a verdict
 * is only ever reached on fully readable media. `-xerror` makes any decode
 * error fatal rather than a warning.
 */
async function verifyVideoFullDecode(file, timeoutMs) {
  try {
    await run(
      [
        "ffmpeg",
        "-v",
        "error",
        "-xerror",
        "-nostdin",
        "-threads",
        String(config.ffmpegThreads),
        "-i",
        file,
        "-map",
        "0:v?",
        "-map",
        "0:a?",
        "-f",
        "null",
        "-",
      ],
      timeoutMs,
    );
  } catch (cause) {
    throw new EngineError(
      "corrupt_media",
      `The media could not be fully decoded: ${cause.message}`,
    );
  }
}

/**
 * Fully decodes an image through libvips by copying it to a native scratch file,
 * proving the pixels are complete rather than the header merely well formed. An
 * animation is copied with every frame loaded ("[n=-1]"), so a truncated
 * animation fails here instead of being silently re-encoded from the frames
 * that happened to be readable; a still is copied plainly, because the JPEG and
 * PNG loaders reject the page selector.
 * Input: a libvips-readable image plus whether it holds more than one frame.
 * Output: nothing. Throws `corrupt_media` when any pixel fails to decode, and
 * always removes the scratch file.
 */
async function verifyImageFullDecode(file, timeoutMs, allFrames) {
  const target = `${file}.verify.v`;
  try {
    await run(["vips", "copy", allFrames ? `${file}[n=-1]` : file, target], timeoutMs);
  } catch (cause) {
    throw new EngineError(
      "corrupt_media",
      `The image could not be fully decoded: ${cause.message}`,
    );
  } finally {
    await rm(target, { force: true });
  }
}

/**
 * Computes the output geometry that fits the profile bounds while preserving
 * the source's display aspect ratio, resolving non-square source pixels onto
 * square ones and keeping even dimensions (required by yuv420p and by most
 * platform encoders). A square pixel source that already fits keeps its exact
 * dimensions, and nothing is ever upscaled.
 */
function targetDimensions(source, profile) {
  const { height, width } =
    source.sampleAspect === 1
      ? { height: source.height, width: source.width }
      : squarePixelDimensions(source);
  return fitWithinBounds({ height, width }, profile);
}

/**
 * Scales one frame's pixel box down to the largest size that fits the profile
 * bounds without upscaling. Rounding differs by kind on purpose: video and the
 * FFmpeg APNG encoder need even dimensions for yuv420p, while an animation
 * written through libvips uses whole integer frames with one page-height
 * applied to every frame, so rounding to the nearest pixel is what keeps
 * `n-pages * page-height == height`. Both encoders and the verifier go through
 * this one function, so a legitimate animation frame is never measured against
 * a grid its encoder was never asked to write.
 * Input: `{width, height}` for a single frame and the profile. Output: the frame
 * size to write, unchanged when the source already fits or the profile is
 * unbounded, and never larger than the source on either axis.
 */
function fitWithinBounds(frame, profile, { even = false } = {}) {
  const maxWidth = profile.max_width;
  const maxHeight = profile.max_height;
  if (!maxWidth || !maxHeight || (frame.width <= maxWidth && frame.height <= maxHeight)) {
    return frame;
  }
  const scale = Math.min(maxWidth / frame.width, maxHeight / frame.height);
  return profile.kind === "video" || even
    ? {
        height: Math.max(2, Math.floor((frame.height * scale) / 2) * 2),
        width: Math.max(2, Math.floor((frame.width * scale) / 2) * 2),
      }
    : {
        height: Math.min(frame.height, Math.max(1, Math.round(frame.height * scale))),
        width: Math.min(frame.width, Math.max(1, Math.round(frame.width * scale))),
      };
}

/**
 * Rounds a pixel count to the nearest even number — the chroma granularity of
 * yuv420p and of most platform encoders — never below a usable 2-pixel frame.
 */
function evenPixels(value) {
  return Math.max(2, 2 * Math.round(value / 2));
}

/**
 * Resolves non-square source pixels onto a 1:1 pixel grid at the same display
 * aspect ratio, so an anamorphic frame is corrected by shrinking rather than by
 * stretching it. The grid shrinks by min(1, sampleAspect), which also keeps the
 * derived height within the source's, and the height itself is derived from the
 * display aspect ratio. Example: 1280x720 at sample aspect 15:16 (display
 * aspect 5:3) becomes 1200x720, and a 720x480 DV frame at 32:27 (display aspect
 * 16:9) becomes 720x406.
 */
function squarePixelDimensions(media) {
  const width = evenPixels(media.width * Math.min(1, media.sampleAspect));
  return { height: evenPixels(width / media.displayAspect), width };
}

/**
 * Returns the deterministic ffmpeg/libvips flags that strip encoder metadata
 * and timestamps, so identical input and profile produce identical bytes.
 */
function deterministicFlags() {
  return ["-fflags", "+bitexact", "-flags:v", "+bitexact"];
}

/**
 * Clamps a profile quality value into the 1-100 range libvips encoders accept,
 * so a profile that omits it gets a sane default and one that exceeds the
 * encoder's range cannot silently produce a rejected plan.
 */
function encoderQuality(raw) {
  const quality = Math.round(Number(raw));
  return Number.isFinite(quality) ? Math.min(100, Math.max(1, quality)) : 82;
}

/**
 * libvips save options per still-image type. `strip` drops the source metadata
 * (including any EXIF orientation tag) so the rendition carries exactly the
 * pixels this engine decided on and re-encoding the same source twice yields
 * the same bytes.
 */
function stillSaveOptions(contentType, quality) {
  if (contentType === "image/jpeg") {
    return {
      extension: ".jpg",
      options: `Q=${quality},strip,optimize_coding=true,interlace=false`,
    };
  }
  if (contentType === "image/png") {
    return { extension: ".png", options: "compression=9,strip" };
  }
  if (contentType === "image/webp") {
    return { extension: ".webp", options: `Q=${quality},strip` };
  }
  return undefined;
}

/**
 * Computes the frame size an animation is written at, delegating to the same
 * `fitWithinBounds` the profile verifier uses so the encoder and the verifier
 * cannot disagree about the target grid. `pageHeight` is the per-frame height a
 * strip encodes. `even` is set for the FFmpeg APNG path, whose yuv420p encoder
 * requires even dimensions rather than libvips' nearest integer.
 * Input: a media fact set, the profile, and whether to round to an even grid.
 * Output: `{pageHeight, width}`.
 */
function animatedFrameDimensions(media, profile, { even = false } = {}) {
  const frame = fitWithinBounds({ height: media.height, width: media.width }, profile, { even });
  return { pageHeight: frame.height, width: frame.width };
}

/**
 * Builds the still-image candidates the profile allows, in the profile's
 * `allowed_content_types` order (the caller treats that order as the publishing
 * preference, so the preferred rendition for this source class is `plans[0]`).
 *
 * Each plan runs libvips: `autorot` first when the source carries an EXIF
 * orientation tag, so the orientation is baked into the pixels instead of being
 * stripped and silently lost, then `resize` only when the source is larger than
 * the profile bounds (never upscaled), then one save at the profile's quality.
 * Orientation and scaling compose in that order, so a rotated source is fitted
 * on its display axes.
 */
function stillImageCandidates(source, profile, directory) {
  const media = source.media;
  const quality = encoderQuality(profile.quality);
  const target = targetDimensions(media, profile);
  const plans = [];
  for (const contentType of profile.allowed_content_types) {
    const save = stillSaveOptions(contentType, quality);
    if (!save) continue;
    // JPEG cannot carry transparency, so a source with alpha is never flattened
    // into it: that would destroy creator content to save bytes.
    if (contentType === "image/jpeg" && media.hasAlpha) continue;
    const file = path.join(directory, `candidate${save.extension}`);
    plans.push({
      contentType,
      file,
      make: () => {
        const baked = `${file}.baked.v`;
        const scaled = `${file}.scaled.v`;
        // A lossless native scratch file between the steps keeps the single
        // lossy encode at the end instead of re-encoding twice.
        const rotate = media.orientation !== 1;
        const resize = target.width < media.width || target.height < media.height;
        const input = rotate ? baked : source.file;
        return [
          ...(rotate ? [["vips", "autorot", source.file, baked]] : []),
          // Each axis is scaled to its exact target: a uniform factor would
          // leave the height up to a few pixels off the even-rounded bound the
          // verifier compares against, which a non-uniform profile bound would
          // trigger on every oversized image.
          ...(resize
            ? [
                [
                  "vips",
                  "resize",
                  input,
                  scaled,
                  String(target.width / media.width),
                  "--vscale",
                  String(target.height / media.height),
                ],
              ]
            : []),
          ["vips", "copy", resize ? scaled : input, `${file}[${save.options}]`],
        ];
      },
    });
  }
  return plans;
}

/**
 * Builds the animated-image candidates the profile allows, in the profile's
 * `allowed_content_types` order. Only WebP and GIF can hold an animation, so
 * those are the only output types offered: writing frames into JPEG or PNG
 * would silently drop all but one of them.
 *
 * FFmpeg cannot be used here at all — it cannot decode an animated WebP, so it
 * could neither produce a verifiable animation nor measure its timing. libvips
 * writes the whole page strip in one pass, keeping every frame, the alpha band
 * and the per-frame delays, with `page-height` stated explicitly because
 * libvips' scale operations resize the strip without updating that field.
 * Animated WebP keeps every frame while dropping GIF's palette overhead; GIF
 * output is only attempted for non-GIF sources, since re-encoding a GIF to GIF
 * cannot shrink it, and GIF holds at most one transparent index so an alpha
 * source stays in WebP.
 *
 * An animation whose frames carry a transposing EXIF orientation is left
 * alone: rotating a page strip rotates the strip rather than each frame, and
 * per-frame rotation is not available as one bounded operation.
 */
function animatedImageCandidates(source, profile, directory) {
  const media = source.media;
  if ((media.orientation ?? 1) !== 1) return [];
  const quality = encoderQuality(profile.quality);
  const effort = Math.min(6, Math.max(0, Math.round(Number(profile.effort ?? 4))));
  // The FFmpeg APNG path encodes yuv420p, so it shares the even grid the
  // verifier measures its rendition against — the libvips grid below.
  const apngTarget = animatedFrameDimensions(media, profile, { even: true });
  const target = animatedFrameDimensions(media, profile);
  // Either axis may drive the fit alone: a frame that already fits in width but
  // overflows in height must still be scaled, otherwise the copied strip is
  // written at a page height that describes frames which do not exist.
  const resize = target.width !== media.width || target.pageHeight !== media.height;
  // One invocation per plan: scaling and encoding a strip happen in the same
  // pass, and `vips resize` takes its scale after the output. `page-height` is
  // stated on the output because scaling does not update it and would otherwise
  // describe frames that no longer exist.
  const argvFor = (file, options) => [
    [
      "vips",
      resize ? "resize" : "copy",
      `${source.file}[n=-1]`,
      `${file}[${options},page-height=${target.pageHeight}]`,
      // The strip's axes scale by the frame ratios, not one shared factor: the
      // vertical axis must land the strip at exactly `n-pages * page-height`, so
      // the horizontal ratio and the per-frame vertical ratio are each given.
      ...(resize
        ? [String(target.width / media.width), "--vscale", String(target.pageHeight / media.height)]
        : []),
    ],
  ];
  const plans = [];
  for (const contentType of profile.allowed_content_types) {
    if (contentType === "image/webp") {
      const file = path.join(directory, "candidate.webp");
      if (media.apng) {
        // Without libwebp_anim there is no verifiable animation plan for an
        // APNG, so the unsupported-type failure downstream is intentional.
        if (!hasLibwebpAnim) continue;
        // FFmpeg's APNG decoder feeds the frames libvips cannot read to
        // libwebp_anim, so the rendition keeps every frame, the acTL play
        // count, the alpha channel and each frame's real duration rather than
        // collapsing the animation to its first frame.
        plans.push({
          contentType,
          file,
          make: () => [
            [
              "ffmpeg",
              "-v",
              "error",
              "-nostdin",
              "-y",
              "-ignore_loop",
              "1",
              "-i",
              source.file,
              "-c:v",
              "libwebp_anim",
              "-q:v",
              String(quality),
              "-pix_fmt",
              media.hasAlpha ? "yuva420p" : "yuv420p",
              "-loop",
              String(media.loop),
              // Even, profile-fitting dimensions: the same grid the verifier
              // compares against and the only geometry libwebp_anim encodes.
              ...(apngTarget.width !== media.width || apngTarget.pageHeight !== media.height
                ? ["-vf", `scale=${apngTarget.width}:${apngTarget.pageHeight}`]
                : []),
              "-filter_threads",
              String(config.ffmpegThreads),
              file,
            ],
          ],
        });
        continue;
      }
      plans.push({
        contentType,
        file,
        make: () => argvFor(file, `Q=${quality},effort=${effort},keep=none`),
      });
    }
    if (
      contentType === "image/gif" &&
      !media.apng &&
      media.contentType !== "image/gif" &&
      !media.hasAlpha
    ) {
      const file = path.join(directory, "candidate.gif");
      plans.push({
        contentType,
        file,
        make: () => argvFor(file, `effort=${effort}`),
      });
    }
  }
  return plans;
}

/**
 * Builds the video candidates: a stream-copy remux when the source is already
 * H.264 MP4/MOV compatible (lossless and fast), plus a bounded H.264/AAC
 * re-encode that normalizes container, pixel format and audio layout. All
 * streams are mapped, so full duration and audio are preserved.
 *
 * The re-encode also normalizes pixel geometry: the scale filter is handed the
 * even, profile-fitting target dimensions that already carry the source display
 * aspect ratio on a 1:1 grid, and `reset_sar=1` clears the source sample aspect,
 * so non-square source pixels are squared off instead of being stretched.
 */
function videoCandidates(source, profile, directory) {
  if (!profile.allowed_content_types.includes("video/mp4")) return [];
  const output = path.join(directory, "candidate.mp4");
  const remuxOutput = path.join(directory, "candidate-remux.mp4");
  const target = targetDimensions(source.media, profile);
  const needsScale = target.width !== source.media.width || target.height !== source.media.height;
  // Square pixel normalization changes the coded dimensions even when the
  // profile bounds are already satisfied, so an anamorphic source is re-encoded
  // rather than remuxed with its non-square sample aspect intact.
  const remuxable =
    source.media.videoCodec === "h264" &&
    source.media.pixelFormat === "yuv420p" &&
    (source.media.formatName.includes("mp4") || source.media.formatName.includes("mov"));
  const plans = [];
  if (remuxable && !needsScale) {
    plans.push({
      contentType: "video/mp4",
      file: remuxOutput,
      // A stream copy never touches decoded pixels, so a verified remux is the
      // lossless candidate the selector prefers over every lossy re-encode.
      lossless: true,
      make: () => [
        [
          "ffmpeg",
          "-v",
          "error",
          "-nostdin",
          "-threads",
          String(config.ffmpegThreads),
          "-i",
          source.file,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          // Container metadata is padding, not content: `-c copy` would carry a
          // multi-megabyte comment through unchanged, so it is dropped — that is
          // the only size win a remux can legitimately offer.
          "-map_metadata",
          "-1",
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          ...deterministicFlags(),
          remuxOutput,
        ],
      ],
    });
  }
  plans.push({
    contentType: "video/mp4",
    file: output,
    make: () => [
      [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-threads",
        String(config.ffmpegThreads),
        "-i",
        source.file,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        ...(needsScale
          ? [
              "-filter_threads",
              String(config.ffmpegThreads),
              "-vf",
              `scale=${target.width}:${target.height}:reset_sar=1`,
            ]
          : []),
        // Container metadata is padding, not content: it is dropped here too
        // so the re-encode and the lossless remux are compared on real bytes.
        "-map_metadata",
        "-1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        String(Math.min(40, Math.max(14, Math.round(profile.quality ?? 23)))),
        // Pixel format normalization: 4:2:0 8-bit is what every platform the
        // upload policy accepts can decode, so the source's chroma layout is
        // normalized rather than carried through.
        "-pix_fmt",
        "yuv420p",
        // Audio normalization only: the sample rate is resampled and the channel
        // layout is left intact, because dropping or folding surround channels
        // would silently remove creator content.
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        "-threads",
        String(config.ffmpegThreads),
        ...deterministicFlags(),
        output,
      ],
    ],
  });
  return plans;
}

/**
 * Returns why verified media does not satisfy the requested profile or failed
 * to preserve the source's duration, frame count, audio and display aspect
 * ratio — `null` when it does satisfy them. Geometry is compared against the
 * normalized target, so a source that only satisfies the profile after square
 * pixel normalization is never reported as already compliant. Video
 * additionally requires browser-compatible H.264 8-bit 4:2:0 and AAC when audio
 * exists; an MP4 container alone is not sufficient. The reason is surfaced in
 * the job's failure payload so a discarded candidate is diagnosable instead of
 * silently absent.
 *
 * Frame sizes are compared within one pixel: an animation is written as whole
 * integer frames, so an exact scaled ratio can only be expressed to the nearest
 * pixel, while the display aspect ratio below still has to hold.
 */
function profileRejection(media, profile, sourceMedia) {
  if (!profile.allowed_content_types.includes(media.contentType)) {
    return `output type ${media.contentType} is not in the profile's allowed types`;
  }
  if (
    profile.kind === "video" &&
    (media.videoCodec !== "h264" ||
      media.pixelFormat !== "yuv420p" ||
      (media.hasAudio && media.audioCodec !== "aac") ||
      media.sampleAspect !== 1)
  ) {
    return `video stream is ${media.videoCodec}/${media.pixelFormat}/${media.audioCodec || "no-audio"} at sample aspect ${media.sampleAspect}, not h264/yuv420p/aac at 1:1`;
  }
  // An animation is written on the integer frame grid its encoder was given, so
  // it is measured against that same grid; stills and video keep the even
  // dimensions their encoders require.
  const target =
    sourceMedia.animated && media.animated
      ? animatedFrameDimensions(sourceMedia, profile, {
          even: Boolean(sourceMedia.apng),
        })
      : targetDimensions(sourceMedia, profile);
  // The animation frame grid reports `pageHeight` where the still/video grid
  // reports `height`; comparing `media.height` against a missing field reads
  // as NaN and would vacuously pass, so the correct key is taken here.
  const targetHeight = target.pageHeight ?? target.height;
  if (Math.abs(media.width - target.width) > 1 || Math.abs(media.height - targetHeight) > 1) {
    return `rendition geometry ${media.width}x${media.height} does not match the ${target.width}x${targetHeight} target grid`;
  }
  const tolerance = Math.max(0.01, sourceMedia.displayAspect * 0.005);
  if (Math.abs(sourceMedia.displayAspect - media.displayAspect) > tolerance) {
    return `display aspect ${media.displayAspect} changed from source ${sourceMedia.displayAspect}`;
  }
  if (sourceMedia.hasAudio !== media.hasAudio) {
    return `audio presence changed from ${sourceMedia.hasAudio} to ${media.hasAudio}`;
  }
  // Codec normalization is allowed; losing channels is not.
  if (sourceMedia.hasAudio && media.audioChannels < sourceMedia.audioChannels) {
    return `audio channels dropped from ${sourceMedia.audioChannels} to ${media.audioChannels}`;
  }
  if (
    sourceMedia.frameCount !== null &&
    media.frameCount !== null &&
    media.frameCount < sourceMedia.frameCount
  ) {
    return `frame count dropped from ${sourceMedia.frameCount} to ${media.frameCount}`;
  }
  if (
    sourceMedia.animated &&
    media.animated &&
    sourceMedia.loop !== undefined &&
    media.loop !== undefined &&
    media.loop !== sourceMedia.loop
  ) {
    // Turning a looping animation into a once-only playback is a content
    // change, exactly like a dropped frame or a changed delay.
    return `loop count changed from ${sourceMedia.loop} to ${media.loop}`;
  }
  if (sourceMedia.durationSeconds !== null && media.durationSeconds !== null) {
    if (
      Math.abs(media.durationSeconds - sourceMedia.durationSeconds) >
      Math.max(0.5, sourceMedia.durationSeconds * 0.02)
    ) {
      return `duration changed from ${sourceMedia.durationSeconds}s to ${media.durationSeconds}s`;
    }
  }
  if (
    profile.max_duration_seconds !== null &&
    media.durationSeconds !== null &&
    media.durationSeconds > profile.max_duration_seconds + 0.5
  ) {
    return `duration ${media.durationSeconds}s exceeds the profile ceiling ${profile.max_duration_seconds}s`;
  }
  return null;
}

/**
 * Uploads a verified rendition through the granted exact-object PUT capability,
 * streaming the body so a 500 MiB output never lands in memory, and reporting
 * the verified size and sha256 the Worker re-checks before committing. HTTP
 * ETags lose only their surrounding quotes to match R2's bare `etag` field;
 * missing or weak tags stay unchanged and cannot falsely prove stored bytes.
 *
 * The request carries `If-None-Match: *`, which the signed capability requires:
 * a replayed or leaked grant may create the rendition object but can never
 * overwrite bytes that were already approved. A single-part PUT is atomic in
 * object storage, so a failure cannot leave a partial, untracked output.
 */
async function uploadOutput(url, file, contentType, signal) {
  const { size } = await stat(file);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const sha256 = digest.digest("hex");
  let response;
  try {
    response = await fetch(url, {
      body: createReadStream(file),
      duplex: "half",
      headers: {
        "content-length": String(size),
        "content-type": contentType,
        "if-none-match": "*",
      },
      method: "PUT",
      signal,
    });
  } catch (cause) {
    throw new EngineError(
      "output_upload_failed",
      `Uploading the rendition failed: ${cause.message}`,
    );
  }
  if (response.status === 412) {
    throw Object.assign(
      new EngineError(
        "output_exists",
        "The rendition object already exists, so this attempt must not replace it. Verify the stored rendition and retry the attachment.",
      ),
      // The digest of the bytes this attempt produced lets a replayed job
      // recognize a conflict whose recomputation is byte-identical to its
      // recorded verdict; whether the stored object is those bytes is the
      // Worker's own stored-digest check to prove.
      { outputSha256: sha256 },
    );
  }
  if (!response.ok) {
    throw new EngineError(
      "output_upload_failed",
      `The output capability rejected the rendition with HTTP ${response.status}; the reserved capacity is unreleased.`,
    );
  }
  const httpEtag = response.headers.get("etag");
  const etag =
    httpEtag?.startsWith('"') && httpEtag.endsWith('"') ? httpEtag.slice(1, -1) : httpEtag;
  return { bytes: size, etag, sha256 };
}

/**
 * Projects verified media facts onto the response contract the Worker persists
 * on the Asset and its rendition row.
 */
function reportMedia(media) {
  return {
    animated: media.animated,
    content_type: media.contentType,
    duration_seconds: media.durationSeconds,
    frame_count: media.frameCount,
    has_audio: media.hasAudio,
    height: media.height,
    width: media.width,
  };
}

/**
 * Builds the "no benefit" success payload, which reports the verified original
 * as the rendition with no upload. Only ever called once the original has been
 * fully decoded and either already satisfies the profile or has been shown not
 * to be improved upon by a verified rendition — it is not a fallback for a
 * candidate that failed to build.
 */
function originalCompatible(job, input, media, startedAt) {
  return {
    engine: { duration_ms: Date.now() - startedAt, ...toolVersions },
    input,
    job_id: job.job_id,
    media: reportMedia(media),
    output: null,
    result: "original_compatible",
  };
}

/**
 * Returns the effective per-job deadline in milliseconds, clamped to the engine
 * ceiling so a caller cannot request unbounded compute.
 */
function deadlineMsFor(job) {
  const requested = job.deadline_seconds
    ? Math.round(job.deadline_seconds * 1000)
    : config.jobTimeoutMs;
  return Math.max(5_000, Math.min(config.jobTimeoutMs, requested));
}

/**
 * Produces one candidate, verifies it fully, and reports whether it may be
 * used. A candidate that cannot be produced, decoded or proven equivalent is
 * discarded with the measured reason, never reported. `sourceFacts` carries the
 * measurements a candidate must match: transparency and measured animation
 * pacing. `stepBudget` hands each tool invocation the job's remaining wall-clock
 * budget, so steps are charged honestly against the deadline.
 * Output: `{ candidate }` when verified, otherwise `{ reason }` naming the
 * check that discarded it, so a failed job reports why rather than a bare count.
 *
 * A plan may need more than one tool invocation — bake the EXIF orientation,
 * fit the profile bounds, then encode — so `make` returns the argv list in
 * execution order. Images are re-read and fully decoded by the same libvips
 * probe that verified the source, so a rendition is measured exactly as
 * strictly as the input was; FFmpeg keeps the video path.
 */
async function produceCandidate(plan, sourceMedia, profile, stepBudget, sourceFacts) {
  const discard = async (reason) => {
    await rm(plan.file, { force: true });
    return { reason };
  };
  const isVideo = sourceMedia.contentType.startsWith("video/");
  let media;
  try {
    for (const argv of plan.make()) await run(argv, stepBudget());
    media = isVideo
      ? await probe(plan.file, { timeoutMs: stepBudget() })
      : await probeImage(plan.file, stepBudget());
  } catch (cause) {
    // The tool's own failure (exit status, decode error, step timeout) is the
    // most useful diagnostic, so it is reported rather than flattened away.
    return discard(`encode or probe failed: ${cause.message}`);
  }
  const rejection = profileRejection(media, profile, sourceMedia);
  if (rejection !== null) return discard(rejection);
  if (sourceMedia.animated || media.animated) {
    const timings =
      media.frameDelays ??
      (isVideo
        ? await videoFrameDeltas(plan.file, stepBudget()).catch(() => undefined)
        : undefined);
    // A candidate whose pacing cannot be measured is discarded, never accepted
    // on frame count alone: keeping every frame at the wrong speed is still a
    // silent content change.
    if (!sameFrameTiming(sourceFacts.timings, timings))
      return discard("measured frame pacing does not match the source delays");
  }
  if (
    sourceFacts.hasAlpha &&
    !isVideo &&
    !(await hasAlpha(plan.file, stepBudget()).catch(() => false))
  ) {
    // Transparency is proven on the rendition itself rather than inferred from
    // the chosen container, so a plan that quietly dropped the alpha band (a
    // flattened WebP or PNG, not only a JPEG) is discarded.
    return discard("the rendition lost the source's alpha band");
  }
  const { size } = await stat(plan.file);
  return {
    candidate: {
      contentType: plan.contentType,
      file: plan.file,
      lossless: plan.lossless === true,
      media,
      size,
    },
  };
}

/**
 * Runs one job end to end: bounded download, full decode, candidate generation,
 * verification, selection, and an upload only when a candidate genuinely helps.
 * Returns the success payload, or throws EngineError with an actionable message.
 */
async function processJob(job, signal) {
  const startedAt = Date.now();
  const directory = path.join(
    config.workDir,
    `job-${createHash("sha256").update(job.job_id).digest("hex").slice(0, 32)}`,
  );
  const deadline = deadlineMsFor(job);
  // Each step is charged the job's remaining wall-clock budget, capped at five
  // minutes, rather than a fixed fraction of the total: a plan chain of many
  // steps must still die at the deadline, but an expensive encode inside a
  // compliant job must not be starved by an arbitrary divisor. The returned
  // budget only ever shrinks as the job runs.
  const stepBudget = () =>
    Math.max(5_000, Math.min(300_000, deadline - (Date.now() - startedAt) - 2_000));
  await mkdir(directory, { recursive: true });
  try {
    const inputFile = path.join(directory, "input");
    const input = await downloadInput(job.input_url, inputFile, {
      expectedChecksum: job.expected_checksum ?? null,
      expectedSize: job.expected_size,
      signal,
    });
    // Images are probed by libvips, the decoder that also re-encodes them: it is
    // the only local reader that understands every accepted animation format,
    // and its loader plus full multi-frame decode is the authority on what the
    // object really is. FFmpeg keeps the video path, where it is the decoder
    // that matters. Either way the verdict follows a full decode, never a header.
    const declaredIsImage = job.declared_content_type.startsWith("image/");
    const sourceMedia = declaredIsImage
      ? await probeImage(inputFile, stepBudget())
      : await probe(inputFile, { timeoutMs: stepBudget() });
    if (!declaredIsImage) await verifyVideoFullDecode(inputFile, stepBudget());
    if (sourceMedia.contentType !== job.declared_content_type) {
      throw new EngineError(
        "unsupported_media",
        `The stored object decodes as ${sourceMedia.contentType}, not the declared ${job.declared_content_type}.`,
      );
    }
    const isVideo = sourceMedia.contentType.startsWith("video/");
    if ((isVideo ? "video" : "image") !== job.profile.kind) {
      throw new EngineError(
        "unsupported_media",
        `The stored object decodes as ${sourceMedia.contentType}, which cannot be processed with the ${job.profile.kind} profile.`,
      );
    }

    // Measurements the candidate pipeline must match: transparency decides
    // whether lossy JPEG is allowed at all, and measured frame pacing is what
    // proves an animation kept its timing rather than only its frame count. An
    // image's pacing comes from the loader's own per-frame delay array (one
    // entry per frame, including the last), which is the only local measurement
    // available for an animated WebP.
    const sourceFacts = {
      // An APNG's alpha is a stream property (its decoded pixel format), not a
      // first-frame measurement: `hasAlpha` would only see frame one.
      hasAlpha: isVideo
        ? false
        : sourceMedia.apng
          ? sourceMedia.hasAlpha
          : await hasAlpha(inputFile, stepBudget()),
      timings: isVideo
        ? sourceMedia.animated && sourceMedia.frameCount !== null && sourceMedia.frameCount <= 2_000
          ? await videoFrameDeltas(inputFile, stepBudget()).catch(() => undefined)
          : undefined
        : (sourceMedia.frameDelays ?? undefined),
    };
    sourceMedia.hasAlpha = sourceFacts.hasAlpha;
    if (sourceMedia.hasAudio && sourceMedia.audioChannels > 6) {
      throw new EngineError(
        "unsupported_media",
        `The upload has a ${sourceMedia.audioChannels}-channel layout that cannot be normalized without dropping channels. Upload a master the platform can accept.`,
      );
    }

    const source = { file: inputFile, media: sourceMedia };
    const plans = isVideo
      ? videoCandidates(source, job.profile, directory)
      : sourceMedia.animated
        ? animatedImageCandidates(source, job.profile, directory)
        : stillImageCandidates(source, job.profile, directory);

    // Candidate outcomes are accounted for separately, because "no verified
    // rendition" has three very different causes and only one of them may ever
    // be reported as success: a verified rendition that is merely over budget, a
    // profile that offers no type able to carry this source, and a genuine
    // encoder or decoder failure. Only the last is retryable, and none of them
    // may fall back to handing back the original as if nothing had gone wrong.
    const verified = [];
    const overBudget = [];
    const failedTypes = [];
    for (const plan of plans) {
      const outcome = await produceCandidate(
        plan,
        sourceMedia,
        job.profile,
        stepBudget,
        sourceFacts,
      );
      if (!outcome.candidate)
        failedTypes.push(`${plan.contentType} (${outcome.reason ?? "unproduced"})`);
      else if (outcome.candidate.size > job.maximum_output_bytes)
        overBudget.push(outcome.candidate);
      else verified.push(outcome.candidate);
    }

    // The preferred output is the first candidate the profile can actually
    // produce for this source's content class: plans are built in
    // allowed_content_types order and already exclude types that cannot
    // represent the source (no JPEG for alpha, only WebP for animation).
    // "Already compliant" therefore means "is the preferred type", so an
    // opaque PNG never skips the required JPEG rendition just because PNG is
    // also publishable somewhere.
    const preferred = plans.length > 0 ? plans[0].contentType : undefined;
    const sourceCompliant =
      preferred !== undefined &&
      sourceMedia.contentType === preferred &&
      profileRejection(sourceMedia, job.profile, sourceMedia) === null;
    // Selection honours profile.allowed_content_types as a preference order
    // before byte size: a publishing-compatible format must win over a smaller
    // but unpublishable one (a WebP still cannot reach Instagram). Inside the
    // winning type a verified lossless candidate wins over a smaller lossy one
    // — a byte win that costs pixels is not one — and size breaks ties only
    // between candidates of the same kind. Every listed type is already
    // verified above, so this never weakens correctness.
    const typeRank = new Map(
      job.profile.allowed_content_types.map((contentType, index) => [contentType, index]),
    );
    const best = verified.reduce((winner, candidate) => {
      if (!winner) return candidate;
      const candidateRank = typeRank.get(candidate.contentType) ?? Infinity;
      const winnerRank = typeRank.get(winner.contentType) ?? Infinity;
      if (candidateRank !== winnerRank) {
        return candidateRank < winnerRank ? candidate : winner;
      }
      // Inside the publishable type a verified lossless candidate is kept over
      // a smaller lossy one: a re-encode that saves bytes by discarding pixel
      // detail is never "free" when a stream copy already satisfies the profile.
      if (candidate.lossless !== winner.lossless) return candidate.lossless ? candidate : winner;
      return candidate.size < winner.size ? candidate : winner;
    }, undefined);
    // A job with no usable rendition is classified by cause, not by whether the
    // source happened to be publishable already: an encoder or decoder that
    // produced nothing is a failure and must never be reported as a success
    // with the original handed back — accepting it would claim verified work
    // that never happened.
    if (!best) {
      if (overBudget.length > 0) {
        throw new EngineError(
          "output_too_large",
          `A verified ${overBudget[0].contentType} rendition of ${overBudget[0].size} bytes exceeds the reserved ${job.maximum_output_bytes} bytes.`,
        );
      }
      if (plans.length === 0) {
        throw new EngineError(
          "unsupported_media",
          `No type this profile allows (${job.profile.allowed_content_types.join(", ")}) can carry a ${sourceMedia.contentType} without losing content.`,
        );
      }
      throw new EngineError(
        "engine_error",
        `No verified rendition could be produced for any of ${failedTypes.join(", ")}; the source decoded but no encoder produced a compliant result.`,
      );
    }
    // "No benefit" is a verified success on the only proven ground: the source
    // already satisfies the requested profile and the verified rendition is
    // not meaningfully smaller. A compliant source with a genuinely better
    // rendition still uploads the rendition.
    if (sourceCompliant && best.size > input.bytes * 0.95) {
      return originalCompatible(job, input, sourceMedia, startedAt);
    }

    const uploaded = await uploadOutput(job.output_url, best.file, best.contentType, signal);
    if (uploaded.bytes > job.maximum_output_bytes) {
      throw new EngineError(
        "output_too_large",
        `The rendition is ${uploaded.bytes} bytes, over the reserved ${job.maximum_output_bytes} bytes.`,
      );
    }
    return {
      engine: { duration_ms: Date.now() - startedAt, ...toolVersions },
      input,
      job_id: job.job_id,
      media: reportMedia(best.media),
      output: {
        bytes: uploaded.bytes,
        content_type: best.contentType,
        etag: uploaded.etag,
        sha256: uploaded.sha256,
      },
      result: "optimized",
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/**
 * Reads the real tool versions this engine executed, once at boot, so the smoke
 * can prove native binaries did the work rather than a mocked response.
 */
const toolVersions = await (async () => {
  const read = async (argv) =>
    (await run(argv, 10_000).catch(() => ({ stdout: "unknown" }))).stdout.split("\n")[0].trim();
  return {
    ffmpeg: await read(["ffmpeg", "-version"]),
    vips: await read(["vips", "--version"]),
  };
})();

/**
 * Whether the build's FFmpeg can encode animated WebP (libwebp_anim). Probed
 * once at boot so its absence is an explicit capability fact — an APNG job then
 * reports "this profile cannot carry it" instead of a generic encoder failure
 * surfacing only after the decode probe ran.
 */
const hasLibwebpAnim = /libwebp_anim/.test(
  (
    await run(["ffmpeg", "-v", "quiet", "-encoders"], 10_000).catch(() => ({
      stdout: "",
    }))
  ).stdout,
);

/**
 * Validates and narrows an untrusted request body into a job, rejecting unknown
 * shapes outright so a malformed payload can never reach the media pipeline.
 */
function parseJob(body) {
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
    job.expected_size > config.maxInputBytes
  ) {
    throw new EngineError(
      "input_too_large",
      `expected_size must be between 1 and ${config.maxInputBytes} bytes.`,
    );
  }
  if (job.expected_checksum !== undefined && job.expected_checksum !== null) {
    if (
      typeof job.expected_checksum !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(job.expected_checksum)
    ) {
      throw new EngineError(
        "invalid_request",
        'Field "expected_checksum" must be a sha256 hex digest.',
      );
    }
  }
  if (!Number.isInteger(job.maximum_output_bytes) || job.maximum_output_bytes <= 0) {
    throw new EngineError("invalid_request", "maximum_output_bytes must be a positive integer.");
  }
  if (job.maximum_output_bytes > config.maxOutputBytes) {
    throw new EngineError(
      "invalid_request",
      `maximum_output_bytes may not exceed the engine ceiling of ${config.maxOutputBytes} bytes.`,
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
  profile.allowed_content_types = profile.allowed_content_types.map((entry) => {
    if (typeof entry !== "string" || !ACCEPTED_CONTENT_TYPES.has(entry.toLowerCase())) {
      throw new EngineError(
        "unsupported_media",
        `Profile output type "${entry}" is outside the accepted formats.`,
      );
    }
    return entry.toLowerCase();
  });
  if (profile.kind === "video" && !profile.allowed_content_types.includes("video/mp4")) {
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
  return job;
}

/** Bounded admission gate: one running job plus at most `maxPendingJobs` waiters. */
const queue = { active: 0, waiting: [] };

/**
 * Admits a job when a slot is free, otherwise queues it while the wait queue has
 * room, otherwise reports saturation so the caller answers with a retryable
 * busy error instead of piling work onto the instance.
 */
function admit() {
  if (queue.active === 0) {
    queue.active += 1;
    return true;
  }
  if (queue.waiting.length < config.maxPendingJobs) {
    return new Promise((resolve) => queue.waiting.push(resolve));
  }
  return false;
}

/**
 * Releases a job slot, handing it straight to the next waiter when one exists so
 * the running job count never exceeds the configured bound.
 */
function release() {
  const next = queue.waiting.shift();
  if (next) {
    next();
    return;
  }
  queue.active = Math.max(0, queue.active - 1);
}

const JOB_CACHE_LIMIT = 256;
const JOB_CACHE_TTL_MS = 30 * 60 * 1000;
const jobCache = new Map();
/**
 * Job ids currently executing. The dedupe window in `jobCache` only covers
 * completed runs, so a lease-expiry redelivery arriving while the original is
 * still working would otherwise start a second `processJob` for the same
 * rendition: both upload the same deterministic key, the loser's create-only
 * PUT gets a 412, and that conflict surfaces as a terminal `output_exists`
 * even though a correct rendition was being written. A duplicate delivery is
 * therefore answered `busy` — retryable, like a saturated worker — and the
 * next delivery replays the recorded verdict.
 */
const inflightJobs = new Set();

/**
 * Returns a recorded terminal outcome for a redelivered job id so a lease-expiry
 * retry can replay the result instead of writing a second rendition. Bounded in
 * age and count: this is a dedupe window, not durable state. The caller must
 * re-verify an "optimized" entry before answering from it — the object it
 * recorded may have been deleted by the Worker's recovery while the grant that
 * could prove it still exists is only reachable by re-executing the job.
 */
function replayFor(jobId) {
  const entry = jobCache.get(jobId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > JOB_CACHE_TTL_MS) {
    jobCache.delete(jobId);
    return undefined;
  }
  return entry;
}

/** Records a terminal outcome, evicting the oldest entry once the cap is hit. */
function rememberFor(jobId, value) {
  if (jobCache.size >= JOB_CACHE_LIMIT) {
    const oldest = jobCache.keys().next().value;
    if (oldest !== undefined) jobCache.delete(oldest);
  }
  jobCache.set(jobId, { at: Date.now(), value });
}

/**
 * Authenticates the per-instance bearer secret in constant time, so a wrong
 * token cannot be discovered by timing the comparison.
 */
function authorized(request) {
  const header = request.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = config.token;
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

/** Builds a JSON response with an explicit status and no-store caching. */
function json(status, payload) {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/json; charset=utf-8",
    },
    status,
  };
}

/**
 * HTTP entrypoint. `POST /process` is the only job route and requires the bearer
 * secret; `GET /healthz` is unauthenticated readiness for the Durable Object's
 * container startup probe. Request bodies are read under a hard size cap. Job
 * ids are single-flight: a recorded terminal outcome replays through
 * `jobCache`, while a delivery for a job id still executing is answered `busy`
 * rather than racing a second rendition PUT on the same deterministic key.
 */
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://engine.local");
  if (request.method === "GET" && url.pathname === "/healthz") {
    const reply = json(200, { engine: ENGINE_ID, ...toolVersions });
    response.writeHead(reply.status, reply.headers);
    response.end(reply.body);
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/process") {
    const reply = json(404, {
      error: {
        code: "invalid_request",
        message: "Unknown route.",
        retryable: false,
      },
    });
    response.writeHead(reply.status, reply.headers);
    response.end(reply.body);
    return;
  }
  if (!authorized(request)) {
    const reply = json(401, {
      error: {
        code: "unauthorized",
        message: "A valid per-instance job token is required.",
        retryable: false,
      },
    });
    response.writeHead(reply.status, {
      ...reply.headers,
      "www-authenticate": "Bearer",
    });
    response.end(reply.body);
    return;
  }
  const chunks = [];
  let received = 0;
  let oversized = false;
  request.on("data", (chunk) => {
    received += chunk.length;
    if (received > 64 * 1024) {
      oversized = true;
      const reply = json(413, {
        error: {
          code: "invalid_request",
          message: "The job payload exceeds 64 KiB.",
          retryable: false,
        },
      });
      response.writeHead(reply.status, reply.headers);
      response.end(reply.body);
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", async () => {
    if (oversized) return;
    let job;
    try {
      job = parseJob(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (cause) {
      const code = cause instanceof EngineError ? cause.code : "invalid_request";
      const spec = ERRORS[code];
      const reply = json(spec.status, {
        error: { code, message: cause.message, retryable: spec.retryable },
      });
      response.writeHead(reply.status, reply.headers);
      response.end(reply.body);
      return;
    }
    const replay = replayFor(job.job_id);
    // An "optimized" verdict is only replayable while the object it uploaded
    // still holds this job's bytes. The Worker clears an unrecorded staging
    // object before re-invoking, and a create-only capability gives the engine
    // no read, so the entry is invalidated and the job re-executes: the
    // rendition PUT either recreates the object or answers 412. A digest match
    // there only proves the recomputation is byte-identical to the recorded
    // verdict — whether the stored object actually is those bytes is the
    // Worker's stored-digest check (sha256, else the PUT-recorded ETag) to
    // prove before it promotes anything.
    let distrusted;
    if (replay) {
      if (replay.value?.result === "optimized" && replay.value.output) {
        distrusted = replay.value;
        jobCache.delete(job.job_id);
      } else {
        const reply = json(200, { ...replay.value, replayed: true });
        response.writeHead(reply.status, reply.headers);
        response.end(reply.body);
        return;
      }
    }
    // A duplicate delivery arriving while this job id is actively executing
    // would otherwise queue and then run on a stale decision: by the time its
    // slot arrives the original has already uploaded the same deterministic
    // key, so the loser's create-only PUT gets a terminal `output_exists` even
    // though a correct rendition was produced. Answer busy — retryable, like a
    // saturated worker — and let the next delivery replay the verdict.
    if (inflightJobs.has(job.job_id)) {
      const reply = json(429, {
        error: {
          code: "busy",
          message: "This job is already running on this processor instance.",
          retryable: true,
        },
      });
      response.writeHead(reply.status, {
        ...reply.headers,
        "retry-after": "30",
      });
      response.end(reply.body);
      return;
    }
    const slot = admit();
    if (slot === false) {
      const reply = json(429, {
        error: {
          code: "busy",
          message: "The processor instance is saturated; retry shortly.",
          retryable: true,
        },
      });
      response.writeHead(reply.status, {
        ...reply.headers,
        "retry-after": "30",
      });
      response.end(reply.body);
      return;
    }
    if (slot !== true) {
      await slot;
      // The wait let the world move: the run this delivery queued behind may
      // have recorded this same job id's verdict. Re-read the dedupe window
      // before executing — an attempt that proceeds on its pre-wait decision
      // PUTs onto the now-existing object and surfaces a terminal conflict for
      // work that already succeeded.
      const settled = replayFor(job.job_id);
      if (settled) {
        if (settled.value?.result === "optimized" && settled.value.output) {
          distrusted = settled.value;
          jobCache.delete(job.job_id);
        } else {
          release();
          const reply = json(200, { ...settled.value, replayed: true });
          response.writeHead(reply.status, reply.headers);
          response.end(reply.body);
          return;
        }
      }
    }
    inflightJobs.add(job.job_id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMsFor(job));
    timer.unref?.();
    try {
      const value = await processJob(job, controller.signal);
      rememberFor(job.job_id, value);
      const reply = json(200, value);
      response.writeHead(reply.status, reply.headers);
      response.end(reply.body);
    } catch (cause) {
      if (
        cause instanceof EngineError &&
        cause.code === "output_exists" &&
        distrusted !== undefined &&
        distrusted.output.sha256 === cause.outputSha256
      ) {
        // The create-only PUT refused to overwrite an object while this job's
        // recomputation is byte-identical to the recorded verdict, so the
        // verdict remains an honest description of what this job produces.
        // It does not prove what the stored bytes are — the Worker verifies
        // the object's own digest/ETag against this verdict before promoting
        // it. The entry is restored so the dedupe window keeps answering.
        rememberFor(job.job_id, distrusted);
        const reply = json(200, { ...distrusted, replayed: true });
        response.writeHead(reply.status, reply.headers);
        response.end(reply.body);
        return;
      }
      const code =
        cause instanceof EngineError
          ? cause.code
          : cause?.name === "AbortError"
            ? "engine_timeout"
            : "engine_error";
      const spec = ERRORS[code] ?? ERRORS.engine_error;
      const reply = json(spec.status, {
        error: {
          code,
          message: cause instanceof Error ? cause.message : "The processor failed unexpectedly.",
          retryable: spec.retryable,
        },
        job_id: job.job_id,
      });
      response.writeHead(reply.status, reply.headers);
      response.end(reply.body);
    } finally {
      clearTimeout(timer);
      inflightJobs.delete(job.job_id);
      release();
    }
  });
});

await mkdir(config.workDir, { recursive: true });
server.listen(config.port, "0.0.0.0", () => {
  console.log(
    `${ENGINE_ID} listening on 0.0.0.0:${config.port} (ffmpeg: ${toolVersions.ffmpeg}; vips: ${toolVersions.vips})`,
  );
});

/**
 * Stops accepting new work on SIGTERM so the platform can reclaim the instance
 * without leaving a half-finished upload behind.
 */
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
