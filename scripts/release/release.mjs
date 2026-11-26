#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "./command-runner.mjs";
import { assertIacState, authorizeMutation, verifyReleaseCheckout } from "./release-guard.mjs";
import { buildReleaseManifest } from "./release-manifest.mjs";
import { smokeLiveApi, smokeVersionCandidate } from "./release-smoke.mjs";
import { transitionAutomationCron } from "./release-cron.mjs";
import { migrateDatabase } from "./release-migrate.mjs";
import {
  loadReleaseInputs,
  loadReleaseSpec,
  preflightRelease,
  redactError,
  writeRenderedConfigs,
} from "./release-lib.mjs";
import { parseReleaseArguments, releaseUsage } from "./release-options.mjs";
import { createRestorePoint } from "./release-restore.mjs";
import {
  deployApiRollout,
  deployWorkerStep,
  injectWorkerSecrets,
  resolveDeployPhase,
} from "./release-worker.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readSecretStdin(stream) {
  if (stream.isTTY) throw new TypeError("release secrets must be supplied through stdin");
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += Buffer.byteLength(chunk);
    if (size > 64 * 1024) throw new TypeError("release secret bundle exceeds 65536 bytes");
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) throw new TypeError("release secret bundle stdin is empty");
  return Buffer.concat(chunks).toString("utf8");
}

function workerIacPhase(spec, worker) {
  if (spec.deployment_mode === "update") return "domains-paused";
  return worker === "api" || worker === "frontend" ? "consumers-paused" : "foundation";
}

async function authorize(options, dependencies, spec, expectedApprovalName) {
  return authorizeMutation({
    apply: options.apply,
    approvalPaths: options.approvalMetadata,
    confirm: options.confirm,
    expectedApprovalNames: new Set([expectedApprovalName]),
    planDigest: options.planDigest,
    repoRoot: dependencies.repoRoot ?? repoRoot,
    runCommand: dependencies.runCommand ?? runCommand,
    spec,
  });
}

export async function runReleaseCli(argv, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const options = parseReleaseArguments(argv, environment);
  if (options.help) {
    return { status: "help", usage: releaseUsage(options.command) };
  }
  const commandRunner = dependencies.runCommand ?? runCommand;
  const checkoutRoot = dependencies.repoRoot ?? repoRoot;

  if (options.command === "preflight") {
    const spec = await loadReleaseSpec(options.inputPath);
    return preflightRelease({
      clientFactory: dependencies.clientFactory,
      environment,
      offline: options.offline,
      repoRoot: checkoutRoot,
      runCommand: commandRunner,
      spec,
    });
  }

  if (options.offline) throw new TypeError("--offline is only valid for preflight");
  if (options.command === "migrate") {
    const spec = await loadReleaseSpec(options.inputPath);
    if (!new Set(["bootstrap", "expand"]).has(options.phase)) {
      throw new TypeError("migrate --phase must be bootstrap or expand");
    }
    const approvals = await authorize(
      options,
      dependencies,
      spec,
      `${spec.environment}-foundation-approval`,
    );
    return migrateDatabase({
      approvals,
      clientFactory: dependencies.clientFactory,
      environment,
      now: dependencies.now,
      outDir: options.outDir,
      phase: options.phase,
      planDigest: options.planDigest,
      repoRoot: checkoutRoot,
      spec,
    });
  }

  const { iac, spec } = await loadReleaseInputs(options);
  if (options.command === "restore-point") {
    assertIacState(
      iac,
      spec.deployment_mode === "bootstrap" ? "foundation" : "domains-paused",
      spec,
    );
    const approvals = await authorize(
      options,
      dependencies,
      spec,
      `${spec.environment}-foundation-approval`,
    );
    return createRestorePoint({
      approvals,
      environment,
      fetchImpl: dependencies.fetchImpl,
      now: dependencies.now,
      outDir: options.outDir,
      planDigest: options.planDigest,
      spec,
    });
  }
  if (options.command === "render") {
    const rendered = await writeRenderedConfigs({
      iac,
      outDir: options.outDir,
      repoRoot: checkoutRoot,
      spec,
    });
    return {
      config_digest: rendered.config_digest,
      deployment_mode: spec.deployment_mode,
      environment: spec.environment,
      paths: Object.fromEntries(
        Object.entries(rendered.paths).map(([worker, outputPath]) => [
          worker,
          path.relative(checkoutRoot, outputPath),
        ]),
      ),
      release_id: spec.release_id,
      status: "rendered",
    };
  }

  if (options.command === "cron") {
    if (!new Set(["cron-activate", "cron-pause"]).has(options.phase)) {
      throw new TypeError("cron --phase must be cron-pause or cron-activate");
    }
    const activating = options.phase === "cron-activate";
    assertIacState(
      iac,
      activating
        ? "active"
        : spec.deployment_mode === "bootstrap"
          ? "foundation"
          : "domains-paused",
      spec,
    );
    const approvals = await authorize(
      options,
      dependencies,
      spec,
      `${spec.environment}-${activating ? "queue-resume" : "foundation"}-approval`,
    );
    return transitionAutomationCron({
      approvals,
      environment,
      fetchImpl: dependencies.fetchImpl,
      outDir: options.outDir,
      phase: options.phase,
      planDigest: options.planDigest,
      runCommand: commandRunner,
      spec,
    });
  }

  if (options.command === "deploy") {
    if (!options.phase) throw new TypeError("deploy requires --phase");
    if (options.phase === "api-rollout") {
      if (!options.percentage) throw new TypeError("api-rollout requires --percentage");
      if (options.step) throw new TypeError("api-rollout does not accept --step");
      assertIacState(iac, "domains-paused", spec);
      const approvals = await authorize(
        options,
        dependencies,
        spec,
        `${spec.environment}-traffic-approval`,
      );
      return deployApiRollout({
        approvals,
        environment,
        outDir: options.outDir,
        percentage: options.percentage,
        planDigest: options.planDigest,
        runCommand: commandRunner,
        spec,
      });
    }
    if (!options.step) throw new TypeError("Worker deploy phases require --step");
    if (options.percentage) throw new TypeError("Worker deploy phases do not accept --percentage");
    const intent = resolveDeployPhase(options.phase, options.step, spec);
    assertIacState(iac, workerIacPhase(spec, intent.worker), spec);
    const approvals = await authorize(
      options,
      dependencies,
      spec,
      `${spec.environment}-foundation-approval`,
    );
    return deployWorkerStep({
      approvals,
      environment,
      iac,
      outDir: options.outDir,
      phase: options.phase,
      planDigest: options.planDigest,
      runCommand: commandRunner,
      repoRoot: checkoutRoot,
      spec,
      step: options.step,
    });
  }

  if (options.command === "secrets") {
    if (!new Set(["api", "automation"]).has(options.phase)) {
      throw new TypeError("secrets --phase must be api or automation");
    }
    if (options.step || options.percentage) {
      throw new TypeError("secrets does not accept --step or --percentage");
    }
    assertIacState(iac, workerIacPhase(spec, options.phase), spec);
    const approvals = await authorize(
      options,
      dependencies,
      spec,
      `${spec.environment}-foundation-approval`,
    );
    const secretSource =
      dependencies.stdin ?? (await readSecretStdin(dependencies.stdinStream ?? process.stdin));
    return injectWorkerSecrets({
      approvals,
      environment,
      outDir: options.outDir,
      planDigest: options.planDigest,
      runCommand: commandRunner,
      secretSource,
      spec,
      worker: options.phase,
    });
  }

  if (options.command === "smoke") {
    if (!new Set(["version", "live"]).has(options.phase)) {
      throw new TypeError("smoke --phase must be version or live");
    }
    await verifyReleaseCheckout({
      repoRoot: checkoutRoot,
      runCommand: commandRunner,
      spec,
    });
    if (options.phase === "version") {
      assertIacState(iac, workerIacPhase(spec, "api"), spec);
      return smokeVersionCandidate({
        environment,
        fetchImpl: dependencies.fetchImpl,
        outDir: options.outDir,
        runCommand: commandRunner,
        spec,
      });
    }
    assertIacState(iac, "domains-paused", spec);
    return smokeLiveApi({
      environment,
      fetchImpl: dependencies.fetchImpl,
      outDir: options.outDir,
      percentage: options.percentage,
      runCommand: commandRunner,
      spec,
    });
  }

  if (options.command === "manifest") {
    await verifyReleaseCheckout({
      repoRoot: checkoutRoot,
      runCommand: commandRunner,
      spec,
    });
    assertIacState(iac, "active", spec);
    return buildReleaseManifest({
      approvalPaths: options.approvalMetadata,
      environment,
      iac,
      outDir: options.outDir,
      repoRoot: checkoutRoot,
      spec,
    });
  }

  throw new TypeError(`release command ${options.command} is not implemented`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runReleaseCli(process.argv.slice(2))));
  } catch (error) {
    console.error(redactError(error, process.env));
    process.exitCode = 1;
  }
}
