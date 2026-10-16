import type { Context } from "hono";

import { runBackgroundContinuation } from "./background-continuation";

import type { ApiWorkerEnvironment } from "./env";

const mutatingHttpMethods: Record<string, true> = {
  DELETE: true,
  PATCH: true,
  POST: true,
  PUT: true,
};

/**
 * Relays pending outbox events on the request's background continuation after a mutating transaction commits.
 *
 * The Outbox pattern decouples database transaction commits from asynchronous Cloudflare Queue sends.
 * For successful mutating HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`), triggers an eager outbox relay
 * via `c.executionCtx.waitUntil` without delaying the HTTP response. If eager delivery fails, messages
 * remain safe in the outbox table for recovery by the scheduled automation poller.
 *
 * @param c - Hono context containing HTTP request/response state and Worker environment bindings.
 */
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
