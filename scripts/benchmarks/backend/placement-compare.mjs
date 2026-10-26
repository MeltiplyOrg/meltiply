import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Validates an operator-provided origin; credentials and URL query strings never enter reports. */
function originFor(value, label) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new TypeError(`${label} must be an HTTPS origin (HTTP is allowed only on loopback)`);
  }
  return url.origin;
}

/** Measures complete authenticated HTTP reads, including forwarding and response consumption, without retaining private bodies. */
export async function comparePlacement(input, fetcher = fetch) {
  const baseline = originFor(input.baseline, "baseline");
  const candidate = originFor(input.candidate, "candidate");
  if (baseline === candidate)
    throw new TypeError("baseline and candidate must be distinct origins");
  if (!input.token?.trim() || /[\r\n]/u.test(input.token))
    throw new TypeError("MELTIPLY_BENCHMARK_TOKEN is required");
  if (!Number.isInteger(input.samples) || input.samples < 1 || input.samples > 1000)
    throw new TypeError("samples must be an integer from 1 to 1000");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.workspaceId))
    throw new TypeError("workspace must be a UUID");
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || start >= end)
    throw new TypeError("start and end must form an increasing timestamp range");
  const range = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
  const workflows = [
    { name: "posts.page60", paths: ["/api/v1/posts?limit=60&offset=0"] },
    {
      name: "analytics.page",
      paths: [
        `/api/v1/analytics/dashboard?${range}`,
        `/api/v1/analytics/posts?${range}&metric=views&limit=10&offset=0`,
      ],
    },
  ];
  const observations = [];
  for (const workflow of workflows) {
    for (let sample = -1; sample < input.samples; sample += 1) {
      const order =
        sample % 2 === 0
          ? [
              ["baseline", baseline],
              ["candidate", candidate],
            ]
          : [
              ["candidate", candidate],
              ["baseline", baseline],
            ];
      for (const [revision, origin] of order) {
        const started = performance.now();
        const responses = await Promise.all(
          workflow.paths.map(async (path) => {
            const response = await fetcher(`${origin}${path}`, {
              headers: {
                Authorization: `Bearer ${input.token}`,
                "X-Workspace-ID": input.workspaceId,
              },
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
            });
            // Never retain private bodies or allocate one buffer for the entire response.
            if (response.status !== 200) {
              await response.body?.cancel();
              throw new Error(`${revision} ${workflow.name} returned HTTP ${response.status}`);
            }
            let bytes = 0;
            if (response.body) {
              const reader = response.body.getReader();
              try {
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  bytes += chunk.value.byteLength;
                }
              } finally {
                reader.releaseLock();
              }
            }
            return {
              bytes,
              placement: response.headers.get("cf-placement"),
              ray: response.headers.get("cf-ray"),
            };
          }),
        );
        if (sample >= 0)
          observations.push({
            revision,
            workflow: workflow.name,
            sample,
            elapsed_ms: performance.now() - started,
            responses,
          });
      }
    }
  }
  const summaries = [];
  for (const workflow of workflows) {
    for (const revision of ["baseline", "candidate"]) {
      const samples = observations.filter(
        (entry) => entry.workflow === workflow.name && entry.revision === revision,
      );
      const durations = samples
        .map((entry) => entry.elapsed_ms)
        .sort((left, right) => left - right);
      const percentile = (fraction) => durations[Math.ceil(durations.length * fraction) - 1];
      summaries.push({
        workflow: workflow.name,
        revision,
        samples: durations.length,
        p50_ms: percentile(0.5),
        p95_ms: percentile(0.95),
        p99_ms: percentile(0.99),
        response_bytes: samples.reduce(
          (sum, entry) =>
            sum + entry.responses.reduce((total, response) => total + response.bytes, 0),
          0,
        ),
      });
    }
  }
  return {
    measured_at: new Date().toISOString(),
    client_location: input.location,
    origins: { baseline, candidate },
    exact_window: { start: start.toISOString(), end: end.toISOString() },
    placement_observed: observations.every((entry) =>
      entry.responses.every((response) => response.placement !== null),
    ),
    summaries,
    observations,
  };
}

/** Runs a read-only experiment against two already-deployed versions; never deploys or changes routing. */
async function main() {
  const args = process.argv.slice(2);
  const values = new Map();
  const allowed = new Set([
    "--baseline",
    "--candidate",
    "--workspace",
    "--start",
    "--end",
    "--location",
    "--samples",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || !args[index + 1] || values.has(args[index]))
      throw new TypeError(
        "Expected unique --baseline, --candidate, --workspace, --start, --end, --location and optional --samples",
      );
    values.set(args[index], args[index + 1]);
  }
  if (!values.get("--location")?.trim())
    throw new TypeError("--location must identify the actual client location");
  const report = await comparePlacement({
    baseline: values.get("--baseline"),
    candidate: values.get("--candidate"),
    workspaceId: values.get("--workspace"),
    start: values.get("--start"),
    end: values.get("--end"),
    location: values.get("--location"),
    samples: Number(values.get("--samples") ?? 30),
    token: process.env.MELTIPLY_BENCHMARK_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // Transport errors may embed credentials or signed URLs; retain only a safe actionable failure.
    process.stderr.write(
      "Placement comparison failed: verify origins, live bearer session, Workspace, range and endpoint availability. No deployment changes were made.\n",
    );
    process.exitCode = 1;
  });
}
