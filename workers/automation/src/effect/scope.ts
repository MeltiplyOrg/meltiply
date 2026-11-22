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

export interface JobScope {
  readonly env: AutomationEnv;
  readonly job: JobContextData;
  readonly logContext: LogContext;
  readonly runtimeLayer: Layer.Layer<
    QueuePublisher | PublishQueueResolver | ReplyWorkflowDispatcher
  >;
}

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
