import { pathToFileURL } from "node:url";
import { parseQueueArguments, runQueueCommand } from "./queue-ops.mjs";

/**
 * Reads unsampled Queue metrics and delivers unhealthy state or monitor failure
 * to an operator-owned JSON webhook. No message bodies, tokens, or webhook URLs
 * enter the report. A rejected/missing notification fails closed so a scheduler
 * can alert on the monitor itself; it never replays or acknowledges Queue work.
 */
export async function alertQueue(options, { environment = process.env, fetchImpl = fetch } = {}) {
  if (options.command !== "metrics") throw new TypeError("Queue alerting accepts metrics only");
  let webhook;
  try {
    webhook = new URL(environment.MELTIPLY_ALERT_WEBHOOK_URL);
  } catch {
    throw new TypeError("MELTIPLY_ALERT_WEBHOOK_URL must be configured");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(webhook.hostname);
  if (
    webhook.username ||
    webhook.password ||
    webhook.hash ||
    (webhook.protocol !== "https:" && !(webhook.protocol === "http:" && loopback))
  ) {
    throw new TypeError("Alert webhook requires HTTPS; HTTP is allowed only on loopback");
  }
  let result;
  let unavailable = false;
  try {
    result = await runQueueCommand(options, { environment, fetchImpl });
  } catch {
    unavailable = true;
    result = {
      command: "metrics",
      environment: options.environment,
      workload: options.workload,
      healthy: false,
      alerts: ["queue_monitor_unavailable"],
    };
  }
  if (result.healthy) return { ...result, notification: "not_needed" };
  let delivered = false;
  try {
    const response = await fetchImpl(webhook.href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "meltiply",
        occurred_at: new Date().toISOString(),
        ...result,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    delivered = response.ok;
    await response.body?.cancel();
  } catch {
    /* Notification failure is surfaced below without leaking a webhook secret. */
  }
  if (!delivered)
    throw new Error("Queue alert delivery failed; unsampled monitoring requires attention");
  if (unavailable) throw new Error("Queue metrics unavailable; monitor-failure alert delivered");
  return { ...result, notification: "delivered" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await alertQueue(parseQueueArguments(["metrics", ...process.argv.slice(2)]));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.healthy) process.exitCode = 2;
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : "Queue alerting failed"}\n`);
    process.exitCode = 1;
  }
}
