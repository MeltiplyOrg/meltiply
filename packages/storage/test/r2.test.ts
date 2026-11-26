import { beforeAll, describe, expect, it } from "vite-plus/test";

import { createR2SignerFromEnv, R2ObjectStore, R2SigV4Signer } from "../src/r2";
import { FakeR2Bucket, r2Body, UPLOADED } from "./fake-r2-bucket";

const NOW = new Date("2026-07-18T12:34:56Z");
const KEY = "org/asset/clip.mp4";

function setup() {
  const bucket = new FakeR2Bucket();
  const store = new R2ObjectStore(bucket);
  return { bucket, store };
}

const written = {
  contentType: null,
  customMetadata: null,
  etag: "etag-written",
  key: KEY,
  sha256: null,
  size: 3,
  uploadedAt: UPLOADED,
  version: null,
};

beforeAll(async () => {
  await new R2SigV4Signer({
    accessKeyId: "warm",
    accountId: "warm",
    bucket: "warm",
    secretAccessKey: "warm",
  }).signDownload({ expiresInSeconds: 1, key: "warm" });
});

describe("R2ObjectStore", () => {
  describe("head", () => {
    it("an object with every field", async () => {
      const { bucket, store } = setup();
      bucket.object = r2Body({
        checksums: { sha256: new Uint8Array([6, 192]).buffer },
        customMetadata: { a: "b" },
        httpMetadata: { contentType: "video/mp4" },
        version: "version-one",
      });

      expect(await store.head(KEY)).toEqual({
        contentType: "video/mp4",
        customMetadata: { a: "b" },
        etag: "etag-one",
        key: KEY,
        sha256: "06c0",
        size: 3,
        uploadedAt: UPLOADED,
        version: "version-one",
      });
    });

    it("an object with no optional field", async () => {
      const { bucket, store } = setup();
      bucket.object = r2Body({ checksums: null });

      expect(await store.head(KEY)).toEqual({ ...written, etag: "etag-one" });
    });

    it("a missing object", async () => {
      const { store } = setup();

      expect(await store.head(KEY)).toEqual(null);
    });
  });

  describe("copyObject", () => {
    const source = "staging/org/asset/session/clip.mp4";
    const body = new ReadableStream();

    it("a promotion with every condition", async () => {
      const { bucket, store } = setup();
      bucket.object = r2Body({ body });

      const result = await store.copyObject(source, KEY, {
        contentType: "image/png",
        ifDestinationAbsent: true,
        ifSourceEtagMatches: "etag-staged",
      });

      expect(result).toEqual(written);
      expect(bucket.calls).toEqual([
        ["get", source, { onlyIf: { etagMatches: "etag-staged" } }],
        [
          "put",
          KEY,
          body,
          { httpMetadata: { contentType: "image/png" }, onlyIf: { etagDoesNotMatch: "*" } },
        ],
      ]);
    });

    it("a copy with no conditions", async () => {
      const { bucket, store } = setup();
      bucket.object = r2Body({ body });

      await store.copyObject(source, KEY);

      expect(bucket.calls).toEqual([
        ["get", source, { onlyIf: { etagMatches: undefined } }],
        ["put", KEY, body, {}],
      ]);
    });

    it.each([
      ["a source that no longer matches", null],
      ["a source answered without a body", r2Body()],
    ])("%s", async (_example, object) => {
      const { bucket, store } = setup();
      bucket.object = object;

      const result = await store.copyObject(source, KEY, { ifSourceEtagMatches: "etag-expected" });

      expect(result).toEqual(null);
      expect(bucket.calls).toEqual([["get", source, { onlyIf: { etagMatches: "etag-expected" } }]]);
    });

    it("a destination that already exists", async () => {
      const { bucket, store } = setup();
      bucket.object = r2Body({ body });
      bucket.written = null;

      expect(await store.copyObject(source, KEY, { ifDestinationAbsent: true })).toEqual(null);
    });
  });

  describe("delete", () => {
    it("a key", async () => {
      const { bucket, store } = setup();

      await store.delete(KEY);

      expect(bucket.calls).toEqual([["delete", KEY]]);
    });
  });

  describe("read", () => {
    it("an object", async () => {
      const { bucket, store } = setup();
      const body = new ReadableStream();
      bucket.object = r2Body({ body, httpMetadata: { contentType: "video/mp4" } });

      expect(await store.read(KEY)).toEqual({ body, contentType: "video/mp4", size: 3 });
    });

    it("a missing object", async () => {
      const { store } = setup();

      expect(await store.read(KEY)).toEqual(null);
    });

    it("an object without a body", async () => {
      const { bucket, store } = setup();
      bucket.object = r2Body();

      await expect(store.read(KEY)).rejects.toThrow(new TypeError("object body is unavailable"));
    });
  });

  describe("readRange", () => {
    it("a range", async () => {
      const { bucket, store } = setup();
      bucket.object = r2Body();

      expect(await store.readRange(KEY, 4, 3)).toEqual(new Uint8Array([1, 2, 3]));
      expect(bucket.calls).toEqual([["get", KEY, { range: { length: 3, offset: 4 } }]]);
    });

    it("a prefix", async () => {
      const { bucket, store } = setup();
      bucket.object = r2Body();

      await store.readPrefix(KEY, 256);

      expect(bucket.calls).toEqual([["get", KEY, { range: { length: 256, offset: 0 } }]]);
    });

    it("a missing object", async () => {
      const { store } = setup();

      expect(await store.readRange(KEY, 0, 1)).toEqual(null);
    });

    it("an invalid range", async () => {
      const { bucket, store } = setup();

      await expect(store.readRange(KEY, -1, 1)).rejects.toThrow("offset");
      expect(bucket.calls).toEqual([]);
    });
  });

  describe("createMultipartUpload", () => {
    it("a new upload driven to completion", async () => {
      const { bucket, store } = setup();

      const upload = await store.createMultipartUpload(KEY, "video/mp4");
      const part = await upload.uploadPart(1, new Uint8Array([9]));
      const completed = await upload.complete([part]);
      await upload.abort();

      expect(completed).toEqual({ ...written, etag: "etag-complete" });
      expect(bucket.calls).toEqual([
        ["createMultipartUpload", KEY, { httpMetadata: { contentType: "video/mp4" } }],
        ["uploadPart", "upload-new", 1, new Uint8Array([9])],
        ["complete", "upload-new", [{ etag: "part-1", partNumber: 1 }]],
        ["abort", "upload-new"],
      ]);
    });
  });

  describe("resumeMultipartUpload", () => {
    it("an existing upload", () => {
      const { bucket, store } = setup();

      const upload = store.resumeMultipartUpload(KEY, "native-upload-id");

      expect(upload.uploadId).toEqual("native-upload-id");
      expect(bucket.calls).toEqual([["resumeMultipartUpload", KEY, "native-upload-id"]]);
    });
  });
});

const credentials = {
  accessKeyId: "access-key",
  accountId: "account-id",
  bucket: "private-assets",
  now: () => NOW,
  secretAccessKey: "secret-key",
};
const request = {
  contentLength: 42,
  contentType: "video/mp4",
  expiresInSeconds: 900,
  key: KEY,
};

describe("R2SigV4Signer", () => {
  it("the account's default endpoint", async () => {
    const signer = new R2SigV4Signer(credentials);

    expect(await signer.signUpload({ ...request, key: "org one/asset/clip final.mp4" })).toEqual(
      "https://account-id.r2.cloudflarestorage.com/private-assets/org%20one/asset/clip%20final.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=02146461c49e3d6579f7718e2caacbc1424af5cada1ca7c8879f62f1d84abbc2&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost",
    );
  });

  it("a loopback endpoint", async () => {
    const signer = new R2SigV4Signer({ ...credentials, endpoint: "http://127.0.0.1:9000" });

    expect(await signer.signUpload(request)).toEqual(
      "http://127.0.0.1:9000/private-assets/org/asset/clip.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=98c931d31fc215e8d4c8203883916e4338a8ac61e9aa466be8404008d0f77e1f&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost",
    );
  });

  it("an unsafe account ID", () => {
    expect(() => new R2SigV4Signer({ ...credentials, accountId: "a/b" })).toThrow(
      new TypeError("accountId must be a non-empty path segment"),
    );
  });
});

const env = {
  R2_ACCESS_KEY_ID: "access-key",
  R2_ACCOUNT_ID: "account-id",
  R2_BUCKET_NAME: "private-assets",
  R2_SECRET_ACCESS_KEY: "secret-key",
};
const imagePath = { ...request, key: "org/asset/image.png" };

describe("createR2SignerFromEnv", () => {
  it.each(["local", "test"])(
    "a plain-http endpoint and path prefix in the %s environment",
    async (ENVIRONMENT) => {
      const signer = createR2SignerFromEnv(
        {
          ...env,
          ENVIRONMENT,
          R2_ENDPOINT: "http://172.18.0.1:8787",
          R2_ENDPOINT_PATH_PREFIX: "/cdn-cgi/local/r2/s3",
        },
        () => NOW,
      );

      expect(await signer.signUpload(imagePath)).toEqual(
        "http://172.18.0.1:8787/cdn-cgi/local/r2/s3/private-assets/org/asset/image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=31b7d5013add3a2d9d5ba67b01635710a1124cd68fcb7bd82e9d2cf8d7304f54&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost",
      );
    },
  );

  it("a path prefix without an endpoint", async () => {
    const signer = createR2SignerFromEnv(
      { ...env, R2_ENDPOINT_PATH_PREFIX: "/ignored" },
      () => NOW,
    );

    expect(await signer.signDownload({ expiresInSeconds: 900, key: KEY })).toEqual(
      "https://account-id.r2.cloudflarestorage.com/private-assets/org/asset/clip.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key%2F20260718%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260718T123456Z&X-Amz-Expires=900&X-Amz-Signature=01570b20e3568cfab55e063c6bce1c0f97f3b257f8a5a9ddede82ea928881bdd&X-Amz-SignedHeaders=host",
    );
  });

  it("a plain-http endpoint outside development", () => {
    expect(() =>
      createR2SignerFromEnv({ ...env, ENVIRONMENT: "staging", R2_ENDPOINT: "http://minio" }),
    ).toThrow("endpoint must use HTTPS");
  });

  it.each(["R2_ACCESS_KEY_ID", "R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_SECRET_ACCESS_KEY"] as const)(
    "no %s",
    (name) => {
      expect(() => createR2SignerFromEnv({ ...env, [name]: "" })).toThrow(
        new TypeError("R2 signing credentials are incomplete"),
      );
    },
  );
});
