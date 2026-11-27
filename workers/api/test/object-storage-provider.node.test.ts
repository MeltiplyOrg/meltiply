import { StorageService } from "@meltiply/storage";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createStorageServiceLiveFromEnv } from "../src/effect/services/storage";
import { bindingStatuses, type ApiWorkerEnv } from "../src/env";
import { fakeEnv, fakeOAuthStateNamespace, fakeR2Bucket } from "../test-support/fakes";

const r2Env = fakeEnv({
  ALLOWED_ORIGINS: "https://app.example.test",
  APP_URL: "https://app.example.test",
  ASSETS: fakeR2Bucket({}),
  DB_AUTHENTICATED: {} as Hyperdrive,
  DB_SYSTEM: {} as Hyperdrive,
  OAUTH_STATE: fakeOAuthStateNamespace({}),
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_ACCOUNT_ID: "r2-account",
  R2_BUCKET_NAME: "meltiply-assets",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  TOKEN_ENCRYPTION_KEY: "token-key",
});

const s3Env = fakeEnv({
  ...r2Env,
  ASSETS: undefined,
  OBJECT_STORAGE_PROVIDER: "s3",
  S3_ACCESS_KEY_ID: "s3-access-key",
  S3_BUCKET: "meltiply-assets",
  S3_ENDPOINT: "https://objects.example.test",
  S3_SECRET_ACCESS_KEY: "s3-secret",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function unavailable(env: ApiWorkerEnv): string[] {
  return bindingStatuses(env)
    .filter((component) => component.status === "unavailable")
    .map((component) => component.name);
}

describe("object storage readiness", () => {
  it("reports R2 bindings ready when configured", () => {
    expect(unavailable(r2Env)).toEqual([]);
    expect(bindingStatuses(r2Env).map((component) => component.name)).toEqual(
      expect.arrayContaining(["ASSETS", "R2_BUCKET_NAME", "R2_SECRET_ACCESS_KEY"]),
    );
  });

  it("reports S3 bindings ready without requiring ASSETS", () => {
    expect(unavailable(s3Env)).toEqual([]);
    expect(bindingStatuses(s3Env).map((component) => component.name)).toEqual(
      expect.arrayContaining(["S3_BUCKET", "S3_ENDPOINT", "S3_SECRET_ACCESS_KEY"]),
    );
  });

  it("marks S3_ENDPOINT unavailable when blank", () => {
    expect(unavailable({ ...s3Env, S3_ENDPOINT: "" })).toContain("S3_ENDPOINT");
  });

  it("marks OBJECT_STORAGE_PROVIDER unavailable when unknown", () => {
    expect(unavailable({ ...s3Env, OBJECT_STORAGE_PROVIDER: "gcs" })).toContain(
      "OBJECT_STORAGE_PROVIDER",
    );
  });
});

describe("createStorageServiceLiveFromEnv", () => {
  it("heads and signs uploads against the configured S3 origin", async () => {
    const requests: Array<{ method: string | undefined; url: string }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ method: init?.method, url: String(input) });
      return new Response(null, {
        headers: { "content-length": "512", "content-type": "video/mp4", etag: '"etag-1"' },
      });
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        return {
          metadata: yield* storage.head("org-1/asset-1/original"),
          upload: yield* storage.signUpload({
            contentLength: 512,
            contentType: "video/mp4",
            expiresInSeconds: 900,
            key: "org-1/asset-1/original",
          }),
        };
      }).pipe(Effect.provide(createStorageServiceLiveFromEnv(s3Env))),
    );

    const upload = new URL(result.upload);
    expect(upload.origin).toEqual("https://objects.example.test");
    expect(upload.pathname).toEqual("/meltiply-assets/org-1/asset-1/original");
    expect(result.upload).not.toContain("s3-secret");
    expect(result.metadata?.etag).toEqual("etag-1");
    expect(requests).toEqual([
      {
        method: "HEAD",
        url: "https://objects.example.test/meltiply-assets/org-1/asset-1/original",
      },
    ]);
  });

  it("fails with sanitized unavailable error when S3 credentials are incomplete", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const storage = yield* StorageService;
          return yield* storage.head("org-1/asset-1/original");
        }).pipe(
          Effect.provide(createStorageServiceLiveFromEnv({ ...s3Env, S3_SECRET_ACCESS_KEY: "" })),
        ),
      ),
    );

    expect(error.message).toEqual("Asset storage is unavailable.");
  });
});
