import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runReleaseCli } from "./release.mjs";

const sha = "a".repeat(40);
const previous = "11111111-1111-4111-8111-111111111111";
const candidate = "22222222-2222-4222-8222-222222222222";
const digest = "b".repeat(64);

/** Exercises the operator CLI with an isolated checkout and simulated command/provider boundary. */
for (const environment of ["staging", "production"]) {
  for (const mode of ["bootstrap", "update"]) {
    test(`${environment} ${mode} builds, deploys, and recovers the reviewed frontend`, async (context) => {
      const root = await mkdtemp(path.join(tmpdir(), "frontend-release-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const outDir = path.join(root, "release");
      const appDir = path.join(root, "frontend/app");
      await mkdir(appDir, { recursive: true });
      const spec = JSON.parse(
        await readFile(new URL("./release-input.example.json", import.meta.url), "utf8"),
      );
      Object.assign(spec, {
        neon_project_id: "project-release",
        neon_branch_id: "branch-release",
        restore_point_expires_at: "2026-08-05T12:00:00.000Z",
        environment,
        deployment_mode: mode,
        git_sha: sha,
        release_id: `${environment}-${sha.slice(0, 12)}`,
        api_workers_dev_url: `https://fork-api-${environment}.example.workers.dev`,
      });
      const names = {
        api: `fork-api-${environment}`,
        automation: `fork-automation-${environment}`,
        state: `fork-state-${environment}`,
        frontend: `fork-frontend-${environment}`,
      };
      const queues = Object.fromEntries(
        [
          "analytics",
          "asset-processing",
          "channel-revocation",
          "comments",
          "publish-facebook",
          "publish-instagram",
          "publish-threads",
          "publish-tiktok",
          "publish-youtube",
          "replies",
          "token-refresh",
        ].map((name) => [name, `meltiply-${name}-${environment}`]),
      );
      const resources = {
        environment,
        worker_names: names,
        frontend_worker_name: names.frontend,
        app_hostname: new URL(spec.app_url).hostname,
        app_custom_domains_attached: mode === "update",
        assets_bucket_name: `fork-assets-${environment}`,
        authenticated_hyperdrive_id: "1".repeat(32),
        system_hyperdrive_id: "2".repeat(32),
        operator_access_aud: null,
        operator_hostname: null,
        queue_consumers_attached: true,
        queue_delivery_paused: true,
        queue_names: queues,
        dead_letter_queue_names: Object.fromEntries(
          Object.entries(queues).map(([key, value]) => [key, `${value}-dlq`]),
        ),
      };
      const outputs = {
        release_resources: { sensitive: false, value: resources },
        worker_bindings: {
          sensitive: false,
          value: {
            ACCESS_POLICY_AUD: null,
            ACCESS_TEAM_DOMAIN: null,
            OPERATOR_HOSTNAME: null,
            ASSETS: resources.assets_bucket_name,
            DB_AUTHENTICATED: resources.authenticated_hyperdrive_id,
            DB_SYSTEM: resources.system_hyperdrive_id,
            queues,
          },
        },
      };
      const input = path.join(root, "input.json");
      const iac = path.join(root, "iac.json");
      const approval = path.join(root, "approval.json");
      await writeFile(input, JSON.stringify(spec));
      await writeFile(iac, JSON.stringify(outputs));
      await writeFile(
        approval,
        JSON.stringify({
          schema_version: 1,
          pipeline_sha: sha,
          plan_digest: digest,
          workflow_id: "99999999-9999-4999-8999-999999999999",
          approval_job: {
            id: "88888888-8888-4888-8888-888888888888",
            approved_by: "operator",
            name: `${environment}-foundation-approval`,
            status: "success",
          },
        }),
      );
      for (const worker of ["api", "automation", "state"]) {
        await mkdir(path.join(root, `workers/${worker}`), { recursive: true });
        await writeFile(path.join(root, `workers/${worker}/wrangler.jsonc`), "{}");
      }
      await writeFile(
        path.join(appDir, "wrangler.jsonc"),
        JSON.stringify({
          name: "unreviewed",
          main: "src/worker.ts",
          assets: {
            directory: "dist/client",
            binding: "ASSETS",
            not_found_handling: "single-page-application",
            run_worker_first: ["/api", "/api/*", "/health", "/__frontend-telemetry"],
          },
          env: { [environment]: { services: [{ binding: "API", service: "unreviewed-api" }] } },
        }),
      );
      let versions = mode === "update" ? [{ id: previous, tag: "old" }] : [];
      let active = previous;
      let builds = 0;
      let uploads = 0;
      let providerSha = sha;
      const tag = `${spec.release_id}-frontend-code`;
      const ok = (value = "") => ({
        code: 0,
        stderr: "",
        stdout: typeof value === "string" ? value : JSON.stringify(value),
      });
      // Command injection models external Vite/Wrangler effects, not release internals.
      async function runCommand(command, args, options = {}) {
        if (command === "git") return ok(args[0] === "rev-parse" ? sha : "");
        if (args.includes(`build:${environment}`)) {
          builds++;
          assert.equal(options.cwd, root);
          assert.equal(options.env.CLOUDFLARE_ENV, environment);
          assert.equal(options.env.APP_URL, spec.app_url);
          const source = JSON.parse(
            await readFile(options.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH, "utf8"),
          );
          assert.equal(source.name, names.frontend);
          assert.equal(source.vars.VERSION, sha);
          const generatedDir = path.join(appDir, "dist/frontend");
          await mkdir(generatedDir, { recursive: true });
          const built = {
            ...source,
            no_bundle: true,
            main: "index.js",
            assets: { ...source.assets, directory: "../client" },
          };
          delete built.env;
          await writeFile(path.join(generatedDir, "wrangler.json"), JSON.stringify(built));
          return ok();
        }
        const wrangler = args.slice(3);
        if (wrangler[0] === "versions" && wrangler[1] === "list")
          return ok(
            versions.map(({ id, tag: versionTag }) => ({
              id,
              annotations: { "workers/tag": versionTag },
            })),
          );
        if (wrangler[0] === "deployments")
          return ok({ versions: [{ version_id: active, percentage: 100 }] });
        if (wrangler[0] === "versions" && wrangler[1] === "view")
          return ok({
            id: candidate,
            annotations: { "workers/tag": tag },
            resources: { bindings: [{ name: "VERSION", text: providerSha, type: "plain_text" }] },
          });
        if (wrangler[0] === "deploy" || wrangler[1] === "upload") {
          uploads++;
          const config = JSON.parse(
            await readFile(wrangler[wrangler.indexOf("--config") + 1], "utf8"),
          );
          assert.equal(config.name, names.frontend);
          assert.equal(config.services[0].service, names.api);
          assert.equal(config.vars.ENVIRONMENT, environment);
          assert.equal(config.vars.API_ORIGIN, undefined);
          assert.equal(path.basename(config.main), "index.js");
          assert.ok(!wrangler.includes("--env")); // generated Vite config is already flattened
          versions.unshift({ id: candidate, tag });
          if (mode === "bootstrap") active = candidate;
          await writeFile(
            options.env.WRANGLER_OUTPUT_FILE_PATH,
            JSON.stringify({
              type: mode === "bootstrap" ? "deploy" : "version-upload",
              worker_name: names.frontend,
              version_id: candidate,
            }) + "\n",
          );
          return ok();
        }
        if (wrangler[1] === "deploy") {
          active = candidate;
          await writeFile(options.env.WRANGLER_OUTPUT_FILE_PATH, "");
          return ok();
        }
        throw new Error(`unexpected command ${command} ${args.join(" ")}`);
      }
      const common = ["--input", input, "--iac-outputs", iac, "--out-dir", outDir];
      const dependencies = { environment: {}, repoRoot: root, runCommand };
      await runReleaseCli(["render", ...common], dependencies);
      const deploy = [
        "deploy",
        ...common,
        "--phase",
        `frontend-${mode}`,
        "--step",
        mode === "bootstrap" ? "initialize" : "upload",
        "--apply",
        "--confirm",
        `release ${environment} ${sha}`,
        "--plan-digest",
        digest,
        "--approval-metadata",
        approval,
      ];
      await runReleaseCli(deploy, dependencies);
      if (mode === "update")
        await runReleaseCli(
          deploy.map((value) => (value === "upload" ? "activate" : value)),
          dependencies,
        );
      const first = JSON.parse(
        await readFile(path.join(outDir, "worker-frontend-candidate.json"), "utf8"),
      );
      await runReleaseCli(deploy, dependencies);
      assert.equal(uploads, 1);
      assert.equal(builds, 1);
      const recovered = JSON.parse(
        await readFile(path.join(outDir, "worker-frontend-candidate.json"), "utf8"),
      );
      assert.equal(recovered.version_id, first.version_id);
      const deployment = JSON.parse(
        await readFile(path.join(outDir, "worker-frontend-deployment.json"), "utf8"),
      );
      assert.equal(deployment.version_id, candidate);
      assert.equal(deployment.worker_name, names.frontend);
      assert.equal(deployment.config_digest, recovered.config_digest);
      providerSha = "c".repeat(40);
      await assert.rejects(runReleaseCli(deploy, dependencies), /frontend VERSION binding/);
      providerSha = sha;
      // Simulate interruption after Cloudflare succeeded but before local evidence persisted.
      await rm(path.join(outDir, "worker-frontend-candidate.json"));
      await rm(path.join(outDir, "worker-frontend-deployment.json"));
      await runReleaseCli(deploy, dependencies);
      if (mode === "update")
        await runReleaseCli(
          deploy.map((value) => (value === "upload" ? "activate" : value)),
          dependencies,
        );
      assert.equal(uploads, 1);
      assert.equal(builds, 2);
      assert.equal(
        JSON.parse(await readFile(path.join(outDir, "worker-frontend-deployment.json"), "utf8"))
          .version_id,
        candidate,
      );
      const builtPath = path.join(outDir, "wrangler/frontend-built.json");
      await writeFile(builtPath, "{}");
      await assert.rejects(runReleaseCli(deploy, dependencies), /frontend built config/);
    });
  }
}
