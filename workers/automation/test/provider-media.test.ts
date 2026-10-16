import type { ObjectUrlSigner } from "@meltiply/storage";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import { createProviderMediaResolver } from "../src/provider-media";

const baseEnv = {
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies AutomationEnv;

function metadata(contentType = "video/mp4", size = 512) {
  return {
    etag: "etag-1",
    httpEtag: '"etag-1"',
    httpMetadata: { contentType },
    key: "org-1/asset-1/video.mp4",
    size,
    uploaded: new Date("2026-07-19T00:00:00.000Z"),
    version: "version-1",
    writeHttpMetadata: vi.fn(),
  };
}

function request(
  transferMode: "byte_upload" | "remote_ingest" | "resumable_upload",
  fileSize = 512,
) {
  return {
    assetId: "asset-1",
    assetType: "video" as const,
    contentType: "video/mp4",
    fileSize,
    objectKey: "org-1/asset-1/video.mp4",
    transferMode,
  };
}

describe("provider media resolver", () => {
  it("creates a 24-hour remote-ingest URL after authoritative R2 metadata", async () => {
    const head = vi.fn(async () => metadata());
    const signDownload = vi.fn(
      async () => "https://r2.example/signed/video.mp4?signature=ephemeral",
    );
    const signer = { signDownload } as unknown as ObjectUrlSigner;
    const resolve = createProviderMediaResolver(
      { ...baseEnv, ASSETS: { head } as unknown as R2Bucket },
      signer,
    );

    await expect(resolve(request("remote_ingest"))).resolves.toEqual({
      contentType: "video/mp4",
      fileSize: 512,
      mode: "remote_ingest",
      url: "https://r2.example/signed/video.mp4?signature=ephemeral",
    });
    expect(head).toHaveBeenCalledWith("org-1/asset-1/video.mp4");
    expect(signDownload).toHaveBeenCalledWith({
      expiresInSeconds: 86_400,
      key: "org-1/asset-1/video.mp4",
    });
  });

  it.each(["byte_upload", "resumable_upload"] as const)(
    "hands %s adapters the R2 stream without buffering",
    async (transferMode) => {
      const body = new ReadableStream<Uint8Array>();
      const get = vi.fn(async () => ({ ...metadata(), body }));
      const resolve = createProviderMediaResolver({
        ...baseEnv,
        ASSETS: { get } as unknown as R2Bucket,
      });

      const result = await resolve(request(transferMode));
      expect(result).toEqual({
        body,
        contentType: "video/mp4",
        fileSize: 512,
        mode: transferMode,
      });
      expect(get).toHaveBeenCalledWith("org-1/asset-1/video.mp4");
    },
  );

  it("preserves an accepted 500 MB stream without consuming it", async () => {
    const fileSize = 500 * 1024 * 1024;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0]));
        controller.close();
      },
    });
    const get = vi.fn(async () => ({
      ...metadata("video/mp4", fileSize),
      body,
    }));
    const resolve = createProviderMediaResolver({
      ...baseEnv,
      ASSETS: { get } as unknown as R2Bucket,
    });

    await expect(resolve(request("resumable_upload", fileSize))).resolves.toMatchObject({
      body,
      contentType: "video/mp4",
      fileSize,
      mode: "resumable_upload",
    });
    expect(body.locked).toBe(false);
    expect(get).toHaveBeenCalledWith("org-1/asset-1/video.mp4");
  });

  it("rejects cross-asset keys and mismatched R2 metadata before signing", async () => {
    const signDownload = vi.fn();
    const signer = { signDownload } as unknown as ObjectUrlSigner;
    const resolve = createProviderMediaResolver(
      {
        ...baseEnv,
        ASSETS: {
          head: vi.fn(async () => metadata("video/mp4", 511)),
        } as unknown as R2Bucket,
      },
      signer,
    );

    await expect(
      resolve({
        ...request("remote_ingest"),
        objectKey: "org-1/other-asset/video.mp4",
      }),
    ).rejects.toThrow("object key is invalid");
    await expect(resolve(request("remote_ingest"))).rejects.toThrow("metadata does not match R2");
    expect(signDownload).not.toHaveBeenCalled();
  });

  it("delivers a promoted rendition key but never an unpromoted staging key", async () => {
    const head = vi.fn(async () => metadata("image/webp", 256));
    const signDownload = vi.fn(
      async () => "https://r2.example/signed/rendition.webp?signature=ephemeral",
    );
    const signer = { signDownload } as unknown as ObjectUrlSigner;
    const resolve = createProviderMediaResolver(
      {
        ...baseEnv,
        ASSETS: {
          head: vi.fn(async (key: string) =>
            key.endsWith("rendition.webp") ? { ...metadata("image/webp", 256), key } : null,
          ) as unknown as R2Bucket["head"],
        } as unknown as R2Bucket,
      },
      signer,
    );

    // A ready rendition keeps the `<org>/<asset>/<name>` layout, so the
    // resolver can still prove ownership from the key alone.
    await expect(
      resolve({
        assetId: "asset-1",
        assetType: "image",
        contentType: "image/webp",
        fileSize: 256,
        objectKey: "org-1/asset-1/rendition.webp",
        transferMode: "remote_ingest",
      }),
    ).resolves.toMatchObject({
      contentType: "image/webp",
      fileSize: 256,
      mode: "remote_ingest",
      url: "https://r2.example/signed/rendition.webp?signature=ephemeral",
    });

    // Staging bytes carry a `staging/` prefix instead of the asset segment, so
    // they can never be handed to a Provider even with a valid grant.
    await expect(
      resolve({
        assetId: "asset-1",
        assetType: "image",
        contentType: "image/webp",
        fileSize: 256,
        objectKey: "staging/org-1/asset-1/session-1/rendition.webp",
        transferMode: "remote_ingest",
      }),
    ).rejects.toThrow("object key is invalid");
    expect(head).not.toHaveBeenCalled();
  });
});
