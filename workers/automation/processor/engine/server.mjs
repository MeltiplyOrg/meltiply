import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { ERRORS, EngineError, deadlineMsFor, parseJob, readConfig } from "./engine-job.mjs";

const config = readConfig(process.env);

const metadataLinePattern = /^([a-z0-9-]+):\s*(.*)$/i;
const whitespacePattern = /\s+/;

const ENGINE_ID = "meltiply-media-processor/1";

function run(argv, timeoutMs, onStdoutChunk) {
  const { promise, reject, resolve } = Promise.withResolvers();
  const child = spawn(argv[0], argv.slice(1), {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = onStdoutChunk ? null : [];
  let stderr = "";
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(stdout ? { stderr, stdout: Buffer.concat(stdout).toString("utf8") } : { stderr });
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(
      new EngineError("engine_timeout", `${argv[0]} exceeded its ${timeoutMs}ms step budget.`),
    );
  }, timeoutMs);
  timer.unref?.();
  child.stdout.on("data", (chunk) => {
    if (onStdoutChunk) onStdoutChunk(chunk);
    else stdout.push(chunk);
  });
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

async function probe(file, { countFrames = false, timeoutMs }) {
  const argv = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams"];
  if (countFrames) argv.push("-count_frames");
  argv.push(file);
  let stdout;
  try {
    ({ stdout } = await run(argv, timeoutMs));
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
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
  const framesRaw = counted ? video.nb_read_frames : (video.nb_read_frames ?? video.nb_frames);
  const frameCount =
    framesRaw === undefined || framesRaw === "N/A" || !Number.isFinite(Number(framesRaw))
      ? null
      : Number(framesRaw);
  const codedWidth = Number(video.width);
  const codedHeight = Number(video.height);
  const quarterTurn = Math.abs(rotationOf(video)) % 180 === 90;
  const codedSampleAspect = parseSampleAspect(video.sample_aspect_ratio);
  const sampleAspect = quarterTurn ? 1 / codedSampleAspect : codedSampleAspect;
  const width = quarterTurn ? codedHeight : codedWidth;
  const height = quarterTurn ? codedWidth : codedHeight;
  return {
    animated: isAnimatedContainer(formatName),
    audioChannels: audio ? Number(audio.channels ?? 0) : 0,
    contentType: contentTypeFor(
      formatName,
      String(video.codec_name ?? ""),
      String(parsed.format?.tags?.major_brand ?? ""),
    ),
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
    sampleAspect,
    videoCodec: String(video.codec_name ?? ""),
    width,
  };
}

function rotationOf(stream) {
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  const tagged = sideData.find((entry) => entry.rotation !== undefined)?.rotation;
  const fromTag = stream.tags?.rotate;
  const raw = tagged ?? fromTag;
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? ((Math.round(value) % 360) + 360) % 360 : 0;
}

function parseSampleAspect(raw) {
  const [numerator, denominator = "1"] = String(raw ?? "").split(":");
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top <= 0 || bottom <= 0) return 1;
  return top / bottom;
}

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

const IMAGE_CONTENT_TYPES = new Map([
  ["gifload", "image/gif"],
  ["jpegload", "image/jpeg"],
  ["pngload", "image/png"],
  ["webpload", "image/webp"],
]);

async function apngPlayCount(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (let offset = 8; offset + 8 <= bytesRead;) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") {
        return length >= 8 && offset + 8 + length <= bytesRead
          ? buffer.readUInt32BE(offset + 12)
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
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new EngineError("corrupt_media", "The APNG produced unreadable frame timing metadata.");
  }
  const frames = parsed.frames ?? [];
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

async function apngHasAlpha(file, timeoutMs) {
  let minimum = 0xffff;
  let carry = null;
  try {
    await run(
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
      timeoutMs,
      (chunk) => {
        const bytes = carry === null ? chunk : Buffer.concat([carry, chunk]);
        for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
          const sample = bytes.readUInt16LE(offset);
          if (sample < minimum) minimum = sample;
        }
        carry = bytes.length % 2 === 1 ? bytes.subarray(bytes.length - 1) : null;
      },
    );
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    throw new EngineError("corrupt_media", `The APNG could not be fully decoded: ${cause.message}`);
  }
  return minimum < 0xffff;
}

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
    orientation: 1,
  };
}

function parseVipsHeader(text) {
  const fields = new Map();
  for (const line of text.split("\n")) {
    const match = metadataLinePattern.exec(line);
    if (match) fields.set(match[1].toLowerCase(), match[2].trim());
  }
  return fields;
}

async function readImageFields(file, timeoutMs) {
  let stdout;
  try {
    ({ stdout } = await run(["vipsheader", "-a", file], timeoutMs));
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
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

function parseFrameDelays(raw) {
  if (raw === undefined) return null;
  const delays = raw
    .split(whitespacePattern)
    .filter((entry) => entry.length > 0)
    .map(Number);
  if (delays.length === 0 || delays.some((delay) => !Number.isFinite(delay) || delay < 0))
    return null;
  return delays.map((delay) => Math.round(delay));
}

function orientationOf(fields) {
  const raw = Number(fields.get("orientation") ?? 1);
  return Number.isInteger(raw) && raw >= 1 && raw <= 8 ? raw : 1;
}

async function probeImage(file, timeoutMs) {
  const fields = await readImageFields(file, timeoutMs);
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
  await verifyImageFullDecode(file, timeoutMs, frameCount > 1);
  if (frameCount > 1 && frameDelays === null) {
    throw new EngineError(
      "corrupt_media",
      "The animation carries no per-frame timing, so its pacing cannot be preserved or verified.",
    );
  }
  if (fields.get("vips-loader") === "pngload") {
    const plays = await apngPlayCount(file);
    if (plays !== null) return probeApng(file, timeoutMs, plays);
  }
  const orientation = orientationOf(fields);
  const transposed = orientation >= 5;
  const width = transposed ? codedHeight : codedWidth;
  const height = transposed ? codedWidth : codedHeight;
  return {
    animated: frameCount > 1,
    audioChannels: 0,
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
    sampleAspect: 1,
    videoCodec: "",
    width,
  };
}

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

async function hasAlpha(file, timeoutMs) {
  const { stdout: header } = await run(["vipsheader", "-a", file], timeoutMs);
  const fields = parseVipsHeader(header);
  const bands = Number(fields.get("bands"));
  const interpretation = fields.get("interpretation");
  const colourBands =
    interpretation === "cmyk" ? 4 : interpretation === "b-w" || interpretation === "grey16" ? 1 : 3;
  if (!Number.isInteger(bands) || bands < colourBands) {
    throw new EngineError("corrupt_media", "The decoded image has an invalid colour-band layout.");
  }
  if (bands === colourBands) return false;
  const pages = Number(fields.get("n-pages") ?? 1);
  const format = fields.get("format");
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

function sameFrameTiming(source, candidate) {
  if (!source || !candidate || source.length !== candidate.length) return false;
  return source.every((delta, index) => Math.abs((candidate[index] ?? 0) - delta) <= 4);
}

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
    if (cause instanceof EngineError) throw cause;
    throw new EngineError(
      "corrupt_media",
      `The media could not be fully decoded: ${cause.message}`,
    );
  }
}

async function verifyImageFullDecode(file, timeoutMs, allFrames) {
  const target = `${file}.verify.v`;
  try {
    await run(["vips", "copy", allFrames ? `${file}[n=-1]` : file, target], timeoutMs);
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    throw new EngineError(
      "corrupt_media",
      `The image could not be fully decoded: ${cause.message}`,
    );
  } finally {
    await rm(target, { force: true });
  }
}

function targetDimensions(source, profile) {
  const { height, width } =
    source.sampleAspect === 1
      ? { height: source.height, width: source.width }
      : squarePixelDimensions(source);
  return fitWithinBounds({ height, width }, profile);
}

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

function evenPixels(value) {
  return Math.max(2, 2 * Math.round(value / 2));
}

function squarePixelDimensions(media) {
  const width = evenPixels(media.width * Math.min(1, media.sampleAspect));
  return { height: evenPixels(width / media.displayAspect), width };
}

function deterministicFlags() {
  return ["-fflags", "+bitexact", "-flags:v", "+bitexact"];
}

function encoderQuality(raw) {
  const quality = Math.round(Number(raw));
  return Number.isFinite(quality) ? Math.min(100, Math.max(1, quality)) : 82;
}

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

function animatedFrameDimensions(media, profile, { even = false } = {}) {
  const frame = fitWithinBounds({ height: media.height, width: media.width }, profile, { even });
  return { pageHeight: frame.height, width: frame.width };
}

function stillImageCandidates(source, profile, directory) {
  const media = source.media;
  const quality = encoderQuality(profile.quality);
  const target = targetDimensions(media, profile);
  const plans = [];
  for (const contentType of profile.allowed_content_types) {
    const save = stillSaveOptions(contentType, quality);
    if (!save) continue;
    if (contentType === "image/jpeg" && media.hasAlpha) continue;
    const file = path.join(directory, `candidate${save.extension}`);
    plans.push({
      contentType,
      file,
      make: () => {
        const baked = `${file}.baked.v`;
        const scaled = `${file}.scaled.v`;
        const rotate = media.orientation !== 1;
        const resize = target.width < media.width || target.height < media.height;
        const input = rotate ? baked : source.file;
        return [
          ...(rotate ? [["vips", "autorot", source.file, baked]] : []),
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

function animatedImageCandidates(source, profile, directory) {
  const media = source.media;
  if ((media.orientation ?? 1) !== 1) return [];
  const quality = encoderQuality(profile.quality);
  const effort = Math.min(6, Math.max(0, Math.round(Number(profile.effort ?? 4))));
  const apngTarget = animatedFrameDimensions(media, profile, { even: true });
  const target = animatedFrameDimensions(media, profile);
  const resize = target.width !== media.width || target.pageHeight !== media.height;
  const argvFor = (file, options) => [
    [
      "vips",
      resize ? "resize" : "copy",
      `${source.file}[n=-1]`,
      `${file}[${options},page-height=${target.pageHeight}]`,
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
        if (!hasLibwebpAnim) continue;
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

function videoCandidates(source, profile, directory) {
  if (!profile.allowed_content_types.includes("video/mp4")) return [];
  const output = path.join(directory, "candidate.mp4");
  const remuxOutput = path.join(directory, "candidate-remux.mp4");
  const target = targetDimensions(source.media, profile);
  const needsScale = target.width !== source.media.width || target.height !== source.media.height;
  const remuxable =
    source.media.videoCodec === "h264" &&
    source.media.pixelFormat === "yuv420p" &&
    (source.media.formatName.includes("mp4") || source.media.formatName.includes("mov"));
  const plans = [];
  if (remuxable && !needsScale) {
    plans.push({
      contentType: "video/mp4",
      file: remuxOutput,
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
        "-map_metadata",
        "-1",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        String(Math.min(40, Math.max(14, Math.round(profile.quality ?? 23)))),
        "-pix_fmt",
        "yuv420p",
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
  const target =
    sourceMedia.animated && media.animated
      ? animatedFrameDimensions(sourceMedia, profile, {
          even: Boolean(sourceMedia.apng),
        })
      : targetDimensions(sourceMedia, profile);
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
    if (cause instanceof EngineError && cause.code === "engine_timeout") {
      await rm(plan.file, { force: true });
      throw cause;
    }
    return discard(`encode or probe failed: ${cause.message}`);
  }
  const rejection = profileRejection(media, profile, sourceMedia);
  if (rejection !== null) return discard(rejection);
  if (sourceMedia.animated || media.animated) {
    if (!sameFrameTiming(sourceFacts.timings, media.frameDelays))
      return discard("measured frame pacing does not match the source delays");
  }
  if (
    sourceFacts.hasAlpha &&
    !isVideo &&
    !(await hasAlpha(plan.file, stepBudget()).catch(() => false))
  ) {
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

async function processJob(job, signal) {
  const startedAt = Date.now();
  const directory = path.join(
    config.workDir,
    `job-${createHash("sha256").update(job.job_id).digest("hex").slice(0, 32)}`,
  );
  const deadline = deadlineMsFor(job, config);
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

    const sourceFacts = {
      hasAlpha: isVideo
        ? false
        : sourceMedia.apng
          ? sourceMedia.hasAlpha
          : await hasAlpha(inputFile, stepBudget()),
      timings: isVideo ? undefined : (sourceMedia.frameDelays ?? undefined),
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

    const preferred = plans.length > 0 ? plans[0].contentType : undefined;
    const sourceCompliant =
      preferred !== undefined &&
      sourceMedia.contentType === preferred &&
      profileRejection(sourceMedia, job.profile, sourceMedia) === null;
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
      if (candidate.lossless !== winner.lossless) return candidate.lossless ? candidate : winner;
      return candidate.size < winner.size ? candidate : winner;
    }, undefined);
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

const toolVersions = await (async () => {
  const read = async (argv) =>
    (await run(argv, 10_000).catch(() => ({ stdout: "unknown" }))).stdout.split("\n")[0].trim();
  return {
    ffmpeg: await read(["ffmpeg", "-version"]),
    vips: await read(["vips", "--version"]),
  };
})();

const hasLibwebpAnim = /libwebp_anim/.test(
  (
    await run(["ffmpeg", "-v", "quiet", "-encoders"], 10_000).catch(() => ({
      stdout: "",
    }))
  ).stdout,
);

const queue = { busy: false, waiting: [] };

function admit() {
  if (!queue.busy) {
    queue.busy = true;
    return true;
  }
  if (queue.waiting.length < config.maxPendingJobs) {
    return new Promise((resolve) => queue.waiting.push(resolve));
  }
  return false;
}

function release() {
  const next = queue.waiting.shift();
  if (next) {
    next();
    return;
  }
  queue.busy = false;
}

const JOB_CACHE_LIMIT = 256;
const JOB_CACHE_TTL_MS = 30 * 60 * 1000;
const jobCache = new Map();
const inflightJobs = new Set();

function replayFor(jobId) {
  const entry = jobCache.get(jobId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > JOB_CACHE_TTL_MS) {
    jobCache.delete(jobId);
    return undefined;
  }
  return entry;
}

function rememberFor(jobId, value) {
  if (jobCache.size >= JOB_CACHE_LIMIT) {
    const oldest = jobCache.keys().next().value;
    if (oldest !== undefined) jobCache.delete(oldest);
  }
  jobCache.set(jobId, { at: Date.now(), value });
}

function authorized(request) {
  const header = request.headers.authorization ?? "";
  const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(config.token);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function sendJson(response, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://engine.local");
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { engine: ENGINE_ID, ...toolVersions });
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/process") {
    sendJson(response, 404, {
      error: {
        code: "invalid_request",
        message: "Unknown route.",
        retryable: false,
      },
    });
    return;
  }
  if (!authorized(request)) {
    sendJson(
      response,
      401,
      {
        error: {
          code: "unauthorized",
          message: "A valid per-instance job token is required.",
          retryable: false,
        },
      },
      { "www-authenticate": "Bearer" },
    );
    return;
  }
  const chunks = [];
  let received = 0;
  let oversized = false;
  request.on("data", (chunk) => {
    if (oversized) return;
    received += chunk.length;
    if (received > 64 * 1024) {
      oversized = true;
      sendJson(response, 413, {
        error: {
          code: "invalid_request",
          message: "The job payload exceeds 64 KiB.",
          retryable: false,
        },
      });
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", async () => {
    if (oversized) return;
    let job;
    try {
      job = parseJob(JSON.parse(Buffer.concat(chunks).toString("utf8")), config);
    } catch (cause) {
      const code = cause instanceof EngineError ? cause.code : "invalid_request";
      const spec = ERRORS[code];
      sendJson(response, spec.status, {
        error: { code, message: cause.message, retryable: spec.retryable },
      });
      return;
    }
    const checkReplay = () => {
      const replay = replayFor(job.job_id);
      if (!replay) return { distrusted: undefined, replayed: false };
      if (replay.value?.result === "optimized" && replay.value.output) {
        jobCache.delete(job.job_id);
        return { distrusted: replay.value, replayed: false };
      }
      sendJson(response, 200, { ...replay.value, replayed: true });
      return { distrusted: undefined, replayed: true };
    };
    const initialReplay = checkReplay();
    if (initialReplay.replayed) return;
    let distrusted = initialReplay.distrusted;
    if (inflightJobs.has(job.job_id)) {
      sendJson(
        response,
        429,
        {
          error: {
            code: "busy",
            message: "This job is already running on this processor instance.",
            retryable: true,
          },
        },
        { "retry-after": "30" },
      );
      return;
    }
    const slot = admit();
    if (slot === false) {
      sendJson(
        response,
        429,
        {
          error: {
            code: "busy",
            message: "The processor instance is saturated; retry shortly.",
            retryable: true,
          },
        },
        { "retry-after": "30" },
      );
      return;
    }
    if (slot !== true) {
      await slot;
      const settledReplay = checkReplay();
      if (settledReplay.replayed) {
        release();
        return;
      }
      if (settledReplay.distrusted !== undefined) {
        distrusted = settledReplay.distrusted;
      }
    }
    inflightJobs.add(job.job_id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMsFor(job, config));
    timer.unref?.();
    try {
      const value = await processJob(job, controller.signal);
      rememberFor(job.job_id, value);
      sendJson(response, 200, value);
    } catch (cause) {
      if (
        cause instanceof EngineError &&
        cause.code === "output_exists" &&
        distrusted !== undefined &&
        distrusted.output.sha256 === cause.outputSha256
      ) {
        rememberFor(job.job_id, distrusted);
        sendJson(response, 200, { ...distrusted, replayed: true });
        return;
      }
      const code =
        cause instanceof EngineError
          ? cause.code
          : cause?.name === "AbortError"
            ? "engine_timeout"
            : "engine_error";
      const spec = ERRORS[code] ?? ERRORS.engine_error;
      sendJson(response, spec.status, {
        error: {
          code,
          message: cause instanceof Error ? cause.message : "The processor failed unexpectedly.",
          retryable: spec.retryable,
        },
        job_id: job.job_id,
      });
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

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
