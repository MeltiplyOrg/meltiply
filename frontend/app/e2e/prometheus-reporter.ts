import { createServer, type Server } from "node:http";

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

type Status = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";

type Metrics = {
  durationSeconds: number;
  lastRunSuccess: number;
  lastRunTimestamp: number;
  startedAt: number;
  statuses: Record<Status, number>;
  total: number;
};

const defaultPort = 9464;
const metricsPath = "/metrics";
const contentType = "text/plain; version=0.0.4; charset=utf-8";

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function metricLine(name: string, value: number, labels: Record<string, string> = {}): string {
  const entries = Object.entries(labels);
  const suffix = entries.length
    ? `{${entries.map(([key, item]) => `${key}="${label(item)}"`).join(",")}}`
    : "";
  return `${name}${suffix} ${Number.isFinite(value) ? value : 0}`;
}

function freshMetrics(): Metrics {
  return {
    durationSeconds: 0,
    lastRunSuccess: 0,
    lastRunTimestamp: 0,
    startedAt: Date.now() / 1_000,
    statuses: {
      failed: 0,
      interrupted: 0,
      passed: 0,
      skipped: 0,
      timedOut: 0,
    },
    total: 0,
  };
}

function renderMetrics(metrics: Metrics, project: string): string {
  const lines = [
    "# HELP meltiply_frontend_e2e_tests_total Number of completed browser test attempts.",
    "# TYPE meltiply_frontend_e2e_tests_total counter",
    ...Object.entries(metrics.statuses).map(([status, value]) =>
      metricLine("meltiply_frontend_e2e_tests_total", value, { project, status }),
    ),
    "# HELP meltiply_frontend_e2e_test_duration_seconds_sum Total browser test duration in seconds.",
    "# TYPE meltiply_frontend_e2e_test_duration_seconds_sum counter",
    metricLine("meltiply_frontend_e2e_test_duration_seconds_sum", metrics.durationSeconds, {
      project,
    }),
    "# HELP meltiply_frontend_e2e_test_duration_seconds_count Number of completed browser test attempts.",
    "# TYPE meltiply_frontend_e2e_test_duration_seconds_count counter",
    metricLine("meltiply_frontend_e2e_test_duration_seconds_count", metrics.total, { project }),
    "# HELP meltiply_frontend_e2e_last_run_success Whether the latest completed browser run passed.",
    "# TYPE meltiply_frontend_e2e_last_run_success gauge",
    metricLine("meltiply_frontend_e2e_last_run_success", metrics.lastRunSuccess, { project }),
    "# HELP meltiply_frontend_e2e_last_run_timestamp_seconds Unix timestamp of the latest completed browser run.",
    "# TYPE meltiply_frontend_e2e_last_run_timestamp_seconds gauge",
    metricLine("meltiply_frontend_e2e_last_run_timestamp_seconds", metrics.lastRunTimestamp, {
      project,
    }),
    "# HELP meltiply_frontend_e2e_run_started_timestamp_seconds Unix timestamp when the browser run started.",
    "# TYPE meltiply_frontend_e2e_run_started_timestamp_seconds gauge",
    metricLine("meltiply_frontend_e2e_run_started_timestamp_seconds", metrics.startedAt, {
      project,
    }),
  ];
  return `${lines.join("\n")}\n`;
}

export default class PrometheusReporter implements Reporter {
  private metrics = freshMetrics();
  private project = "unknown";
  private server: Server | undefined;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.project = suite.allTests()[0]?.parent.project()?.name ?? "frontend-e2e";
    const port = Number(process.env.MELTIPLY_E2E_METRICS_PORT ?? defaultPort);
    const host = process.env.MELTIPLY_E2E_METRICS_HOST ?? "0.0.0.0";
    this.server = createServer((request, response) => {
      if (request.url !== metricsPath) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": contentType });
      response.end(renderMetrics(this.metrics, this.project));
    });
    this.server.on("error", (error) => {
      console.error("[meltiply:frontend-e2e-metrics] server error", error);
    });
    this.server.listen(port, host, () => {
      console.info(`[meltiply:frontend-e2e-metrics] listening on ${host}:${port}${metricsPath}`);
    });
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    const status = (result.status ?? "interrupted") as Status;
    this.metrics.statuses[status] += 1;
    this.metrics.total += 1;
    this.metrics.durationSeconds += result.duration / 1_000;
  }

  /**
   * Finalizes scrape metrics and optionally pushes them to an explicitly configured gateway.
   * Local/CI runs without a gateway perform no network push; configured gateway failures
   * remain diagnostic and do not replace the browser suite's own outcome.
   */
  async onEnd(result: FullResult): Promise<void> {
    this.metrics.lastRunSuccess = result.status === "passed" ? 1 : 0;
    this.metrics.lastRunTimestamp = Date.now() / 1_000;

    const pushgatewayUrl = process.env.MELTIPLY_E2E_PUSHGATEWAY_URL?.trim();
    if (!pushgatewayUrl) return;
    try {
      const response = await fetch(`${pushgatewayUrl}/metrics/job/meltiply-frontend-e2e`, {
        body: renderMetrics(this.metrics, this.project),
        headers: { "content-type": contentType },
        method: "PUT",
      });
      if (!response.ok) {
        throw new Error(`Pushgateway returned HTTP ${response.status}`);
      }
    } catch (error) {
      console.error("[meltiply:frontend-e2e-metrics] push failed", error);
    }
  }

  async onExit(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }

  printsToStdio(): boolean {
    return false;
  }
}
