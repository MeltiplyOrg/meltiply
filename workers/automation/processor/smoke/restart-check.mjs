import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2];
const directory = process.env.FIXTURE_DIR;
const origin = process.env.BASE_URL;
const objects = process.env.FIXTURE_URL;
const token = process.env.PROCESSOR_JOB_TOKEN;
assert.ok(directory && origin && objects && token);
const checkpoint = join(directory, "restart-checkpoint.json");

async function processJob(job) {
  const response = await fetch(`${origin}/process`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(job),
    signal: AbortSignal.timeout(90_000),
  });
  return { status: response.status, body: await response.json() };
}
if (mode === "prepare") {
  const input = await readFile(join(directory, "objects", "photo-opaque.png"));
  const job = {
    asset_id: "00000000-0000-4000-8000-000000000001",
    declared_content_type: "image/png",
    expected_size: input.byteLength,
    expected_checksum: createHash("sha256").update(input).digest("hex"),
    input_url: `${objects}/objects/photo-opaque.png`,
    output_url: `${objects}/objects/restart-rendition`,
    job_id: "restart-image",
    maximum_output_bytes: 32 * 1024 * 1024,
    profile: {
      name: "restart_image",
      kind: "image",
      max_width: 1280,
      max_height: 1280,
      max_duration_seconds: null,
      allowed_content_types: ["image/webp"],
      quality: 82,
      effort: 4,
    },
  };
  const result = await processJob(job);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.result, "optimized");
  const output = await readFile(join(directory, "objects", "restart-rendition"));
  assert.equal(createHash("sha256").update(output).digest("hex"), result.body.output.sha256);
  await writeFile(
    checkpoint,
    JSON.stringify({ job, sha256: result.body.output.sha256, bytes: output.byteLength }),
  );
  console.log("Prepared real optimized bytes before engine restart");
} else if (mode === "verify") {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2_000) }).catch(
      () => null,
    );
    if (health?.ok) break;
    if (Date.now() >= deadline) throw new Error("Restarted engine did not become ready");
    await delay(250);
  }
  const saved = JSON.parse(await readFile(checkpoint, "utf8"));
  const refused = await processJob(saved.job);
  assert.equal(refused.status, 412, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "output_exists");
  assert.equal(refused.body.output, undefined);
  const retained = await readFile(join(directory, "objects", "restart-rendition"));
  assert.equal(createHash("sha256").update(retained).digest("hex"), saved.sha256);
  const cleared = await fetch(saved.job.output_url, { method: "DELETE" });
  assert.equal(cleared.status, 204);
  const recreated = await processJob(saved.job);
  assert.equal(recreated.status, 200, JSON.stringify(recreated.body));
  assert.equal(recreated.body.output.sha256, saved.sha256);
  assert.equal(recreated.body.output.bytes, saved.bytes);
  const actual = await readFile(join(directory, "objects", "restart-rendition"));
  assert.equal(createHash("sha256").update(actual).digest("hex"), saved.sha256);
  console.log(
    `RESTART_REPLAY ${JSON.stringify({ verified: true, recreated_bytes: actual.byteLength, cache_required: false })}`,
  );
} else {
  throw new TypeError("Expected prepare or verify mode");
}
