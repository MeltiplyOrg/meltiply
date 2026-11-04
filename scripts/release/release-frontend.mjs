import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, sha256 } from "./release-guard.mjs";
import { releaseInternals } from "./release-lib.mjs";

/**
 * Builds the selected production bundle from the reviewed Wrangler source, then
 * rebases Vite's flattened deploy config into private release scratch. Assets
 * remain in frontend/app/dist, outside the publishable evidence directory.
 * Throws before upload if Vite changed the reviewed identity or routing.
 */
export async function buildFrontend({
  configPath,
  environment,
  outDir,
  repoRoot,
  runCommand,
  spec,
}) {
  const source = await readJsonFile(configPath, "reviewed frontend config");
  await runCommand("bun", ["run", "--filter", "frontend-app", `build:${spec.environment}`], {
    cwd: repoRoot,
    env: {
      ...environment,
      APP_URL: spec.app_url,
      CLOUDFLARE_ENV: spec.environment,
      CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: path.resolve(configPath),
    },
  });
  const generatedPath = path.join(repoRoot, "frontend/app/dist/frontend/wrangler.json");
  const built = await readJsonFile(generatedPath, "built frontend config", 1024 * 1024);
  if (
    built.name !== source.name ||
    built.vars?.VERSION !== spec.git_sha ||
    built.vars?.ENVIRONMENT !== spec.environment ||
    built.vars?.API_ORIGIN !== undefined ||
    JSON.stringify(built.services) !== JSON.stringify(source.services) ||
    built.assets?.binding !== source.assets?.binding ||
    built.assets?.not_found_handling !== source.assets?.not_found_handling ||
    JSON.stringify(built.assets?.run_worker_first) !==
      JSON.stringify(source.assets?.run_worker_first) ||
    built.no_bundle !== true ||
    typeof built.main !== "string" ||
    !/\.m?js$/.test(built.main) ||
    typeof built.assets?.directory !== "string" ||
    built.env
  ) {
    throw new TypeError("frontend build does not match the reviewed release config");
  }
  const target = path.join(outDir, "wrangler/frontend-built.json");
  for (const field of ["main", "$schema"]) {
    if (typeof built[field] === "string") {
      built[field] = path
        .relative(path.dirname(target), path.resolve(path.dirname(generatedPath), built[field]))
        .split(path.sep)
        .join("/");
    }
  }
  built.assets.directory = path
    .relative(
      path.dirname(target),
      path.resolve(path.dirname(generatedPath), built.assets.directory),
    )
    .split(path.sep)
    .join("/");
  const content = releaseInternals.json(built);
  await writeFile(target, content, { mode: 0o600 });
  return { configPath: target, build_config_digest: sha256(content) };
}

/**
 * Refuses domain mutation or manifest publication without frontend candidate and
 * full deployment evidence for this release, reviewed name, and exact source /
 * generated config bytes. Missing or mismatched artifacts name the frontend step.
 * Returns the validated evidence pair; never contacts or mutates a provider.
 */
export async function assertFrontendReleaseEvidence({ iac, outDir, spec }) {
  try {
    const candidate = await readJsonFile(
      path.join(outDir, "worker-frontend-candidate.json"),
      "frontend candidate evidence",
    );
    const deployment = await readJsonFile(
      path.join(outDir, "worker-frontend-deployment.json"),
      "frontend deployment evidence",
    );
    const source = await readFile(path.join(outDir, "wrangler/frontend.json"), "utf8");
    const built = await readFile(path.join(outDir, "wrangler/frontend-built.json"), "utf8");
    const config = JSON.parse(source);
    const builtConfig = JSON.parse(built);
    for (const record of [candidate, deployment]) {
      if (
        record.schema_version !== 1 ||
        record.worker !== "frontend" ||
        record.git_sha !== spec.git_sha ||
        record.release_id !== spec.release_id ||
        record.worker_name !== iac.frontend_worker_name ||
        record.config_digest !== sha256(source) ||
        record.build_config_digest !== sha256(built)
      ) {
        throw new TypeError("candidate/deployment identity or config differs from this release");
      }
    }
    if (
      config.name !== iac.frontend_worker_name ||
      builtConfig.name !== config.name ||
      config.vars?.VERSION !== spec.git_sha ||
      config.vars?.ENVIRONMENT !== spec.environment ||
      builtConfig.vars?.VERSION !== spec.git_sha ||
      builtConfig.vars?.ENVIRONMENT !== spec.environment ||
      config.services?.find((binding) => binding.binding === "API")?.service !==
        iac.worker_names.api ||
      builtConfig.services?.find((binding) => binding.binding === "API")?.service !==
        iac.worker_names.api ||
      candidate.deployment_mode !== spec.deployment_mode ||
      candidate.step !== (spec.deployment_mode === "bootstrap" ? "initialize" : "upload") ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(candidate.version_id) ||
      deployment.version_id !== candidate.version_id ||
      deployment.traffic?.length !== 1 ||
      deployment.traffic[0].version_id !== candidate.version_id ||
      deployment.traffic[0].percentage !== 100
    ) {
      throw new TypeError("candidate/deployment does not prove the reviewed frontend activation");
    }
    return { candidate, deployment };
  } catch (error) {
    throw new TypeError(`frontend deploy step evidence is missing or mismatched: ${error.message}`);
  }
}
