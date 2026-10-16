import { describe, expect, it } from "vite-plus/test";

import {
  ASSET_UPLOAD_POLICY,
  type AssetPolicyError,
  isoDateTime,
  uploadLayout,
  validateUpload,
} from "../src";

const acceptedMediaCases = [
  ["image", "image/gif", "asset.gif", 25 * 1024 * 1024],
  ["image", "image/jpeg", "asset.jpg", 25 * 1024 * 1024],
  ["image", "image/jpeg", "asset.jpeg", 25 * 1024 * 1024],
  ["image", "image/png", "asset.png", 25 * 1024 * 1024],
  ["image", "image/webp", "asset.webp", 25 * 1024 * 1024],
  ["video", "video/mp4", "asset.mp4", 500 * 1024 * 1024],
  ["video", "video/quicktime", "asset.mov", 500 * 1024 * 1024],
] as const;

describe("asset upload policy", () => {
  it("normalizes accepted MIME types and matches extensions", () => {
    expect(
      validateUpload({
        assetType: "image",
        contentType: "IMAGE/JPEG; charset=binary",
        fileSize: 42,
        filename: "cover.JPEG",
      }),
    ).toEqual({
      assetType: "image",
      contentType: "image/jpeg",
      fileSize: 42,
      filename: "cover.JPEG",
    });
  });

  it("normalizes Date and database timestamp values consistently", () => {
    const timestamp = "2026-07-22T12:34:56.789Z";

    expect(isoDateTime(new Date(timestamp))).toBe(timestamp);
    expect(isoDateTime(timestamp)).toBe(timestamp);
  });

  it.each([
    ["../clip.mp4", "video/mp4", "video", "invalid_filename"],
    ["clip.exe", "video/mp4", "video", "unsupported_media_type"],
    ["clip.webm", "video/webm", "video", "unsupported_media_type"],
    ["clip.mp4", "video/mp4", "image", "unsupported_media_type"],
  ] as const)("rejects invalid upload %s", (filename, contentType, assetType, code) => {
    expect(() =>
      validateUpload({
        assetType,
        contentType,
        fileSize: 42,
        filename,
      }),
    ).toThrow(expect.objectContaining<Partial<AssetPolicyError>>({ code }));
  });

  it.each(acceptedMediaCases)(
    "holds the accepted media boundary properties for %s %s",
    (assetType, contentType, filename, maximum) => {
      for (const fileSize of [1, maximum]) {
        expect(validateUpload({ assetType, contentType, fileSize, filename })).toEqual({
          assetType,
          contentType,
          fileSize,
          filename,
        });
      }

      expect(() =>
        validateUpload({
          assetType,
          contentType,
          fileSize: maximum + 1,
          filename,
        }),
      ).toThrow(
        expect.objectContaining<Partial<AssetPolicyError>>({
          code: "payload_too_large",
        }),
      );

      expect(() =>
        validateUpload({
          assetType: assetType === "image" ? "video" : "image",
          contentType,
          fileSize: 1,
          filename,
        }),
      ).toThrow(
        expect.objectContaining<Partial<AssetPolicyError>>({
          code: "unsupported_media_type",
        }),
      );
    },
  );

  it("selects the server-owned single/multipart boundary", () => {
    expect(uploadLayout(ASSET_UPLOAD_POLICY.multipartThresholdBytes)).toEqual({
      strategy: "single",
    });
    expect(uploadLayout(ASSET_UPLOAD_POLICY.multipartThresholdBytes + 1)).toEqual({
      maxParallelParts: 4,
      partCount: 4,
      partSize: 8 * 1024 * 1024,
      strategy: "multipart",
    });
  });

  it("preserves multipart layout properties across part boundaries", () => {
    const partSize = ASSET_UPLOAD_POLICY.multipartPartSizeBytes;
    const maximumAcceptedSize = 500 * 1024 * 1024;
    const sizes = [ASSET_UPLOAD_POLICY.multipartThresholdBytes + 1, maximumAcceptedSize];
    for (
      let boundary =
        Math.ceil((ASSET_UPLOAD_POLICY.multipartThresholdBytes + 1) / partSize) * partSize;
      boundary <= maximumAcceptedSize;
      boundary += partSize
    ) {
      sizes.push(boundary);
      if (boundary < maximumAcceptedSize) sizes.push(boundary + 1);
    }

    for (const fileSize of new Set(sizes)) {
      const layout = uploadLayout(fileSize);
      expect(layout.strategy).toBe("multipart");
      if (layout.strategy !== "multipart") throw new Error("expected multipart layout");
      expect(layout.partCount).toBe(Math.ceil(fileSize / partSize));
      expect(layout.partSize * layout.partCount).toBeGreaterThanOrEqual(fileSize);
      expect(layout.partSize * (layout.partCount - 1)).toBeLessThan(fileSize);
      expect(layout.maxParallelParts).toBe(ASSET_UPLOAD_POLICY.maxParallelParts);
    }
  });
});
