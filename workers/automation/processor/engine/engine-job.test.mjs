import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ERRORS,
  EngineError,
  boundedInt,
  deadlineMsFor,
  parseJob,
  readConfig,
} from "./engine-job.mjs";

function validJobBody(overrides = {}) {
  return {
    asset_id: "asset-123",
    declared_content_type: "image/jpeg",
    expected_size: 4096,
    input_url: "https://storage.example.test/org/asset-123/original",
    job_id: "asset-media:org:asset-123:image_auto_4096_long_edge",
    maximum_output_bytes: 8192,
    output_url: "https://storage.example.test/staging/org/asset-123/out",
    profile: {
      allowed_content_types: ["image/jpeg", "image/png"],
      kind: "image",
      max_height: 4096,
      max_width: 4096,
      name: "image_auto_4096_long_edge",
    },
    ...overrides,
  };
}

describe("engine-job parseJob & deadlineMsFor", () => {
  it("accepts a valid job and returns a fresh object without mutating the parsed body", () => {
    const raw = validJobBody({
      deadline_seconds: 120,
      profile: {
        allowed_content_types: ["IMAGE/JPEG", "Image/Png"],
        kind: "image",
        max_height: 4096,
        max_width: 4096,
        name: "image_auto_4096_long_edge",
      },
    });
    const parsed = parseJob(raw);

    assert.notEqual(parsed, raw);
    assert.notEqual(parsed.profile, raw.profile);
    assert.deepEqual(parsed.profile.allowed_content_types, ["image/jpeg", "image/png"]);
    assert.deepEqual(raw.profile.allowed_content_types, ["IMAGE/JPEG", "Image/Png"]);
  });

  it("validates deadline_seconds strictly inside [5, 540] when present", () => {
    for (const valid of [undefined, null, 5, 60, 540]) {
      const body = validJobBody(valid === undefined ? {} : { deadline_seconds: valid });
      assert.doesNotThrow(() => parseJob(body));
    }

    for (const invalid of ["60", true, Number.NaN, Number.POSITIVE_INFINITY, 0, 4.9, 540.1, -10]) {
      assert.throws(
        () => parseJob(validJobBody({ deadline_seconds: invalid })),
        (error) => error instanceof EngineError && error.code === "invalid_request",
      );
    }
  });

  it("clamps deadlineMsFor to [5000, limits.jobTimeoutMs] and defaults when absent", () => {
    assert.equal(deadlineMsFor({}, { jobTimeoutMs: 300_000 }), 300_000);
    assert.equal(deadlineMsFor({ deadline_seconds: null }, { jobTimeoutMs: 300_000 }), 300_000);
    assert.equal(deadlineMsFor({ deadline_seconds: 90 }, { jobTimeoutMs: 300_000 }), 90_000);
    assert.equal(deadlineMsFor({ deadline_seconds: 540 }, { jobTimeoutMs: 300_000 }), 300_000);
    assert.equal(deadlineMsFor({ deadline_seconds: 1 }, { jobTimeoutMs: 300_000 }), 5_000);
  });

  it("includes retryable input_unavailable in ERRORS taxonomy", () => {
    assert.deepEqual(ERRORS.input_unavailable, { retryable: true, status: 502 });
  });

  it("validates readConfig token requirement and boundedInt bounds", () => {
    assert.throws(() => readConfig({}), /PROCESSOR_JOB_TOKEN/);
    assert.throws(() => readConfig({ PROCESSOR_JOB_TOKEN: "short" }), /PROCESSOR_JOB_TOKEN/);
    const cfg = readConfig({
      PROCESSOR_JOB_TOKEN: "0123456789abcdef",
      PROCESSOR_JOB_TIMEOUT_MS: "120000",
    });
    assert.equal(cfg.jobTimeoutMs, 120_000);
    assert.equal(boundedInt("99999999", 42, 1, 100), 42);
    assert.equal(boundedInt("50", 42, 1, 100), 50);
  });
});
