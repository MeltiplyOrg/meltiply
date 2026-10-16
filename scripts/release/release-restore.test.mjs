import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createRestorePoint,
  parseCreateSnapshotResponse,
  parseEndpointResponse,
} from "./release-restore.mjs";

const projectId = "project-staging-123";
const branchId = "branch-staging-123";
const snapshotId = "snapshot-release-123";
const operationId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-07-22T12:00:00.000Z";
const expiresAt = "2026-08-05T12:00:00.000Z";
const gitSha = "a".repeat(40);
const endpointHost = "ep-staging.us-east-2.aws.neon.tech";
const endpointId = "ep-staging-123";
const spec = {
  git_sha: gitSha,
  neon_branch_id: branchId,
  neon_project_id: projectId,
  release_id: "staging-20260722-a1b2c3d4",
  restore_point_expires_at: expiresAt,
};
const environment = {
  MELTIPLY_NEON_BRANCH_ID: branchId,
  MELTIPLY_NEON_PROJECT_ID: projectId,
  MELTIPLY_SYSTEM_DATABASE_URL:
    "postgresql://system:secret@ep-staging-pooler.us-east-2.aws.neon.tech/meltiply?sslmode=require",
  NEON_API_KEY: "fixture-token-0000000000",
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function endpointResponse() {
  return jsonResponse({
    endpoints: [
      {
        branch_id: branchId,
        disabled: false,
        host: endpointHost,
        id: endpointId,
        project_id: projectId,
      },
    ],
  });
}

function snapshot() {
  return {
    created_at: createdAt,
    expires_at: expiresAt.replace(".000Z", "Z"),
    id: snapshotId,
    name: `meltiply-${spec.release_id}`,
    source_branch_id: branchId,
  };
}

function operation(status) {
  return {
    action: "create_timeline",
    created_at: createdAt,
    failures_count: 0,
    id: operationId,
    project_id: projectId,
    status,
    total_duration_ms: status === "finished" ? 10 : 0,
    updated_at: createdAt,
  };
}

test("primary Neon create-snapshot fixture matches the official envelope", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/neon-create-snapshot-response.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    parseCreateSnapshotResponse(fixture, {
      branchId,
      name: snapshot().name,
      projectId,
    }).snapshot.id,
    snapshotId,
  );
});

test("Neon endpoint proof accepts only the reviewed branch database host", () => {
  assert.equal(
    parseEndpointResponse(
      {
        endpoints: [
          {
            branch_id: branchId,
            disabled: false,
            host: endpointHost,
            id: endpointId,
            project_id: projectId,
          },
        ],
      },
      { branchId, environment, projectId },
    ).id,
    endpointId,
  );
});

test("restore point creates one named Neon snapshot and waits for completion", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "release-restore-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  const requests = [];
  let operationPolls = 0;
  const evidence = await createRestorePoint({
    approvals: [],
    environment,
    fetchImpl: async (url, options) => {
      requests.push({ method: options.method, url: String(url) });
      if (String(url).endsWith("/endpoints")) {
        return jsonResponse({
          endpoints: [
            {
              branch_id: branchId,
              disabled: false,
              host: endpointHost,
              id: endpointId,
              project_id: projectId,
            },
          ],
        });
      }
      if (String(url).endsWith("/snapshots")) {
        return jsonResponse({ snapshots: [] });
      }
      if (options.method === "POST") {
        assert.equal(new URL(url).searchParams.get("name"), snapshot().name);
        return jsonResponse({
          operations: [operation("running")],
          snapshot: snapshot(),
        });
      }
      operationPolls += 1;
      return jsonResponse({
        operation: operation("finished"),
      });
    },
    now: () => Date.parse(createdAt),
    outDir,
    pause: async () => {},
    planDigest: "b".repeat(64),
    spec,
  });
  assert.equal(operationPolls, 1);
  assert.equal(evidence.snapshot_id, snapshotId);
  assert.equal(evidence.status, "ready");
  assert.doesNotMatch(JSON.stringify(evidence), /NEON_API_KEY|neon-api-key/);
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
});

test("restore point rejects a remote snapshot without completed local evidence", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "release-restore-retry-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  await assert.rejects(
    createRestorePoint({
      approvals: [],
      environment,
      fetchImpl: async (url) =>
        String(url).endsWith("/endpoints")
          ? endpointResponse()
          : jsonResponse({ snapshots: [snapshot()] }),
      now: () => Date.parse(createdAt),
      outDir,
      planDigest: "b".repeat(64),
      spec,
    }),
    /exists without completed local evidence/,
  );
});

test("restore point fails closed on ambiguous snapshots", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "release-restore-duplicate-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  await assert.rejects(
    createRestorePoint({
      approvals: [],
      environment,
      fetchImpl: async (url) =>
        String(url).endsWith("/endpoints")
          ? endpointResponse()
          : jsonResponse({
              snapshots: [snapshot(), { ...snapshot(), id: "snapshot-release-456" }],
            }),
      now: () => Date.parse(createdAt),
      outDir,
      planDigest: "b".repeat(64),
      spec,
    }),
    /duplicate release snapshots/,
  );
});
