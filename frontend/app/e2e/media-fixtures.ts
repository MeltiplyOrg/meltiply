import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface MediaFixture {
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly name: string;
}

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function attachmentTitle(fileName: string): string {
  const extensionStart = fileName.lastIndexOf(".");
  return extensionStart > 0 ? fileName.slice(0, extensionStart) : fileName;
}

export function attachmentControlName(prefix: string, fileName: string): RegExp {
  const label = `${prefix}${attachmentTitle(fileName)}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${label}(?:\\.[^/.]+)?$`);
}

function readFixture(fileName: string): Buffer {
  return readFileSync(resolve(fixturesDirectory, fileName));
}

export function pngFixture(): MediaFixture {
  return {
    buffer: readFixture("composer-blue.png"),
    mimeType: "image/png",
    name: "composer-blue.png",
  };
}

export function animatedGifFixture(): MediaFixture {
  return {
    buffer: readFixture("composer-animation.gif"),
    mimeType: "image/gif",
    name: "composer-animation.gif",
  };
}

export function mp4Fixture(): MediaFixture {
  return {
    buffer: readFixture("composer-clip.mp4"),
    mimeType: "video/mp4",
    name: "composer-clip.mp4",
  };
}

export function publicationVideoFixture(): MediaFixture {
  return {
    buffer: readFixture("composer-publish.mp4"),
    mimeType: "video/mp4",
    name: "composer-publish.mp4",
  };
}

export function quickTimeFixture(): MediaFixture {
  return {
    buffer: readFixture("composer-camera.mov"),
    mimeType: "video/quicktime",
    name: "composer-camera.mov",
  };
}

export function truncatedMp4Fixture(): MediaFixture {
  return {
    buffer: readFixture("composer-truncated.mp4"),
    mimeType: "video/mp4",
    name: "composer-truncated.mp4",
  };
}
