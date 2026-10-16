import { Layer } from "effect";
import { effectLoggerLayer, effectTracerLayer, type LogContext } from "@meltiply/observability";

import type { AutomationEnv } from "../env";
import { publishingQueueFor } from "../publish-queues";
import type { JobContextData } from "./job-context";
import {
  createPublishQueueResolverLive,
  createQueuePublisherLive,
  createReplyWorkflowDispatcherLive,
} from "./services";
import type { PublishQueueResolver, QueuePublisher, ReplyWorkflowDispatcher } from "./services";

/**
 * Per-invocation execution scope built fresh for every queue message, cron
 * unit, or workflow step. Pg-free: scope construction needs only env
 * metadata and job correlation, so unit tests build scopes without loading
 * the database client. The runtime layer supplies the queue publisher,
 * per-platform publish queue resolver, and reply workflow dispatcher (all
 * binding-only) alongside job-scoped logging and tracing.
 */
export interface JobScope {
  readonly env: AutomationEnv;
  readonly job: JobContextData;
  readonly logContext: LogContext;
  readonly runtimeLayer: Layer.Layer<
    QueuePublisher | PublishQueueResolver | ReplyWorkflowDispatcher
  >;
}

/**
 * Builds an isolated per-invocation scope from the worker env and job correlation.
 *
 * Derives fresh service and logger/tracer layers on every call so one queue
 * message's identifiers never leak into a sibling delivery when the Worker
 * isolate is reused. Queue/workflow service factories read env bindings only,
 * keeping scope construction pg-free. Mirrors the API worker's requestScope
 * boundary.
 *
 * @param env - Automation worker environment bindings.
 * @param job - Job correlation including source discriminator and identifiers.
 * @returns Isolated job scope with layers and logging context.
 */
export function jobScope(env: AutomationEnv, job: JobContextData): JobScope {
  const logContext: LogContext = {
    environment: env.ENVIRONMENT,
    ...(job.jobId ? { job_id: job.jobId } : {}),
    ...(job.requestId ? { request_id: job.requestId } : {}),
    service: "automation",
    trace_id: job.traceId,
    version: env.VERSION,
    ...(job.workflowId ? { workflow_id: job.workflowId } : {}),
  };
  const runtimeLayer = Layer.mergeAll(
    createQueuePublisherLive(),
    createPublishQueueResolverLive((platform) => publishingQueueFor(env, platform)),
    createReplyWorkflowDispatcherLive(env),
    effectLoggerLayer(logContext),
    effectTracerLayer(logContext),
  );
  return { env, job, logContext, runtimeLayer };
}
