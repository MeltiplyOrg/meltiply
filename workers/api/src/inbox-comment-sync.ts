import type { Context } from "hono";

import { runBackgroundContinuation } from "./background-continuation";

import type { ApiWorkerEnvironment } from "./env";

/**
 * Schedules an asynchronous background comment sync via Automation worker when the Inbox is viewed.
 *
 * Comment syncing ceases automatically once a Distribution exceeds `demandDrivenCommentsAgeSeconds`,
 * making explicit Inbox views the trigger for refreshing comments on older distributions. Runs on the
 * request's background continuation (`c.executionCtx.waitUntil`) without blocking the HTTP response.
 * The organization id comes from the resolved actor's workspace, which already proved
 * database-level tenant membership during request authentication.
 *
 * @param c - Hono context containing Worker environment bindings and execution context.
 * @param organizationId - Resolved actor workspace UUID (internal organizations.id).
 * @param distributionId - Optional target distribution UUID to restrict synchronization scope.
 */
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
