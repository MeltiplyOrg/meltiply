// Compares two sets of backend benchmark runs and writes the Markdown report.
//
// Samples from every repetition are pooled. Configuration, dataset, and workflow
// names must match across every input before aggregation; failed scenarios are
// reported explicitly rather than dropped.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

/** Parses repeated `--flag value` pairs. */
function parseArgs(argv) {
  const parsed = { baseline: [], candidate: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--baseline" || flag === "--candidate" || flag === "--out" || flag === "--json") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === "--out" || flag === "--json") parsed[flag.slice(2)] = value;
      else parsed[flag.slice(2)].push(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (parsed.baseline.length === 0 || parsed.candidate.length === 0) {
    throw new Error("at least one --baseline and one --candidate result file are required");
  }
  if (!parsed.out) throw new Error("--out is required");
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const baselineRuns = args.baseline.map((file) => JSON.parse(readFileSync(file, "utf8")));
const candidateRuns = args.candidate.map((file) => JSON.parse(readFileSync(file, "utf8")));

/** Nearest-rank percentile. */
function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)];
}

/** Rounds to two decimals. */

/** Formats a number with fixed decimals. */
const fixed = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : "n/a");

/** Percent change from baseline to candidate; null when the baseline is zero. */
function change(baseline, candidate) {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate) || baseline === 0) return null;
  return ((candidate - baseline) / baseline) * 100;
}

/** Formats a signed percentage. */
function signedPercent(value) {
  return value === null ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/**
 * Rejects incomparable workloads before pooling samples or writing reports.
 * Every repetition on both sides must match the first baseline's config,
 * dataset, and sorted workflow names. Object key and workflow order do not
 * matter; array values and all configuration fields do. Repetition counts,
 * revision metadata, and measured results are deliberately not compared.
 */
function validateWorkloads(baselines, candidates) {
  const reference = baselines[0];
  const names = reference.workflows.map((workflow) => workflow.name).sort();
  for (const [label, runs] of [
    ["baseline", baselines],
    ["candidate", candidates],
  ]) {
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      for (const field of ["config", "dataset"]) {
        if (
          !run[field] ||
          typeof run[field] !== "object" ||
          Array.isArray(run[field]) ||
          !isDeepStrictEqual(run[field], reference[field])
        ) {
          throw new TypeError(`${label} run ${index + 1}: ${field} must match baseline run 1`);
        }
      }
      const workflowNames = run.workflows.map((workflow) => workflow.name).sort();
      if (!isDeepStrictEqual(workflowNames, names)) {
        throw new TypeError(`${label} run ${index + 1}: workflow names must match baseline run 1`);
      }
    }
  }
}

/** Aggregates the runs of one revision into pooled per-scenario metrics. */
function aggregate(runs) {
  const workflows = new Map();
  for (const run of runs) {
    for (const workflow of run.workflows) {
      const bucket = workflows.get(workflow.name) ?? {
        errors: [],
        operations: 0,
        requestSamples: [],
        responseBytes: [],
        samples: [],
        statements: 0,
        statementTimeMs: 0,
        cpuMs: 0,
        setupMs: 0,
      };
      if (workflow.error) {
        bucket.errors.push(workflow.error);
        workflows.set(workflow.name, bucket);
        continue;
      }
      const metrics = workflow.metrics;
      bucket.samples.push(...metrics.samples_ms);
      bucket.requestSamples.push(...(metrics.request_samples_ms ?? metrics.samples_ms));
      bucket.responseBytes.push(...(metrics.response_bytes_samples ?? []));
      bucket.operations += metrics.operations;
      bucket.statements += metrics.db.statements_total;
      bucket.statementTimeMs += metrics.db.time_ms_total;
      bucket.cpuMs += metrics.cpu_ms.user_total + metrics.cpu_ms.system_total;
      bucket.setupMs += metrics.setup_ms_total ?? 0;
      workflows.set(workflow.name, bucket);
    }
  }
  return workflows;
}

validateWorkloads(baselineRuns, candidateRuns);

const baseline = aggregate(baselineRuns);
const candidate = aggregate(candidateRuns);
const scenarioNames = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();

/** Builds one comparison row, leaving unavailable metrics as `n/a`. */
function comparisonRow(name) {
  const left = baseline.get(name);
  const right = candidate.get(name);
  if (!left || !right || left.errors.length > 0 || right.errors.length > 0) {
    return { name, unavailable: true };
  }
  const metrics = (bucket) => ({
    bytes: percentile(bucket.responseBytes, 0.5),
    cpuPerOp: bucket.cpuMs / bucket.operations,
    dbMsPerOp: bucket.statementTimeMs / bucket.operations,
    p50: percentile(bucket.samples, 0.5),
    p95: percentile(bucket.samples, 0.95),
    p99: percentile(bucket.samples, 0.99),
    reqP95: percentile(bucket.requestSamples, 0.95),
    setupMs: bucket.setupMs,
    statementsPerOp: bucket.statements / bucket.operations,
    throughput:
      bucket.operations / (bucket.samples.reduce((total, value) => total + value, 0) / 1_000),
  });
  return {
    baseline: metrics(left),
    candidate: metrics(right),
    name,
    samples: { baseline: left.samples.length, candidate: right.samples.length },
  };
}

const rows = scenarioNames.map(comparisonRow);
const revisions = {
  baseline: [
    ...new Set(
      baselineRuns.map((run) => `${run.revision.branch}@${run.revision.sha.slice(0, 12)}`),
    ),
  ],
  candidate: [
    ...new Set(
      candidateRuns.map((run) => `${run.revision.branch}@${run.revision.sha.slice(0, 12)}`),
    ),
  ],
};
const first = baselineRuns[0];
const failed = rows.filter((row) => row.unavailable);

const markdown = [];
markdown.push("# Backend benchmark comparison", "");
markdown.push(`Baseline: ${revisions.baseline.join(", ")}`, "");
markdown.push(`Candidate: ${revisions.candidate.join(", ")}`, "");
markdown.push("## Environment and workload", "");
markdown.push(
  `- Environment: ${first.environment.platform}/${first.environment.arch}, ${first.environment.runtime}`,
);
markdown.push(
  `- PostgreSQL: ${first.environment.database_version} (service container), one dedicated database per revision`,
);
markdown.push(`- Dataset: ${JSON.stringify(first.dataset)}`);
markdown.push(`- Configuration: ${JSON.stringify(first.config)}`);
markdown.push(
  `- Repetitions: ${baselineRuns.length} baseline runs, ${candidateRuns.length} candidate runs, alternating order`,
);
markdown.push(
  `- Samples per run: ${first.config.measured_samples} measured read/mutation samples after ${first.config.warmup_samples} warm-ups; deletion batches use ${first.config.delete_samples} samples after ${first.config.delete_warmup} warm-up`,
);
markdown.push("");
markdown.push("## Latency and throughput", "");
markdown.push(
  "| Workflow | Samples (B/C) | p50 B | p50 C | Δ p50 | p95 B | p95 C | Δ p95 | p99 B | p99 C | Δ p99 | Throughput B | Throughput C | Δ |",
);
markdown.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of rows) {
  if (row.unavailable) {
    markdown.push(
      `| ${row.name} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`,
    );
    continue;
  }
  const { baseline: b, candidate: c, samples } = row;
  markdown.push(
    `| ${row.name} | ${samples.baseline}/${samples.candidate} | ${fixed(b.p50)} | ${fixed(c.p50)} | ${signedPercent(change(b.p50, c.p50))} | ${fixed(b.p95)} | ${fixed(c.p95)} | ${signedPercent(change(b.p95, c.p95))} | ${fixed(b.p99)} | ${fixed(c.p99)} | ${signedPercent(change(b.p99, c.p99))} | ${fixed(b.throughput)} | ${fixed(c.throughput)} | ${signedPercent(change(b.throughput, c.throughput))} |`,
  );
}
markdown.push("");
markdown.push("## Database and resource use", "");
markdown.push(
  "| Workflow | Statements/op B | Statements/op C | DB ms/op B | DB ms/op C | Response bytes B | Response bytes C | CPU ms/op B | CPU ms/op C | Fixture setup ms total B | Fixture setup ms total C |",
);
markdown.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of rows) {
  if (row.unavailable) {
    markdown.push(`| ${row.name} | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`);
    continue;
  }
  const { baseline: b, candidate: c } = row;
  markdown.push(
    `| ${row.name} | ${fixed(b.statementsPerOp)} | ${fixed(c.statementsPerOp)} | ${fixed(b.dbMsPerOp)} | ${fixed(c.dbMsPerOp)} | ${fixed(b.bytes)} | ${fixed(c.bytes)} | ${fixed(b.cpuPerOp)} | ${fixed(c.cpuPerOp)} | ${fixed(b.setupMs, 0)} | ${fixed(c.setupMs, 0)} |`,
  );
}
markdown.push("");
markdown.push("## Limitations", "");
markdown.push(
  "- The benchmark calls the API app in-process instead of deploying a Worker; Cloudflare CPU-time metrics, Queue latency, and network/provider time are unavailable.",
);
markdown.push(
  "- CPU is the whole Node process (`process.cpuUsage`), including fixture-free benchmark driver work; it is directional, not per-request platform CPU.",
);
markdown.push(
  "- RSS/heap measurements are captured around each scenario and are noisy; only peak RSS is meaningful.",
);
markdown.push(
  "- p99 for deletion batches is computed from pooled batch samples, not individual requests; per-request p95 is reported in the raw JSON.",
);
markdown.push(
  "- Publishing Provider HTTP calls, Queues delivery, and Durable Object work are outside this harness; schedule fan-out and outbox writes are measured.",
);
if (failed.length > 0) {
  markdown.push("");
  markdown.push("## Incomplete scenarios", "");
  for (const row of failed)
    markdown.push(`- ${row.name}: missing data or a recorded error; not compared.`);
}
markdown.push("");
markdown.push("## Raw results", "");
for (const file of [...args.baseline, ...args.candidate]) markdown.push(`- \`${file}\``);
markdown.push("");

const outPath = resolve(args.out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${markdown.join("\n")}\n`);
if (args.json) {
  writeFileSync(
    resolve(args.json),
    `${JSON.stringify({ baseline_revision: revisions.baseline, candidate_revision: revisions.candidate, rows }, null, 2)}\n`,
  );
}
process.stdout.write(`wrote ${outPath}\n`);
if (failed.length > 0) process.exitCode = 1;
