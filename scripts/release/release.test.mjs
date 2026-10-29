import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCommand } from "./command-runner.mjs";
import {
  preflightRelease,
  redactError,
  releaseInternals,
  renderWranglerConfigs,
  validateIacOutputs,
  validateDatabaseEnvironment,
  validateReleaseSpec,
  writeRenderedConfigs,
} from "./release-lib.mjs";
import { runReleaseCli } from "./release.mjs";

const gitSha = "a".repeat(40);
const authenticatedHyperdriveId = "1".repeat(32);
const systemHyperdriveId = "2".repeat(32);

function releaseInput(overrides = {}) {
  return {
    schema_version: 1,
    environment: "staging",
    deployment_mode: "bootstrap",
    git_sha: gitSha,
    neon_branch_id: "branch-staging-123",
    neon_project_id: "project-staging-123",
    release_id: `staging-${gitSha.slice(0, 12)}`,
    restore_point_expires_at: "2026-08-05T12:00:00.000Z",
    api_workers_dev_url: "https://meltiply-api.example.workers.dev",
    app_url: "https://staging.meltiply.com",
    automation_guard: { consumers_paused: true, cron_safe: true },
    provider_acceptance: {
      facebook: false,
      instagram: false,
      instagram_engagement: false,
      threads: false,
      threads_engagement: false,
      tiktok: false,
      youtube: false,
    },
    runtime: {
      mail_from_address: "auth@staging.meltiply.com",
      mail_from_name: "Meltiply",
      r2_account_id: "3".repeat(32),
    },
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

function iacOutput(overrides = {}) {
  const queues = queueNames();
  const resources = {
    app_hostname: "staging.meltiply.com",
    app_custom_domains_attached: false,
    assets_bucket_name: "meltiply-assets-staging",
    authenticated_hyperdrive_id: authenticatedHyperdriveId,
    dead_letter_queue_ids: {},
    dead_letter_queue_names: {},
    environment: "staging",
    operator_access_aud: null,
    operator_hostname: null,
    queue_consumers_attached: false,
    queue_delivery_paused: true,
    queue_names: queues,
    system_hyperdrive_id: systemHyperdriveId,
    ...overrides,
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

// Return the clean checkout and installed Wrangler version used by preflight scenarios.
function successfulPreflightCommand(command, args) {
  if (command === "git" && args[0] === "rev-parse") {
    return Promise.resolve({ code: 0, stderr: "", stdout: `${gitSha}\n` });
  }
  if (command === "git" && args[0] === "status") {
    return Promise.resolve({ code: 0, stderr: "", stdout: "" });
  }
  if (command === "bun") {
    return Promise.resolve({ code: 0, stderr: "", stdout: "4.148.0\n" });
  }
  throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
}

test("command runner does not open stdin for read-only commands", async () => {
  const result = await runCommand("git", ["rev-parse", "HEAD"]);
  assert.match(result.stdout, /^[0-9a-f]{40}\n$/);

  const stress = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { runCommand } from "./scripts/release/command-runner.mjs"; await Promise.all(Array.from({ length: 100 }, () => runCommand("git", ["rev-parse", "HEAD"])));',
    ],
    { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" },
  );
  assert.equal(stress.status, 0, stress.stderr);
});

test("release input is canonicalized and rejects secret-bearing fields", () => {
  const spec = validateReleaseSpec({
    ...releaseInput(),
    allowed_origins: [
      "https://www.staging.meltiply.com",
      "https://staging.meltiply.com",
      "https://staging.meltiply.com",
    ],
  });
  assert.deepEqual(spec.allowed_origins, [
    "https://staging.meltiply.com",
    "https://www.staging.meltiply.com",
  ]);
  assert.equal(
    validateReleaseSpec({
      ...releaseInput(),
      restore_point_expires_at: "2026-08-05T12:00:00Z",
    }).restore_point_expires_at,
    "2026-08-05T12:00:00Z",
  );
  assert.throws(
    () =>
      validateReleaseSpec({
        ...releaseInput(),
        database_url: "postgres://hidden",
      }),
    /must not contain credentials or database URLs/,
  );
  assert.throws(
    () =>
      validateReleaseSpec({
        ...releaseInput(),
        runtime: { ...releaseInput().runtime, extra: "unexpected" },
      }),
    /runtime contains unknown fields: extra/,
  );
  assert.throws(
    () => validateReleaseSpec({ ...releaseInput(), deployment_mode: "auto" }),
    /deployment_mode must be bootstrap or update/,
  );
  assert.throws(
    () =>
      validateReleaseSpec({
        ...releaseInput(),
        api_workers_dev_url: "https://preview.example.com",
      }),
    /api_workers_dev_url must use a workers.dev hostname/,
  );
  assert.throws(
    () =>
      validateReleaseSpec({
        ...releaseInput(),
        restore_point_expires_at: "2026-02-30T12:00:00Z",
      }),
    /restore_point_expires_at is invalid/,
  );
});

// Release validation must reject sender identities that would fail closed in the Worker:
// bare dot-atom addresses forbid empty local-part atoms and are limited to 254
// characters with valid DNS labels; display names are limited to 200.
test("release sender requires a bare address and safe optional display name", () => {
  const runtime = releaseInput().runtime;
  const runtimeWithoutName = { ...runtime };
  delete runtimeWithoutName.mail_from_name;
  assert.equal(validateReleaseSpec(releaseInput()).runtime.mail_from_name, "Meltiply");
  assert.equal(
    validateReleaseSpec({
      ...releaseInput(),
      runtime: runtimeWithoutName,
    }).runtime.mail_from_name,
    undefined,
  );
  const dottedSender = "sender.name+tag@example.com";
  assert.equal(
    validateReleaseSpec({
      ...releaseInput(),
      runtime: { ...runtime, mail_from_address: dottedSender },
    }).runtime.mail_from_address,
    dottedSender,
  );
  for (const mail_from_address of [
    "Meltiply <auth@staging.meltiply.com>",
    "auth@staging.meltiply.com, ops@staging.meltiply.com",
    "auth@localhost",
    "a@b@c.staging.meltiply.com",
    ".sender@example.com",
    "sender.@example.com",
    "sender..name@example.com",
    "a\nb@staging.meltiply.com",
    `${"a".repeat(248)}@x.test`,
    "auth@-invalid.test",
    `auth@${"a".repeat(64)}.test`,
  ]) {
    assert.throws(
      () =>
        validateReleaseSpec({
          ...releaseInput(),
          runtime: { ...runtime, mail_from_address },
        }),
      /runtime\.mail_from_address is invalid/,
      `sender ${JSON.stringify(mail_from_address)} must be rejected`,
    );
  }
  for (const mail_from_name of [
    "Meltiply <ops@staging.meltiply.com>",
    'Quoted "Name"',
    "Meltiply\nAlerts",
    "a".repeat(201),
  ]) {
    assert.throws(
      () =>
        validateReleaseSpec({
          ...releaseInput(),
          runtime: { ...runtime, mail_from_name },
        }),
      /runtime\.mail_from_name is invalid/,
      `display name ${JSON.stringify(mail_from_name)} must be rejected`,
    );
  }
  const boundaryRuntime = {
    ...runtime,
    mail_from_address: `${"a".repeat(247)}@x.test`,
    mail_from_name: "a".repeat(200),
  };
  const validatedRuntime = validateReleaseSpec({
    ...releaseInput(),
    runtime: boundaryRuntime,
  }).runtime;
  assert.equal(validatedRuntime.mail_from_address, boundaryRuntime.mail_from_address);
  assert.equal(validatedRuntime.mail_from_name, boundaryRuntime.mail_from_name);
});

test("provider acceptance requires its public client configuration", () => {
  assert.throws(
    () =>
      validateReleaseSpec({
        ...releaseInput(),
        provider_acceptance: {
          ...releaseInput().provider_acceptance,
          threads: true,
        },
      }),
    /threads_client_id is required when threads is accepted/,
  );
});

test("IaC outputs must be non-sensitive, staging-scoped, and internally consistent", () => {
  const spec = validateReleaseSpec(releaseInput());
  const validated = validateIacOutputs(iacOutput(), spec);
  assert.equal(validated.assets_bucket, "meltiply-assets-staging");
  assert.equal(validated.authenticated_hyperdrive_id, authenticatedHyperdriveId);
  assert.deepEqual(validated.queues, queueNames());

  const sensitive = iacOutput();
  sensitive.worker_bindings.sensitive = true;
  assert.throws(
    () => validateIacOutputs(sensitive, spec),
    /IaC output worker_bindings must not be sensitive/,
  );

  const inconsistent = iacOutput();
  inconsistent.worker_bindings.value.queues.analytics = "wrong-environment";
  assert.throws(
    () => validateIacOutputs(inconsistent, spec),
    /queue analytics is not the expected staging queue/,
  );
});

test("rendering replaces placeholders with reviewed non-secret bindings", () => {
  const spec = validateReleaseSpec(releaseInput());
  const iac = validateIacOutputs(iacOutput(), spec);
  const configs = renderWranglerConfigs(
    {
      api: {
        name: "meltiply-api",
        vars: { ACCESS_POLICY_AUD: "placeholder", UNUSED: "remove-me" },
        r2_buckets: [
          {
            binding: "ASSETS",
            bucket_name: "placeholder",
            preview_bucket_name: "must-not-escape",
          },
        ],
        hyperdrive: [{ binding: "DB_AUTHENTICATED", id: "placeholder" }],
        send_email: [
          { name: "MAIL", allowed_sender_addresses: ["stale@example.com"] },
          { name: "AUDIT_MAIL", destination_address: "ops@example.com" },
        ],
      },
      automation: {
        name: "meltiply-automation",
        vars: { UNUSED: "remove-me" },
        r2_buckets: [{ binding: "ASSETS", bucket_name: "placeholder" }],
        hyperdrive: [{ binding: "DB_SYSTEM", id: "placeholder" }],
        queues: { producers: [] },
      },
      state: { name: "meltiply-state", migrations: [{ tag: "v1" }] },
    },
    spec,
    iac,
  );

  assert.equal(configs.api.vars.VERSION, gitSha);
  assert.equal(configs.api.vars.ACCESS_POLICY_AUD, undefined);
  assert.equal(configs.api.vars.UNUSED, undefined);
  assert.equal(configs.api.vars.MAIL_FROM_ADDRESS, "auth@staging.meltiply.com");
  assert.equal(configs.api.vars.MAIL_FROM_NAME, "Meltiply");
  assert.deepEqual(configs.api.send_email, [
    { name: "AUDIT_MAIL", destination_address: "ops@example.com" },
    {
      name: "MAIL",
      allowed_sender_addresses: ["auth@staging.meltiply.com"],
    },
  ]);
  assert.deepEqual(configs.api.hyperdrive, [
    { binding: "DB_AUTHENTICATED", id: authenticatedHyperdriveId },
    { binding: "DB_SYSTEM", id: systemHyperdriveId },
  ]);
  assert.deepEqual(configs.api.r2_buckets, [
    { binding: "ASSETS", bucket_name: "meltiply-assets-staging" },
  ]);
  assert.deepEqual(configs.state, {
    migrations: [{ tag: "v1" }],
    name: "meltiply-state",
  });
});

test("rendered files are deterministic and private", async (context) => {
  const outDir = await mkdtemp(path.join(tmpdir(), "meltiply-release-"));
  context.after(() => rm(outDir, { force: true, recursive: true }));
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const spec = validateReleaseSpec(releaseInput());
  const iac = validateIacOutputs(iacOutput(), spec);

  const first = await writeRenderedConfigs({ iac, outDir, repoRoot, spec });
  const second = await writeRenderedConfigs({ iac, outDir, repoRoot, spec });
  assert.equal(first.config_digest, second.config_digest);
  assert.match(first.config_digest, /^[0-9a-f]{64}$/);
  for (const outputPath of Object.values(first.paths)) {
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(outputPath, "utf8"), /replace-with-/);
  }
  const apiConfig = JSON.parse(await readFile(first.paths.api, "utf8"));
  assert.equal(
    path.resolve(path.dirname(first.paths.api), apiConfig.main),
    path.join(repoRoot, "workers/api/src/index.ts"),
  );
  assert.equal(
    path.resolve(path.dirname(first.paths.api), apiConfig.$schema),
    path.join(repoRoot, "node_modules/wrangler/config-schema.json"),
  );
  // The source wrangler.jsonc carries a placeholder MAIL entry; rendering must replace it
  // in place, leaving exactly one binding restricted to the configured sender.
  assert.deepEqual(apiConfig.send_email, [
    {
      name: "MAIL",
      allowed_sender_addresses: ["auth@staging.meltiply.com"],
    },
  ]);
});

test("connected preflight requires matching Cloudflare and TLS database credentials", async () => {
  const spec = validateReleaseSpec(releaseInput());
  await assert.rejects(
    preflightRelease({
      environment: {},
      offline: false,
      repoRoot: "/repo",
      runCommand: successfulPreflightCommand,
      spec,
    }),
    /CLOUDFLARE_ACCOUNT_ID is missing or does not match release input/,
  );
  await assert.rejects(
    preflightRelease({
      environment: {
        CLOUDFLARE_ACCOUNT_ID: spec.runtime.r2_account_id,
        CLOUDFLARE_API_TOKEN: "set",
        MELTIPLY_SYSTEM_DATABASE_URL: "postgresql://system:password@db.example.com/meltiply",
      },
      offline: false,
      repoRoot: "/repo",
      runCommand: successfulPreflightCommand,
      spec,
    }),
    /must be a complete TLS PostgreSQL URL/,
  );
});

/** Supplies both protected role credentials for connected preflight fixtures. */
function databaseEnvironment() {
  return {
    MELTIPLY_SYSTEM_DATABASE_URL:
      "postgresql://meltiply_system:system-secret@ep-staging.us-east-2.aws.neon.tech/meltiply?sslmode=require",
    MELTIPLY_AUTHENTICATED_DATABASE_URL:
      "postgresql://meltiply_rls:authenticated-secret@ep-staging.us-east-2.aws.neon.tech/meltiply?sslmode=require",
  };
}

/** Models each protected connection's catalog view and effective login identity. */
function roleClientFactory(
  { missing, systemBypass = true, authenticatedBypass = false, identity } = {},
) {
  return async (url) => {
    const role = new URL(url).username;
    return {
      connect: async () => {},
      end: async () => {},
      query: async () => ({
        rows: [
          { rolname: "meltiply_system", rolbypassrls: systemBypass, rolsuper: false },
          { rolname: "meltiply_rls", rolbypassrls: authenticatedBypass, rolsuper: false },
        ]
          .filter((row) => row.rolname !== missing)
          .map((row) => ({
            ...row,
            current_user: identity ?? role,
            session_user: identity ?? role,
          })),
      }),
    };
  };
}

test("connected preflight rejects missing, unsafe, and misresolved database roles", async () => {
  const spec = validateReleaseSpec(releaseInput());
  for (const [fixture, diagnostic] of [
    [{ missing: "meltiply_rls" }, /meltiply_rls.*missing.*MELTIPLY_AUTHENTICATED_DATABASE_URL/],
    [{ missing: "meltiply_system" }, /meltiply_system.*missing.*MELTIPLY_SYSTEM_DATABASE_URL/],
    [{ systemBypass: false }, /meltiply_system.*BYPASSRLS.*MELTIPLY_SYSTEM_DATABASE_URL/],
    [{ authenticatedBypass: true }, /meltiply_rls.*NOBYPASSRLS.*MELTIPLY_AUTHENTICATED_DATABASE_URL/],
    [{ identity: "neondb_owner" }, /MELTIPLY_SYSTEM_DATABASE_URL.*meltiply_system/],
  ]) {
    await assert.rejects(
      preflightRelease({
        clientFactory: roleClientFactory(fixture),
        environment: {
          ...databaseEnvironment(),
          CLOUDFLARE_ACCOUNT_ID: spec.runtime.r2_account_id,
          CLOUDFLARE_API_TOKEN: "set",
        },
        offline: false,
        repoRoot: "/repo",
        runCommand: successfulPreflightCommand,
        spec,
      }),
      diagnostic,
    );
  }
});

test("preflight records verified roles online and an explicit credential-free offline skip", async () => {
  const spec = validateReleaseSpec(releaseInput());
  const common = { repoRoot: "/repo", runCommand: successfulPreflightCommand, spec };
  const online = await preflightRelease({
    ...common,
    clientFactory: roleClientFactory(),
    environment: {
      ...databaseEnvironment(),
      CLOUDFLARE_ACCOUNT_ID: spec.runtime.r2_account_id,
      CLOUDFLARE_API_TOKEN: "set",
    },
    offline: false,
  });
  assert.equal(online.database_roles.status, "verified");
  const offline = await preflightRelease({
    ...common,
    clientFactory: () => {
      throw new Error("offline must not connect");
    },
    environment: {},
    offline: true,
  });
  assert.deepEqual(offline.database_roles, { reason: "offline", status: "skipped" });
});

test("preflight database connection errors never disclose protected credentials", async () => {
  const spec = validateReleaseSpec(releaseInput());
  await assert.rejects(
    preflightRelease({
      clientFactory: async (url) => {
        throw new Error(`password system-secret in ${url}`);
      },
      environment: {
        ...databaseEnvironment(),
        CLOUDFLARE_ACCOUNT_ID: spec.runtime.r2_account_id,
        CLOUDFLARE_API_TOKEN: "set",
      },
      offline: false,
      repoRoot: "/repo",
      runCommand: successfulPreflightCommand,
      spec,
    }),
    (error) => {
      assert.match(error.message, /MELTIPLY_SYSTEM_DATABASE_URL.*meltiply_system/);
      assert.doesNotMatch(error.message, /system-secret|postgresql:|password/);
      return true;
    },
  );
});

test("the preflight CLI forwards the protected database client seam", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "release-preflight-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const inputPath = path.join(directory, "release.json");
  const input = releaseInput();
  await writeFile(inputPath, JSON.stringify(input));
  const result = await runReleaseCli(["preflight", "--input", inputPath], {
    clientFactory: roleClientFactory(),
    environment: {
      ...databaseEnvironment(),
      CLOUDFLARE_ACCOUNT_ID: input.runtime.r2_account_id,
      CLOUDFLARE_API_TOKEN: "set",
    },
    repoRoot: directory,
    runCommand: successfulPreflightCommand,
  });
  assert.equal(result.database_roles.status, "verified");
});

test("database validation binds both roles to one Neon endpoint", () => {
  const system =
    "postgresql://system:secret@ep-staging-pooler.us-east-2.aws.neon.tech/meltiply?sslmode=require";
  assert.equal(
    validateDatabaseEnvironment({
      MELTIPLY_AUTHENTICATED_DATABASE_URL:
        "postgresql://authenticated:secret@ep-staging.us-east-2.aws.neon.tech/meltiply?sslmode=verify-full",
      MELTIPLY_SYSTEM_DATABASE_URL: system,
    }),
    system,
  );
  assert.throws(
    () =>
      validateDatabaseEnvironment({
        MELTIPLY_AUTHENTICATED_DATABASE_URL:
          "postgresql://authenticated:secret@ep-other.us-east-2.aws.neon.tech/meltiply?sslmode=require",
        MELTIPLY_SYSTEM_DATABASE_URL: system,
      }),
    /same Neon endpoint/,
  );
});

test("release error redaction includes the Neon API key", () => {
  const token = "fixture-token-0000000000";
  assert.equal(
    redactError(new Error(`request failed for ${token}`), {
      NEON_API_KEY: token,
    }),
    "request failed for [REDACTED]",
  );
});

// Dirty checkout and outdated Wrangler must reject preflight; message wording
// and the particular currently pinned version are not the consumer contract.
test("preflight fails closed on checkout and toolchain drift", async () => {
  const spec = validateReleaseSpec(releaseInput());
  await assert.rejects(
    preflightRelease({
      environment: {},
      offline: true,
      repoRoot: "/repo",
      runCommand(command, args) {
        if (command === "git" && args[0] === "status") {
          return Promise.resolve({
            code: 0,
            stderr: "",
            stdout: " M package.json\n",
          });
        }
        return successfulPreflightCommand(command, args);
      },
      spec,
    }),
  );
  await assert.rejects(
    preflightRelease({
      environment: {},
      offline: true,
      repoRoot: "/repo",
      runCommand(command, args) {
        if (command === "bun") {
          return Promise.resolve({ code: 0, stderr: "", stdout: "4.113.0\n" });
        }
        return successfulPreflightCommand(command, args);
      },
      spec,
    }),
  );
});

test("release CLI rejects ambiguous or command-inappropriate options", async () => {
  await assert.rejects(runReleaseCli(["wat"]), /unknown release command: wat/);
  await assert.rejects(
    runReleaseCli(["render", "--offline", "--input", "input.json", "--iac-outputs", "iac.json"]),
    /unknown option for render: --offline/,
  );
  await assert.rejects(
    runReleaseCli(["preflight", "--wat"]),
    /unknown option for preflight: --wat/,
  );
});
