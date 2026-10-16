import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A deterministic media file handed to Playwright's `setInputFiles`. The
 * filename extension, declared MIME type, and byte length always agree with
 * the upload policy, and the bytes decode as a real picture: the native
 * processor parses them with libvips/FFmpeg, so filler bytes would fail for a
 * reason unrelated to the behavior under test.
 */
export interface MediaFixture {
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly name: string;
}

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * Maps imported filenames to default persisted titles: blue.png → blue.
 * Names with no dot after the first character (clip, .env) are unchanged.
 */
export function attachmentTitle(fileName: string): string {
  const extensionStart = fileName.lastIndexOf(".");
  return extensionStart > 0 ? fileName.slice(0, extensionStart) : fileName;
}

/**
 * Matches a control while a local filename becomes its persisted media title.
 * Optional extension presentation is not the behavior under test; identity and
 * the control's action/position prefix survive that transition.
 */
export function attachmentControlName(prefix: string, fileName: string): RegExp {
  const label = `${prefix}${attachmentTitle(fileName)}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${label}(?:\\.[^/.]+)?$`);
}

/**
 * Loads one committed fixture's bytes from disk.
 *
 * The files under `e2e/fixtures` were produced by FFmpeg 8.0.1 — the same
 * alpine:3.23 linux/amd64 build the native processor image installs — and each
 * one was verified by a full decode with those binaries, not by a header scan:
 *
 * - `composer-blue.png` — 64x64 truecolour, libvips `vips copy` decode + `vipsheader`.
 * - `composer-animation.gif` — 64x64, 3 frames at 5 fps, `ffmpeg -f null` decodes every frame.
 * - `composer-clip.mp4` — 128x128, 10 H.264 frames + a 44.1 kHz stereo AAC track, 1.0 s,
 *   decoded end to end with `ffmpeg -xerror`.
 * - `composer-camera.mov` — 128x128, 10 ProRes frames + a 44.1 kHz stereo PCM track in a
 *   QuickTime container, 1.0 s, decoded end to end with `ffmpeg -xerror`. A camera codec no
 *   browser plays, so only the engine's MP4 rendition can ever satisfy a preview.
 * - `composer-truncated.mp4` — the first 900 bytes of the clip: a real MP4 header whose
 *   media data is cut short, which the same decode rejects ("partial file"). It exercises
 *   the processor's actionable-failure path rather than a synthetic transport error.
 *
 * Only the bytes are read here; verification is a property of the committed files, so a
 * spec that needs a different picture adds a verified file rather than hand-writing bytes.
 *
 * @param fileName - File name inside `e2e/fixtures`.
 * @returns The file's exact bytes.
 */
function readFixture(fileName: string): Buffer {
  return readFileSync(resolve(fixturesDirectory, fileName));
}

/**
 * Deterministic PNG fixture: a small solid-blue still image.
 *
 * @returns PNG bytes with `image/png` metadata.
 */
export function pngFixture(): MediaFixture {
  return {
    buffer: readFixture("composer-blue.png"),
    mimeType: "image/png",
    name: "composer-blue.png",
  };
}

/**
 * Deterministic animated GIF fixture: a three-frame looping animation, so the
 * processor's animation-preserving path sees real multiple frames.
 *
 * @returns GIF bytes with `image/gif` metadata.
 */
export function animatedGifFixture(): MediaFixture {
  return {
    buffer: readFixture("composer-animation.gif"),
    mimeType: "image/gif",
    name: "composer-animation.gif",
  };
}

/**
 * Deterministic MP4 fixture: a one-second clip carrying both an H.264 video
 * track and an AAC audio track, so duration, frame, and audio metadata are all
 * real rather than implied by a container header.
 *
 * @returns MP4 bytes with `video/mp4` metadata.
 */
export function mp4Fixture(): MediaFixture {
  return {
    buffer: readFixture("composer-clip.mp4"),
    mimeType: "video/mp4",
    name: "composer-clip.mp4",
  };
}

/**
 * Deterministic QuickTime fixture: a one-second ProRes clip carrying a PCM audio
 * track in a MOV container. It is the camera-codec shape a creator's phone
 * produces and a browser cannot play, so a preview can only be satisfied by the
 * processor's MP4 rendition while the download stays the original file.
 *
 * @returns MOV bytes with `video/quicktime` metadata.
 */
export function quickTimeFixture(): MediaFixture {
  return {
    buffer: readFixture("composer-camera.mov"),
    mimeType: "video/quicktime",
    name: "composer-camera.mov",
  };
}

/**
 * Deliberately damaged MP4: valid container header, truncated media data. The
 * upload succeeds because the bytes are a legal `video/mp4` of the declared
 * size, so only real decoding can reject it — which is the failure the composer
 * must report with an actionable reason and offer to retry.
 *
 * @returns Truncated MP4 bytes with `video/mp4` metadata.
 */
export function truncatedMp4Fixture(): MediaFixture {
  return {
    buffer: readFixture("composer-truncated.mp4"),
    mimeType: "video/mp4",
    name: "composer-truncated.mp4",
  };
}
