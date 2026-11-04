import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { readJsonFile, sha256, validateApprovalMetadata, writeEvidence } from "./release-guard.mjs";
import { validateReleaseSpec } from "./release-lib.mjs";

const scopes = { foundation: true, traffic: true, "queue-resume": true };
const [scope, inputPath, planPath, operator, confirmation, ...extra] = process.argv.slice(2);
if (!Object.hasOwn(scopes, scope ?? "") || !inputPath || !planPath || !operator || extra.length) {
  throw new Error(
    'Usage: bun run release:approve <foundation|traffic|queue-resume> <input.json> <reviewed.tfplan> <operator> "approve <environment> <git-sha> <plan-sha256>"',
  );
}
const spec = validateReleaseSpec(await readJsonFile(inputPath, "release input"));
const digest = sha256(await readFile(planPath));
if (confirmation !== `approve ${spec.environment} ${spec.git_sha} ${digest}`) {
  throw new Error(
    "Confirmation must identify the environment, exact release commit, and reviewed plan SHA-256",
  );
}
const outDir = path.resolve(process.env.MELTIPLY_RELEASE_DIR ?? ".release");
let session;
try {
  session = await readJsonFile(path.join(outDir, "approval-session.json"), "approval session");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  session = { git_sha: spec.git_sha, release_id: spec.release_id, id: randomUUID() };
  await writeEvidence(outDir, "approval-session.json", session);
}
if (session.git_sha !== spec.git_sha || session.release_id !== spec.release_id) {
  throw new Error("Use a fresh release directory for a different release");
}
// An operator attestation binds review intent to exact bytes, not an authenticated
// external identity. Filesystem permissions and deployment credentials remain the trust boundary.
const evidence = validateApprovalMetadata(
  {
    schema_version: 1,
    workflow_id: session.id,
    pipeline_sha: spec.git_sha,
    plan_digest: digest,
    approval_job: {
      id: randomUUID(),
      name: `${spec.environment}-${scope}-approval`,
      status: "success",
      approved_by: operator,
    },
  },
  spec,
);
await writeEvidence(outDir, `approval-${scope}.json`, evidence);
console.log(`Recorded ${scope} review for ${spec.release_id}; plan SHA-256 ${digest}`);
