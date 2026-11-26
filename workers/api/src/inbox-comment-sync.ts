import type { Context } from "hono";

import { runBackgroundContinuation } from "./background-continuation";

import type { ApiWorkerEnvironment } from "./env";

export function scheduleInboxCommentSync(
  c: Context<ApiWorkerEnvironment>,
  organizationId: string,
  distributionId?: string,
): void {
  const automation = c.env.AUTOMATION;
  if (!automation) return;

  runBackgroundContinuation(c, {
    errorCode: "inbox_comment_sync_failed",
    errorRetryClass: "client_retry",
    event: "inbox_comment_sync",
    perform: () => automation.requestCommentsSync(organizationId, distributionId ?? null),
    onSuccess: (enqueued) => ({
      retry_class: "none",
      sync_enqueued: enqueued,
    }),
  });
}
