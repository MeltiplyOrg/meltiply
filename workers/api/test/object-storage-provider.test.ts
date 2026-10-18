import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { bindingStatuses } from "../src/env";
import type { ApiWorkerEnv } from "../src/env";
import { createStorageServiceLiveFromEnv } from "../src/effect/services/storage";
import { StorageService } from "@meltiply/storage";

const r2Env = {
  ALLOWED_ORIGINS: "https://app.example.test",
  ASSETS: {} as R2Bucket,
  DB_AUTHENTICATED: {} as Hyperdrive,
  DB_SYSTEM: {} as Hyperdrive,
  ENVIRONMENT: "test",
  FRONTEND_URL: "https://app.example.test",
  OAUTH_STATE: {} as DurableObjectNamespace<never>,
  PUBLIC_API_URL: "https://app.example.test",
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_ACCOUNT_ID: "r2-account",
  R2_BUCKET_NAME: "meltiply-assets",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  TOKEN_ENCRYPTION_KEY: "token-key",
  VERSION: "test",
} as unknown as ApiWorkerEnv;

const s3Env = {
  ...r2Env,
  ASSETS: undefined,
  OBJECT_STORAGE_PROVIDER: "s3",
  S3_ACCESS_KEY_ID: "s3-access-key",
  S3_BUCKET: "meltiply-assets",
  S3_ENDPOINT: "https://objects.example.test",
  S3_SECRET_ACCESS_KEY: "s3-secret",
} as unknown as ApiWorkerEnv;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Names of the components a readiness probe reports as unavailable. */
function unavailable(env: ApiWorkerEnv): string[] {
  return bindingStatuses(env)
    .filter((component) => component.status === "unavailable")
    .map((component) => component.name);
}

describe("object storage readiness", () => {
  it("keeps reporting R2 bindings by default", () => {
    expect(unavailable(r2Env)).toEqual([]);
    expect(bindingStatuses(r2Env).map((component) => component.name)).toEqual(
      expect.arrayContaining(["ASSETS", "R2_BUCKET_NAME", "R2_SECRET_ACCESS_KEY"]),
    );
  });

  it("reports the S3 bindings an operator actually has to configure", () => {
    expect(unavailable(s3Env)).toEqual([]);
    expect(bindingStatuses(s3Env).map((component) => component.name)).toEqual(
      expect.arrayContaining(["S3_BUCKET", "S3_ENDPOINT", "S3_SECRET_ACCESS_KEY"]),
    );
    // An S3 deployment has no R2 bucket binding; reporting one would send an
    // operator chasing a setting that does not apply to them.
    expect(unavailable(s3Env)).not.toContain("ASSETS");
    expect(unavailable({ ...s3Env, S3_ENDPOINT: "" })).toContain("S3_ENDPOINT");
  });

  it("names the provider itself when it cannot be parsed", () => {
    expect(unavailable({ ...s3Env, OBJECT_STORAGE_PROVIDER: "gcs" })).toContain(
      "OBJECT_STORAGE_PROVIDER",
    );
  });
});

describe("API storage layer", () => {
  it("signs browser uploads against the configured S3 origin", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          headers: { "content-length": "512", "content-type": "video/mp4", etag: '"etag-1"' },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

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
    expect(upload.origin).toBe("https://objects.example.test");
    expect(upload.pathname).toBe("/meltiply-assets/org-1/asset-1/original");
    expect(result.upload).not.toContain("s3-secret");
    expect(result.metadata?.etag).toBe("etag-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://objects.example.test/meltiply-assets/org-1/asset-1/original",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("keeps signing and object access independently unavailable when unconfigured", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* StorageService;
        yield* storage.head("org-1/asset-1/original");
      }).pipe(
        Effect.provide(createStorageServiceLiveFromEnv({ ...s3Env, S3_SECRET_ACCESS_KEY: "" })),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      // The operator gets the configuration diagnosis, never a transport error
      // from an origin that was never configured.
      expect(String(exit.cause)).toContain("Asset storage is unavailable.");
      expect(String(exit.cause)).not.toContain("S3 object storage requires");
    }
  });
});
