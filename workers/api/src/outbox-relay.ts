import type { Context } from "hono";

import { runBackgroundContinuation } from "./background-continuation";

import type { ApiWorkerEnvironment } from "./env";

const mutatingHttpMethods: Record<string, true> = {
  DELETE: true,
  PATCH: true,
  POST: true,
  PUT: true,
};

export function scheduleEagerOutboxRelay(c: Context<ApiWorkerEnvironment>): void {
  if (!mutatingHttpMethods[c.req.method]) return;
  if (c.res.status >= 400) return;
  const automation = c.env.AUTOMATION;
  if (!automation) return;

  runBackgroundContinuation(c, {
    errorCode: "outbox_eager_relay_failed",
    errorRetryClass: "platform_retry",
    event: "outbox_eager_relay",
    perform: () => automation.relayOutbox(),
    onSuccess: (result) => ({
      relayed_claimed: result.claimed,
      relayed_dead: result.dead,
      relayed_failed: result.failed,
      relayed_published: result.published,
      retry_class: result.failed > 0 ? "platform_retry" : "none",
    }),
  });
}
