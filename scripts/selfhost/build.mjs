import { mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseJsonc } from "../lib/jsonc.mjs";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(root, "dist/selfhost");
await mkdir(output, { recursive: true });
const automation = parseJsonc(
  await readFile(resolve(root, "workers/automation/wrangler.jsonc"), "utf8"),
);
const local = parseJsonc(
  await readFile(resolve(root, "workers/automation/wrangler.local.jsonc"), "utf8"),
);
const queues = {};
for (const producer of automation.queues.producers) {
  const localProducer = local.queues.producers.find((entry) => entry.binding === producer.binding);
  const consumer = local.queues.consumers.find((entry) => entry.queue === localProducer?.queue);
  if (!consumer) throw new Error(`Missing queue policy for ${producer.binding}`);
  queues[producer.queue.replace(/-staging$/, "-selfhost")] = {
    binding: producer.binding,
    maxBatchSize: consumer.max_batch_size,
    maxRetries: consumer.max_retries,
    retryDelay: consumer.retry_delay ?? 5,
    deadLetterQueue: producer.queue.replace(/-staging$/, "-selfhost-dlq"),
  };
}
await writeFile(resolve(output, "queues.json"), JSON.stringify(queues));

const metadata = {};
for (const [name, entry] of Object.entries({
  api: "scripts/selfhost/api.ts",
  automation: "scripts/selfhost/automation.ts",
  state: "workers/state/src/index.ts",
  bindings: "scripts/selfhost/bindings.ts",
  diagnostics: "scripts/selfhost/diagnostics.ts",
  frontend: "frontend/app/src/worker.ts",
})) {
  const sourcePath =
    name === "frontend"
      ? "frontend/app/wrangler.jsonc"
      : `workers/${["bindings", "diagnostics"].includes(name) ? "automation" : name}/wrangler.jsonc`;
  const source = parseJsonc(await readFile(resolve(root, sourcePath), "utf8"));
  metadata[name] = {
    entry: `${basename(entry, ".ts")}.js`,
    compatibilityDate: source.compatibility_date,
    compatibilityFlags: source.compatibility_flags ?? [],
  };
  const configPath = resolve(output, `${name}.json`);
  await writeFile(
    configPath,
    JSON.stringify({
      name: `meltiply-selfhost-${name}`,
      main: resolve(root, entry),
      compatibility_date: source.compatibility_date,
      compatibility_flags: source.compatibility_flags ?? [],
    }),
  );
  try {
    const result = spawnSync(
      "bun",
      [
        "x",
        "--no-install",
        "wrangler",
        "deploy",
        "--config",
        configPath,
        "--dry-run",
        "--minify",
        "--outdir",
        resolve(output, name),
      ],
      { cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
    if (result.status !== 0) throw new Error(`Worker build failed: ${name}`);
  } finally {
    await rm(configPath);
  }
}
await writeFile(resolve(output, "metadata.json"), JSON.stringify(metadata));
await cp(resolve(root, "frontend/app/dist/client"), resolve(output, "app"), { recursive: true });
await cp(resolve(root, "frontend/public/dist"), resolve(output, "public"), { recursive: true });
