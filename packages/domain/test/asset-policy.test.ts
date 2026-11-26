import { describe, expect, it } from "vite-plus/test";

import {
  AssetPolicyError,
  isAcceptedMediaType,
  mediaUploadExtension,
  mediaUploadMaximum,
  uploadLayout,
  validateUpload,
} from "../src/asset-policy";

const MIB = 1024 * 1024;

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("validateUpload", () => {
  it.each([
    ["a GIF image", "image", "image/gif", "asset.gif"],
    ["a JPEG named .jpg", "image", "image/jpeg", "asset.jpg"],
    ["a JPEG named .jpeg", "image", "image/jpeg", "asset.jpeg"],
    ["a PNG image", "image", "image/png", "asset.png"],
    ["a WebP image", "image", "image/webp", "asset.webp"],
    ["an MP4 video", "video", "video/mp4", "asset.mp4"],
    ["a QuickTime video", "video", "video/quicktime", "asset.mov"],
    ["a filename outside ASCII", "image", "image/jpeg", "café 🚀.jpg"],
    ["a filename of 255 characters", "image", "image/jpeg", `${"a".repeat(251)}.jpg`],
  ] as const)("%s", (_example, assetType, contentType, filename) => {
    const input = { assetType, contentType, fileSize: 1, filename };

    expect(validateUpload(input)).toEqual({ assetType, contentType, fileSize: 1, filename });
  });

  it("a content type with parameters and capitals", () => {
    const input = {
      assetType: "image",
      contentType: "IMAGE/JPEG; charset=binary",
      fileSize: 42,
      filename: "cover.JPEG",
    };

    expect(validateUpload(input)).toEqual({
      assetType: "image",
      contentType: "image/jpeg",
      fileSize: 42,
      filename: "cover.JPEG",
    });
  });

  it("a filename padded with spaces", () => {
    const input = {
      assetType: "image",
      contentType: "image/png",
      fileSize: 42,
      filename: "  cover.png  ",
    };

    expect(validateUpload(input)).toEqual({
      assetType: "image",
      contentType: "image/png",
      fileSize: 42,
      filename: "cover.png",
    });
  });

  it.each([
    ["an empty filename", ""],
    ["a filename of only spaces", "   "],
    ["a filename of 256 characters", `${"a".repeat(252)}.jpg`],
    ["a parent-directory path", "../clip.jpg"],
    ["a single dot", "."],
    ["two dots", ".."],
    ["a backslash path", "a\\b.jpg"],
    ["a control character", "a\u0000b.jpg"],
    ["a delete character", "a\u007fb.jpg"],
  ])("%s", (_example, filename) => {
    const input = { assetType: "image", contentType: "image/jpeg", fileSize: 42, filename };

    expect(thrownBy(() => validateUpload(input))).toEqual(
      new AssetPolicyError(
        "invalid_filename",
        "filename must be a safe single path segment of at most 255 characters",
      ),
    );
  });

  it.each([
    ["an empty file", 0],
    ["a negative size", -1],
    ["a fractional size", 1.5],
    ["a size that is not a number", Number.NaN],
    ["an infinite size", Number.POSITIVE_INFINITY],
    ["a size past the safe integers", Number.MAX_SAFE_INTEGER + 1],
  ])("%s", (_example, fileSize) => {
    const input = { assetType: "image", contentType: "image/jpeg", fileSize, filename: "a.jpg" };

    expect(thrownBy(() => validateUpload(input))).toEqual(
      new AssetPolicyError("validation_error", "file_size must be a positive safe integer"),
    );
  });

  it("an unsupported content type", () => {
    const input = {
      assetType: "video",
      contentType: "video/webm",
      fileSize: 42,
      filename: "clip.webm",
    };

    expect(thrownBy(() => validateUpload(input))).toEqual(
      new AssetPolicyError("unsupported_media_type", "content_type is not supported"),
    );
  });

  it.each([
    ["a video declared as an image", "image", "video/mp4", "clip.mp4"],
    ["an image declared as a video", "video", "image/png", "cover.png"],
  ])("%s", (_example, assetType, contentType, filename) => {
    const input = { assetType, contentType, fileSize: 42, filename };

    expect(thrownBy(() => validateUpload(input))).toEqual(
      new AssetPolicyError("unsupported_media_type", "asset_type does not match content_type"),
    );
  });

  it.each([
    ["an extension of another type", "clip.exe"],
    ["a filename without an extension", "mp4"],
  ])("%s", (_example, filename) => {
    const input = { assetType: "video", contentType: "video/mp4", fileSize: 42, filename };

    expect(thrownBy(() => validateUpload(input))).toEqual(
      new AssetPolicyError(
        "unsupported_media_type",
        "filename extension does not match content_type",
      ),
    );
  });

  it.each([
    ["a GIF at its size limit", "image", "image/gif", "a.gif", 25 * MIB],
    ["a JPEG at its size limit", "image", "image/jpeg", "a.jpg", 25 * MIB],
    ["a PNG at its size limit", "image", "image/png", "a.png", 25 * MIB],
    ["a WebP at its size limit", "image", "image/webp", "a.webp", 25 * MIB],
    ["an MP4 at its size limit", "video", "video/mp4", "a.mp4", 500 * MIB],
    ["a QuickTime at its size limit", "video", "video/quicktime", "a.mov", 500 * MIB],
  ] as const)("%s", (_example, assetType, contentType, filename, fileSize) => {
    const input = { assetType, contentType, fileSize, filename };

    expect(validateUpload(input)).toEqual({ assetType, contentType, fileSize, filename });
  });

  it.each([
    ["a GIF one byte over", "image", "image/gif", "a.gif", 25 * MIB + 1, 26214400],
    ["a JPEG one byte over", "image", "image/jpeg", "a.jpg", 25 * MIB + 1, 26214400],
    ["a PNG one byte over", "image", "image/png", "a.png", 25 * MIB + 1, 26214400],
    ["a WebP one byte over", "image", "image/webp", "a.webp", 25 * MIB + 1, 26214400],
    ["an MP4 one byte over", "video", "video/mp4", "a.mp4", 500 * MIB + 1, 524288000],
    ["a QuickTime one byte over", "video", "video/quicktime", "a.mov", 500 * MIB + 1, 524288000],
  ] as const)("%s", (_example, assetType, contentType, filename, fileSize, maximum) => {
    const input = { assetType, contentType, fileSize, filename };

    expect(thrownBy(() => validateUpload(input))).toEqual(
      new AssetPolicyError(
        "payload_too_large",
        `${assetType} uploads cannot exceed ${maximum} bytes`,
      ),
    );
  });
});

describe("uploadLayout", () => {
  it.each([
    ["a one-byte file", 1],
    ["a file on the multipart threshold", 25 * MIB],
  ])("%s", (_example, fileSize) => {
    expect(uploadLayout(fileSize)).toEqual({ strategy: "single" });
  });

  it.each([
    ["a file one byte past the threshold", 25 * MIB + 1, 4],
    ["a file that fills its last part", 32 * MIB, 4],
    ["a file one byte into another part", 32 * MIB + 1, 5],
    ["the largest accepted video", 500 * MIB, 63],
    ["a file of exactly 10000 parts", 10_000 * 8 * MIB, 10_000],
  ])("%s", (_example, fileSize, partCount) => {
    expect(uploadLayout(fileSize)).toEqual({
      maxParallelParts: 4,
      partCount,
      partSize: 8 * MIB,
      strategy: "multipart",
    });
  });

  it("a file past 10000 parts", () => {
    const fileSize = 10_000 * 8 * MIB + 1;

    expect(thrownBy(() => uploadLayout(fileSize))).toEqual(
      new AssetPolicyError("payload_too_large", "multipart upload would exceed 10000 parts"),
    );
  });

  it.each([
    ["an empty file", 0],
    ["a negative size", -1],
    ["a fractional size", 1.5],
    ["a size that is not a number", Number.NaN],
    ["an infinite size", Number.POSITIVE_INFINITY],
    ["a size past the safe integers", Number.MAX_SAFE_INTEGER + 1],
  ])("%s", (_example, fileSize) => {
    expect(thrownBy(() => uploadLayout(fileSize))).toEqual(
      new AssetPolicyError("validation_error", "file size must be a positive safe integer"),
    );
  });
});

describe("isAcceptedMediaType", () => {
  it.each([
    ["an accepted type", "image/png", true],
    ["an unaccepted type", "text/plain", false],
    ["an empty string", "", false],
    ["an inherited object key", "toString", false],
    ["no type", undefined, false],
    ["a null type", null, false],
  ])("%s", (_example, contentType, accepted) => {
    expect(isAcceptedMediaType(contentType)).toEqual(accepted);
  });
});

describe("mediaUploadMaximum", () => {
  it.each([
    ["an image type", "image/jpeg", 26214400],
    ["a video type", "video/mp4", 524288000],
    ["an unaccepted type", "text/plain", null],
    ["an empty string", "", null],
    ["a constructor key", "constructor", null],
    ["a prototype key", "__proto__", null],
    ["no type", undefined, null],
    ["a null type", null, null],
  ])("%s", (_example, contentType, maximum) => {
    expect(mediaUploadMaximum(contentType)).toEqual(maximum);
  });
});

describe("mediaUploadExtension", () => {
  it.each([
    ["a type with two extensions", "image/jpeg", "jpg"],
    ["a type with one extension", "video/quicktime", "mov"],
    ["an unaccepted type", "text/plain", null],
  ])("%s", (_example, contentType, extension) => {
    expect(mediaUploadExtension(contentType)).toEqual(extension);
  });
});
