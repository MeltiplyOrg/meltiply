import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createR2SignerFromEnv,
  createStorageServiceLive,
  readyObjectKey,
  R2ObjectStore,
  R2SigV4Signer,
  stagingObjectKey,
  StorageService,
  type R2BucketLike,
} from "../src";

describe("storage keys", () => {
  it("separates upload-writable staging keys from publishable ready keys", () => {
    // A ready key keeps `<org>/<asset>/<name>` so ownership is verifiable from
    // the key alone, which is what authorizes a Provider delivery.
    expect(readyObjectKey("org-alpha", "asset-one", "rendition-webp")).toBe(
      "org-alpha/asset-one/rendition-webp",
    );
    // A staging key lives in a distinct namespace, so it can never be mistaken
    // for or promoted into an approved byte stream by key shape alone.
    expect(stagingObjectKey("org-alpha", "asset-one", "session-one", "clip.mp4")).toBe(
      "staging/org-alpha/asset-one/session-one/clip.mp4",
    );
  });

  it.each(["../escape", "nested/name", "", "."])("rejects unsafe segment %j", (segment) => {
    expect(() => readyObjectKey("org-alpha", "asset-one", segment)).toThrow(
      "non-empty path segment",
    );
    expect(() => stagingObjectKey("org-alpha", "asset-one", "session-one", segment)).toThrow(
      "non-empty path segment",
    );
  });
});

describe("R2SigV4Signer key derivation", () => {
  it("reuses a date-scoped signing key across concurrent requests", async () => {
    let current = new Date("2026-01-01T00:00:00Z");
    const signer = new R2SigV4Signer({
      accessKeyId: "access-key",
      accountId: "account-id",
      bucket: "meltiply-test",
      now: () => current,
      secretAccessKey: "secret-key",
    });
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    try {
      const requests = Array.from({ length: 63 }, (_, index) =>
        signer.signMultipartPart({
          contentLength: 100 + index,
          contentType: "video/mp4",
          expiresInSeconds: 900,
          key: `org/asset/part-${index}`,
          partNumber: index + 1,
          uploadId: "upload-id",
        }),
      );
      const signed = await Promise.all(requests);

      expect(signed).toHaveLength(63);
      expect(importKey).toHaveBeenCalledTimes(5);

      current = new Date("2026-01-02T00:00:00Z");
      await signer.signUpload({
        contentLength: 100,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "org/asset/next",
      });
      expect(importKey).toHaveBeenCalledTimes(10);
    } finally {
      importKey.mockRestore();
    }
  });
});

describe("R2ObjectStore", () => {
  it("normalizes native R2 metadata", async () => {
    const uploaded = new Date("2026-01-01T00:00:00Z");
    const store = new R2ObjectStore({
      createMultipartUpload: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      head: vi.fn().mockResolvedValue({
        checksums: { sha256: new Uint8Array([0xab, 0xcd]) },
        etag: "etag-one",
        httpMetadata: { contentType: "video/mp4" },
        key: "org/asset/clip.mp4",
        size: 42,
        uploaded,
        version: "version-one",
      }),
      put: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    });

    await expect(store.head("org/asset/clip.mp4")).resolves.toEqual({
      contentType: "video/mp4",
      customMetadata: null,
      etag: "etag-one",
      key: "org/asset/clip.mp4",
      sha256: "abcd",
      size: 42,
      uploadedAt: uploaded,
      version: "version-one",
    });
  });

  /**
   * Promotion of verified upload bytes from the upload-writable staging key to
   * the publishable ready key is the security boundary a reusable upload grant
   * must not cross: the source generation is pinned by ETag and the destination
   * is written only when absent, so a mutated staging object is never promoted
   * and a replayed copy adopts the bytes an interrupted attempt already wrote.
   */
  it("promotes staged bytes to a ready key under a pinned source ETag", async () => {
    const body = { locked: false } as unknown as ReadableStream;
    const uploaded = new Date("2026-01-01T00:00:00Z");
    const get = vi.fn().mockResolvedValue({
      body,
      etag: "etag-staged",
      key: "staging/org/asset/session/clip.mp4",
      size: 42,
      uploaded,
    });
    const put = vi.fn().mockResolvedValue({
      etag: "etag-ready",
      httpMetadata: { contentType: "image/png" },
      key: "org/asset/original",
      size: 42,
      uploaded,
    });
    const store = new R2ObjectStore({
      createMultipartUpload: vi.fn(),
      delete: vi.fn(),
      get,
      head: vi.fn(),
      put,
      resumeMultipartUpload: vi.fn(),
    });

    await expect(
      store.copyObject("staging/org/asset/session/clip.mp4", "org/asset/original", {
        contentType: "image/png",
        ifDestinationAbsent: true,
        ifSourceEtagMatches: "etag-staged",
      }),
    ).resolves.toMatchObject({
      contentType: "image/png",
      etag: "etag-ready",
      key: "org/asset/original",
      size: 42,
    });
    expect(get).toHaveBeenCalledWith("staging/org/asset/session/clip.mp4", {
      onlyIf: { etagMatches: "etag-staged" },
    });
    // The source body is streamed straight into the destination write; the
    // worker never buffers the object.
    expect(put).toHaveBeenCalledWith(
      "org/asset/original",
      body,
      expect.objectContaining({ onlyIf: { etagDoesNotMatch: "*" } }),
    );
  });

  it("refuses to promote a staging object a reused grant rewrote", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const put = vi.fn();
    const store = new R2ObjectStore({
      createMultipartUpload: vi.fn(),
      delete: vi.fn(),
      get,
      head: vi.fn(),
      put,
      resumeMultipartUpload: vi.fn(),
    });

    await expect(
      store.copyObject("staging/org/asset/session/clip.mp4", "org/asset/original", {
        ifDestinationAbsent: true,
        ifSourceEtagMatches: "etag-expected",
      }),
    ).resolves.toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it("adopts an existing destination instead of duplicating a replayed copy", async () => {
    const put = vi.fn().mockResolvedValue(null);
    const store = new R2ObjectStore({
      createMultipartUpload: vi.fn(),
      delete: vi.fn(),
      get: vi.fn().mockResolvedValue({
        body: {} as unknown as ReadableStream,
        etag: "etag-staged",
        key: "staging/org/asset/session/clip.mp4",
        size: 42,
        uploaded: new Date("2026-01-01T00:00:00Z"),
      }),
      head: vi.fn(),
      put,
      resumeMultipartUpload: vi.fn(),
    });

    await expect(
      store.copyObject("staging/org/asset/session/clip.mp4", "org/asset/original", {
        ifDestinationAbsent: true,
      }),
    ).resolves.toBeNull();
  });

  it("resumes opaque native multipart uploads", async () => {
    const upload = {
      abort: vi.fn(),
      complete: vi.fn(),
      uploadId: "native-upload-id",
      uploadPart: vi.fn(),
    };
    const resumeMultipartUpload = vi.fn().mockReturnValue(upload);
    const store = new R2ObjectStore({
      createMultipartUpload: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      put: vi.fn(),
      resumeMultipartUpload,
    });

    const resumed = store.resumeMultipartUpload("org/asset/clip.mp4", "native-upload-id");

    expect(resumeMultipartUpload).toHaveBeenCalledWith("org/asset/clip.mp4", "native-upload-id");
    expect(resumed.uploadId).toBe("native-upload-id");
  });

  it("reads only a bounded object prefix", async () => {
    const get = vi.fn().mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      etag: "etag-one",
      key: "org/asset/image.png",
      size: 3,
      uploaded: new Date("2026-01-01T00:00:00Z"),
    });
    const store = new R2ObjectStore({
      createMultipartUpload: vi.fn(),
      delete: vi.fn(),
      get,
      head: vi.fn(),
      put: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    });

    await expect(store.readPrefix("org/asset/image.png", 256)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(get).toHaveBeenCalledWith("org/asset/image.png", {
      range: { length: 256, offset: 0 },
    });
    await expect(store.readPrefix("org/asset/image.png", 0)).rejects.toThrow("maximumBytes");
    await expect(store.readRange("org/asset/image.png", -1, 256)).rejects.toThrow("offset");
  });
});

describe("R2SigV4Signer", () => {
  const signer = new R2SigV4Signer({
    accessKeyId: "access-key",
    accountId: "account-id",
    bucket: "private-assets",
    now: () => new Date("2026-07-18T12:34:56Z"),
    secretAccessKey: "secret-key",
  });

  it("binds upload length and type without exposing credentials", async () => {
    const signed = new URL(
      await signer.signUpload({
        contentLength: 42,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "org one/asset/clip final.mp4",
      }),
    );

    expect(signed.origin).toBe("https://account-id.r2.cloudflarestorage.com");
    expect(signed.pathname).toBe("/private-assets/org%20one/asset/clip%20final.mp4");
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(signed.searchParams.get("X-Amz-Credential")).toContain(
      "access-key/20260718/auto/s3/aws4_request",
    );
    expect(signed.toString()).not.toContain("secret-key");
  });

  it("clamps a signed upload grant to an absolute expiresAt captured at signing time", async () => {
    // The clock advances a full second while the signature is produced. A
    // grant whose remaining TTL were recomputed from a later instant than the
    // one the signature is dated at would silently outlive the deadline the
    // caller already persisted on its inventory row.
    let clockReads = 0;
    const delayedSigner = new R2SigV4Signer({
      accessKeyId: "access-key",
      accountId: "account-id",
      bucket: "private-assets",
      now: () => {
        clockReads += 1;
        const instant = new Date("2026-07-18T12:34:56Z");
        instant.setUTCSeconds(instant.getUTCSeconds() + clockReads - 1);
        return instant;
      },
      secretAccessKey: "secret-key",
    });
    const deadline = new Date("2026-07-18T12:38:16Z"); // 200s after the first instant.

    const signed = new URL(
      await delayedSigner.signUpload({
        contentLength: 42,
        contentType: "video/mp4",
        expiresAt: deadline,
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
      }),
    );

    // One captured instant drives both halves of the grant: the signature's
    // own date and the remaining lifetime that clamps the nominal TTL to the
    // persisted deadline.
    expect(signed.searchParams.get("X-Amz-Date")).toBe("20260718T123456Z");
    expect(signed.searchParams.get("X-Amz-Expires")).toBe("200");
  });

  it("clamps multipart part and exact-write grants to the same absolute deadline", async () => {
    // Exactly 120s of the frozen instant's window remain, so both write
    // capabilities are signed for the deadline remainder rather than their
    // nominal TTL.
    const deadline = new Date("2026-07-18T12:36:56Z");

    const part = new URL(
      await signer.signMultipartPart({
        contentLength: 5 * 1024 * 1024,
        contentType: "video/mp4",
        expiresAt: deadline,
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
        partNumber: 2,
        uploadId: "upload-9",
      }),
    );
    expect(part.searchParams.get("X-Amz-Date")).toBe("20260718T123456Z");
    expect(part.searchParams.get("X-Amz-Expires")).toBe("120");

    const write = new URL(
      await signer.signObjectWrite({
        expiresAt: deadline,
        expiresInSeconds: 900,
        key: "staging/org/asset/processing",
        requiredHeaders: { "if-none-match": "*" },
      }),
    );
    expect(write.searchParams.get("X-Amz-Date")).toBe("20260718T123456Z");
    expect(write.searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("rejects a write deadline that elapsed before signing instead of minting a one-second grant", async () => {
    // The signer's frozen instant is 2026-07-18T12:34:56Z, so a deadline at or
    // before it — including one with under a second left — can never become a
    // valid grant and must fail rather than be stretched to expiresInSeconds=1.
    await expect(
      signer.signUpload({
        contentLength: 42,
        contentType: "video/mp4",
        expiresAt: new Date("2026-07-18T12:34:55Z"),
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
      }),
    ).rejects.toThrow("expiresAt has already elapsed");
    await expect(
      signer.signUpload({
        contentLength: 42,
        contentType: "video/mp4",
        expiresAt: new Date("2026-07-18T12:34:56.500Z"),
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
      }),
    ).rejects.toThrow("expiresAt has already elapsed");
    await expect(
      signer.signObjectWrite({
        expiresAt: new Date("2026-07-18T12:34:56Z"),
        expiresInSeconds: 900,
        key: "staging/org/asset/processing",
        requiredHeaders: { "if-none-match": "*" },
      }),
    ).rejects.toThrow("expiresAt has already elapsed");
  });

  it("keeps the requested expiresInSeconds when the deadline is further out", async () => {
    // expiresAt is a ceiling, not a replacement TTL: a deadline an hour away
    // must not widen a 60-second grant beyond the caller's requested
    // lifetime. The signed duration is the smaller of the two.
    const deadline = new Date("2026-07-18T13:34:56Z"); // 3600s after the frozen instant.

    const upload = new URL(
      await signer.signUpload({
        contentLength: 42,
        contentType: "video/mp4",
        expiresAt: deadline,
        expiresInSeconds: 60,
        key: "org/asset/clip.mp4",
      }),
    );
    expect(upload.searchParams.get("X-Amz-Expires")).toBe("60");

    const write = new URL(
      await signer.signObjectWrite({
        expiresAt: deadline,
        expiresInSeconds: 60,
        key: "staging/org/asset/processing",
        requiredHeaders: { "if-none-match": "*" },
      }),
    );
    expect(write.searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("signs bounded multipart identifiers as query parameters", async () => {
    const signed = new URL(
      await signer.signMultipartPart({
        contentLength: 5 * 1024 * 1024,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
        partNumber: 3,
        uploadId: "opaque/native+id",
      }),
    );

    expect([...signed.searchParams.keys()]).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
      "partNumber",
      "uploadId",
    ]);
    expect(signed.search).toContain("uploadId=opaque%2Fnative%2Bid");
    expect(signed.searchParams.get("partNumber")).toBe("3");
    expect(signed.searchParams.get("uploadId")).toBe("opaque/native+id");
    expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports loopback S3 endpoints for compatibility tests", async () => {
    const localSigner = new R2SigV4Signer({
      accessKeyId: "minioadmin",
      accountId: "local",
      bucket: "meltiply-test",
      endpoint: "http://127.0.0.1:9000",
      now: () => new Date("2026-07-18T12:34:56Z"),
      secretAccessKey: "minioadmin",
    });

    const signed = new URL(
      await localSigner.signUpload({
        contentLength: 42,
        contentType: "image/png",
        expiresInSeconds: 60,
        key: "org/asset/image.png",
      }),
    );

    expect(signed.origin).toBe("http://127.0.0.1:9000");
    expect(signed.pathname).toBe("/meltiply-test/org/asset/image.png");
  });

  it("rejects insecure remote and ambiguous custom endpoints", () => {
    expect(
      () =>
        new R2SigV4Signer({
          accessKeyId: "access-key",
          accountId: "account-id",
          bucket: "private-assets",
          endpoint: "http://storage.example.com",
          secretAccessKey: "secret-key",
        }),
    ).toThrow("HTTPS");
    expect(
      () =>
        new R2SigV4Signer({
          accessKeyId: "access-key",
          accountId: "account-id",
          bucket: "private-assets",
          endpoint: "https://storage.example.com/s3",
          secretAccessKey: "secret-key",
        }),
    ).toThrow("must not include");
  });

  it.each([
    { boundary: "single", prefix: "/cdn-cgi/local/r2/s3/" },
    {
      boundary: "large",
      prefix: `${"/".repeat(100_000)}cdn-cgi/local/r2/s3${"/".repeat(100_000)}`,
    },
  ])(
    "signs a path-prefixed S3 origin with $boundary boundary slashes and binds required write headers",
    async ({ prefix }) => {
      // A local runtime serves the same bucket at `/cdn-cgi/local/r2/s3/<bucket>`.
      // The prefix is part of the canonical URI (otherwise the signature could not
      // be verified), while `host` stays the configured origin so the browser and
      // a processor container receive byte-identical signed URLs.
      const localSigner = new R2SigV4Signer({
        accessKeyId: "local-r2-access-key",
        accountId: "local",
        allowInsecureEndpoint: true,
        bucket: "meltiply-assets-local",
        endpoint: "http://172.18.0.1:8787",
        endpointPathPrefix: prefix,
        now: () => new Date("2026-07-18T12:34:56Z"),
        secretAccessKey: "local-r2-secret-key",
      });

      const signed = new URL(
        await localSigner.signObjectWrite({
          expiresInSeconds: 900,
          key: "staging/org/asset/processing-image_jpeg_webp_4096_long_edge",
          requiredHeaders: { "If-None-Match": "*" },
        }),
      );

      expect(signed.origin).toBe("http://172.18.0.1:8787");
      expect(signed.pathname).toBe(
        "/cdn-cgi/local/r2/s3/meltiply-assets-local/staging/org/asset/processing-image_jpeg_webp_4096_long_edge",
      );
      // The header is inside the signature, so an engine that omits it is rejected
      // by the origin instead of overwriting an earlier attempt's output.
      expect(signed.searchParams.get("X-Amz-SignedHeaders")).toBe("host;if-none-match");
    },
  );

  it("rejects an insecure origin unless it is explicitly allowed", () => {
    const insecure = {
      accessKeyId: "access-key",
      accountId: "account-id",
      bucket: "private-assets",
      endpoint: "http://storage.example.com",
      secretAccessKey: "secret-key",
    };
    expect(() => new R2SigV4Signer(insecure)).toThrow("HTTPS");
    expect(
      () =>
        new R2SigV4Signer({
          ...insecure,
          allowInsecureEndpoint: true,
        }),
    ).not.toThrow();
  });

  it("derives the insecure-endpoint permission from ENVIRONMENT alone", () => {
    const local = createR2SignerFromEnv({
      ENVIRONMENT: "local",
      R2_ACCESS_KEY_ID: "local-r2-access-key",
      R2_ACCOUNT_ID: "local",
      R2_BUCKET_NAME: "meltiply-assets-local",
      R2_ENDPOINT: "http://172.18.0.1:8787",
      R2_ENDPOINT_PATH_PREFIX: "/cdn-cgi/local/r2/s3",
      R2_SECRET_ACCESS_KEY: "local-r2-secret-key",
    });
    expect(local).toBeInstanceOf(R2SigV4Signer);
    // No configuration value can turn the plain-HTTP allowance on outside a
    // local/test environment: the flag is derived, not read from the env.
    expect(() =>
      createR2SignerFromEnv({
        ENVIRONMENT: "staging",
        R2_ACCESS_KEY_ID: "access-key",
        R2_ACCOUNT_ID: "account-id",
        R2_BUCKET_NAME: "private-assets",
        R2_ENDPOINT: "http://storage.example.com",
        R2_SECRET_ACCESS_KEY: "secret-key",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      createR2SignerFromEnv({
        R2_ACCESS_KEY_ID: "access-key",
        R2_ACCOUNT_ID: "account-id",
        R2_BUCKET_NAME: "private-assets",
      }),
    ).toThrow("credentials are incomplete");
  });

  it("rejects a required-header map that would fake create-only safety", async () => {
    await expect(
      signer.signObjectWrite({
        expiresInSeconds: 900,
        key: "staging/org/asset/processing",
        requiredHeaders: {},
      }),
    ).rejects.toThrow("must not be empty");
    await expect(
      signer.signObjectWrite({
        expiresInSeconds: 900,
        key: "staging/org/asset/processing",
        requiredHeaders: { host: "evil.example.com" },
      }),
    ).rejects.toThrow("must not override host");
    await expect(
      signer.signObjectWrite({
        expiresInSeconds: 900,
        key: "staging/org/asset/processing",
        requiredHeaders: { "if none match": "*" },
      }),
    ).rejects.toThrow("invalid header name");
  });

  it("rejects unsafe keys and out-of-bounds signing inputs", async () => {
    await expect(
      signer.signUpload({
        contentLength: 0,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
      }),
    ).rejects.toThrow("contentLength");
    await expect(
      signer.signDownload({
        expiresInSeconds: 900,
        key: "org/../clip.mp4",
      }),
    ).rejects.toThrow("path segment");
    await expect(
      signer.signMultipartPart({
        contentLength: 1,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
        partNumber: 10_001,
        uploadId: "upload",
      }),
    ).rejects.toThrow("partNumber");
  });

  it("binds downloads to an attachment disposition and safe content type", async () => {
    const signed = new URL(
      await signer.signDownload({
        downloadFilename: 'clip".mp4',
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
      }),
    );
    expect([...signed.searchParams.keys()]).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
      "response-content-disposition",
      "response-content-type",
    ]);
    expect(signed.search).toContain(
      "response-content-disposition=attachment%3B%20filename%3D%22clip_.mp4%22",
    );
    expect(signed.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="clip_.mp4"',
    );
    expect(signed.searchParams.get("response-content-type")).toBe("application/octet-stream");
  });

  it("leaves validated inline previews on their stored media metadata", async () => {
    const signed = new URL(
      await signer.signDownload({
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
      }),
    );
    expect(signed.searchParams.has("response-content-disposition")).toBe(false);
    expect(signed.searchParams.has("response-content-type")).toBe(false);
  });

  it("exposes Effect-returning operations on R2ObjectStore and distinguishes NotFoundError", async () => {
    const { Cause, Effect, Option } = await import("effect");
    const uploaded = new Date("2026-01-01T00:00:00Z");
    const store = new R2ObjectStore({
      createMultipartUpload: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      head: vi.fn().mockImplementation(async (key: string) => {
        if (key === "exists.mp4") {
          return {
            etag: "etag-1",
            httpMetadata: { contentType: "video/mp4" },
            key,
            size: 100,
            uploaded,
          };
        }
        return null;
      }),
      put: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    });

    const successProgram = Effect.gen(function* () {
      const meta = yield* store.getMetadataEffect("exists.mp4");
      return meta;
    });
    const meta = await Effect.runPromise(successProgram);
    expect(meta.etag).toBe("etag-1");

    const notFoundProgram = store.getMetadataEffect("missing.mp4");
    const exit = await Effect.runPromiseExit(notFoundProgram);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({ _tag: "NotFoundError" });
      }
    }
  });

  it("exposes Effect-returning operations on R2SigV4Signer and maps invalid args to InvalidRequestError", async () => {
    const { Cause, Effect, Option } = await import("effect");
    const localSigner = new R2SigV4Signer({
      accessKeyId: "access-key",
      accountId: "account-id",
      bucket: "meltiply-test",
      secretAccessKey: "secret-key",
    });

    const uploadUrl = await Effect.runPromise(
      localSigner.signUploadEffect({
        contentLength: 1024,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
      }),
    );
    expect(uploadUrl).toContain("https://account-id.r2.cloudflarestorage.com");

    const invalidExit = await Effect.runPromiseExit(
      localSigner.signUploadEffect({
        contentLength: -5,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
      }),
    );
    expect(invalidExit._tag).toBe("Failure");
    if (invalidExit._tag === "Failure") {
      const failure = Cause.findErrorOption(invalidExit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({ _tag: "InvalidRequestError" });
      }
    }
  });

  it("keeps signing available while absent object storage fails closed", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        const url = yield* storage.signDownload({
          key: "org/asset/photo.png",
          expiresInSeconds: 60,
        });
        const missing = yield* storage
          .head("org/asset/photo.png")
          .pipe(
            Effect.catchTag("StorageUnavailableError", (error) => Effect.succeed(error.message)),
          );
        return { url, missing };
      }).pipe(
        Effect.provide(
          createStorageServiceLive({
            signer: {
              accessKeyId: "access-key",
              accountId: "account-id",
              bucket: "assets",
              secretAccessKey: "secret-key",
            },
          }),
        ),
      ),
    );
    expect(result.url).toContain("X-Amz-Signature=");
    expect(result.missing).toBe("Object storage is not configured.");
  });

  it("StorageService composes via createStorageServiceLive and createStorageServiceTest", async () => {
    const { Effect } = await import("effect");
    const { StorageService, createStorageServiceLive, createStorageServiceTest } =
      await import("../src");

    const uploaded = new Date("2026-01-01T00:00:00Z");
    const liveLayer = createStorageServiceLive({
      bucket: {
        createMultipartUpload: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
        head: vi.fn().mockResolvedValue({
          etag: "etag-live",
          httpMetadata: { contentType: "image/png" },
          key: "org/asset/photo.png",
          size: 200,
          uploaded,
        }),
        put: vi.fn(),
        resumeMultipartUpload: vi.fn(),
      },
    });

    const liveProgram = Effect.gen(function* () {
      const storage = yield* StorageService;
      return yield* storage.head("org/asset/photo.png");
    }).pipe(Effect.provide(liveLayer));

    const liveResult = await Effect.runPromise(liveProgram);
    expect(liveResult?.etag).toBe("etag-live");

    const testLayer = createStorageServiceTest({
      head: (key) =>
        Effect.succeed({
          contentType: "text/plain",
          etag: "mock-etag",
          key,
          size: 10,
          uploadedAt: new Date("2026-01-01"),
        }),
    });

    const testProgram = Effect.gen(function* () {
      const storage = yield* StorageService;
      return yield* storage.head("test-key");
    }).pipe(Effect.provide(testLayer));

    const testResult = await Effect.runPromise(testProgram);
    expect(testResult?.etag).toBe("mock-etag");
  });

  it("exercises R2ObjectStore and EffectMultipartUpload full lifecycle", async () => {
    const { Effect } = await import("effect");
    const uploaded = new Date("2026-01-01T00:00:00Z");
    const mockAbort = vi.fn().mockResolvedValue(undefined);
    const mockComplete = vi.fn().mockResolvedValue({
      etag: "complete-etag",
      httpMetadata: { contentType: "video/mp4" },
      key: "org/asset/video.mp4",
      size: 1024,
      uploaded,
    });
    const mockUploadPart = vi.fn().mockResolvedValue({
      etag: "part-1-etag",
      partNumber: 1,
    });

    const store = new R2ObjectStore({
      createMultipartUpload: vi.fn().mockResolvedValue({
        abort: mockAbort,
        complete: mockComplete,
        uploadId: "upl-123",
        uploadPart: mockUploadPart,
      }),
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        etag: "etag-get",
        key: "org/asset/video.mp4",
        size: 4,
        uploaded,
      }),
      head: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      resumeMultipartUpload: vi.fn().mockReturnValue({
        abort: mockAbort,
        complete: mockComplete,
        uploadId: "upl-resumed",
        uploadPart: mockUploadPart,
      }),
    });

    const program = Effect.gen(function* () {
      yield* store.deleteEffect("org/asset/video.mp4");
      const prefix = yield* store.readPrefixEffect("org/asset/video.mp4", 4);
      const range = yield* store.readRangeEffect("org/asset/video.mp4", 0, 4);

      const mp = yield* store.createMultipartUploadEffect("org/asset/video.mp4", "video/mp4");
      const part = yield* mp.uploadPart(1, new Uint8Array([1, 2]));
      const completed = yield* mp.complete([part]);
      yield* mp.abort();

      const resumedMp = yield* store.resumeMultipartUploadEffect(
        "org/asset/video.mp4",
        "upl-resumed",
      );
      yield* resumedMp.abort();

      return { completed, prefix, range };
    });

    const res = await Effect.runPromise(program);
    expect(res.prefix).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(res.range).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(res.completed.etag).toBe("complete-etag");
  });

  it("exercises R2SigV4Signer multipart and download effect methods", async () => {
    const { Effect } = await import("effect");
    const localSigner = new R2SigV4Signer({
      accessKeyId: "access-key",
      accountId: "account-id",
      bucket: "meltiply-test",
      secretAccessKey: "secret-key",
    });

    const partUrl = await Effect.runPromise(
      localSigner.signMultipartPartEffect({
        contentLength: 512,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
        partNumber: 1,
        uploadId: "upload-1",
      }),
    );
    expect(partUrl).toContain("partNumber=1");

    const downloadUrl = await Effect.runPromise(
      localSigner.signDownloadEffect({
        downloadFilename: "my_video.mp4",
        expiresInSeconds: 900,
        key: "org/asset/clip.mp4",
      }),
    );
    expect(downloadUrl).toContain("response-content-disposition");
  });

  it("exercises StorageService live with full signer options and test defaults", async () => {
    const { Effect } = await import("effect");
    const { StorageService, createStorageServiceLive, createStorageServiceTest } =
      await import("../src");

    const uploaded = new Date("2026-01-01T00:00:00Z");
    const liveLayer = createStorageServiceLive({
      bucket: {
        createMultipartUpload: vi.fn().mockResolvedValue({
          abort: vi.fn(),
          complete: vi.fn().mockResolvedValue({
            etag: "live-complete",
            httpMetadata: { contentType: "video/mp4" },
            key: "test.mp4",
            size: 100,
            uploaded,
          }),
          uploadId: "upl-live",
          uploadPart: vi.fn().mockResolvedValue({ etag: "p1", partNumber: 1 }),
        }),
        delete: vi.fn(),
        get: vi.fn().mockResolvedValue({
          arrayBuffer: async () => new Uint8Array([10, 20]).buffer,
          etag: "live-etag",
          key: "test.mp4",
          size: 2,
          uploaded,
        }),
        head: vi.fn().mockResolvedValue({
          etag: "live-etag",
          httpMetadata: { contentType: "video/mp4" },
          key: "test.mp4",
          size: 2,
          uploaded,
        }),
        put: vi.fn(),
        resumeMultipartUpload: vi.fn().mockReturnValue({
          abort: vi.fn(),
          complete: vi.fn().mockResolvedValue({
            etag: "live-resumed",
            httpMetadata: { contentType: "video/mp4" },
            key: "test.mp4",
            size: 2,
            uploaded,
          }),
          uploadId: "upl-resumed",
          uploadPart: vi.fn().mockResolvedValue({ etag: "p1", partNumber: 1 }),
        }),
      },
      signer: {
        accessKeyId: "access-key",
        accountId: "account-id",
        bucket: "meltiply-test",
        secretAccessKey: "secret-key",
      },
    });

    const liveProgram = Effect.gen(function* () {
      const storage = yield* StorageService;
      const meta = yield* storage.getMetadata("test.mp4");
      const prefix = yield* storage.readPrefix("test.mp4", 2);
      const range = yield* storage.readRange("test.mp4", 0, 2);
      yield* storage.delete("test.mp4");

      const mp = yield* storage.createMultipartUpload("test.mp4", "video/mp4");
      const part = yield* mp.uploadPart(1, new Uint8Array([1]));
      const completed = yield* mp.complete([part]);
      yield* mp.abort();

      const resumed = yield* storage.resumeMultipartUpload("test.mp4", "upl-resumed");
      yield* resumed.abort();

      const uploadUrl = yield* storage.signUpload({
        contentLength: 100,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "test.mp4",
      });
      const partUrl = yield* storage.signMultipartPart({
        contentLength: 100,
        contentType: "video/mp4",
        expiresInSeconds: 900,
        key: "test.mp4",
        partNumber: 1,
        uploadId: "upl-1",
      });
      const downloadUrl = yield* storage.signDownload({
        expiresInSeconds: 900,
        key: "test.mp4",
      });

      return {
        completed,
        downloadUrl,
        meta,
        partUrl,
        prefix,
        range,
        uploadUrl,
      };
    }).pipe(Effect.provide(liveLayer));

    const liveRes = await Effect.runPromise(liveProgram);
    expect(liveRes.meta.etag).toBe("live-etag");
    expect(liveRes.uploadUrl).toContain("https://");

    // Test default implementation doubles in createStorageServiceTest
    const defaultTestLayer = createStorageServiceTest();
    const testProgram = Effect.gen(function* () {
      const storage = yield* StorageService;
      yield* storage.delete("dummy");
      const meta = yield* storage.getMetadata("dummy");
      const head = yield* storage.head("dummy");
      const prefix = yield* storage.readPrefix("dummy", 10);
      const range = yield* storage.readRange("dummy", 0, 10);

      const mp = yield* storage.createMultipartUpload("dummy", "text/plain");
      const p = yield* mp.uploadPart(1, new Uint8Array([1]));
      const c = yield* mp.complete([p]);
      yield* mp.abort();

      const resumed = yield* storage.resumeMultipartUpload("dummy", "u1");
      yield* resumed.abort();
      yield* resumed.uploadPart(1, new Uint8Array([1]));
      yield* resumed.complete([]);

      const upUrl = yield* storage.signUpload({
        contentLength: 10,
        contentType: "text/plain",
        expiresInSeconds: 60,
        key: "dummy",
      });
      const partUrl = yield* storage.signMultipartPart({
        contentLength: 10,
        contentType: "text/plain",
        expiresInSeconds: 60,
        key: "dummy",
        partNumber: 1,
        uploadId: "u1",
      });
      const downUrl = yield* storage.signDownload({
        expiresInSeconds: 60,
        key: "dummy",
      });

      return { c, downUrl, head, meta, partUrl, prefix, range, upUrl };
    }).pipe(Effect.provide(defaultTestLayer));

    const testRes = await Effect.runPromise(testProgram);
    expect(testRes.meta.etag).toBe("mock-etag");
    expect(testRes.upUrl).toContain("mock-storage.local");

    // Live layer without signer fails closed on signing
    const noSignerLayer = createStorageServiceLive({
      bucket: {
        createMultipartUpload: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
        head: vi.fn(),
        put: vi.fn(),
        resumeMultipartUpload: vi.fn(),
      },
    });

    const noSignerProgram = Effect.gen(function* () {
      const storage = yield* StorageService;
      return yield* storage.signDownload({ expiresInSeconds: 60, key: "test" });
    }).pipe(Effect.provide(noSignerLayer));

    const exit = await Effect.runPromiseExit(noSignerProgram);
    expect(exit._tag).toBe("Failure");

    // Live layer with plain ObjectUrlSigner (Promise-based)
    const customSignerLayer = createStorageServiceLive({
      bucket: {
        createMultipartUpload: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
        head: vi.fn(),
        put: vi.fn(),
        resumeMultipartUpload: vi.fn(),
      },
      signer: {
        signDownload: vi.fn().mockResolvedValue("https://plain.signer/download"),
        signMultipartPart: vi.fn().mockResolvedValue("https://plain.signer/part"),
        signUpload: vi.fn().mockResolvedValue("https://plain.signer/upload"),
      },
    });

    const customProgram = Effect.gen(function* () {
      const storage = yield* StorageService;
      const d = yield* storage.signDownload({ expiresInSeconds: 60, key: "k" });
      const p = yield* storage.signMultipartPart({
        contentLength: 10,
        contentType: "text/plain",
        expiresInSeconds: 60,
        key: "k",
        partNumber: 1,
        uploadId: "u",
      });
      const u = yield* storage.signUpload({
        contentLength: 10,
        contentType: "text/plain",
        expiresInSeconds: 60,
        key: "k",
      });
      return { d, p, u };
    }).pipe(Effect.provide(customSignerLayer));

    const customRes = await Effect.runPromise(customProgram);
    expect(customRes.d).toBe("https://plain.signer/download");
    expect(customRes.p).toBe("https://plain.signer/part");
    expect(customRes.u).toBe("https://plain.signer/upload");

    // Live layer with invalid signer options catches and fails closed
    const invalidSignerLayer = createStorageServiceLive({
      bucket: {
        createMultipartUpload: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
        head: vi.fn(),
        put: vi.fn(),
        resumeMultipartUpload: vi.fn(),
      },
      signer: {
        accessKeyId: "",
        accountId: "",
        bucket: "",
        secretAccessKey: "",
      },
    });

    const invalidSignerProgram = Effect.gen(function* () {
      const storage = yield* StorageService;
      return yield* storage.signUpload({
        contentLength: 10,
        contentType: "text/plain",
        expiresInSeconds: 60,
        key: "k",
      });
    }).pipe(Effect.provide(invalidSignerLayer));

    const invalidSignerExit = await Effect.runPromiseExit(invalidSignerProgram);
    expect(invalidSignerExit._tag).toBe("Failure");

    // Invalid parameters in signMultipartPartEffect and signDownloadEffect
    const localSigner = new R2SigV4Signer({
      accessKeyId: "access-key",
      accountId: "account-id",
      bucket: "meltiply-test",
      secretAccessKey: "secret-key",
    });

    const partErrExit = await Effect.runPromiseExit(
      localSigner.signMultipartPartEffect({
        contentLength: 10,
        contentType: "text/plain",
        expiresInSeconds: 60,
        key: "org/asset/file.txt",
        partNumber: 0,
        uploadId: "u1",
      }),
    );
    expect(partErrExit._tag).toBe("Failure");

    const downErrExit = await Effect.runPromiseExit(
      localSigner.signDownloadEffect({
        expiresInSeconds: 0,
        key: "org/asset/file.txt",
      }),
    );
    expect(downErrExit._tag).toBe("Failure");

    // Custom signer failure maps to StorageUnavailableError
    const failingSignerLayer = createStorageServiceLive({
      bucket: {
        createMultipartUpload: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
        head: vi.fn(),
        put: vi.fn(),
        resumeMultipartUpload: vi.fn(),
      },
      signer: {
        signDownload: vi.fn().mockRejectedValue(new Error("network failure")),
        signMultipartPart: vi.fn().mockRejectedValue(new Error("network failure")),
        signUpload: vi.fn().mockRejectedValue(new Error("network failure")),
      },
    });

    const failingDownExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.signDownload({ expiresInSeconds: 60, key: "k" });
      }).pipe(Effect.provide(failingSignerLayer)),
    );
    expect(failingDownExit._tag).toBe("Failure");

    const failingPartExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.signMultipartPart({
          contentLength: 10,
          contentType: "text/plain",
          expiresInSeconds: 60,
          key: "k",
          partNumber: 1,
          uploadId: "u",
        });
      }).pipe(Effect.provide(failingSignerLayer)),
    );
    expect(failingPartExit._tag).toBe("Failure");

    const failingUpExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.signUpload({
          contentLength: 10,
          contentType: "text/plain",
          expiresInSeconds: 60,
          key: "k",
        });
      }).pipe(Effect.provide(failingSignerLayer)),
    );
    expect(failingUpExit._tag).toBe("Failure");

    // Invalid request in signUploadEffect
    const upErrExit = await Effect.runPromiseExit(
      localSigner.signUploadEffect({
        contentLength: 10,
        contentType: "text/plain",
        expiresInSeconds: 0,
        key: "invalid.txt",
      }),
    );
    expect(upErrExit._tag).toBe("Failure");

    // Multipart upload errors in EffectMultipartUpload
    const failingMultipartLayer = createStorageServiceLive({
      bucket: {
        createMultipartUpload: vi.fn().mockResolvedValue({
          abort: vi.fn().mockRejectedValue(new Error("abort failed")),
          complete: vi.fn().mockRejectedValue(new Error("complete failed")),
          uploadId: "fail-upl",
          uploadPart: vi
            .fn()
            .mockRejectedValueOnce(new TypeError("invalid part"))
            .mockRejectedValueOnce(new Error("part storage error")),
        }),
        delete: vi.fn(),
        get: vi.fn(),
        head: vi.fn(),
        put: vi.fn(),
        resumeMultipartUpload: vi.fn(),
      },
    });

    const mpFailProgram = Effect.gen(function* () {
      const storage = yield* StorageService;
      const mp = yield* storage.createMultipartUpload("test.txt", "text/plain");

      const abortExit = yield* Effect.exit(mp.abort());
      expect(abortExit._tag).toBe("Failure");

      const compExit = yield* Effect.exit(mp.complete([]));
      expect(compExit._tag).toBe("Failure");

      const typeErrExit = yield* Effect.exit(mp.uploadPart(1, new Uint8Array([1])));
      expect(typeErrExit._tag).toBe("Failure");

      const standardErrExit = yield* Effect.exit(mp.uploadPart(1, new Uint8Array([1])));
      expect(standardErrExit._tag).toBe("Failure");
    }).pipe(Effect.provide(failingMultipartLayer));

    await Effect.runPromise(mpFailProgram);

    // Characters in encode: [!'()*]
    const specialUrl = await localSigner.signDownload({
      expiresInSeconds: 60,
      key: "org/asset/clip!(1)'*.mp4",
    });
    expect(specialUrl).toContain("%21");
    expect(specialUrl).toContain("%28");
    expect(specialUrl).toContain("%29");
    expect(specialUrl).toContain("%27");
    expect(specialUrl).toContain("%2A");
  });

  it("resumes multipart uploads inside the Effect error channel", async () => {
    const { Cause, Effect, Option } = await import("effect");
    const { R2ObjectStore, StorageService, createStorageServiceLive, createStorageServiceTest } =
      await import("../src");

    const uploaded = new Date("2026-01-01T00:00:00Z");
    const nativeHandle = {
      abort: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue({
        etag: "resumed-etag",
        httpMetadata: { contentType: "video/mp4" },
        key: "org/asset/video.mp4",
        size: 512,
        uploaded,
      }),
      uploadId: "upl-resumed",
      uploadPart: vi.fn().mockResolvedValue({ etag: "part-1", partNumber: 1 }),
    };
    const bucketWith = (resumeMultipartUpload: R2BucketLike["resumeMultipartUpload"]) => ({
      createMultipartUpload: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      put: vi.fn(),
      resumeMultipartUpload,
    });

    const successStore = new R2ObjectStore(bucketWith(vi.fn().mockReturnValue(nativeHandle)));
    const resumed = await Effect.runPromise(
      successStore.resumeMultipartUploadEffect("org/asset/video.mp4", "upl-resumed"),
    );
    expect(resumed.uploadId).toBe("upl-resumed");
    const part = await Effect.runPromise(resumed.uploadPart(1, new Uint8Array([1])));
    expect(part.etag).toBe("part-1");

    for (const [cause, tag] of [
      [new TypeError("bad key"), "InvalidRequestError"],
      [new RangeError("bad range"), "InvalidRequestError"],
      [new Error("r2 is down"), "StorageUnavailableError"],
    ] as const) {
      const failing = new R2ObjectStore(
        bucketWith(
          vi.fn().mockImplementation(() => {
            throw cause;
          }),
        ),
      );
      const exit = await Effect.runPromiseExit(failing.resumeMultipartUploadEffect("k", "u"));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toMatchObject({ _tag: tag });
        }
      }
    }

    const liveLayer = createStorageServiceLive({
      bucket: bucketWith(vi.fn().mockReturnValue(nativeHandle)),
    });
    const liveResumed = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.resumeMultipartUpload("org/asset/video.mp4", "upl-resumed");
      }).pipe(Effect.provide(liveLayer)),
    );
    expect(liveResumed.uploadId).toBe("upl-resumed");

    const liveValidationLayer = createStorageServiceLive({
      bucket: bucketWith(
        vi.fn().mockImplementation(() => {
          throw new TypeError("bad upload id");
        }),
      ),
    });
    const liveExit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.resumeMultipartUpload("k", "u");
      }).pipe(Effect.provide(liveValidationLayer)),
    );
    expect(liveExit._tag).toBe("Failure");
    if (liveExit._tag === "Failure") {
      const failure = Cause.findErrorOption(liveExit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toMatchObject({ _tag: "InvalidRequestError" });
      }
    }

    const testResumed = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.resumeMultipartUpload("dummy", "u1");
      }).pipe(Effect.provide(createStorageServiceTest())),
    );
    expect(testResumed.uploadId).toBe("u1");
    await Effect.runPromise(testResumed.abort());
  });

  it("maps custom ObjectUrlSigner validation and infrastructure failures", async () => {
    const { Cause, Effect, Option } = await import("effect");
    const { StorageService, createStorageServiceLive } = await import("../src");

    const bucket = () => ({
      createMultipartUpload: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      head: vi.fn(),
      put: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    });
    const uploadRequest = {
      contentLength: 10,
      contentType: "text/plain",
      expiresInSeconds: 60,
      key: "k",
    } as const;
    const partRequest = {
      ...uploadRequest,
      partNumber: 1,
      uploadId: "u",
    } as const;
    const downloadRequest = { expiresInSeconds: 60, key: "k" } as const;

    const validationLayer = createStorageServiceLive({
      bucket: bucket(),
      signer: {
        signDownload: vi.fn().mockRejectedValue(new TypeError("bad key")),
        signMultipartPart: vi.fn().mockRejectedValue(new RangeError("bad part number")),
        signUpload: vi.fn().mockRejectedValue(new TypeError("bad input")),
      },
    });

    for (const program of [
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.signUpload({ ...uploadRequest });
      }),
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.signMultipartPart({ ...partRequest });
      }),
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.signDownload({ ...downloadRequest });
      }),
    ]) {
      const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(validationLayer)));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toMatchObject({ _tag: "InvalidRequestError" });
        }
      }
    }

    const infraLayer = createStorageServiceLive({
      bucket: bucket(),
      signer: {
        signDownload: vi.fn().mockRejectedValue(new Error("network failure")),
        signMultipartPart: vi.fn().mockRejectedValue(new Error("network failure")),
        signUpload: vi.fn().mockRejectedValue(new Error("network failure")),
      },
    });

    for (const program of [
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.signUpload({ ...uploadRequest });
      }),
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.signMultipartPart({ ...partRequest });
      }),
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return yield* storage.signDownload({ ...downloadRequest });
      }),
    ]) {
      const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(infraLayer)));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toMatchObject({
            _tag: "StorageUnavailableError",
          });
        }
      }
    }
  });
});
