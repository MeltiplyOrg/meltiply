import { describe, expect, it, vi } from "vite-plus/test";

import {
  createObjectStoreFromEnv,
  createObjectUrlSignerFromEnv,
  objectStorageBindings,
  objectStorageProvider,
  R2ObjectStore,
  R2SigV4Signer,
  S3ObjectStore,
  S3SigV4Signer,
  type R2BucketLike,
} from "../src";

/** Minimal R2 binding double; provider selection only checks it is present. */
const bucket: R2BucketLike = {
  createMultipartUpload: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  head: vi.fn(),
  put: vi.fn(),
  resumeMultipartUpload: vi.fn(),
};

const r2Env = {
  ASSETS: bucket,
  ENVIRONMENT: "staging",
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_ACCOUNT_ID: "r2-account",
  R2_BUCKET_NAME: "meltiply-assets",
  R2_SECRET_ACCESS_KEY: "r2-secret",
};

const s3Env = {
  ENVIRONMENT: "staging",
  OBJECT_STORAGE_PROVIDER: "s3",
  S3_ACCESS_KEY_ID: "s3-access-key",
  S3_BUCKET: "meltiply-assets",
  S3_ENDPOINT: "https://objects.example.com",
  S3_SECRET_ACCESS_KEY: "s3-secret",
};

describe("objectStorageProvider", () => {
  it("keeps R2 as the default so existing deployments are untouched", () => {
    expect(objectStorageProvider(r2Env)).toBe("r2");
    expect(objectStorageProvider({ ...r2Env, OBJECT_STORAGE_PROVIDER: "  " })).toBe("r2");
    expect(createObjectStoreFromEnv(r2Env)).toBeInstanceOf(R2ObjectStore);
    expect(createObjectUrlSignerFromEnv(r2Env)).toBeInstanceOf(R2SigV4Signer);
  });

  it("routes every construction through the selected provider", () => {
    expect(objectStorageProvider(s3Env)).toBe("s3");
    expect(createObjectStoreFromEnv(s3Env)).toBeInstanceOf(S3ObjectStore);
    expect(createObjectUrlSignerFromEnv(s3Env)).toBeInstanceOf(S3SigV4Signer);
    // An S3 deployment never touches the R2 binding, even when one is bound.
    expect(createObjectStoreFromEnv({ ...s3Env, ASSETS: bucket })).toBeInstanceOf(S3ObjectStore);
  });

  it("rejects an unknown provider instead of silently falling back", () => {
    expect(() => objectStorageProvider({ OBJECT_STORAGE_PROVIDER: "gcs" })).toThrow(
      "OBJECT_STORAGE_PROVIDER must be r2 or s3",
    );
    expect(() => createObjectStoreFromEnv({ OBJECT_STORAGE_PROVIDER: "gcs" })).toThrow(
      "OBJECT_STORAGE_PROVIDER must be r2 or s3",
    );
  });
});

describe("createObjectStoreFromEnv", () => {
  it("fails closed when the R2 binding is missing", () => {
    expect(() => createObjectStoreFromEnv({ ...r2Env, ASSETS: undefined })).toThrow(
      "ASSETS R2 binding is unavailable",
    );
  });

  it("reports incomplete S3 settings precisely", () => {
    expect(() => createObjectStoreFromEnv({ ...s3Env, S3_ENDPOINT: undefined })).toThrow(
      "S3 object storage requires S3_ACCESS_KEY_ID, S3_BUCKET, S3_ENDPOINT, and S3_SECRET_ACCESS_KEY",
    );
    expect(() => createObjectStoreFromEnv({ ...s3Env, S3_BUCKET: "  " })).toThrow(
      "S3 object storage requires",
    );
    expect(() => createObjectStoreFromEnv({ ...s3Env, S3_FORCE_PATH_STYLE: "maybe" })).toThrow(
      "S3_FORCE_PATH_STYLE must be true or false",
    );
  });

  it("derives the plain-HTTP allowance from ENVIRONMENT alone", () => {
    expect(() =>
      createObjectUrlSignerFromEnv({ ...s3Env, S3_ENDPOINT: "http://minio:9000" }),
    ).toThrow("HTTPS");
    expect(() =>
      createObjectUrlSignerFromEnv({
        ...s3Env,
        ENVIRONMENT: "local",
        S3_ENDPOINT: "http://minio:9000",
      }),
    ).not.toThrow();
  });
});

describe("objectStorageBindings", () => {
  const missing = (env: Parameters<typeof objectStorageBindings>[0]) =>
    objectStorageBindings(env)
      .filter((binding) => !binding.ready)
      .map((binding) => binding.name);

  it("describes the R2 bindings an existing deployment needs", () => {
    expect(objectStorageBindings(r2Env)).toEqual([
      { name: "ASSETS", ready: true },
      { name: "R2_ACCESS_KEY_ID", ready: true },
      { name: "R2_ACCOUNT_ID", ready: true },
      { name: "R2_BUCKET_NAME", ready: true },
      { name: "R2_SECRET_ACCESS_KEY", ready: true },
    ]);
    expect(missing({ ...r2Env, ASSETS: undefined })).toEqual(["ASSETS"]);
  });

  it("describes the S3 bindings instead of R2 ones when S3 is selected", () => {
    expect(objectStorageBindings(s3Env)).toEqual([
      { name: "S3_ACCESS_KEY_ID", ready: true },
      { name: "S3_BUCKET", ready: true },
      { name: "S3_ENDPOINT", ready: true },
      { name: "S3_FORCE_PATH_STYLE", ready: true },
      { name: "S3_SECRET_ACCESS_KEY", ready: true },
    ]);
    expect(missing({ ...s3Env, S3_SECRET_ACCESS_KEY: "" })).toEqual(["S3_SECRET_ACCESS_KEY"]);
  });

  /**
   * Readiness has to agree with construction: reporting a rejected endpoint as
   * ready would produce a green `/ready` probe over a deployment whose every
   * asset request fails.
   */
  it("reports settings the signer would reject as unavailable", () => {
    expect(missing({ ...s3Env, S3_ENDPOINT: "https://objects.example.com/prefix" })).toEqual([
      "S3_ENDPOINT",
    ]);
    expect(missing({ ...s3Env, S3_ENDPOINT: "http://objects.example.com" })).toEqual([
      "S3_ENDPOINT",
    ]);
    expect(missing({ ...s3Env, S3_FORCE_PATH_STYLE: "maybe" })).toEqual(["S3_FORCE_PATH_STYLE"]);
    // The same endpoint is acceptable in a development environment.
    expect(
      missing({
        ...s3Env,
        ENVIRONMENT: "local",
        S3_ENDPOINT: "http://objects.example.com",
      }),
    ).toEqual([]);
  });
});
