import { describe, expect, it } from "vite-plus/test";

import {
  createObjectStoreFromEnv,
  createObjectUrlSignerFromEnv,
  objectStorageBindings,
  objectStorageProvider,
  type ObjectStorageEnv,
} from "../src/provider";
import { R2ObjectStore, R2SigV4Signer } from "../src/r2";
import { S3ObjectStore, S3SigV4Signer } from "../src/s3";
import { FakeR2Bucket } from "./fake-r2-bucket";

const r2Env = {
  ASSETS: new FakeR2Bucket(),
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

const unready = (env: ObjectStorageEnv) =>
  objectStorageBindings(env)
    .filter((binding) => !binding.ready)
    .map((binding) => binding.name);

const INCOMPLETE =
  "S3 object storage requires S3_ACCESS_KEY_ID, S3_BUCKET, S3_ENDPOINT, and S3_SECRET_ACCESS_KEY";

describe("objectStorageProvider", () => {
  it.each([
    ["no provider", undefined, "r2"],
    ["a blank provider", "  ", "r2"],
    ["R2", "r2", "r2"],
    ["padded S3", " s3 ", "s3"],
  ])("%s", (_example, OBJECT_STORAGE_PROVIDER, provider) => {
    expect(objectStorageProvider({ OBJECT_STORAGE_PROVIDER })).toEqual(provider);
  });

  it("an unknown provider", () => {
    expect(() => objectStorageProvider({ OBJECT_STORAGE_PROVIDER: "gcs" })).toThrow(
      new TypeError("OBJECT_STORAGE_PROVIDER must be r2 or s3"),
    );
  });
});

describe("createObjectStoreFromEnv", () => {
  it.each([
    ["the R2 environment", r2Env, R2ObjectStore],
    ["the S3 environment", s3Env, S3ObjectStore],
    ["S3 selected beside an R2 binding", { ...s3Env, ASSETS: r2Env.ASSETS }, S3ObjectStore],
  ])("%s", (_example, env, Store) => {
    expect(createObjectStoreFromEnv(env)).toBeInstanceOf(Store);
  });

  it("R2 without its binding", () => {
    expect(() => createObjectStoreFromEnv({ ...r2Env, ASSETS: undefined })).toThrow(
      new TypeError("the ASSETS R2 binding is unavailable"),
    );
  });

  it.each(["S3_ACCESS_KEY_ID", "S3_BUCKET", "S3_ENDPOINT", "S3_SECRET_ACCESS_KEY"] as const)(
    "S3 with a blank %s",
    (name) => {
      expect(() => createObjectStoreFromEnv({ ...s3Env, [name]: "  " })).toThrow(
        new TypeError(INCOMPLETE),
      );
    },
  );

  it.each([
    [
      "a path-style flag that is not a boolean",
      { S3_FORCE_PATH_STYLE: "maybe" },
      "S3_FORCE_PATH_STYLE must be true or false",
    ],
    [
      "a region with a slash",
      { S3_REGION: "us/east-1" },
      "S3_REGION must contain only lowercase letters, digits, and hyphens",
    ],
    ["a region with a space", { S3_REGION: "us east-1" }, "S3_REGION must contain only"],
    ["a region in capitals", { S3_REGION: "US-EAST-1" }, "S3_REGION must contain only"],
    ["a plain-http endpoint", { S3_ENDPOINT: "http://minio:9000" }, "S3 endpoint must use HTTPS"],
    [
      "an endpoint with a path",
      { S3_ENDPOINT: "https://objects.example.com/prefix" },
      "must not include",
    ],
  ])("S3 with %s", (_example, override, message) => {
    expect(() => createObjectStoreFromEnv({ ...s3Env, ...override })).toThrow(message);
  });
});

describe("createObjectUrlSignerFromEnv", () => {
  it.each([
    ["the R2 environment", r2Env, R2SigV4Signer],
    ["the S3 environment", s3Env, S3SigV4Signer],
  ])("%s", (_example, env, Signer) => {
    expect(createObjectUrlSignerFromEnv(env)).toBeInstanceOf(Signer);
  });

  it("a malformed S3 region", () => {
    expect(() => createObjectUrlSignerFromEnv({ ...s3Env, S3_REGION: "us/east-1" })).toThrow(
      "S3_REGION must contain only lowercase letters, digits, and hyphens",
    );
  });

  it.each(["local", "test"])("a plain-http S3 endpoint in the %s environment", (ENVIRONMENT) => {
    const env = { ...s3Env, ENVIRONMENT, S3_ENDPOINT: "http://minio:9000" };

    expect(() => createObjectUrlSignerFromEnv(env)).not.toThrow();
  });

  it.each([
    ["no region", undefined, "us-east-1", "true", "https://objects.example.com/meltiply-assets/k"],
    [
      "a padded region",
      " eu-west-1 ",
      "eu-west-1",
      " TRUE ",
      "https://objects.example.com/meltiply-assets/k",
    ],
    [
      "a blank region and path style off",
      "  ",
      "us-east-1",
      "False",
      "https://meltiply-assets.objects.example.com/k",
    ],
  ])("%s", async (_example, S3_REGION, region, S3_FORCE_PATH_STYLE, object) => {
    const signer = createObjectUrlSignerFromEnv(
      { ...s3Env, S3_REGION, S3_FORCE_PATH_STYLE },
      () => new Date("2026-07-18T12:34:56Z"),
    );

    const url = new URL(await signer.signDownload({ key: "k", expiresInSeconds: 60 }));

    expect([`${url.origin}${url.pathname}`, url.searchParams.get("X-Amz-Credential")]).toEqual([
      object,
      `s3-access-key/20260718/${region}/s3/aws4_request`,
    ]);
  });
});

describe("objectStorageBindings", () => {
  it("a complete R2 environment", () => {
    expect(objectStorageBindings(r2Env)).toEqual(
      ["ASSETS", "R2_ACCESS_KEY_ID", "R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_SECRET_ACCESS_KEY"].map(
        (name) => ({ name, ready: true }),
      ),
    );
  });

  it("a complete S3 environment", () => {
    expect(objectStorageBindings(s3Env)).toEqual(
      [
        "S3_ACCESS_KEY_ID",
        "S3_BUCKET",
        "S3_ENDPOINT",
        "S3_FORCE_PATH_STYLE",
        "S3_REGION",
        "S3_SECRET_ACCESS_KEY",
      ].map((name) => ({ name, ready: true })),
    );
  });

  it("an empty R2 environment", () => {
    expect(unready({})).toEqual([
      "ASSETS",
      "R2_ACCESS_KEY_ID",
      "R2_ACCOUNT_ID",
      "R2_BUCKET_NAME",
      "R2_SECRET_ACCESS_KEY",
    ]);
  });

  it.each([
    ["no access key", { S3_ACCESS_KEY_ID: " " }, ["S3_ACCESS_KEY_ID"]],
    ["no bucket", { S3_BUCKET: undefined }, ["S3_BUCKET"]],
    ["no endpoint", { S3_ENDPOINT: undefined }, ["S3_ENDPOINT"]],
    ["no secret", { S3_SECRET_ACCESS_KEY: "" }, ["S3_SECRET_ACCESS_KEY"]],
    [
      "an endpoint with a path",
      { S3_ENDPOINT: "https://objects.example.com/prefix" },
      ["S3_ENDPOINT"],
    ],
    [
      "a remote plain-http endpoint",
      { S3_ENDPOINT: "http://objects.example.com" },
      ["S3_ENDPOINT"],
    ],
    [
      "that endpoint in local",
      { ENVIRONMENT: "local", S3_ENDPOINT: "http://objects.example.com" },
      [],
    ],
    ["a bad path-style flag", { S3_FORCE_PATH_STYLE: "maybe" }, ["S3_FORCE_PATH_STYLE"]],
    ["a bad region", { S3_REGION: "US" }, ["S3_REGION"]],
  ])("S3 with %s", (_example, override, names) => {
    expect(unready({ ...s3Env, ...override })).toEqual(names);
  });
});
