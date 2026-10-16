import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  parseR2AcceptanceArguments,
  prepareR2AcceptanceOptions,
  r2AcceptanceInternals,
  runR2Acceptance,
  uploadSignedPart,
  verifySignedPutCors,
} from "./r2-acceptance.mjs";
import {
  releaseInternals,
  validateIacOutputs,
  validateReleaseSpec,
} from "../release/release-lib.mjs";

const gitSha = "a".repeat(40);
const accountId = "b".repeat(32);
const apiOrigin = "https://api.staging.example.com";
const browserOrigin = "https://staging.example.com";
const r2Origin = `https://${accountId}.r2.cloudflarestorage.com`;
const bucketName = "meltiply-assets-staging";
const bearerToken = "staging-secret-token";
const acceptanceUserId = "00000000-0000-4000-8000-000000000901";
const acceptanceOrganizationId = "00000000-0000-4000-8000-000000000902";
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function environment(overrides = {}) {
  return {
    MELTIPLY_STAGING_ACCEPTANCE_ORG_ID: acceptanceOrganizationId,
    MELTIPLY_STAGING_ACCEPTANCE_USER_ID: acceptanceUserId,
    MELTIPLY_STAGING_BEARER_TOKEN: bearerToken,
    ...overrides,
  };
}

function releaseInput(overrides = {}) {
  return {
    api_base_url: apiOrigin,
    api_workers_dev_url: "https://meltiply-api.example.workers.dev",
    automation_guard: { consumers_paused: true, cron_safe: true },
    deployment_mode: "update",
    environment: "staging",
    frontend_origins: [browserOrigin],
    frontend_url: browserOrigin,
    git_sha: gitSha,
    neon_branch_id: "branch-staging-123",
    neon_project_id: "project-staging-123",
    provider_acceptance: {
      facebook: false,
      instagram: false,
      instagram_engagement: false,
      threads: false,
      threads_engagement: false,
      tiktok: false,
      youtube: false,
    },
    release_id: `staging-${gitSha.slice(0, 12)}`,
    restore_point_expires_at: "2026-08-05T12:00:00.000Z",
    runtime: {
      mail_from_address: "auth@staging.example.com",
      mail_from_name: "Meltiply",
      r2_account_id: accountId,
    },
    schema_version: 1,
    ...overrides,
  };
}

function queueNames() {
  return Object.fromEntries(
    Object.keys(releaseInternals.queueBindings).map((workload) => [
      workload,
      `meltiply-${workload}-staging`,
    ]),
  );
}

function iacOutput(resourceOverrides = {}) {
  const queues = queueNames();
  const resources = {
    api_custom_domains_attached: true,
    api_hostname: new URL(apiOrigin).hostname,
    assets_bucket_name: bucketName,
    authenticated_hyperdrive_id: "1".repeat(32),
    dead_letter_queue_ids: {},
    dead_letter_queue_names: {},
    environment: "staging",
    operator_access_aud: null,
    operator_hostname: null,
    queue_consumers_attached: true,
    queue_delivery_paused: false,
    queue_names: queues,
    system_hyperdrive_id: "2".repeat(32),
    ...resourceOverrides,
  };
  return {
    release_resources: {
      sensitive: false,
      type: ["object", {}],
      value: resources,
    },
    worker_bindings: {
      sensitive: false,
      type: ["object", {}],
      value: {
        ACCESS_POLICY_AUD: null,
        ACCESS_TEAM_DOMAIN: null,
        ASSETS: resources.assets_bucket_name,
        DB_AUTHENTICATED: resources.authenticated_hyperdrive_id,
        DB_SYSTEM: resources.system_hyperdrive_id,
        OPERATOR_HOSTNAME: null,
        queues,
      },
    },
  };
}

function releaseInputs(resourceOverrides = {}) {
  const spec = validateReleaseSpec(releaseInput());
  return {
    iac: validateIacOutputs(iacOutput(resourceOverrides), spec),
    spec,
  };
}

function parsedArguments(overrides = {}) {
  return {
    apply: true,
    confirm: `r2 staging ${gitSha}`,
    iacOutputsPath: "/unused/iac.json",
    inputPath: "/unused/release.json",
    multipartBytes: 25 * 1024 * 1024 + 1,
    outputPath: "/unused/.release/r2-acceptance.json",
    pollTimeoutMs: 5_000,
    ...overrides,
  };
}

function acceptanceOptions(directory, overrides = {}) {
  return {
    ...prepareR2AcceptanceOptions(
      parsedArguments({
        outputPath: join(directory, "r2-acceptance.json"),
        ...overrides,
      }),
      releaseInputs(),
      directory,
    ),
  };
}

function cleanCheckout(command, args) {
  if (command === "git" && args[0] === "rev-parse") {
    return Promise.resolve({ code: 0, stderr: "", stdout: `${gitSha}\n` });
  }
  if (command === "git" && args[0] === "status") {
    return Promise.resolve({ code: 0, stderr: "", stdout: "" });
  }
  throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
}

function lifecycleDependencies(harness, probeNumber, overrides = {}) {
  let currentTime = Date.parse("2026-07-22T00:00:00.000Z");
  const sleeps = [];
  return {
    dependencies: {
      environment: environment(),
      fetchImpl: harness.fetchImpl,
      now: () => currentTime,
      randomUUID: () => identifier(probeNumber),
      runCommand: cleanCheckout,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        currentTime += milliseconds;
      },
      ...overrides,
    },
    sleeps,
  };
}

function signedRequest(path = "/assets/object") {
  return {
    expires_at: "2999-01-01T00:00:00.000Z",
    headers: { "Content-Type": "image/png" },
    method: "PUT",
    url: `${r2Origin}/${bucketName}${path}?X-Amz-Signature=test-signature`,
  };
}

function jsonResponse(value, status = 200, requestId = "api-request") {
  return new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": requestId,
    },
    status,
  });
}

function identifier(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function acceptanceFetch({
  corruptDownload = false,
  healthVersion = gitSha,
  multipartPartSize = 8 * 1024 * 1024,
  partialIdentifiers = false,
  stuckDeletion = false,
} = {}) {
  const assets = new Map();
  const objects = new Map();
  const sessions = new Map();
  let apiRequestNumber = 0;
  let r2RequestNumber = 0;
  let sessionNumber = 0;

  const signed = (path, contentType, partNumber) => ({
    expires_at: "2999-01-01T00:00:00.000Z",
    headers: { "Content-Type": contentType },
    method: "PUT",
    ...(partNumber === undefined ? {} : { part_number: partNumber }),
    url: `${r2Origin}/${bucketName}${path}?X-Amz-Signature=signature-${partNumber ?? "single"}`,
  });

  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);

    if (url.origin === apiOrigin) {
      assert.equal(headers.get("authorization"), `Bearer ${bearerToken}`);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const requestId = `api-${++apiRequestNumber}`;

      if (method === "GET" && path === "/health") {
        return jsonResponse(
          { environment: "staging", status: "ok", version: healthVersion },
          200,
          requestId,
        );
      }
      if (method === "GET" && path === "/users/me") {
        return jsonResponse(
          {
            active_organization: {
              id: acceptanceOrganizationId,
              name: "R2 Acceptance",
              role: "admin",
              slug: "r2-acceptance",
            },
            avatar_url: null,
            created_at: "2026-07-22T00:00:00.000Z",
            display_name: "R2 Acceptance",
            email: "r2-acceptance@example.invalid",
            id: acceptanceUserId,
            updated_at: "2026-07-22T00:00:00.000Z",
          },
          200,
          requestId,
        );
      }

      if (method === "POST" && path === "/asset-upload-sessions") {
        assert.ok(headers.get("idempotency-key"));
        const body = JSON.parse(init.body);
        if (body.file_size > 500 * 1024 * 1024) {
          return jsonResponse({ error: { code: "payload_too_large" } }, 413, requestId);
        }
        sessionNumber += 1;
        const assetId = identifier(100 + sessionNumber);
        const sessionId = identifier(200 + sessionNumber);
        const strategy = body.asset_type === "image" ? "single" : "multipart";
        const session = {
          assetId,
          contentType: body.content_type,
          fileSize: body.file_size,
          id: sessionId,
          partSize: multipartPartSize,
          parts: new Map(),
          status: "created",
          strategy,
        };
        sessions.set(sessionId, session);
        assets.set(assetId, {
          deleted: false,
          deletePolls: 0,
          id: assetId,
          processingPolls: 0,
          status: "pending_upload",
        });
        return jsonResponse(
          {
            asset: { id: assetId, status: "pending_upload" },
            upload_session: {
              asset_id: assetId,
              content_type: body.content_type,
              expires_at: "2999-01-01T00:00:00.000Z",
              file_size: body.file_size,
              id: partialIdentifiers && sessionNumber === 1 ? "invalid-session-id" : sessionId,
              multipart:
                strategy === "multipart"
                  ? {
                      max_parallel_parts: 4,
                      part_count: Math.ceil(body.file_size / multipartPartSize),
                      part_size: multipartPartSize,
                    }
                  : null,
              single_upload:
                strategy === "single"
                  ? signed(`/upload/${assetId}/single`, body.content_type)
                  : null,
              status: "created",
              strategy,
            },
          },
          201,
          requestId,
        );
      }

      const partMatch = path.match(/^\/asset-upload-sessions\/([0-9a-f-]+)\/parts$/);
      if (method === "POST" && partMatch) {
        const session = sessions.get(partMatch[1]);
        assert.ok(session);
        const body = JSON.parse(init.body);
        return jsonResponse(
          {
            parts: body.part_numbers.map((partNumber) =>
              signed(
                `/upload/${session.assetId}/part/${partNumber}`,
                session.contentType,
                partNumber,
              ),
            ),
          },
          200,
          requestId,
        );
      }

      const completeMatch = path.match(/^\/asset-upload-sessions\/([0-9a-f-]+)\/complete$/);
      if (method === "POST" && completeMatch) {
        const session = sessions.get(completeMatch[1]);
        assert.ok(session);
        if (session.strategy === "multipart") {
          objects.set(
            session.assetId,
            Buffer.concat(
              [...session.parts.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, bytes]) => bytes),
            ),
          );
          session.parts.clear();
        }
        const asset = assets.get(session.assetId);
        asset.status = "processing";
        asset.processingPolls = 0;
        session.status = "completed";
        return jsonResponse({ id: session.assetId, status: "processing" }, 202, requestId);
      }

      const downloadMatch = path.match(/^\/assets\/([0-9a-f-]+)\/download-url$/);
      if (method === "GET" && downloadMatch) {
        return jsonResponse(
          {
            expires_at: "2999-01-01T00:00:00.000Z",
            url: `${r2Origin}/${bucketName}/download/${downloadMatch[1]}?X-Amz-Signature=download`,
          },
          200,
          requestId,
        );
      }

      const assetMatch = path.match(/^\/assets\/([0-9a-f-]+)$/);
      if (assetMatch && method === "GET") {
        const asset = assets.get(assetMatch[1]);
        if (!asset || asset.deleted) {
          return new Response(null, {
            headers: { "X-Request-ID": requestId },
            status: 404,
          });
        }
        if (asset.status === "processing") {
          asset.processingPolls += 1;
          if (asset.processingPolls >= 2) asset.status = "ready";
        }
        if (asset.status === "deleting") {
          asset.deletePolls += 1;
          if (!stuckDeletion && asset.deletePolls >= 2) {
            asset.deleted = true;
            objects.delete(asset.id);
            return new Response(null, {
              headers: { "X-Request-ID": requestId },
              status: 404,
            });
          }
        }
        return jsonResponse({ id: asset.id, status: asset.status }, 200, requestId);
      }
      if (assetMatch && method === "DELETE") {
        const asset = assets.get(assetMatch[1]);
        assert.ok(asset);
        asset.status = "deleting";
        asset.deletePolls = 0;
        return jsonResponse({ id: asset.id, status: "deleting" }, 202, requestId);
      }

      const sessionMatch = path.match(/^\/asset-upload-sessions\/([0-9a-f-]+)$/);
      if (sessionMatch && method === "DELETE") {
        const session = sessions.get(sessionMatch[1]);
        assert.ok(session);
        if (session.status === "completed") {
          return jsonResponse({ error: { code: "upload_already_completed" } }, 409, requestId);
        }
        session.status = "aborted";
        session.parts.clear();
        return new Response(null, {
          headers: { "X-Request-ID": requestId },
          status: 204,
        });
      }
      if (sessionMatch && method === "GET") {
        const session = sessions.get(sessionMatch[1]);
        assert.ok(session);
        return jsonResponse(
          {
            asset: { id: session.assetId },
            upload_session: { id: session.id, status: session.status },
            uploaded_parts: [],
          },
          200,
          requestId,
        );
      }
      throw new Error(`unexpected API request: ${method} ${path}`);
    }

    if (url.origin === r2Origin) {
      const objectPath = url.pathname.replace(`/${bucketName}`, "");
      if (method === "OPTIONS") {
        assert.equal(headers.get("origin"), browserOrigin);
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "PUT",
            "Access-Control-Allow-Origin": browserOrigin,
            "CF-Ray": `r2-${++r2RequestNumber}`,
          },
          status: 204,
        });
      }
      const uploadMatch = objectPath.match(/^\/upload\/([0-9a-f-]+)\/(single|part\/(\d+))$/);
      if (method === "PUT" && uploadMatch) {
        const session = [...sessions.values()].find((entry) => entry.assetId === uploadMatch[1]);
        assert.ok(session);
        if (session.status === "aborted") {
          return new Response(null, {
            headers: { "CF-Ray": `r2-${++r2RequestNumber}` },
            status: 404,
          });
        }
        assert.equal(headers.get("origin"), browserOrigin);
        const bytes = Buffer.from(init.body);
        const expectedBytes =
          uploadMatch[2] === "single"
            ? session.fileSize
            : Math.min(
                session.partSize,
                session.fileSize - (Number(uploadMatch[3]) - 1) * session.partSize,
              );
        if (bytes.byteLength !== expectedBytes) {
          return new Response(null, {
            headers: { "CF-Ray": `r2-${++r2RequestNumber}` },
            status: 403,
          });
        }
        if (uploadMatch[2] === "single") {
          objects.set(session.assetId, bytes);
        } else {
          session.parts.set(Number(uploadMatch[3]), bytes);
        }
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": browserOrigin,
            "Access-Control-Expose-Headers": "ETag",
            ETag: `etag-${uploadMatch[3] ?? "single"}`,
            "X-Amz-Request-ID": `r2-${++r2RequestNumber}`,
          },
          status: 200,
        });
      }
      const downloadMatch = objectPath.match(/^\/download\/([0-9a-f-]+)$/);
      if (method === "GET" && downloadMatch) {
        const bytes = objects.get(downloadMatch[1]);
        assert.ok(bytes);
        return new Response(corruptDownload ? Buffer.concat([bytes, Buffer.from([0])]) : bytes, {
          headers: { "CF-Ray": `r2-${++r2RequestNumber}` },
          status: 200,
        });
      }
      throw new Error(`unexpected R2 request: ${method} ${objectPath}`);
    }

    throw new Error(`unexpected origin: ${url.origin}`);
  };

  return { assets, fetchImpl, objects, sessions };
}

describe("R2 acceptance arguments", () => {
  it("is dry-run by default and derives the exact R2 origin", () => {
    const parsed = parseR2AcceptanceArguments([
      "--input",
      "release.json",
      "--iac-outputs",
      "iac.json",
    ]);
    const options = prepareR2AcceptanceOptions(parsed, releaseInputs());
    assert.equal(parsed.apply, false);
    assert.equal(options.r2Origin, r2Origin);
    assert.equal(options.bucketName, bucketName);
    assert.equal(options.multipartBytes, 25 * 1024 * 1024 + 1);
    assert.equal(options.releaseId, `staging-${gitSha.slice(0, 12)}`);
  });

  it("requires exact confirmation and bounded multipart inputs", () => {
    assert.throws(
      () =>
        prepareR2AcceptanceOptions(
          parseR2AcceptanceArguments([
            "--apply",
            "--input",
            "release.json",
            "--iac-outputs",
            "iac.json",
          ]),
          releaseInputs(),
        ),
      /--apply requires --confirm/,
    );
    assert.throws(
      () =>
        parseR2AcceptanceArguments([
          "--input",
          "release.json",
          "--iac-outputs",
          "iac.json",
          "--multipart-bytes",
          String(25 * 1024 * 1024),
        ]),
      /must exceed the 25 MiB multipart threshold/,
    );
    assert.throws(
      () =>
        prepareR2AcceptanceOptions(
          parsedArguments(),
          releaseInputs({ queue_delivery_paused: true }),
        ),
      /do not prove the active release state/,
    );
    assert.equal(
      parseR2AcceptanceArguments([
        "--apply",
        "--confirm",
        `r2 staging ${gitSha}`,
        "--input",
        "release.json",
        "--iac-outputs",
        "iac.json",
      ]).apply,
      true,
    );
  });
});

describe("signed R2 requests", () => {
  it("verifies exact browser CORS and forwards no API credential", async () => {
    let observed;
    await verifySignedPutCors(
      signedRequest(),
      browserOrigin,
      { bucketName, origin: r2Origin },
      async (url, init) => {
        observed = { init, url: String(url) };
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Headers": "content-type",
            "Access-Control-Allow-Methods": "PUT",
            "Access-Control-Allow-Origin": browserOrigin,
            "CF-Ray": "request-1",
          },
          status: 204,
        });
      },
    );
    assert.equal(observed.init.headers.Origin, browserOrigin);
    assert.equal(observed.init.headers.Authorization, undefined);
    assert.match(observed.url, /X-Amz-Signature=/);
  });

  it("rejects off-account, wrong-bucket, and unsafe requests before fetch", async () => {
    let calls = 0;
    await assert.rejects(
      verifySignedPutCors(
        {
          ...signedRequest(),
          url: "https://attacker.example/object?X-Amz-Signature=bad",
        },
        browserOrigin,
        { bucketName, origin: r2Origin },
        async () => {
          calls += 1;
          return new Response();
        },
      ),
      /unsafe signed PUT URL/,
    );
    await assert.rejects(
      verifySignedPutCors(
        {
          ...signedRequest(),
          url: `${r2Origin}/production-assets/object?X-Amz-Signature=bad`,
        },
        browserOrigin,
        { bucketName, origin: r2Origin },
        async () => {
          calls += 1;
          return new Response();
        },
      ),
      /unsafe signed PUT URL/,
    );
    await assert.rejects(
      verifySignedPutCors(
        { ...signedRequest(), headers: { Authorization: "secret" } },
        browserOrigin,
        { bucketName, origin: r2Origin },
        async () => {
          calls += 1;
          return new Response();
        },
      ),
      /unsafe signed PUT header/,
    );
    assert.equal(calls, 0);
  });

  it("requires browser-visible ETags and records only safe request IDs", async () => {
    const result = await uploadSignedPart({
      body: new Uint8Array([1, 2, 3]),
      browserOrigin,
      fetchImpl: async (_url, init) => {
        assert.equal(new Headers(init.headers).get("origin"), browserOrigin);
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": browserOrigin,
            "Access-Control-Expose-Headers": "ETag",
            ETag: "etag-1",
            "X-Amz-Request-ID": "request-1",
          },
          status: 200,
        });
      },
      request: signedRequest(),
      requireEtag: true,
      target: { bucketName, origin: r2Origin },
    });
    assert.deepEqual(result, { etag: "etag-1", requestId: "request-1" });

    await assert.rejects(
      uploadSignedPart({
        body: new Uint8Array([1, 2, 3]),
        browserOrigin,
        fetchImpl: async () =>
          new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": browserOrigin,
              "Access-Control-Expose-Headers": "ETag",
              ETag: "etag-1",
            },
            status: 200,
          }),
        request: signedRequest(),
        requireEtag: true,
        target: { bucketName, origin: r2Origin },
      }),
      /omitted a safe request ID/,
    );
  });
});

it("runs the credential-gated lifecycle and emits redacted mode-0600 evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meltiply-r2-"));
  temporaryDirectories.push(directory);
  const options = acceptanceOptions(directory);
  await writeFile(options.outputPath, JSON.stringify({ probe_id: "stale", status: "passed" }), {
    mode: 0o644,
  });
  const harness = acceptanceFetch();
  const { dependencies, sleeps } = lifecycleDependencies(harness, 999);
  const result = await runR2Acceptance(options, dependencies);

  assert.equal(result.status, "passed");
  assert.equal(result.kind, "acceptance");
  assert.equal(result.result, "passed");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.probe_id, identifier(999));
  assert.deepEqual(result.operationIds, [
    "abortUploadSession",
    "completeUploadSession",
    "createUploadPartUrls",
    "createUploadSession",
    "deleteAsset",
    "getAsset",
    "getAssetDownloadUrl",
    "getBillingUsage",
    "getCurrentUser",
    "getHealth",
    "getUploadSession",
  ]);
  assert.deepEqual(result.attemptedOperationIds, result.operationIds);
  assert.deepEqual(
    result.cases.map((entry) => entry.name),
    [
      "single-put-size-cors-head-download-delete",
      "multipart-complete-head-download-delete",
      "multipart-abort-stale-url-rejection",
      "oversized-rejection",
    ],
  );
  assert.ok([...harness.assets.values()].every((asset) => asset.deleted));
  assert.equal(harness.objects.size, 0);
  assert.ok(sleeps.length >= 5);
  assert.ok(sleeps.every((milliseconds) => milliseconds === 1_000));
  assert.ok(result.api_request_ids.every((value) => /^api-\d+$/.test(value)));
  assert.ok(result.r2_request_ids.every((value) => /^r2-\d+$/.test(value)));

  const evidence = await readFile(options.outputPath, "utf8");
  assert.equal((await stat(options.outputPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(evidence, new RegExp(bearerToken));
  assert.doesNotMatch(evidence, /X-Amz-Signature|\/upload\/|\/download\//);
  assert.doesNotMatch(evidence, /"probe_id":"stale"/);
  assert.deepEqual(JSON.parse(evidence), result);
});

it("keeps dry-run credential-free and redacts secrets from CLI errors", async () => {
  const options = acceptanceOptions(tmpdir(), {
    apply: false,
    confirm: undefined,
  });
  const result = await runR2Acceptance(options, {
    fetchImpl: async () => assert.fail("dry-run must not access the network"),
    runCommand: async () => assert.fail("dry-run must not inspect git"),
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(
    r2AcceptanceInternals.safeError(
      new Error(`${bearerToken} https://example.com/object?X-Amz-Signature=secret`),
      { MELTIPLY_STAGING_BEARER_TOKEN: bearerToken },
    ),
    "[REDACTED] [SIGNED_URL]",
  );
});

it("checks the clean release checkout before any staging request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meltiply-r2-dirty-"));
  temporaryDirectories.push(directory);
  const options = acceptanceOptions(directory);
  await writeFile(options.outputPath, JSON.stringify({ probe_id: "stale", status: "passed" }), {
    mode: 0o644,
  });
  const harness = acceptanceFetch();
  const { dependencies } = lifecycleDependencies(harness, 997, {
    fetchImpl: async () => assert.fail("dirty checkout must block the network"),
    runCommand: async (command, args) => {
      if (command === "git" && args[0] === "status") {
        return { code: 0, stderr: "", stdout: " M tracked-file\n" };
      }
      return cleanCheckout(command, args);
    },
  });

  await assert.rejects(
    runR2Acceptance(options, dependencies),
    /tracked working tree changes are not releasable/,
  );

  const evidence = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.checkout_verified, false);
  assert.deepEqual(evidence.attemptedOperationIds, []);
  assert.equal((await stat(options.outputPath)).mode & 0o777, 0o600);
});

it("checks the staging health SHA before creating upload sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meltiply-r2-health-"));
  temporaryDirectories.push(directory);
  const options = acceptanceOptions(directory);
  const harness = acceptanceFetch({ healthVersion: "f".repeat(40) });
  const { dependencies } = lifecycleDependencies(harness, 996);

  await assert.rejects(
    runR2Acceptance(options, dependencies),
    /health does not match the approved environment and git SHA/,
  );

  assert.equal(harness.assets.size, 0);
  const evidence = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.equal(evidence.status, "failed");
  assert.deepEqual(evidence.attemptedOperationIds, ["getHealth"]);
  assert.deepEqual(evidence.operationIds, ["getHealth"]);
});

it("requires the configured acceptance identity before mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meltiply-r2-identity-"));
  temporaryDirectories.push(directory);
  const options = acceptanceOptions(directory);
  const harness = acceptanceFetch();
  const { dependencies } = lifecycleDependencies(harness, 992, {
    environment: environment({ MELTIPLY_STAGING_ACCEPTANCE_ORG_ID: identifier(999) }),
  });

  await assert.rejects(
    runR2Acceptance(options, dependencies),
    /not the dedicated staging acceptance identity/,
  );

  assert.equal(harness.assets.size, 0);
  const evidence = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.equal(evidence.status, "failed");
  assert.deepEqual(evidence.attemptedOperationIds, ["getCurrentUser", "getHealth"]);
});

it("polls cleanup and writes failed evidence when verification fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meltiply-r2-failed-"));
  temporaryDirectories.push(directory);
  const options = acceptanceOptions(directory);
  const harness = acceptanceFetch({ corruptDownload: true });
  const { dependencies, sleeps } = lifecycleDependencies(harness, 998);
  await assert.rejects(
    runR2Acceptance(options, dependencies),
    /download exceeded the expected object size/,
  );
  assert.ok([...harness.assets.values()].every((asset) => asset.deleted));
  assert.equal(harness.objects.size, 0);
  assert.ok(sleeps.length >= 2);

  const evidenceText = await readFile(options.outputPath, "utf8");
  const evidence = JSON.parse(evidenceText);
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.cleanup_error_count, 0);
  assert.deepEqual(evidence.unresolved_resources, []);
  assert.ok(evidence.r2_request_ids.includes("r2-4"));
  assert.equal((await stat(options.outputPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(evidenceText, /X-Amz-Signature|staging-secret-token/);
});

it("tracks partial create identifiers so cleanup can remove the asset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meltiply-r2-partial-"));
  temporaryDirectories.push(directory);
  const options = acceptanceOptions(directory);
  const harness = acceptanceFetch({ partialIdentifiers: true });
  const { dependencies } = lifecycleDependencies(harness, 995);

  await assert.rejects(runR2Acceptance(options, dependencies), /invalid upload identifiers/);

  assert.ok([...harness.assets.values()].every((asset) => asset.deleted));
  const evidence = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.equal(evidence.cleanup_error_count, 0);
  assert.deepEqual(evidence.unresolved_resources, []);
});

it("rejects an unbounded multipart layout before allocating a part", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meltiply-r2-layout-"));
  temporaryDirectories.push(directory);
  const options = acceptanceOptions(directory);
  const harness = acceptanceFetch({
    multipartPartSize: 20 * 1024 * 1024,
  });
  const { dependencies } = lifecycleDependencies(harness, 993);

  await assert.rejects(runR2Acceptance(options, dependencies), /invalid multipart bounds/);

  assert.ok([...harness.assets.values()].every((asset) => asset.deleted));
  const evidence = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.equal(evidence.status, "failed");
  assert.deepEqual(evidence.unresolved_resources, []);
});

it("replaces stale success with unresolved-resource failure evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meltiply-r2-stuck-"));
  temporaryDirectories.push(directory);
  const options = acceptanceOptions(directory, { pollTimeoutMs: 2_000 });
  await writeFile(options.outputPath, JSON.stringify({ probe_id: "stale", status: "passed" }), {
    mode: 0o644,
  });
  const harness = acceptanceFetch({ stuckDeletion: true });
  const { dependencies } = lifecycleDependencies(harness, 994);

  await assert.rejects(
    runR2Acceptance(options, dependencies),
    /cleanup operation\(s\) also failed/,
  );

  const evidence = JSON.parse(await readFile(options.outputPath, "utf8"));
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.probe_id, identifier(994));
  assert.ok(evidence.cleanup_error_count >= 1);
  assert.equal(evidence.unresolved_resources.length, 1);
  assert.ok(evidence.unresolved_resources[0].asset_id);
  assert.ok(evidence.unresolved_resources[0].session_id);
  assert.equal((await stat(options.outputPath)).mode & 0o777, 0o600);
});

it("gives a 500 MiB transfer a bounded size-aware deadline", () => {
  assert.equal(r2AcceptanceInternals.transferTimeoutForBytes(1), 60_000);
  assert.equal(r2AcceptanceInternals.transferTimeoutForBytes(500 * 1024 * 1024), 530_000);
});
