import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

interface BenchmarkRun {
  config: {
    measured_samples: number;
    warmup_samples: number;
    delete_samples: number;
    delete_warmup: number;
    batch_sizes: number[];
  };
  dataset: { assets: number; posts: number };
  environment: { arch: string; database_version: string; platform: string; runtime: string };
  revision: { branch: string; sha: string };
  workflows: {
    name: string;
    metrics: {
      cpu_ms: { system_total: number; user_total: number };
      db: { statements_total: number; time_ms_total: number };
      operations: number;
      response_bytes_samples: number[];
      samples_ms: number[];
      setup_ms_total: number;
    };
  }[];
}

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const prepareScript = join(repositoryRoot, "scripts/benchmarks/backend/prepare-database.mjs");
const compareScript = join(repositoryRoot, "workers/api/bench/compare.mjs");
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "meltiply-benchmark-cli-"));
});
afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

/** Runs the real CLI with a short deadline; no external PostgreSQL is needed. */
function runCli(script: string, args: string[], env: Partial<NodeJS.ProcessEnv> = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, BENCHMARK_ALLOW_REMOTE_DATABASE: "0", ...env },
    timeout: 3_000,
  });
  if (result.error) throw result.error;
  return result;
}

/** Supplies independent workload/result data sufficient for a complete comparison. */
function benchmarkRun(): BenchmarkRun {
  const metrics = {
    cpu_ms: { system_total: 0, user_total: 1 },
    db: { statements_total: 1, time_ms_total: 3 },
    operations: 1,
    response_bytes_samples: [100],
    samples_ms: [10],
    setup_ms_total: 0,
  };
  return {
    config: {
      measured_samples: 1,
      warmup_samples: 0,
      delete_samples: 1,
      delete_warmup: 0,
      batch_sizes: [1, 5],
    },
    dataset: { assets: 2, posts: 2 },
    environment: { arch: "x64", database_version: "18.6", platform: "linux", runtime: "Node" },
    revision: { branch: "fixture", sha: "0123456789abcdef" },
    workflows: [
      { name: "posts.list.page100", metrics },
      { name: "calendar.range", metrics: { ...metrics, samples_ms: [25] } },
    ],
  };
}

/** Writes one run under the test's private directory and returns its CLI path. */
function writeRun(name: string, run: BenchmarkRun) {
  const path = join(directory, `${name}.json`);
  writeFileSync(path, JSON.stringify(run));
  return path;
}

/**
 * Observes a real connection to a loopback-only TCP listener, then terminates
 * the CLI before authentication or administrator SQL can run. The non-default
 * 127.0.0.2 address exercises the remote opt-in without contacting a remote DB.
 */
async function databaseConnection(host: string, allowRemote: string) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  const child = spawn(process.execPath, [prepareScript], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      BENCHMARK_DATABASE_ADMIN_URL: `postgres://guard:secret@${host}:${address.port}/postgres?sslmode=disable`,
      BENCHMARK_DATABASE_NAME: "meltiply_bench_cli_test",
      BENCHMARK_ALLOW_REMOTE_DATABASE: allowRemote,
    },
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 3_000,
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error(stderr)));
      server.once("connection", (socket) => {
        const destination = socket.localAddress ?? "";
        socket.destroy();
        resolve(destination);
      });
    });
  } finally {
    child.kill();
    await closed;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("benchmark database administrator host guard", () => {
  it.each([
    { host: "remote.invalid", query: "", optIn: "0" },
    { host: "localhost", query: "?host=remote.invalid", optIn: "0" },
    { host: "localhost", query: "?host=localhost&host=remote.invalid", optIn: "true" },
    { host: "", query: "", optIn: "0" },
  ])("rejects $host$query without an exact opt-in", ({ host, query, optIn }) => {
    const authority = host ? `guard:credential-sentinel@${host}` : "";
    const result = runCli(prepareScript, [], {
      BENCHMARK_DATABASE_ADMIN_URL: `postgres://${authority}/postgres${query}`,
      BENCHMARK_DATABASE_NAME: "meltiply_bench_cli_test",
      BENCHMARK_ALLOW_REMOTE_DATABASE: optIn,
      PGHOST: "remote.invalid",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BENCHMARK_DATABASE_ADMIN_URL must target localhost");
    expect(result.stderr).not.toContain("credential-sentinel");
  });

  it("permits the default loopback host to connect", async () => {
    expect(await databaseConnection("127.0.0.1", "0")).toBe("127.0.0.1");
  });

  it("permits a non-allowlisted host only with the explicit opt-in", async () => {
    expect(await databaseConnection("127.0.0.2", "1")).toBe("127.0.0.2");
  });
});

describe("benchmark workload compatibility", () => {
  const mismatches: {
    field: string;
    change: (run: BenchmarkRun) => void;
  }[] = [
    {
      field: "config",
      change: (run) => {
        run.config.measured_samples = 2;
      },
    },
    {
      field: "dataset",
      change: (run) => {
        run.dataset.posts = 3;
      },
    },
    {
      field: "workflow names",
      change: (run) => {
        run.workflows = run.workflows.slice(1);
      },
    },
  ];

  for (const side of ["baseline", "candidate"]) {
    it.each(mismatches)(
      `rejects incompatible $field in a later ${side} run`,
      ({ field, change }) => {
        const reference = benchmarkRun();
        const incompatible = benchmarkRun();
        change(incompatible);
        const baseline = writeRun("baseline", reference);
        const candidate = writeRun("candidate", reference);
        const mismatch = writeRun("mismatch", incompatible);
        const output = join(directory, "comparison.md");
        const json = join(directory, "comparison.json");
        const result = runCli(compareScript, [
          "--baseline",
          baseline,
          "--candidate",
          candidate,
          `--${side}`,
          mismatch,
          "--out",
          output,
          "--json",
          json,
        ]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${side} run 2: ${field} must match baseline run 1`);
        expect(existsSync(output)).toBe(false);
        expect(existsSync(json)).toBe(false);
      },
    );
  }

  it("pools unequal repetition counts despite metadata key and workflow ordering", () => {
    const reference = benchmarkRun();
    const { warmup_samples, ...config } = reference.config;
    const { posts, ...dataset } = reference.dataset;
    const candidate = {
      ...reference,
      config: { warmup_samples, ...config },
      dataset: { posts, ...dataset },
      workflows: [...reference.workflows].reverse(),
    };
    const baseline = writeRun("baseline", reference);
    const secondRun = benchmarkRun();
    for (const workflow of secondRun.workflows) {
      workflow.metrics.samples_ms = workflow.metrics.samples_ms.map((sample) => sample + 20);
    }
    const secondBaseline = writeRun("baseline-second", secondRun);
    const right = writeRun("candidate", candidate);
    const output = join(directory, "comparison.md");
    const json = join(directory, "comparison.json");
    const result = runCli(compareScript, [
      "--baseline",
      baseline,
      "--baseline",
      secondBaseline,
      "--candidate",
      right,
      "--out",
      output,
      "--json",
      json,
    ]);
    expect(result.status).toBe(0);
    const comparison: unknown = JSON.parse(readFileSync(json, "utf8"));
    expect(comparison).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          name: "posts.list.page100",
          samples: { baseline: 2, candidate: 1 },
          baseline: expect.objectContaining({
            p50: 10,
            p95: 30,
            statementsPerOp: 1,
            throughput: 50,
          }),
          candidate: expect.objectContaining({ p50: 10, statementsPerOp: 1, throughput: 100 }),
        }),
      ]),
    });
  });
});
