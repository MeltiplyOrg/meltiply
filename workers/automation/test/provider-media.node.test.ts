import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import { createProviderMediaResolver } from "../src/provider-media";
import { fakeObjectUrlSigner, fakeR2Bucket, fakeR2Object, fakeR2ObjectBody } from "./test-doubles";

const baseEnv = {
  ENVIRONMENT: "test",
  VERSION: "1.0.0-target.0",
} satisfies AutomationEnv;

afterEach(() => {
  vi.unstubAllGlobals();
});

function metadata(contentType = "video/mp4", size = 512): R2Object {
  return fakeR2Object({
    httpMetadata: { contentType },
    size,
    writeHttpMetadata: () => undefined,
  });
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

describe("createProviderMediaResolver", () => {
  it("mints a 24-hour remote-ingest URL after verifying R2 metadata", async () => {
    const headKeys: string[] = [];
    const signed: unknown[] = [];
    const resolve = createProviderMediaResolver(
      {
        ...baseEnv,
        ASSETS: fakeR2Bucket({
          head: async (key) => {
            headKeys.push(key);
            return metadata();
          },
        }),
      },
      fakeObjectUrlSigner({
        signDownload: async (input) => {
          signed.push(input);
          return "https://r2.example/signed/video.mp4?signature=ephemeral";
        },
      }),
    );

    expect(await resolve(request("remote_ingest"))).toEqual({
      contentType: "video/mp4",
      fileSize: 512,
      mode: "remote_ingest",
      url: "https://r2.example/signed/video.mp4?signature=ephemeral",
    });
    expect(headKeys).toEqual(["org-1/asset-1/video.mp4"]);
    expect(signed).toEqual([{ expiresInSeconds: 86_400, key: "org-1/asset-1/video.mp4" }]);
  });

  it.each(["byte_upload", "resumable_upload"] as const)(
    "hands %s adapters the unbuffered R2 stream",
    async (transferMode) => {
      const body = new ReadableStream<Uint8Array>();
      const getKeys: string[] = [];
      const resolve = createProviderMediaResolver({
        ...baseEnv,
        ASSETS: fakeR2Bucket({
          get: async (key) => {
            getKeys.push(key);
            return fakeR2ObjectBody(body, metadata());
          },
        }),
      });

      expect(await resolve(request(transferMode))).toEqual({
        body,
        contentType: "video/mp4",
        fileSize: 512,
        mode: transferMode,
      });
      expect(getKeys).toEqual(["org-1/asset-1/video.mp4"]);
    },
  );

  it("preserves an accepted 500 MB stream without locking it", async () => {
    const fileSize = 500 * 1024 * 1024;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0]));
        controller.close();
      },
    });
    const resolve = createProviderMediaResolver({
      ...baseEnv,
      ASSETS: fakeR2Bucket({
        get: async () => fakeR2ObjectBody(body, metadata("video/mp4", fileSize)),
      }),
    });

    expect(await resolve(request("resumable_upload", fileSize))).toEqual({
      body,
      contentType: "video/mp4",
      fileSize,
      mode: "resumable_upload",
    });
    expect(body.locked).toEqual(false);
  });

  it.each([
    ["cross-asset key", "org-1/other-asset/video.mp4", "object key is invalid"],
    [
      "unpromoted staging key",
      "staging/org-1/asset-1/session-1/video.mp4",
      "object key is invalid",
    ],
    [
      "mismatched stored size",
      "org-1/asset-1/video.mp4",
      "metadata does not match the object store",
    ],
  ])("rejects %s before signing", async (_example, objectKey, expectedError) => {
    let signedCount = 0;
    const resolve = createProviderMediaResolver(
      {
        ...baseEnv,
        ASSETS: fakeR2Bucket({ head: async () => metadata("video/mp4", 511) }),
      },
      fakeObjectUrlSigner({
        signDownload: async () => {
          signedCount += 1;
          return "https://unused";
        },
      }),
    );

    await expect(resolve({ ...request("remote_ingest"), objectKey })).rejects.toThrow(
      expectedError,
    );
    expect(signedCount).toEqual(0);
  });

  it("delivers a promoted rendition key", async () => {
    const resolve = createProviderMediaResolver(
      {
        ...baseEnv,
        ASSETS: fakeR2Bucket({
          head: async (key) => fakeR2Object({ ...metadata("image/webp", 256), key }),
        }),
      },
      fakeObjectUrlSigner({
        signDownload: async () => "https://r2.example/signed/rendition.webp?signature=ephemeral",
      }),
    );

    expect(
      await resolve({
        assetId: "asset-1",
        assetType: "image",
        contentType: "image/webp",
        fileSize: 256,
        objectKey: "org-1/asset-1/rendition.webp",
        transferMode: "remote_ingest",
      }),
    ).toEqual({
      contentType: "image/webp",
      fileSize: 256,
      mode: "remote_ingest",
      url: "https://r2.example/signed/rendition.webp?signature=ephemeral",
    });
  });

  it("reads metadata and signs against an S3-compatible origin", async () => {
    const requests: Array<{ method: string | undefined; url: string }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: init?.method, url: String(input) });
      return new Response(null, {
        headers: {
          "content-length": "512",
          "content-type": "video/mp4",
          etag: '"etag-1"',
          "last-modified": "Sat, 19 Jul 2026 00:00:00 GMT",
        },
      });
    });

    const resolve = createProviderMediaResolver({
      ...baseEnv,
      OBJECT_STORAGE_PROVIDER: "s3",
      S3_ACCESS_KEY_ID: "s3-access-key",
      S3_BUCKET: "meltiply-assets",
      S3_ENDPOINT: "https://objects.example.test",
      S3_SECRET_ACCESS_KEY: "s3-secret",
    });

    const resolved = await resolve(request("remote_ingest"));

    expect(requests).toEqual([
      {
        method: "HEAD",
        url: "https://objects.example.test/meltiply-assets/org-1/asset-1/video.mp4",
      },
    ]);
    if (resolved.mode !== "remote_ingest") throw new Error("expected remote-ingest media");
    const url = new URL(resolved.url);
    expect(url.origin).toEqual("https://objects.example.test");
    expect(url.pathname).toEqual("/meltiply-assets/org-1/asset-1/video.mp4");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/s3/aws4_request");
    expect(resolved.url).not.toContain("s3-secret");
  });
});
