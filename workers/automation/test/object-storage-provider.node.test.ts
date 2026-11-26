import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import { processorJobUrlsEffect } from "../src/native-processor";

const r2Env = {
  ASSETS: {} as R2Bucket,
  ENVIRONMENT: "test",
  R2_ACCESS_KEY_ID: "r2-access-key",
  R2_ACCOUNT_ID: "r2-account",
  R2_BUCKET_NAME: "meltiply-assets",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  VERSION: "automation-test",
} satisfies AutomationEnv;

const s3Env = {
  ENVIRONMENT: "test",
  OBJECT_STORAGE_PROVIDER: "s3",
  S3_ACCESS_KEY_ID: "s3-access-key",
  S3_BUCKET: "meltiply-assets",
  S3_ENDPOINT: "https://objects.example.test",
  S3_SECRET_ACCESS_KEY: "s3-secret",
  VERSION: "automation-test",
} satisfies AutomationEnv;

const request = {
  inputKey: "org-1/asset-1/original",
  outputExpiresAt: new Date(Date.now() + 120_000),
  outputKey: "staging/org-1/asset-1/session-1/processing-image_auto_4096_long_edge",
};

describe("processorJobUrlsEffect", () => {
  it("mints R2 capabilities when default R2 provider is configured", async () => {
    const urls = await Effect.runPromise(processorJobUrlsEffect(r2Env, request));

    expect(new URL(urls.input_url).origin).toEqual("https://r2-account.r2.cloudflarestorage.com");
    expect(new URL(urls.input_url).searchParams.get("X-Amz-Credential")).toContain("/auto/s3/");
    expect(new URL(urls.output_url).searchParams.get("X-Amz-SignedHeaders")).toEqual(
      "host;if-none-match",
    );
  });

  it("mints S3 capabilities without leaking credentials", async () => {
    const urls = await Effect.runPromise(processorJobUrlsEffect(s3Env, request));

    const input = new URL(urls.input_url);
    expect(input.origin).toEqual("https://objects.example.test");
    expect(input.pathname).toEqual("/meltiply-assets/org-1/asset-1/original");
    expect(input.searchParams.get("X-Amz-Credential")).toContain("/us-east-1/s3/");

    const output = new URL(urls.output_url);
    expect(output.pathname).toEqual(
      "/meltiply-assets/staging/org-1/asset-1/session-1/processing-image_auto_4096_long_edge",
    );
    expect(output.searchParams.get("X-Amz-SignedHeaders")).toEqual("host;if-none-match");
    const outputExpiry = Number(output.searchParams.get("X-Amz-Expires"));
    expect(outputExpiry).toBeGreaterThan(100);
    expect(outputExpiry).toBeLessThanOrEqual(120);
    expect(urls.output_url).not.toContain("s3-secret");
  });

  it("fails when S3 signing credentials are incomplete", async () => {
    const exit = await Effect.runPromiseExit(
      processorJobUrlsEffect({ ...s3Env, S3_SECRET_ACCESS_KEY: undefined }, request),
    );

    expect(exit._tag).toEqual("Failure");
  });
});
