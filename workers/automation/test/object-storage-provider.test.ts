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

describe("processor job capabilities", () => {
  it("mints the R2 capabilities the default provider implies", async () => {
    const urls = await Effect.runPromise(processorJobUrlsEffect(r2Env, request));

    expect(new URL(urls.input_url).origin).toBe("https://r2-account.r2.cloudflarestorage.com");
    expect(new URL(urls.input_url).searchParams.get("X-Amz-Credential")).toContain("/auto/s3/");
    expect(new URL(urls.output_url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "host;if-none-match",
    );
  });

  /**
   * Media processing runs in a container that only ever receives object-scoped
   * URLs, never bucket credentials. Switching to an S3-compatible origin must
   * therefore keep working: the same two capabilities are minted, against the
   * configured origin, with the output grant still create-only and still
   * bounded by the persisted write hold.
   */
  it("mints the same capabilities against an S3-compatible origin", async () => {
    const urls = await Effect.runPromise(processorJobUrlsEffect(s3Env, request));

    const input = new URL(urls.input_url);
    expect(input.origin).toBe("https://objects.example.test");
    expect(input.pathname).toBe("/meltiply-assets/org-1/asset-1/original");
    expect(input.searchParams.get("X-Amz-Credential")).toContain("/us-east-1/s3/");

    const output = new URL(urls.output_url);
    expect(output.pathname).toBe(
      "/meltiply-assets/staging/org-1/asset-1/session-1/processing-image_auto_4096_long_edge",
    );
    // The output grant stays create-only, so a retry cannot overwrite bytes an
    // earlier attempt already committed.
    expect(output.searchParams.get("X-Amz-SignedHeaders")).toBe("host;if-none-match");
    expect(Number(output.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(120);
    expect(urls.output_url).not.toContain("s3-secret");
  });

  it("fails retryably when the provider cannot sign", async () => {
    const exit = await Effect.runPromiseExit(
      processorJobUrlsEffect({ ...s3Env, S3_SECRET_ACCESS_KEY: undefined }, request),
    );

    expect(exit._tag).toBe("Failure");
  });
});
