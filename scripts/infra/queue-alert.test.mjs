import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { alertQueue } from "./queue-alert.mjs";
import { parseQueueArguments } from "./queue-ops.mjs";

test("unsampled Queue alerts reach the webhook; metrics or delivery failures cannot appear healthy", async () => {
  let mode = "unhealthy";
  const alerts = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/notify") {
      let body = "";
      for await (const chunk of request) body += chunk;
      alerts.push(JSON.parse(body));
      response.writeHead(mode === "delivery-failed" ? 503 : 204);
      response.end();
      return;
    }
    if (mode === "metrics-failed") {
      response.writeHead(503);
      response.end("sensitive origin failure");
      return;
    }
    const pathname = new URL(request.url, "http://fixture").pathname;
    const result = pathname.endsWith("/metrics")
      ? mode === "malformed"
        ? {}
        : {
            backlog_bytes: 10,
            backlog_count: mode === "healthy" ? 0 : 1,
            oldest_message_timestamp_ms: mode === "healthy" ? 0 : Date.now() - 120_000,
          }
      : [
          { queue_id: "source", queue_name: "meltiply-publish-threads-staging-dlq" },
          { queue_id: "target", queue_name: "meltiply-publish-threads-staging" },
        ];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: true, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const options = parseQueueArguments([
    "metrics",
    "--environment",
    "staging",
    "--workload",
    "publish-threads",
  ]);
  const dependencies = {
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "never-report-token",
      MELTIPLY_ALERT_WEBHOOK_URL: `${origin}/notify`,
    },
    // External transport adapter routes the Cloudflare API to a real HTTP fixture.
    fetchImpl: (url, init) =>
      fetch(
        String(url).startsWith("https://api.cloudflare.com/")
          ? `${origin}${new URL(url).pathname}`
          : url,
        init,
      ),
  };
  try {
    const unhealthy = await alertQueue(options, dependencies);
    assert.equal(unhealthy.notification, "delivered");
    assert.equal(unhealthy.healthy, false);
    assert.deepEqual(alerts[0].alerts, ["workload_age", "dead_letter_backlog"]);
    assert.ok(!JSON.stringify(alerts).includes("never-report-token"));
    mode = "healthy";
    const healthy = await alertQueue(options, dependencies);
    assert.equal(healthy.notification, "not_needed");
    assert.equal(alerts.length, 1);
    mode = "metrics-failed";
    await assert.rejects(alertQueue(options, dependencies), /monitor-failure alert delivered/u);
    assert.deepEqual(alerts.at(-1).alerts, ["queue_monitor_unavailable"]);
    mode = "malformed";
    await assert.rejects(alertQueue(options, dependencies));
    assert.deepEqual(alerts.at(-1).alerts, ["queue_monitor_unavailable"]);
    mode = "delivery-failed";
    await assert.rejects(alertQueue(options, dependencies), /alert delivery failed/u);
    await assert.rejects(
      alertQueue(options, {
        ...dependencies,
        environment: {
          ...dependencies.environment,
          MELTIPLY_ALERT_WEBHOOK_URL: "http://public.example/secret",
        },
      }),
      /HTTPS/u,
    );
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
});
