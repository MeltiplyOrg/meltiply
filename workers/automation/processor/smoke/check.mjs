import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const baseUrl = required("BASE_URL");
const fixtureUrl = required("FIXTURE_URL").replace(/\/$/, "");
const fixtureDir = required("FIXTURE_DIR");
const token = required("PROCESSOR_JOB_TOKEN");
const objectsDir = path.join(fixtureDir, "objects");

const IMAGE_PROFILE = {
  name: "smoke-image",
  kind: "image",
  max_width: null,
  max_height: null,
  max_duration_seconds: null,
  allowed_content_types: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  quality: 82,
  effort: 4,
};
const VIDEO_PROFILE = {
  name: "smoke-video",
  kind: "video",
  max_width: 1920,
  max_height: 1080,
  max_duration_seconds: null,
  allowed_content_types: ["video/mp4"],
  quality: 23,
  effort: 4,
};

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env ${name}`);
    process.exit(2);
  }
  return value;
}

const SOURCE_CONTENT_TYPES = {
  "anamorphic-hd.mp4": "video/mp4",
  "anamorphic.mp4": "video/mp4",
  "animation-alpha.png": "image/png",
  "animation.gif": "image/gif",
  "animation.png": "image/png",
  "animation.webp": "image/webp",
  "bloated.mp4": "video/mp4",
  "high10.mp4": "video/mp4",
  "long.mov": "video/quicktime",
  "oriented.jpg": "image/jpeg",
  "photo-alpha.png": "image/png",
  "photo-opaque.png": "image/png",
  "photo.jpg": "image/jpeg",
  "short.mp4": "video/mp4",
  "tall-animation.webp": "image/webp",
  "thin-animation.webp": "image/webp",
};

const EXTENSION_CONTENT_TYPES = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".webp": "image/webp",
};

const MAGIC_FOR_CONTENT_TYPE = {
  "image/gif": (magic) => magic.startsWith("474946383761") || magic.startsWith("474946383961"),
  "image/jpeg": (magic) => magic.startsWith("ffd8ff"),
  "image/png": (magic) => magic.startsWith("89504e47"),
  "image/webp": (magic) => magic.startsWith("52494646") && magic.slice(16, 24) === "57454250",
  "video/mp4": (magic) => magic.slice(8, 16) === "66747970",
  "video/quicktime": (magic) => magic.slice(8, 16) === "66747970",
};

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` :: ${detail}`}`);
}

function assert(name, condition, detail) {
  record(name, Boolean(condition), detail ?? "condition was false");
  return Boolean(condition);
}

function exec(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function probe(file, { countFrames = false } = {}) {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams"];
  if (countFrames) args.push("-count_frames");
  const parsed = JSON.parse(await exec("ffprobe", [...args, file]));
  return summarize(parsed);
}

function sampleAspectOf(video) {
  const [numerator, denominator = "1"] = String(video?.sample_aspect_ratio ?? "1:1").split(":");
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top <= 0 || bottom <= 0) return 1;
  return top / bottom;
}

function summarize(parsed) {
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const durationRaw =
    parsed.format?.duration ??
    video?.duration ??
    audio?.duration ??
    parsed.format?.duration_ts / parsed.format?.time_base;
  const frameCountRaw = video?.nb_read_frames ?? video?.nb_frames;
  const sampleAspect = video ? sampleAspectOf(video) : null;
  return {
    audioCodec: audio ? audio.codec_name : null,
    codecs: video ? video.codec_name : null,
    contentType: contentTypeFor(parsed.format?.format_name ?? "", video?.codec_name ?? ""),
    displayAspect: video ? (Number(video.width) * sampleAspect) / Number(video.height) : null,
    durationSeconds: durationRaw === undefined ? null : Number(durationRaw),
    frameCount:
      frameCountRaw === undefined || !Number.isFinite(Number(frameCountRaw))
        ? null
        : Number(frameCountRaw),
    formatName: parsed.format?.format_name ?? null,
    hasAudio: Boolean(audio) && Number(audio.channels ?? 0) > 0,
    height: video ? Number(video.height) : null,
    pixelFormat: video ? video.pix_fmt : null,
    sampleAspect,
    sampleAspectRatio: video ? String(video.sample_aspect_ratio ?? "1:1") : null,
    width: video ? Number(video.width) : null,
  };
}

function contentTypeFor(formatName, codecName) {
  const formats = new Set((formatName ?? "").split(","));
  if (formats.has("mov")) return "video/quicktime";
  if (formats.has("matroska") || formats.has("webm")) return "video/webm";
  if (formats.has("mp4")) return "video/mp4";
  if (formats.has("gif")) return "image/gif";
  if (formats.has("webp")) return "image/webp";
  if (formats.has("png_pipe")) return "image/png";
  if (formats.has("png")) return "image/png";
  if (codecName === "png") return "image/png";
  if (codecName === "mjpeg") return "image/jpeg";
  return "application/octet-stream";
}

async function sha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}

async function signature(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(16);
    await handle.read(buffer, 0, 16, 0);
    return buffer.toString("hex");
  } finally {
    await handle.close();
  }
}

async function recordedUploads() {
  const response = await fetch(`${fixtureUrl}/_recorded`);
  if (!response.ok) throw new Error(`fixture listing failed: ${response.status}`);
  return response.json();
}

function jobFor(name, overrides = {}) {
  return {
    asset_id: "00000000-0000-4000-8000-000000000001",
    declared_content_type: SOURCE_CONTENT_TYPES[name] ?? "video/mp4",
    expected_checksum: null,
    expected_size: 1,
    input_url: `${fixtureUrl}/objects/${name}`,
    job_id: `smoke-${name}`,
    maximum_output_bytes: 64 * 1024 * 1024,
    output_url: `${fixtureUrl}/objects/rendition-${name}`,
    profile: (SOURCE_CONTENT_TYPES[name] ?? "video/mp4").startsWith("image/")
      ? IMAGE_PROFILE
      : VIDEO_PROFILE,
    ...overrides,
  };
}

/**
 * undici's fetch caps the wait for response headers at 300 s with no option to
 * raise it; native jobs can run longer under emulation.
 */
function engineRequest(body, auth) {
  const url = new URL(`${baseUrl}/process`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        headers: {
          authorization: auth ? `Bearer ${token}` : "",
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
        },
        host: url.hostname,
        method: "POST",
        path: url.pathname,
        port: url.port,
        timeout: 30 * 60 * 1_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("engine request timed out")));
    req.end(body);
  });
}

async function processRequest(payload, { auth = true } = {}) {
  const { status, text } = await engineRequest(JSON.stringify(payload), auth);
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { body, status };
}

/** The JPEG and PNG loaders reject the `[n=-1]` page selector. */
async function vipsFullyDecodes(file, { allFrames = false } = {}) {
  const target = `${file}.decoded.v`;
  try {
    await exec("vips", ["copy", allFrames ? `${file}[n=-1]` : file, target]);
    return true;
  } catch {
    return false;
  } finally {
    await rm(target, { force: true });
  }
}

/** FFmpeg cannot decode animated WebP ("image data not found"). */
async function vipsImageFacts(file) {
  const header = await exec("vipsheader", ["-a", file]).catch(() => null);
  if (header === null) return null;
  const fields = new Map();
  for (const line of header.split("\n")) {
    const match = /^([a-z0-9-]+):\s*(.*)$/i.exec(line);
    if (match) fields.set(match[1].toLowerCase(), match[2].trim());
  }
  if (!fields.has("vips-loader")) return null;
  const headerMatch = /(\d+)x(\d+)/.exec(header.split("\n")[0] ?? "");
  const firstDim = (key, fallback) => {
    const value = Number(fields.get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const raw = fields.get("delay");
  return {
    bands: Number(fields.get("bands")),
    delays: raw === undefined ? null : raw.split(/\s+/).map(Number),
    frameCount: Number(fields.get("n-pages") ?? 1),
    height: firstDim("height", firstDim("page-height", Number(headerMatch?.[2]))),
    loader: fields.get("vips-loader"),
    orientation: Number(fields.get("orientation") ?? 1),
    pageHeight: Number(fields.get("page-height") ?? fields.get("height") ?? headerMatch?.[2]),
    width: firstDim("width", firstDim("page-width", Number(headerMatch?.[1]))),
  };
}

/** libvips' pngload returns only the first APNG frame. */
async function apngFacts(file) {
  const counted = await probe(file, { countFrames: true }).catch(() => null);
  if (!counted || (counted.frameCount ?? 0) < 1) return null;
  const stream =
    JSON.parse(
      await exec("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,pix_fmt",
        "-of",
        "json",
        file,
      ]),
    ).streams?.[0] ?? {};
  const frames =
    JSON.parse(
      await exec("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=duration_time",
        "-of",
        "json",
        file,
      ]),
    ).frames ?? [];
  const delays = frames.map((frame) => Math.round(Number(frame.duration_time) * 1000));
  if (delays.length === counted.frameCount - 1) delays.push(delays[delays.length - 1]);
  return {
    bands: /rgba|ya|pal8/.test(String(stream.pix_fmt)) ? 4 : 3,
    delays: delays.every((value) => Number.isFinite(value) && value > 0) ? delays : null,
    frameCount: counted.frameCount,
    height: counted.height,
    loader: "apng",
    orientation: 1,
    width: counted.width,
  };
}

async function ffmpegAlphaRange(file) {
  const scratch = `${file}.alpha.raw`;
  try {
    await exec("ffmpeg", [
      "-v",
      "error",
      "-xerror",
      "-nostdin",
      "-y",
      "-i",
      file,
      "-vf",
      "alphaextract",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      scratch,
    ]);
    let minimum = 255;
    let maximum = 0;
    for await (const chunk of createReadStream(scratch)) {
      for (const byte of chunk) {
        if (byte < minimum) minimum = byte;
        if (byte > maximum) maximum = byte;
      }
      if (minimum === 0 && maximum === 255) break;
    }
    return { max: maximum, min: minimum };
  } catch {
    return null;
  } finally {
    await rm(scratch, { force: true });
  }
}

function sameDelays(source, candidate, tolerance = 4) {
  if (!Array.isArray(source) || !Array.isArray(candidate)) return false;
  if (source.length === 0 || source.length !== candidate.length) return false;
  return source.every((delay, index) => Math.abs((candidate[index] ?? 0) - delay) <= tolerance);
}

async function vipsField(file, field) {
  const output = await exec("vipsheader", ["-a", file]).catch(() => "");
  const match = new RegExp(`^${field}:\\s*(\\S+)`, "m").exec(output);
  return match ? match[1] : null;
}

async function alphaRange(file) {
  const target = `${file}.alpha.v`;
  try {
    const bands = Number(await vipsField(file, "bands"));
    if (!Number.isInteger(bands) || bands < 4) return null;
    const pages = Number(await vipsField(file, "n-pages"));
    await exec("vips", [
      "extract_band",
      pages > 1 ? `${file}[n=-1]` : file,
      target,
      String(bands - 1),
    ]);
    const min = Number((await exec("vips", ["min", target])).trim());
    const max = Number((await exec("vips", ["max", target])).trim());
    return Number.isFinite(min) && Number.isFinite(max) ? { max, min } : null;
  } catch {
    return null;
  } finally {
    await rm(target, { force: true });
  }
}

async function fullyDecodes(file) {
  try {
    await exec("ffmpeg", [
      "-v",
      "error",
      "-xerror",
      "-nostdin",
      "-y",
      "-i",
      file,
      "-f",
      "null",
      "-",
    ]);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const encoded = await readdir(objectsDir);
  for (const name of [
    "anamorphic-hd.mp4",
    "anamorphic.mp4",
    "animation-alpha.png",
    "animation.gif",
    "animation.png",
    "animation.webp",
    "bloated.mp4",
    "high10.mp4",
    "long.mov",
    "long.mp4",
    "oriented.jpg",
    "photo-alpha.png",
    "photo-opaque.png",
    "photo.jpg",
    "short.mp4",
    "tall-animation.webp",
    "thin-animation.webp",
  ]) {
    if (!encoded.includes(name)) {
      console.error(`fixture missing: ${name}`);
      process.exit(2);
    }
  }

  const health = await fetch(`${baseUrl}/healthz`);
  const healthBody = await health.json();
  assert(
    "healthz is reachable without a bearer secret",
    health.status === 200,
    `status ${health.status}`,
  );
  assert(
    "healthz reports the real ffmpeg binary",
    typeof healthBody.ffmpeg === "string" && /ffmpeg version/.test(healthBody.ffmpeg),
    JSON.stringify(healthBody),
  );
  assert(
    "healthz reports the real libvips binary",
    typeof healthBody.vips === "string" && /vips/.test(healthBody.vips),
    JSON.stringify(healthBody),
  );

  const unauthorized = await processRequest(jobFor("short.mp4"), {
    auth: false,
  });
  assert(
    "unauthenticated invocation is rejected",
    unauthorized.status === 401,
    `status ${unauthorized.status}`,
  );
  assert(
    "unauthenticated rejection carries the unauthorized code",
    unauthorized.body?.error?.code === "unauthorized",
    JSON.stringify(unauthorized.body),
  );

  const oversized = await processRequest(
    jobFor("short.mp4", {
      expected_size: 900 * 1024 * 1024,
      maximum_output_bytes: 10 * 1024 * 1024,
    }),
  );
  assert(
    "input above the engine's bound is rejected before any fetch",
    oversized.status === 413 && oversized.body?.error?.code === "input_too_large",
    JSON.stringify(oversized.body),
  );

  const badProfile = await processRequest(
    jobFor("short.mp4", {
      maximum_output_bytes: 4 * 1024 * 1024 * 1024,
      profile: { ...VIDEO_PROFILE },
    }),
  );
  assert(
    "output reservation above the engine bound is rejected",
    badProfile.status === 400 && badProfile.body?.error?.code === "invalid_request",
    JSON.stringify(badProfile.body),
  );

  const scratch = path.join(objectsDir, "corrupt");
  await mkdir(scratch, { recursive: true });
  const corruptVideo = path.join(scratch, "corrupt.mp4");
  await writeFile(
    corruptVideo,
    Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from("ftypisom"),
      Buffer.alloc(4096, 0x41),
    ]),
  );
  const corruptResult = await processRequest({
    ...jobFor("corrupt.mp4", {
      input_url: `${fixtureUrl}/objects/corrupt/corrupt.mp4`,
    }),
    declared_content_type: "video/mp4",
    expected_size: (await stat(corruptVideo)).size,
    profile: VIDEO_PROFILE,
  });
  assert(
    "corrupt video fails with a non-retryable actionable code",
    corruptResult.status === 422 &&
      ["corrupt_media", "unsupported_media"].includes(corruptResult.body?.error?.code) &&
      corruptResult.body?.error?.retryable === false,
    JSON.stringify(corruptResult.body),
  );
  assert(
    "corrupt video failure explains the problem in prose",
    typeof corruptResult.body?.error?.message === "string" &&
      corruptResult.body.error.message.length > 20,
    JSON.stringify(corruptResult.body),
  );

  const corruptImage = path.join(scratch, "corrupt.png");
  await writeFile(
    corruptImage,
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2048, 0x5a)]),
  );
  const corruptImageResult = await processRequest({
    ...jobFor("corrupt.png", {
      input_url: `${fixtureUrl}/objects/corrupt/corrupt.png`,
    }),
    declared_content_type: "image/png",
    expected_size: (await stat(corruptImage)).size,
    profile: IMAGE_PROFILE,
  });
  assert(
    "corrupt image fails instead of being stored as usable media",
    corruptImageResult.status === 422 &&
      ["corrupt_media", "unsupported_media"].includes(corruptImageResult.body?.error?.code),
    JSON.stringify(corruptImageResult.body),
  );

  const mismatchResult = await processRequest(
    jobFor("short.mp4", {
      declared_content_type: "image/jpeg",
      expected_size: (await stat(path.join(objectsDir, "short.mp4"))).size,
      profile: IMAGE_PROFILE,
    }),
  );
  assert(
    "declared type disagreeing with the decoded stream is rejected",
    mismatchResult.status === 422 && mismatchResult.body?.error?.code === "unsupported_media",
    JSON.stringify(mismatchResult.body),
  );

  const photo = await runJob({
    job_id: "smoke-photo",
    max: IMAGE_PROFILE.max_width,
    name: "photo.jpg",
    profile: IMAGE_PROFILE,
  });
  if (photo.ok && photo.result.output !== null) {
    const sourceInfo = await vipsImageFacts(path.join(objectsDir, "photo.jpg"));
    const outputInfo = await vipsImageFacts(photo.uploaded);
    assert(
      "still image rendition is smaller than the verified original",
      photo.result.output.bytes < photo.result.input.bytes,
      `${photo.result.output.bytes} >= ${photo.result.input.bytes}`,
    );
    assert(
      "still image keeps the original pixel dimensions (no crop)",
      outputInfo.width === sourceInfo.width && outputInfo.height === sourceInfo.height,
      `${outputInfo.width}x${outputInfo.height} vs ${sourceInfo.width}x${sourceInfo.height}`,
    );
    assert(
      "still image rendition really decodes through libvips",
      await vipsFullyDecodes(photo.uploaded),
      "vips copy failed on the uploaded rendition",
    );
    assert(
      "still image output type is inside the profile's allowed types",
      IMAGE_PROFILE.allowed_content_types.includes(photo.result.output.content_type),
      photo.result.output.content_type,
    );
  } else if (photo.ok) {
    record(
      "still image produced a rendition (no-benefit outcome is allowed but unexpected)",
      false,
      JSON.stringify(photo.result),
    );
  }

  const transparentAlpha = await alphaRange(path.join(objectsDir, "photo-alpha.png"));
  assert(
    "the transparent fixture has partially transparent pixels, not just a fourth band",
    transparentAlpha !== null && transparentAlpha.min === 0 && transparentAlpha.max === 255,
    `alpha ${transparentAlpha ? `${transparentAlpha.min}..${transparentAlpha.max}` : "unreadable"}`,
  );
  const opaqueAlpha = await alphaRange(path.join(objectsDir, "photo-opaque.png"));
  assert(
    "the RGBA fixture's alpha band is fully opaque",
    opaqueAlpha !== null && opaqueAlpha.min === 255,
    `alpha minimum ${opaqueAlpha ? opaqueAlpha.min : "unreadable"}`,
  );

  const transparent = await runJob({
    job_id: "smoke-photo-alpha.png",
    max: IMAGE_PROFILE.max_width,
    name: "photo-alpha.png",
    profile: IMAGE_PROFILE,
  });
  if (transparent.ok) {
    if (transparent.result.output === null) {
      assert(
        "a transparent source is kept intact when no smaller rendition helps",
        transparent.result.result === "original_compatible",
        JSON.stringify(transparent.result),
      );
    } else {
      assert(
        "a transparent source is never flattened into JPEG",
        transparent.result.output.content_type !== "image/jpeg",
        transparent.result.output.content_type,
      );
      const renditionAlpha = await alphaRange(transparent.uploaded);
      assert(
        "the rendition of a transparent source still spans the full alpha range",
        renditionAlpha !== null && renditionAlpha.min === 0 && renditionAlpha.max === 255,
        `alpha ${renditionAlpha ? `${renditionAlpha.min}..${renditionAlpha.max}` : "unreadable"}`,
      );
      assert(
        "the alpha-preserving rendition fully decodes through libvips",
        await vipsFullyDecodes(transparent.uploaded),
        "vips copy failed on the uploaded rendition",
      );
    }
  }

  const opaque = await runJob({
    job_id: "smoke-photo-opaque.png",
    max: IMAGE_PROFILE.max_width,
    name: "photo-opaque.png",
    profile: IMAGE_PROFILE,
  });
  if (opaque.ok && opaque.result.output !== null) {
    const opaqueBands = await vipsField(opaque.uploaded, "bands");
    assert(
      "an opaque RGBA source normalizes to the JPEG the profile prefers",
      opaque.result.output.content_type === "image/jpeg",
      opaque.result.output.content_type,
    );
    assert(
      "the JPEG rendition of an opaque RGBA source has no alpha band",
      opaqueBands === "3",
      `bands ${opaqueBands}`,
    );
    const opaqueSource = await vipsImageFacts(path.join(objectsDir, "photo-opaque.png"));
    const opaqueOutput = await vipsImageFacts(opaque.uploaded);
    assert(
      "the JPEG rendition keeps the source pixel dimensions",
      opaqueOutput.width === opaqueSource.width && opaqueOutput.height === opaqueSource.height,
      `${opaqueOutput.width}x${opaqueOutput.height} vs ${opaqueSource.width}x${opaqueSource.height}`,
    );
  } else if (opaque.ok) {
    record("an opaque RGBA source produced a rendition", false, JSON.stringify(opaque.result));
  }

  for (const name of ["animation-alpha.png", "animation.gif", "animation.png", "animation.webp"]) {
    const animated = await runJob({
      job_id: `smoke-${name}`,
      max: IMAGE_PROFILE.max_width,
      name,
      profile: IMAGE_PROFILE,
    });
    if (!animated.ok) continue;
    const sourceInfo = name.endsWith(".png")
      ? await apngFacts(path.join(objectsDir, name))
      : await vipsImageFacts(path.join(objectsDir, name));
    assert(
      `${name} fixture really is an animation`,
      (sourceInfo?.frameCount ?? 0) > 1,
      JSON.stringify(sourceInfo),
    );
    assert(
      `${name} fixture really carries per-frame timing`,
      sourceInfo?.delays?.length === sourceInfo?.frameCount,
      JSON.stringify(sourceInfo?.delays),
    );
    if (name.endsWith(".png")) {
      assert(
        `${name} produced a verified animated rendition`,
        animated.result.output !== null,
        JSON.stringify(animated.result),
      );
    }
    if (animated.result.output) {
      const outputInfo = await vipsImageFacts(animated.uploaded);
      assert(
        `${name} rendition keeps every source frame`,
        outputInfo.frameCount >= sourceInfo.frameCount,
        `${outputInfo.frameCount} < ${sourceInfo.frameCount}`,
      );
      assert(
        `${name} rendition stays animated`,
        outputInfo.frameCount > 1 && animated.result.media.animated === true,
        `${outputInfo.frameCount} frames, animated=${animated.result.media.animated}`,
      );
      assert(
        `${name} rendition keeps the source frame size`,
        outputInfo.width === sourceInfo.width && outputInfo.height === sourceInfo.height,
        `${outputInfo.width}x${outputInfo.height} vs ${sourceInfo.width}x${sourceInfo.height}`,
      );
      assert(
        `${name} rendition preserves the per-frame delays, last frame included`,
        sameDelays(sourceInfo.delays, outputInfo.delays),
        `source ${JSON.stringify(sourceInfo.delays)} vs ${JSON.stringify(outputInfo.delays)}`,
      );
      assert(
        `${name} rendition duration matches the source timing`,
        Math.abs(
          (animated.result.media.duration_seconds ?? 0) -
            sourceInfo.delays.reduce((total, delay) => total + delay, 0) / 1000,
        ) <= 0.05,
        `${animated.result.media.duration_seconds}s vs ${sourceInfo.delays.reduce((total, delay) => total + delay, 0) / 1000}s`,
      );
      // libvips decodes palette GIFs into four bands regardless of content.
      if (!name.endsWith(".png")) {
        const renditionAlpha = outputInfo.bands >= 4 ? await alphaRange(animated.uploaded) : null;
        assert(
          `${name} rendition never introduces transparency the source lacks`,
          outputInfo.bands < 4 || (renditionAlpha !== null && renditionAlpha.min === 255),
          `bands ${outputInfo.bands}, alpha ${JSON.stringify(renditionAlpha)}`,
        );
      }
      assert(
        `${name} rendition fully decodes frame by frame through libvips`,
        await vipsFullyDecodes(animated.uploaded, { allFrames: true }),
        "multi-frame vips copy failed on the uploaded rendition",
      );
      if (name === "animation-alpha.png") {
        const sourceAlpha = await ffmpegAlphaRange(path.join(objectsDir, name));
        const renditionAlpha = await alphaRange(animated.uploaded);
        assert(
          `${name} source really carries transparent pixels`,
          sourceAlpha !== null && sourceAlpha.min === 0,
          JSON.stringify(sourceAlpha),
        );
        assert(
          `${name} rendition retains real transparency across every frame`,
          renditionAlpha !== null && renditionAlpha.min === 0 && renditionAlpha.max === 255,
          JSON.stringify(renditionAlpha),
        );
      }
      if (name === "animation.png") {
        const sourceAlpha = await ffmpegAlphaRange(path.join(objectsDir, name));
        const renditionAlpha = outputInfo.bands >= 4 ? await alphaRange(animated.uploaded) : null;
        assert(
          `${name} source is opaque RGBA with no transparent pixels`,
          sourceAlpha !== null && sourceAlpha.min === 255,
          JSON.stringify(sourceAlpha),
        );
        assert(
          `${name} rendition carries no transparent pixels`,
          outputInfo.bands < 4 || (renditionAlpha !== null && renditionAlpha.min === 255),
          `bands ${outputInfo.bands}, alpha ${JSON.stringify(renditionAlpha)}`,
        );
      }
    } else {
      assert(
        `${name} no-benefit path left the source animation untouched`,
        animated.result.media.animated === true &&
          animated.result.media.frame_count >= sourceInfo.frameCount,
        JSON.stringify(animated.result.media),
      );
    }
  }

  const tall = await runJob({
    job_id: "smoke-tall-animation",
    max: 2048,
    name: "tall-animation.webp",
    profile: IMAGE_PROFILE,
  });
  if (tall.ok && tall.result.output) {
    const sourceInfo = await vipsImageFacts(path.join(objectsDir, "tall-animation.webp"));
    const outputInfo = await vipsImageFacts(tall.uploaded);
    assert(
      "the tall-animation fixture really overflows the height bound",
      sourceInfo.pageHeight > 2048,
      `page height ${sourceInfo.pageHeight}`,
    );
    assert(
      "the tall rendition's frame height is fitted inside the bound",
      outputInfo.pageHeight <= 2048 && outputInfo.pageHeight > 0,
      `page height ${outputInfo.pageHeight}`,
    );
    assert(
      "the tall rendition keeps every source frame",
      outputInfo.frameCount >= sourceInfo.frameCount,
      `${outputInfo.frameCount} < ${sourceInfo.frameCount}`,
    );
    assert(
      "the tall rendition's header height is its frame height, not the strip",
      outputInfo.height === outputInfo.pageHeight,
      `header height ${outputInfo.height} vs page height ${outputInfo.pageHeight}`,
    );
    assert(
      "the tall rendition preserves the per-frame delays, last frame included",
      sameDelays(sourceInfo.delays, outputInfo.delays),
      `source ${JSON.stringify(sourceInfo.delays)} vs ${JSON.stringify(outputInfo.delays)}`,
    );
    assert(
      "the tall rendition fully decodes frame by frame through libvips",
      await vipsFullyDecodes(tall.uploaded, { allFrames: true }),
      "multi-frame vips copy failed on the uploaded rendition",
    );
  } else if (tall.ok) {
    record(
      "a height-overflowing animation produced a fitted rendition",
      false,
      JSON.stringify(tall.result),
    );
  }

  const thin = await runJob({
    job_id: "smoke-thin-animation",
    max: 4096,
    name: "thin-animation.webp",
    profile: IMAGE_PROFILE,
  });
  if (thin.ok && thin.result.output) {
    const sourceInfo = await vipsImageFacts(path.join(objectsDir, "thin-animation.webp"));
    const outputInfo = await vipsImageFacts(thin.uploaded);
    assert(
      "the thin-animation fixture really sits on the rounding boundary",
      sourceInfo.width === 8192 &&
        sourceInfo.pageHeight === 203 &&
        (sourceInfo.pageHeight * 0.5) % 1 === 0.5,
      `${sourceInfo.width}x${sourceInfo.pageHeight}`,
    );
    assert(
      "the thin rendition is measured on the nearest-integer frame grid",
      outputInfo.width === 4096 && outputInfo.pageHeight === 102,
      `${outputInfo.width}x${outputInfo.pageHeight}`,
    );
    assert(
      "the thin rendition keeps every source frame",
      outputInfo.frameCount >= sourceInfo.frameCount,
      `${outputInfo.frameCount} < ${sourceInfo.frameCount}`,
    );
    assert(
      "the thin rendition's header height is its frame height, not the strip",
      outputInfo.height === outputInfo.pageHeight,
      `header height ${outputInfo.height} vs page height ${outputInfo.pageHeight}`,
    );
    assert(
      "the thin rendition preserves the per-frame delays, last frame included",
      sameDelays(sourceInfo.delays, outputInfo.delays),
      `source ${JSON.stringify(sourceInfo.delays)} vs ${JSON.stringify(outputInfo.delays)}`,
    );
    assert(
      "the thin rendition fully decodes frame by frame through libvips",
      await vipsFullyDecodes(thin.uploaded, { allFrames: true }),
      "multi-frame vips copy failed on the uploaded rendition",
    );
  } else if (thin.ok) {
    record(
      "a fractionally scaled animation produced a rendition",
      false,
      JSON.stringify(thin.result),
    );
  }

  const oriented = await runJob({
    job_id: "smoke-oriented",
    max: 2048,
    name: "oriented.jpg",
    profile: IMAGE_PROFILE,
  });
  if (oriented.ok && oriented.result.output) {
    const sourceInfo = await vipsImageFacts(path.join(objectsDir, "oriented.jpg"));
    const outputInfo = await vipsImageFacts(oriented.uploaded);
    assert(
      "the oriented fixture really carries an EXIF orientation tag",
      sourceInfo.orientation === 6,
      `orientation ${sourceInfo.orientation}`,
    );
    assert(
      "the orientation tag transposes the source (3000x4000 stored, 4000x3000 displayed)",
      sourceInfo.width === 3000 && sourceInfo.height === 4000,
      `${sourceInfo.width}x${sourceInfo.height}`,
    );
    assert(
      "an oriented source is fitted on its display axes, not its stored ones",
      outputInfo.width === 2048 && outputInfo.height === 1536,
      `${outputInfo.width}x${outputInfo.height}`,
    );
    assert(
      "the rendition keeps the display aspect ratio of the oriented source",
      Math.abs(outputInfo.width / outputInfo.height - 4 / 3) < 0.01,
      `${outputInfo.width}x${outputInfo.height}`,
    );
    assert(
      "the orientation is baked into the pixels, not left as a tag",
      outputInfo.orientation === 1,
      `orientation ${outputInfo.orientation}`,
    );
    assert(
      "the engine reported the rendition's own display geometry",
      oriented.result.media.width === outputInfo.width &&
        oriented.result.media.height === outputInfo.height,
      `${oriented.result.media.width}x${oriented.result.media.height} vs ${outputInfo.width}x${outputInfo.height}`,
    );
    assert(
      "the oriented rendition fully decodes through libvips",
      await vipsFullyDecodes(oriented.uploaded),
      "vips copy failed on the uploaded rendition",
    );
  } else if (oriented.ok) {
    record("an oriented source produced a rendition", false, JSON.stringify(oriented.result));
  }

  const bounded = await runJob({
    job_id: "smoke-photo-bounded",
    max: 2048,
    name: "photo.jpg",
    profile: IMAGE_PROFILE,
  });
  if (bounded.ok && bounded.result.output) {
    const outputInfo = await vipsImageFacts(bounded.uploaded);
    assert(
      "a source larger than the profile bounds is fitted inside them",
      outputInfo.width <= 2048 && outputInfo.height <= 2048,
      `${outputInfo.width}x${outputInfo.height}`,
    );
    assert(
      "the fitted rendition keeps the source display aspect ratio",
      Math.abs(outputInfo.width / outputInfo.height - 4000 / 3000) < 0.01,
      `${outputInfo.width}x${outputInfo.height}`,
    );
    assert(
      "the fitted rendition is smaller than the verified original",
      bounded.result.output.bytes < bounded.result.input.bytes,
      `${bounded.result.output.bytes} >= ${bounded.result.input.bytes}`,
    );
    assert(
      "the fitted rendition fully decodes through libvips",
      await vipsFullyDecodes(bounded.uploaded),
      "vips copy failed on the uploaded rendition",
    );
  } else if (bounded.ok) {
    record(
      "an oversized source produced a fitted rendition",
      false,
      JSON.stringify(bounded.result),
    );
  }

  const beforeFailedUploads = (await recordedUploads()).map((entry) => entry.key);
  const animationSize = (await stat(path.join(objectsDir, "animation.gif"))).size;
  const noApplicableType = await processRequest({
    ...jobFor("animation.gif", {
      expected_size: animationSize,
      job_id: "smoke-animation-jpeg-only",
      output_url: `${fixtureUrl}/objects/rendition-animation-jpeg-only`,
      profile: { ...IMAGE_PROFILE, allowed_content_types: ["image/jpeg"] },
    }),
  });
  assert(
    "a profile that cannot carry an animation is rejected, not silently passed through",
    noApplicableType.status === 422 && noApplicableType.body?.error?.code === "unsupported_media",
    JSON.stringify(noApplicableType.body),
  );
  const photoSize = (await stat(path.join(objectsDir, "photo.jpg"))).size;
  const overBudget = await processRequest({
    ...jobFor("photo.jpg", {
      expected_size: photoSize,
      job_id: "smoke-over-budget",
      maximum_output_bytes: 1024,
      output_url: `${fixtureUrl}/objects/rendition-over-budget`,
      profile: { ...IMAGE_PROFILE, max_height: 2048, max_width: 2048 },
    }),
  });
  assert(
    "a verified rendition over the reserved capacity fails instead of reporting no benefit",
    overBudget.status === 422 && overBudget.body?.error?.code === "output_too_large",
    JSON.stringify(overBudget.body),
  );
  const afterFailedUploads = (await recordedUploads()).map((entry) => entry.key);
  assert(
    "a failed image job uploads nothing at all",
    afterFailedUploads.length === beforeFailedUploads.length,
    `${JSON.stringify(afterFailedUploads)} vs ${JSON.stringify(beforeFailedUploads)} before`,
  );

  for (const name of ["short.mp4", "high10.mp4", "bloated.mp4", "long.mp4", "long.mov"]) {
    const video = await runJob({
      job_id: `smoke-${name}`,
      max: VIDEO_PROFILE.max_width,
      name,
      profile: VIDEO_PROFILE,
    });
    if (!video.ok) continue;
    const sourceInfo = await probe(path.join(objectsDir, name));
    if (video.result.output === null) {
      assert(
        `${name} original is reported compatible only when it already is`,
        video.result.result === "original_compatible" &&
          sourceInfo.formatName.split(",").includes("mp4") &&
          sourceInfo.codecs === "h264" &&
          sourceInfo.pixelFormat === "yuv420p" &&
          (!sourceInfo.hasAudio || sourceInfo.audioCodec === "aac"),
        `${video.result.result} ${sourceInfo.formatName} ${sourceInfo.codecs} ${sourceInfo.pixelFormat} ${sourceInfo.audioCodec}`,
      );
      assert(
        `${name} reports the verified source's own media facts`,
        video.result.media.width === sourceInfo.width &&
          video.result.media.height === sourceInfo.height,
        `${video.result.media.width}x${video.result.media.height} vs ${sourceInfo.width}x${sourceInfo.height}`,
      );
      assert(
        `${name} no-benefit path writes no output object`,
        !(await stat(video.uploaded).then(
          () => true,
          () => false,
        )),
        `${video.uploaded} unexpectedly exists`,
      );
      if (name === "long.mp4") {
        assert(
          "long.mp4 source exceeds the 100 MB short-video service input ceiling",
          video.result.input.bytes > 100 * 1024 * 1024,
          `${video.result.input.bytes} bytes`,
        );
        assert(
          "long.mp4 source exceeds the 60 s short-video service output ceiling",
          sourceInfo.durationSeconds > 60,
          `${sourceInfo.durationSeconds}s`,
        );
      }
      continue;
    }
    const outputInfo = await probe(video.uploaded);
    const outputFile = video.uploaded;
    assert(
      `${name} rendition is a real MP4 with browser-ready streams`,
      outputInfo.formatName.split(",").includes("mp4") &&
        outputInfo.codecs === "h264" &&
        outputInfo.pixelFormat === "yuv420p" &&
        (!outputInfo.hasAudio || outputInfo.audioCodec === "aac") &&
        video.result.output.content_type === "video/mp4",
      `${outputInfo.formatName} ${outputInfo.codecs} ${outputInfo.pixelFormat} ${outputInfo.audioCodec} / ${video.result.output.content_type}`,
    );
    assert(
      `${name} rendition preserves full duration`,
      Math.abs(outputInfo.durationSeconds - sourceInfo.durationSeconds) <= 0.5,
      `${outputInfo.durationSeconds} vs ${sourceInfo.durationSeconds}`,
    );
    assert(
      `${name} rendition preserves the audio track`,
      outputInfo.hasAudio === sourceInfo.hasAudio && outputInfo.hasAudio === true,
      `${outputInfo.hasAudio} vs ${sourceInfo.hasAudio}`,
    );
    assert(
      `${name} rendition preserves orientation and aspect ratio`,
      outputInfo.width === sourceInfo.width &&
        outputInfo.height === sourceInfo.height &&
        video.result.media.width === sourceInfo.width &&
        video.result.media.height === sourceInfo.height,
      `${outputInfo.width}x${outputInfo.height} vs ${sourceInfo.width}x${sourceInfo.height}`,
    );
    assert(
      `${name} rendition fully decodes through ffmpeg`,
      await fullyDecodes(outputFile),
      "null-output decode failed",
    );
    assert(
      `${name} uploaded bytes match the reported sha256`,
      video.result.output.sha256 === (await sha256(outputFile)),
      "digest mismatch between engine report and stored object",
    );
    assert(
      `${name} uploaded size matches the reported bytes`,
      video.result.output.bytes === (await stat(outputFile)).size,
      "size mismatch between engine report and stored object",
    );
    if (name === "high10.mp4") {
      // HTTP strong ETags are quoted; R2 binding etags are not.
      const recorded = (await recordedUploads()).find(
        (entry) => entry.key === "rendition-smoke-high10.mp4",
      );
      assert(
        "uploaded ETag is compatible with the R2 binding commit contract",
        recorded !== undefined && video.result.output.etag === recorded.etag.replace(/^"|"$/g, ""),
        `engine ${video.result.output.etag} vs origin ${recorded?.etag}`,
      );
      assert(
        "high10.mp4 source really is a 10-bit H.264 stream",
        sourceInfo.codecs === "h264" &&
          sourceInfo.pixelFormat !== null &&
          sourceInfo.pixelFormat !== "yuv420p",
        `${sourceInfo.codecs} ${sourceInfo.pixelFormat}`,
      );
      assert(
        "high10.mp4 rendition is normalized to 8-bit 4:2:0 H.264 with AAC audio",
        outputInfo.codecs === "h264" &&
          outputInfo.pixelFormat === "yuv420p" &&
          outputInfo.audioCodec === "aac",
        `${outputInfo.codecs} ${outputInfo.pixelFormat} ${outputInfo.audioCodec}`,
      );
      assert(
        "the normalized rendition is uploaded even though it is not smaller",
        video.result.output !== null,
        JSON.stringify(video.result),
      );
    }
    if (name === "bloated.mp4") {
      assert(
        "bloated.mp4 source carries removable container padding",
        (await stat(path.join(objectsDir, name))).size - video.result.output.bytes > 512 * 1024,
        `${video.result.input.bytes} -> ${video.result.output.bytes}`,
      );
      assert(
        "the remuxed rendition is smaller than the padded original",
        video.result.output.bytes < video.result.input.bytes,
        `${video.result.output.bytes} >= ${video.result.input.bytes}`,
      );
      assert(
        "the remuxed rendition keeps 8-bit 4:2:0 H.264 with AAC audio",
        outputInfo.codecs === "h264" &&
          outputInfo.pixelFormat === "yuv420p" &&
          outputInfo.audioCodec === "aac",
        `${outputInfo.codecs} ${outputInfo.pixelFormat} ${outputInfo.audioCodec}`,
      );
    }
    if (name === "long.mp4") {
      assert(
        "long.mp4 source exceeds the 100 MB short-video service input ceiling",
        video.result.input.bytes > 100 * 1024 * 1024,
        `${video.result.input.bytes} bytes`,
      );
      assert(
        "long.mp4 rendition output exceeds the 60 s short-video service output ceiling",
        outputInfo.durationSeconds > 60,
        `${outputInfo.durationSeconds}s`,
      );
    }
  }

  for (const name of ["anamorphic.mp4", "anamorphic-hd.mp4"]) {
    const video = await runJob({
      job_id: `smoke-${name}`,
      max: VIDEO_PROFILE.max_width,
      name,
      profile: VIDEO_PROFILE,
    });
    if (!video.ok) continue;
    if (!video.result.output) {
      record(
        `${name} produced a rendition from a non-square pixel source`,
        false,
        JSON.stringify(video.result),
      );
      continue;
    }
    const sourceInfo = await probe(path.join(objectsDir, name));
    const outputInfo = await probe(video.uploaded);
    assert(
      `${name} fixture really carries non-square source pixels`,
      sourceInfo.sampleAspect !== 1 && sourceInfo.sampleAspectRatio !== "1:1",
      `sample aspect ratio ${sourceInfo.sampleAspectRatio}`,
    );
    assert(
      `${name} fixture displays at the anamorphic 5:3 ratio, not its pixel grid`,
      Math.abs(sourceInfo.displayAspect - 5 / 3) < 0.01,
      `display aspect ${sourceInfo.displayAspect}`,
    );
    assert(
      `${name} rendition is normalized to square pixels`,
      outputInfo.sampleAspect === 1,
      `sample aspect ratio ${outputInfo.sampleAspectRatio}`,
    );
    const darTolerance = sourceInfo.displayAspect * (1 / outputInfo.width + 1 / outputInfo.height);
    assert(
      `${name} rendition preserves the source display aspect ratio`,
      Math.abs(outputInfo.displayAspect - sourceInfo.displayAspect) <= darTolerance,
      `${outputInfo.displayAspect} vs ${sourceInfo.displayAspect} (tolerance ${darTolerance})`,
    );
    assert(
      `${name} rendition never upscales the source frame`,
      outputInfo.width <= sourceInfo.width && outputInfo.height <= sourceInfo.height,
      `${outputInfo.width}x${outputInfo.height} vs ${sourceInfo.width}x${sourceInfo.height}`,
    );
    assert(
      `${name} rendition preserves duration and audio`,
      Math.abs(outputInfo.durationSeconds - sourceInfo.durationSeconds) <= 0.5 &&
        outputInfo.hasAudio === sourceInfo.hasAudio,
      `${outputInfo.durationSeconds}s audio=${outputInfo.hasAudio} vs ${sourceInfo.durationSeconds}s audio=${sourceInfo.hasAudio}`,
    );
    assert(
      `${name} engine reported the rendition's own dimensions`,
      video.result.media.width === outputInfo.width &&
        video.result.media.height === outputInfo.height,
      `${video.result.media.width}x${video.result.media.height} vs ${outputInfo.width}x${outputInfo.height}`,
    );
    assert(
      `${name} rendition fully decodes through ffmpeg`,
      await fullyDecodes(video.uploaded),
      "null-output decode failed",
    );
  }

  const uploadsBeforeSecondPass = (await recordedUploads()).map((entry) => entry.key);
  const secondPass = await runJob({
    job_id: "smoke-no-benefit",
    max: VIDEO_PROFILE.max_width,
    name: "rendition-smoke-anamorphic.mp4",
    profile: VIDEO_PROFILE,
  });
  if (secondPass.ok) {
    assert(
      "an already-compliant normalized rendition needs no second optimization",
      secondPass.result.result === "original_compatible" && secondPass.result.output === null,
      JSON.stringify(secondPass.result),
    );
    assert(
      "the verified original is reported as a successful, non-error outcome",
      secondPass.status === 200 && secondPass.result.media.duration_seconds > 0,
      JSON.stringify(secondPass.result),
    );
  }
  const uploadsAfterNoBenefit = await recordedUploads();
  const secondPassUploads = uploadsAfterNoBenefit
    .map((entry) => entry.key)
    .filter((key) => !uploadsBeforeSecondPass.includes(key));
  assert(
    "the no-benefit path uploaded nothing",
    secondPassUploads.length === 0,
    `${JSON.stringify(secondPassUploads)} new objects`,
  );

  const boundedKey = "rendition-smoke-photo-bounded";
  const boundedFile = path.join(objectsDir, boundedKey);
  const boundedOutput = bounded.ok ? bounded.result.output : null;
  if (boundedOutput === null) {
    record(
      "the bounded rendition exists to drive the replay lifecycle",
      false,
      JSON.stringify(bounded.result),
    );
  } else {
    const uploadsFor = async (key) =>
      (await recordedUploads()).filter((entry) => entry.key === key);

    const replay = await processRequest(bounded.payload);
    const storedSha = await sha256(boundedFile);
    assert(
      "a redelivery with the recorded object intact replays the verdict",
      replay.status === 200 && replay.body?.replayed === true,
      JSON.stringify(replay.body),
    );
    assert(
      "the replayed verdict names the digest of the bytes actually stored",
      replay.body?.output?.sha256 === storedSha && storedSha === boundedOutput.sha256,
      `verdict ${replay.body?.output?.sha256} vs stored ${storedSha} vs recorded ${boundedOutput.sha256}`,
    );
    assert(
      "the replay uploaded no second object",
      (await uploadsFor(boundedKey)).length === 1,
      JSON.stringify(await uploadsFor(boundedKey)),
    );

    const cleared = await fetch(`${fixtureUrl}/objects/${boundedKey}`, {
      method: "DELETE",
    });
    assert(
      "the staging-clear delete removes the recorded rendition",
      cleared.status === 204,
      `status ${cleared.status}`,
    );
    const regenerated = await processRequest(bounded.payload);
    assert(
      "a redelivery whose recorded output was deleted re-executes, not replays",
      regenerated.status === 200 &&
        regenerated.body?.replayed !== true &&
        regenerated.body?.result === "optimized",
      JSON.stringify(regenerated.body),
    );
    const regeneratedSha = await sha256(boundedFile);
    assert(
      "the regenerated rendition was re-uploaded at the same key",
      regenerated.body?.output?.sha256 === regeneratedSha &&
        (await uploadsFor(boundedKey)).length === 2,
      `verdict ${regenerated.body?.output?.sha256} vs stored ${regeneratedSha}; uploads ${JSON.stringify(await uploadsFor(boundedKey))}`,
    );
    assert(
      "the recreated rendition is byte-identical to the deleted one",
      regeneratedSha === boundedOutput.sha256,
      `stored ${regeneratedSha} vs recorded ${boundedOutput.sha256}`,
    );
    assert(
      "the regenerated rendition fully decodes through libvips",
      await vipsFullyDecodes(boundedFile),
      "vips copy failed on the regenerated rendition",
    );

    const identicalJob = await jobPayload(
      "photo.jpg",
      "smoke-identical-collision",
      IMAGE_PROFILE,
      2048,
    );
    identicalJob.output_url = `${fixtureUrl}/objects/${boundedKey}`;
    const identical = await processRequest(identicalJob);
    assert(
      "a byte-identical pre-existing object is a terminal conflict, never adopted",
      identical.status === 412 &&
        identical.body?.error?.code === "output_exists" &&
        identical.body?.error?.retryable === false &&
        identical.body?.output === undefined,
      JSON.stringify(identical.body),
    );
    assert(
      "the identical object survives the refused job untouched",
      (await sha256(boundedFile)) === regeneratedSha,
      `stored ${await sha256(boundedFile)} vs ${regeneratedSha}`,
    );

    const pristine = await readFile(boundedFile);
    const pristineSha = createHash("sha256").update(pristine).digest("hex");
    const foreignKey = "rendition-smoke-foreign-collision";
    const foreignFile = path.join(objectsDir, foreignKey);
    const impostor = Buffer.from(pristine);
    impostor[impostor.length - 16] ^= 0xff;
    await writeFile(foreignFile, impostor);
    const impostorSha = await sha256(foreignFile);
    assert(
      "the seeded impostor collides on size and signature, not content",
      impostor.length === pristine.length &&
        impostorSha !== pristineSha &&
        (await signature(foreignFile)).startsWith("ffd8ff"),
      `${impostor.length}B sha ${impostorSha} vs ${pristineSha}`,
    );
    const foreignJob = await jobPayload(
      "photo.jpg",
      "smoke-foreign-collision",
      IMAGE_PROFILE,
      2048,
    );
    const foreign = await processRequest(foreignJob);
    assert(
      "a foreign same-size object at the granted key is refused, not adopted",
      foreign.status === 412 &&
        foreign.body?.error?.code === "output_exists" &&
        foreign.body?.error?.retryable === false &&
        foreign.body?.output === undefined &&
        foreign.body?.result !== "optimized",
      JSON.stringify(foreign.body),
    );
    assert(
      "the foreign object is left byte-for-byte untouched",
      (await sha256(foreignFile)) === impostorSha,
      `stored ${await sha256(foreignFile)} vs ${impostorSha}`,
    );
    const swapped = Buffer.from(pristine);
    swapped[Math.floor(swapped.length / 2)] ^= 0xff;
    await writeFile(boundedFile, swapped);
    const swappedSha = await sha256(boundedFile);
    const swappedReplay = await processRequest(bounded.payload);
    assert(
      "a redelivery facing a foreign same-size object answers its own verdict",
      swappedReplay.status === 200 &&
        swappedReplay.body?.replayed === true &&
        swappedReplay.body?.output?.sha256 === pristineSha,
      JSON.stringify(swappedReplay.body),
    );
    assert(
      "the foreign same-size object fails the stored-digest commit check",
      swappedSha !== swappedReplay.body?.output?.sha256,
      `stored ${swappedSha} vs verdict ${swappedReplay.body?.output?.sha256}`,
    );
    assert(
      "the impostor object survives the replayed verdict untouched",
      (await sha256(boundedFile)) === swappedSha,
      `stored ${await sha256(boundedFile)} vs ${swappedSha}`,
    );

    const raceJob = await jobPayload("photo.jpg", "smoke-race", IMAGE_PROFILE, 2048);
    const raceKey = "rendition-smoke-race";
    const [first, second] = await Promise.all([processRequest(raceJob), processRequest(raceJob)]);
    const fresh = [first, second].filter(
      (entry) => entry.status === 200 && entry.body?.replayed !== true,
    );
    const safelyAnswered = [first, second].filter(
      (entry) =>
        (entry.status === 429 &&
          entry.body?.error?.code === "busy" &&
          entry.body?.error?.retryable === true) ||
        (entry.status === 200 && entry.body?.replayed === true),
    );
    assert(
      "a duplicate in-flight delivery gets a safe retry or replay, never a second execution",
      fresh.length === 1 && safelyAnswered.length === 1,
      `statuses ${first.status}/${second.status} :: ${JSON.stringify(first.body)} ${JSON.stringify(second.body)}`,
    );
    const raceFile = path.join(objectsDir, raceKey);
    const raceUploads = await uploadsFor(raceKey);
    assert(
      "the raced deliveries produced exactly one rendition upload",
      raceUploads.length === 1,
      JSON.stringify(raceUploads),
    );
    const raceSha = await sha256(raceFile);
    assert(
      "the single raced upload is the deterministic rendition",
      raceSha === pristineSha,
      `stored ${raceSha} vs ${pristineSha}`,
    );
    const settled = await processRequest(raceJob);
    assert(
      "the post-settle redelivery replays the recorded verdict",
      settled.status === 200 &&
        settled.body?.replayed === true &&
        settled.body?.output?.sha256 === raceSha,
      JSON.stringify(settled.body),
    );
  }

  const uploads = await recordedUploads();
  const unexpected = uploads.filter((entry) => !entry.key.startsWith("rendition-"));
  assert(
    "the engine wrote only the exact output objects it was granted",
    unexpected.length === 0,
    JSON.stringify(unexpected),
  );

  await rm(scratch, { force: true, recursive: true });

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((entry) => entry.name).join(", ")}`);
    process.exit(1);
  }
}

async function jobPayload(name, job_id, profile, max) {
  const source = path.join(objectsDir, name);
  const size = (await stat(source)).size;
  return {
    asset_id: "00000000-0000-4000-8000-000000000001",
    declared_content_type:
      SOURCE_CONTENT_TYPES[name] ?? EXTENSION_CONTENT_TYPES[path.extname(name)],
    expected_checksum: await sha256(source),
    expected_size: size,
    input_url: `${fixtureUrl}/objects/${name}`,
    job_id,
    maximum_output_bytes: Math.min(512 * 1024 * 1024, Math.max(size * 2, 32 * 1024 * 1024)),
    output_url: `${fixtureUrl}/objects/rendition-${job_id}`,
    profile: { ...profile, max_height: max, max_width: max },
  };
}

async function runJob({ job_id, name, profile, max }) {
  const payload = await jobPayload(name, job_id, profile, max);
  const response = await processRequest(payload);
  if (response.status !== 200) {
    assert(`job ${job_id} succeeds`, false, JSON.stringify(response.body));
    return { ok: false, payload };
  }
  record(`job ${job_id} succeeds`, true, "");
  const uploaded = path.join(objectsDir, `rendition-${job_id}`);
  if (response.body.output) {
    const exists = await stat(uploaded).then(
      () => true,
      () => false,
    );
    assert(`job ${job_id} uploaded exactly the granted object key`, exists, `${uploaded} missing`);
    if (exists) {
      const magic = await signature(uploaded);
      const expectedMagic = MAGIC_FOR_CONTENT_TYPE[response.body.output.content_type];
      assert(
        `job ${job_id} uploaded bytes carry the signature of its reported type`,
        expectedMagic !== undefined && expectedMagic(magic),
        `${response.body.output.content_type} from ${magic}`,
      );
    }
  }
  return {
    ok: true,
    payload,
    result: response.body,
    status: response.status,
    uploaded,
  };
}

await main();
