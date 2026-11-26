import {
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  createTraceId,
  errorDiagnostic,
  elapsedMilliseconds,
  log,
  type RetryClass,
} from "@meltiply/observability";

import { Cause, Effect, Exit } from "effect";
import type { ProviderAdapterError, ProviderRegistry } from "@meltiply/providers";
import {
  classifyJobError,
  configureJobLogging,
  exitToJobOutcome,
  logJobOutcome,
  jobScope,
  makeJobContext,
  queueBackoffDelaySeconds,
  recoverJobErrorCause,
  ReplyWorkflowDispatcher,
  runJobProgram,
  TerminalJobError,
} from "./effect/index";
import type {
  AutomationJobError,
  JobScope,
  PublishQueueResolver,
  QueuePublisher,
} from "./effect/index";
import type { AssetJobProcessor } from "./assets";
import type { AutomationEnv } from "./env";
import {
  isOutboxMessage,
  isProviderSyncMessage,
  isReplyWorkflowPayload,
  replyWorkflowMessage,
  type OutboxMessage,
  type ReplyWorkflowPayload,
  type ProviderSyncMessage,
} from "./messages";
import { flowDatabaseAvailable, flowExplorerEnabled, flowRecorderFor } from "./flow-observability";
import {
  queueDiagnosticReport,
  registerDiagnostic,
  scheduledDiagnosticReport,
  workflowDiagnosticReport,
} from "./diagnostic-reporting";
import type { OutboxRelayResult } from "./outbox";
import type { ProviderDueResult } from "./provider-sync";
import type { DeliverySummary } from "@meltiply/reporting";
import type { RetentionResult } from "./retention";
import type { UsageReportResult } from "./usage-reporting";

const publishQueuePattern = /publish-(facebook|instagram|threads|tiktok|youtube)(?:-|$)/;

const EAGER_RELAY_BATCH_SIZE = 50;

export class ReplyWorkflow extends WorkflowEntrypoint<AutomationEnv, ReplyWorkflowPayload> {
  async run(event: Readonly<WorkflowEvent<ReplyWorkflowPayload>>, step: WorkflowStep) {
    configureJobLogging(this.env);
    if (!isReplyWorkflowPayload(event.payload)) {
      throw new TypeError("ReplyWorkflow accepts only reply.workflow payloads");
    }
    const traceId = createTraceId(undefined, event.payload.request_id ?? event.payload.event_id);
    return step.do(
      "deliver or reconcile provider reply",
      {
        retries: { backoff: "exponential", delay: "15 seconds", limit: 10 },
        timeout: "5 minutes",
      },
      async () => {
        const env = { ...this.env };
        const startedAt = performance.now();
        const scope = jobScope(
          env,
          makeJobContext({
            jobId: event.payload.event_id,
            ...(event.payload.request_id ? { requestId: event.payload.request_id } : {}),
            source: "workflow",
            traceId,
            workflowId: event.instanceId,
          }),
        );
        const program = Effect.flatMap(
          Effect.tryPromise({
            catch: (cause) => classifyJobError(cause),
            try: () => import("./replies"),
          }),
          (module) => module.processReplyMessage(env, replyWorkflowMessage(event.payload)),
        );
        const exit = await runJobProgram(Effect.provide(program, scope.runtimeLayer));
        const mapped = exitToJobOutcome(exit);
        if (mapped.outcome === "processed") {
          const outcome =
            Exit.isSuccess(exit) && typeof exit.value === "string" ? exit.value : "processed";
          log(
            "info",
            context(this.env, traceId, {
              jobId: event.payload.event_id,
              requestId: event.payload.request_id ?? undefined,
              workflowId: event.instanceId,
            }),
            {
              event: "reply_workflow_step",
              job: "reply_delivery",
              latency_ms: elapsedMilliseconds(startedAt),
              outcome,
              retry_class: "none",
            },
          );
          return { outcome };
        }
        if (mapped.outcome === "ambiguous") {
          log(
            "warn",
            context(this.env, traceId, {
              jobId: event.payload.event_id,
              requestId: event.payload.request_id ?? undefined,
              workflowId: event.instanceId,
            }),
            {
              ...(mapped.diagnostic ?? {}),
              error_code: "reply_workflow_step_ambiguous",
              event: "reply_workflow_step",
              job: "reply_delivery",
              latency_ms: elapsedMilliseconds(startedAt),
              outcome: "ambiguous",
              retry_class: "reconciliation",
            },
          );
          return { outcome: "ambiguous" as const };
        }
        const cause = Exit.isSuccess(exit)
          ? new Error("reply workflow step failed")
          : Cause.squash(exit.cause);
        if (mapped.outcome === "rejected") {
          log(
            "warn",
            context(this.env, traceId, {
              jobId: event.payload.event_id,
              requestId: event.payload.request_id ?? undefined,
              workflowId: event.instanceId,
            }),
            {
              ...(mapped.diagnostic ?? {}),
              error_code: "reply_workflow_step_rejected",
              event: "reply_workflow_step",
              job: "reply_delivery",
              latency_ms: elapsedMilliseconds(startedAt),
              outcome: "rejected",
              retry_class: "none",
            },
          );
          return { outcome: "rejected" as const };
        }
        registerDiagnostic(
          this.ctx,
          env,
          workflowDiagnosticReport(cause, { outcome: "retry" }),
          context(this.env, traceId, {
            jobId: event.payload.event_id,
            requestId: event.payload.request_id ?? undefined,
            workflowId: event.instanceId,
          }),
        );
        log(
          "error",
          context(this.env, traceId, {
            jobId: event.payload.event_id,
            requestId: event.payload.request_id ?? undefined,
            workflowId: event.instanceId,
          }),
          {
            error_code: "reply_workflow_step_failed",
            event: "reply_workflow_step",
            job: "reply_delivery",
            latency_ms: elapsedMilliseconds(startedAt),
            outcome: "retry",
            ...errorDiagnostic(cause),
            retry_class: "workflow_backoff",
          },
        );
        throw cause;
      },
    );
  }
}

export { MediaProcessorContainer } from "./native-processor-container";

export interface AutomationDependencies {
  providerRegistry?: ProviderRegistry;
  assetProcessorFor?: (env: AutomationEnv) => AssetJobProcessor | Promise<AssetJobProcessor>;
  sweepAccountAnalytics?: (
    env: AutomationEnv,
  ) => Effect.Effect<{ failed: number; recorded: number; scanned: number }, unknown>;
  relay?: (env: AutomationEnv) => Effect.Effect<OutboxRelayResult, unknown>;
  enqueueDue?: (env: AutomationEnv) => Effect.Effect<number, unknown>;
  sweepDue?: (env: AutomationEnv) => Effect.Effect<number, unknown>;
  sweepProviderDue?: (env: AutomationEnv) => Effect.Effect<ProviderDueResult, unknown>;
  enqueueDueReplyReconciliations?: (env: AutomationEnv) => Effect.Effect<number, unknown>;
  runRetention?: (env: AutomationEnv) => Effect.Effect<RetentionResult, unknown>;
  deliverImprovementReports?: (env: AutomationEnv) => Effect.Effect<DeliverySummary, unknown>;
  enqueueDailyUsageReport?: (env: AutomationEnv) => Effect.Effect<UsageReportResult, unknown>;
  providerSyncProcessor?: (
    env: AutomationEnv,
    message: ProviderSyncMessage,
  ) => Effect.Effect<"processed" | "skipped", unknown>;
  replyWorkflowEnqueue?: (
    env: AutomationEnv,
    message: OutboxMessage,
  ) => Effect.Effect<"enqueued", unknown>;
  channelRevocationProcessor?: (
    env: AutomationEnv,
    message: OutboxMessage,
  ) => Effect.Effect<"processed" | "skipped", unknown>;
}

type ScheduledTier = "daily" | "hourly";

const SCHEDULED_TIERS: Readonly<Record<ScheduledTier, string>> = {
  daily: "0 0 * * *",
  hourly: "0 * * * *",
};

type ScheduledWorkName =
  | "account-analytics-sweep"
  | "asset-maintenance"
  | "distribution-sweep"
  | "due-distribution-scan"
  | "outbox-relay"
  | "provider-sync-sweep"
  | "reply-reconciliation"
  | "improvement-reporting-delivery"
  | "usage-reporting"
  | "retention";

interface ScheduledWorkUnit {
  empty: unknown;
  field: string;
  name: ScheduledWorkName;
  run: (
    env: AutomationEnv,
  ) => Effect.Effect<
    unknown,
    AutomationJobError | ProviderAdapterError,
    QueuePublisher | PublishQueueResolver
  >;
  tier: ScheduledTier;
}

interface CorrelationIds {
  jobId?: string;
  requestId?: string;
  workflowId?: string;
}

function context(env: AutomationEnv, traceId: string, correlation: CorrelationIds = {}) {
  return {
    environment: env.ENVIRONMENT,
    ...(correlation.jobId ? { job_id: correlation.jobId } : {}),
    ...(correlation.requestId ? { request_id: correlation.requestId } : {}),
    service: "automation",
    trace_id: traceId,
    version: env.VERSION,
    ...(correlation.workflowId ? { workflow_id: correlation.workflowId } : {}),
  };
}

function queueCorrelation(body: unknown, messageId: string) {
  const jobId = isProviderSyncMessage(body) || isOutboxMessage(body) ? body.event_id : messageId;
  const requestId =
    isProviderSyncMessage(body) || isOutboxMessage(body)
      ? (body.request_id ?? undefined)
      : undefined;
  return {
    jobId,
    requestId,
    traceId: createTraceId(undefined, requestId ?? jobId),
  };
}

function queueEvent(body: unknown): string {
  if (isProviderSyncMessage(body)) return "provider_sync_job";
  if (isOutboxMessage(body)) {
    if (body.topic.startsWith("distribution.")) {
      return "distribution_job";
    }
    if (body.topic === "channel.revocation.requested") {
      return "channel_revocation_job";
    }
    if (body.topic === "comment.reply.requested") {
      return "reply_job";
    }
    if (body.topic === "notification.delivery.requested") {
      return "notification_job";
    }
    return "asset_job";
  }
  return "unsupported_queue_message";
}

function queueJob(body: unknown): string {
  if (isProviderSyncMessage(body)) return body.workload;
  if (isOutboxMessage(body)) return body.topic;
  return "unsupported";
}

function queueProvider(queue: string): string | undefined {
  return publishQueuePattern.exec(queue)?.[1];
}

function logQueueOutcome(
  env: AutomationEnv,
  correlation: { jobId?: string; requestId?: string; traceId: string },
  opts: {
    attempts: number;
    event: string;
    workload?: string;
    job: string;
    latencyMs: number;
    messageId: string;
    outcome: string;
    provider?: string;
    queue: string;
    retryClass?: RetryClass;
  },
): void {
  log("info", context(env, correlation.traceId, correlation), {
    attempts: opts.attempts,
    event: opts.event,
    job: opts.job,
    latency_ms: opts.latencyMs,
    message_id: opts.messageId,
    outcome: opts.outcome,
    ...(opts.provider ? { provider: opts.provider } : {}),
    queue: opts.queue,
    retry_class: opts.retryClass ?? "none",
    ...(opts.workload ? { workload: opts.workload } : {}),
  });
}

async function beginQueueFlow(
  env: AutomationEnv,
  input: {
    correlation: { jobId?: string; requestId?: string; traceId: string };
    event: string;
    job: string;
    organizationId?: string;
    provider?: string;
    queue: string;
  },
) {
  if (!flowExplorerEnabled(env) || !flowDatabaseAvailable(env) || !input.correlation.requestId) {
    return null;
  }
  const recorder = flowRecorderFor(env);
  const runId = await recorder.startRunForRequest({
    entrypoint: `queue:${input.event}`,
    orgId: input.organizationId,
    requestId: input.correlation.requestId,
    traceId: input.correlation.traceId,
  });
  if (!runId) return null;
  const stepIds: string[] = [];
  const consumeStepId = await recorder.recordStep({
    nodeKey: "queue",
    operation: "consume_message",
    orgId: input.organizationId,
    jobId: input.correlation.jobId,
    metadata: { event: input.event, job: input.job },
    provider: input.provider,
    queueName: input.queue,
    requestId: input.correlation.requestId,
    runId,
    service: "automation",
    traceId: input.correlation.traceId,
  });
  if (consumeStepId) stepIds.push(consumeStepId);
  const processNode = input.event === "reply_job" ? "workflow" : "automation";
  const processStepId = await recorder.recordStep({
    nodeKey: processNode,
    operation: input.event === "reply_job" ? "enqueue_reply_workflow" : `process:${input.job}`,
    orgId: input.organizationId,
    jobId: input.correlation.jobId,
    metadata: { event: input.event },
    provider: input.provider,
    queueName: input.queue,
    requestId: input.correlation.requestId,
    runId,
    service: "automation",
    traceId: input.correlation.traceId,
  });
  if (processStepId) stepIds.push(processStepId);
  return {
    async finish(outcome: "failed" | "succeeded") {
      const stepOutcome =
        outcome === "succeeded"
          ? { status: "succeeded" as const }
          : {
              errorCode: "queue_job_failed",
              retryable: true,
              status: "failed" as const,
            };
      for (const stepId of stepIds) {
        await recorder.finishStep(stepId, stepOutcome);
      }
      await recorder.finishRun(runId, stepOutcome);
    },
  };
}

interface QueueDispatchInput {
  body: unknown;
  providerRegistry?: ProviderRegistry;
  enqueueReplyWorkflow: (
    env: AutomationEnv,
    message: OutboxMessage,
  ) => Effect.Effect<"enqueued", AutomationJobError, ReplyWorkflowDispatcher>;
  processProviderSync: (
    env: AutomationEnv,
    message: ProviderSyncMessage,
  ) => Effect.Effect<
    "processed" | "skipped",
    AutomationJobError | ProviderAdapterError,
    QueuePublisher
  >;
  processChannelRevocation: (
    env: AutomationEnv,
    message: OutboxMessage,
  ) => Effect.Effect<"processed" | "skipped", unknown>;
  processorFor: () => Promise<AssetJobProcessor>;
}

function dispatchQueueMessage(
  env: AutomationEnv,
  input: QueueDispatchInput,
): Effect.Effect<string, AutomationJobError, ReplyWorkflowDispatcher | QueuePublisher> {
  const { body } = input;
  if (isProviderSyncMessage(body)) {
    return Effect.mapError(input.processProviderSync(env, body), (cause) =>
      classifyJobError(cause),
    );
  }
  if (isOutboxMessage(body) && body.topic.startsWith("distribution.")) {
    return Effect.flatMap(
      Effect.tryPromise({
        catch: (cause) => classifyJobError(cause),
        try: () => import("./distribution"),
      }),
      (module) =>
        module
          .processDistributionMessage(env, body, {
            providerRegistry: input.providerRegistry,
          })
          .pipe(Effect.mapError((cause) => classifyJobError(cause))),
    );
  }
  if (isOutboxMessage(body) && body.topic === "channel.revocation.requested") {
    return Effect.mapError(input.processChannelRevocation(env, body), (cause) =>
      classifyJobError(cause),
    );
  }
  if (isOutboxMessage(body) && body.topic === "comment.reply.requested") {
    return input.enqueueReplyWorkflow(env, body);
  }
  if (isOutboxMessage(body) && body.topic === "notification.delivery.requested") {
    return Effect.flatMap(
      Effect.tryPromise({
        catch: (cause) => classifyJobError(cause),
        try: () => import("./notifications"),
      }),
      (module) => module.processNotificationMessage(env, body),
    );
  }
  if (isOutboxMessage(body)) {
    return Effect.flatMap(
      Effect.tryPromise({
        catch: (cause) => classifyJobError(cause),
        try: () => input.processorFor(),
      }),
      (processor) => processor.process(body),
    );
  }
  return Effect.fail(
    new TerminalJobError({
      code: "unknown_message_type",
      message: "unsupported queue message reached the dispatcher",
    }),
  );
}

export interface AutomationHandler extends ExportedHandler<AutomationEnv, unknown> {
  fetch: NonNullable<ExportedHandler<AutomationEnv, unknown>["fetch"]>;
  queue: NonNullable<ExportedHandler<AutomationEnv, unknown>["queue"]>;
  scheduled: (
    controller: ScheduledController | null | undefined,
    env: AutomationEnv,
    ctx: ExecutionContext,
  ) => void | Promise<void>;
}

export function createAutomationHandler(
  dependencies: AutomationDependencies = {},
): AutomationHandler {
  const processorFor =
    dependencies.assetProcessorFor ??
    (async (env) => (await import("./assets")).createAssetJobProcessor(env));
  const scheduledWork: readonly ScheduledWorkUnit[] = [
    {
      empty: 0,
      field: "due_distributions",
      name: "due-distribution-scan",
      run: dependencies.enqueueDue
        ? (env) =>
            Effect.suspend(() => dependencies.enqueueDue!(env)).pipe(
              Effect.mapError((cause) => classifyJobError(cause)),
            )
        : (env) =>
            Effect.flatMap(
              Effect.tryPromise({
                catch: (cause) => classifyJobError(cause),
                try: () => import("./distribution"),
              }),
              (module) => module.enqueueDueDistributions(env),
            ),
      tier: "hourly",
    },
    {
      empty: { claimed: 0, dead: 0, failed: 0, published: 0 },
      field: "outbox",
      name: "outbox-relay",
      run: dependencies.relay
        ? (env) =>
            Effect.suspend(() => dependencies.relay!(env)).pipe(
              Effect.mapError((cause) => classifyJobError(cause)),
            )
        : (env) =>
            Effect.flatMap(
              Effect.tryPromise({
                catch: (cause) => classifyJobError(cause),
                try: () => import("./outbox"),
              }),
              (module) => module.relayOutbox(env),
            ),
      tier: "hourly",
    },
    {
      empty: undefined,
      field: "maintenance",
      name: "asset-maintenance",
      run: (env) =>
        Effect.flatMap(
          Effect.tryPromise({
            catch: (cause) => classifyJobError(cause),
            try: () => Promise.resolve(processorFor(env)),
          }),
          (processor) => processor.runMaintenance(),
        ),
      tier: "hourly",
    },
    {
      empty: 0,
      field: "distribution_sweep",
      name: "distribution-sweep",
      run: dependencies.sweepDue
        ? (env) =>
            Effect.suspend(() => dependencies.sweepDue!(env)).pipe(
              Effect.mapError((cause) => classifyJobError(cause)),
            )
        : (env) =>
            Effect.flatMap(
              Effect.tryPromise({
                catch: (cause) => classifyJobError(cause),
                try: () => import("./distribution"),
              }),
              (module) => module.sweepDueDistributions(env),
            ),
      tier: "hourly",
    },
    {
      empty: { analytics: 0, comments: 0, token_refresh: 0 },
      field: "provider_sync_sweep",
      name: "provider-sync-sweep",
      run: dependencies.sweepProviderDue
        ? (env) =>
            Effect.suspend(() => dependencies.sweepProviderDue!(env)).pipe(
              Effect.mapError((cause) => classifyJobError(cause)),
            )
        : (env) =>
            Effect.flatMap(
              Effect.tryPromise({
                catch: (cause) => classifyJobError(cause),
                try: () => import("./provider-sync"),
              }),
              (module) => module.sweepDueProviderJobs(env),
            ),
      tier: "hourly",
    },
    {
      empty: undefined,
      field: "reply_reconciliations",
      name: "reply-reconciliation",
      run: dependencies.enqueueDueReplyReconciliations
        ? (env) =>
            Effect.suspend(() => dependencies.enqueueDueReplyReconciliations!(env)).pipe(
              Effect.mapError((cause) => classifyJobError(cause)),
            )
        : (env) =>
            Effect.flatMap(
              Effect.tryPromise({
                catch: (cause) => classifyJobError(cause),
                try: () => import("./reply-reconciliation"),
              }),
              (module) => module.enqueueDueReplyReconciliations(env),
            ),
      tier: "hourly",
    },
    {
      empty: { failed: 0, recorded: 0, scanned: 0 },
      field: "account_analytics",
      name: "account-analytics-sweep",
      run: dependencies.sweepAccountAnalytics
        ? (env) =>
            Effect.suspend(() => dependencies.sweepAccountAnalytics!(env)).pipe(
              Effect.mapError((cause) => classifyJobError(cause)),
            )
        : (env) =>
            Effect.flatMap(
              Effect.tryPromise({
                catch: (cause) => classifyJobError(cause),
                try: () => import("./account-analytics"),
              }),
              (module) => module.sweepAccountAnalytics(env),
            ),
      tier: "hourly",
    },
    {
      empty: undefined,
      field: "retention",
      name: "retention",
      run: dependencies.runRetention
        ? (env) =>
            Effect.suspend(() => dependencies.runRetention!(env)).pipe(
              Effect.mapError((cause) => classifyJobError(cause)),
            )
        : (env) =>
            Effect.flatMap(
              Effect.tryPromise({
                catch: (cause) => classifyJobError(cause),
                try: () => import("./retention"),
              }),
              (module) => module.runRetention(env),
            ),
      tier: "daily",
    },
    {
      empty: { considered: 0, queued: 0 },
      field: "usage",
      name: "usage-reporting",
      run: dependencies.enqueueDailyUsageReport
        ? (env) =>
            Effect.suspend(() => dependencies.enqueueDailyUsageReport!(env)).pipe(
              Effect.mapError((cause) => classifyJobError(cause)),
            )
        : (env) =>
            Effect.flatMap(
              Effect.tryPromise({
                catch: (cause) => classifyJobError(cause),
                try: () => import("./usage-reporting"),
              }),
              (module) => module.enqueueDailyUsageReport(env),
            ),
      tier: "daily",
    },
    {
      empty: { claimed: 0, delivered: 0, discarded: 0, failed: 0, released: 0, skipped: 0 },
      field: "reporting",
      name: "improvement-reporting-delivery",
      run: dependencies.deliverImprovementReports
        ? (env) =>
            Effect.suspend(() => dependencies.deliverImprovementReports!(env)).pipe(
              Effect.mapError((cause) => classifyJobError(cause)),
            )
        : (env) =>
            Effect.flatMap(
              Effect.tryPromise({
                catch: (cause) => classifyJobError(cause),
                try: () => import("./improvement-reporting"),
              }),
              (module) => module.deliverImprovementReports(env),
            ),
      tier: "daily",
    },
  ];
  const providerSyncOverride = dependencies.providerSyncProcessor;
  const processProviderSync: QueueDispatchInput["processProviderSync"] = providerSyncOverride
    ? (env, message) =>
        Effect.suspend(() => providerSyncOverride(env, message)).pipe(
          Effect.mapError((cause) => classifyJobError(cause)),
        )
    : (env, message) =>
        Effect.flatMap(
          Effect.tryPromise({
            catch: (cause) => classifyJobError(cause),
            try: () => import("./provider-sync"),
          }),
          (module) => module.processProviderSyncMessage(env, message),
        );
  const replyEnqueueOverride = dependencies.replyWorkflowEnqueue;
  const enqueueReplyWorkflow: QueueDispatchInput["enqueueReplyWorkflow"] = replyEnqueueOverride
    ? (env, message) =>
        Effect.suspend(() => replyEnqueueOverride(env, message)).pipe(
          Effect.mapError((cause) => classifyJobError(cause)),
        )
    : (_env, message) =>
        Effect.gen(function* () {
          const dispatcher = yield* ReplyWorkflowDispatcher;
          return yield* dispatcher.enqueue(message);
        }).pipe(Effect.mapError((cause) => classifyJobError(cause)));
  const channelRevocationOverride = dependencies.channelRevocationProcessor;
  const processChannelRevocation: QueueDispatchInput["processChannelRevocation"] =
    channelRevocationOverride
      ? (env, message) =>
          Effect.suspend(() => channelRevocationOverride(env, message)).pipe(
            Effect.mapError((cause) => classifyJobError(cause)),
          )
      : (env, message) =>
          Effect.flatMap(
            Effect.tryPromise({
              catch: (cause) => classifyJobError(cause),
              try: () => import("./channel-revocation"),
            }),
            (module) => module.processChannelRevocationMessage(env, message),
          );

  return {
    fetch(_request, env) {
      configureJobLogging(env);
      return Response.json({
        environment: env.ENVIRONMENT,
        service: "automation",
        status: "ok",
        version: env.VERSION,
      });
    },

    async queue(batch, bindings, executionCtx) {
      const env = { ...bindings };
      configureJobLogging(env);
      let assetProcessor: Promise<AssetJobProcessor> | undefined;
      const provider = queueProvider(batch.queue);
      if (
        env.PUBLISH_BATCH_CONCURRENCY !== undefined &&
        env.PUBLISH_BATCH_CONCURRENCY !== "1" &&
        env.PUBLISH_BATCH_CONCURRENCY !== "2"
      ) {
        throw new RangeError("PUBLISH_BATCH_CONCURRENCY must be 1 or 2");
      }
      const consume = async (message: Message<unknown>) => {
        const startedAt = performance.now();
        const correlation = queueCorrelation(message.body, message.id);
        const event = queueEvent(message.body);
        const job = queueJob(message.body);
        const scope: JobScope = jobScope(
          env,
          makeJobContext({
            jobId: correlation.jobId,
            queue: batch.queue,
            ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
            source: "queue",
            traceId: correlation.traceId,
          }),
        );
        const body = message.body;
        const organizationId =
          typeof body === "object" && body !== null && "organization_id" in body
            ? (body.organization_id as string | undefined)
            : undefined;
        const flow = await beginQueueFlow(env, {
          correlation,
          event,
          job,
          organizationId,
          provider,
          queue: batch.queue,
        });
        const program = dispatchQueueMessage(env, {
          body,
          enqueueReplyWorkflow,
          processChannelRevocation,
          processProviderSync,
          providerRegistry: dependencies.providerRegistry,
          processorFor: () => (assetProcessor ??= Promise.resolve(processorFor(env))),
        });
        const exit = await runJobProgram(Effect.provide(program, scope.runtimeLayer));
        const { diagnostic, failure, outcome } = exitToJobOutcome(exit);
        const latencyMs = elapsedMilliseconds(startedAt);
        if (outcome === "processed") {
          message.ack();
          await flow?.finish("succeeded");
          const processorOutcome =
            Exit.isSuccess(exit) && typeof exit.value === "string" ? exit.value : "processed";
          logQueueOutcome(env, correlation, {
            attempts: message.attempts,
            event,
            ...(isProviderSyncMessage(body) ? { workload: body.workload } : {}),
            job,
            latencyMs,
            messageId: message.id,
            outcome: processorOutcome,
            ...(provider ? { provider } : {}),
            queue: batch.queue,
          });
          return;
        }
        if (outcome === "rejected") {
          message.ack();
          await flow?.finish("failed");
          log("warn", context(env, correlation.traceId, correlation), {
            attempts: message.attempts,
            ...(diagnostic ?? {}),
            event,
            job,
            latency_ms: latencyMs,
            message_id: message.id,
            outcome: "rejected",
            ...(provider ? { provider } : {}),
            queue: batch.queue,
            retry_class: "none",
          });
          registerDiagnostic(
            executionCtx,
            env,
            queueDiagnosticReport(failure, {
              outcome: "rejected",
              ...(provider ? { provider } : {}),
              ...(isOutboxMessage(body) ? { topic: body.topic } : {}),
            }),
            context(env, correlation.traceId, correlation),
          );
          return;
        }
        if (outcome === "ambiguous") {
          message.ack();
          await flow?.finish("succeeded");
          log("warn", context(env, correlation.traceId, correlation), {
            attempts: message.attempts,
            ...(diagnostic ?? {}),
            event,
            job,
            latency_ms: latencyMs,
            message_id: message.id,
            outcome: "ambiguous",
            ...(provider ? { provider } : {}),
            queue: batch.queue,
            retry_class: "reconciliation",
          });
          registerDiagnostic(
            executionCtx,
            env,
            queueDiagnosticReport(failure, {
              outcome: "ambiguous",
              ...(provider ? { provider } : {}),
              ...(isOutboxMessage(body) ? { topic: body.topic } : {}),
            }),
            context(env, correlation.traceId, correlation),
          );
          return;
        }
        await flow?.finish("failed");
        message.retry({
          delaySeconds: queueBackoffDelaySeconds(message.attempts),
        });
        log("error", context(env, correlation.traceId, correlation), {
          attempts: message.attempts,
          ...(diagnostic ?? { error_code: "queue_job_failed" }),
          event,
          job,
          latency_ms: latencyMs,
          message_id: message.id,
          outcome: "retry",
          ...(provider ? { provider } : {}),
          queue: batch.queue,
          retry_class: "queue_backoff",
        });
        registerDiagnostic(
          executionCtx,
          env,
          queueDiagnosticReport(failure, {
            outcome: "retry",
            ...(provider ? { provider } : {}),
            ...(isOutboxMessage(body) ? { topic: body.topic } : {}),
          }),
          context(env, correlation.traceId, correlation),
        );
      };
      if (provider && env.PUBLISH_BATCH_CONCURRENCY === "2") {
        const { consumePublishPartitions, partitionPublishBatch } = await import("./publish-batch");
        const partitions = await runDirectProgram(env, partitionPublishBatch(env, batch.messages));
        await consumePublishPartitions(partitions, consume);
      } else {
        for (const message of batch.messages) await consume(message);
      }
    },

    async scheduled(_controller, bindings, executionCtx) {
      const env = { ...bindings };
      configureJobLogging(env);
      const startedAt = performance.now();
      const jobId = crypto.randomUUID();
      const scheduledContext = context(env, jobId, { jobId });
      const cron = _controller?.cron;
      const tierRuns: Record<ScheduledTier, boolean> = {
        daily: !cron || cron === SCHEDULED_TIERS.daily,
        hourly: !cron || cron === SCHEDULED_TIERS.hourly,
      };
      const dueWork = scheduledWork.filter((unit) => tierRuns[unit.tier]);
      const results: Record<string, unknown> = Object.fromEntries(
        scheduledWork.map((unit) => [unit.field, unit.empty]),
      );
      const failures: Array<{ cause: unknown; unit: ScheduledWorkName }> = [];
      for (const unit of dueWork) {
        const unitScope: JobScope = jobScope(
          env,
          makeJobContext({ jobId, source: "scheduled", traceId: jobId }),
        );
        const program = Effect.suspend(() => unit.run(env));
        const programExit = await runJobProgram(Effect.provide(program, unitScope.runtimeLayer));
        if (programExit._tag === "Success") {
          results[unit.field] = programExit.value;
          logJobOutcome(unitScope, "processed", {
            event: "automation_scheduled",
            job: unit.name,
            latencyMs: elapsedMilliseconds(startedAt),
          });
          continue;
        }
        const cause = recoverJobErrorCause(programExit.cause);
        failures.push({ cause, unit: unit.name });
      }
      const [firstFailure] = failures;
      if (firstFailure) {
        for (const failure of failures) {
          log("error", scheduledContext, {
            error_code: "scheduled_job_failed",
            event: "automation_scheduled",
            job: "scheduled_maintenance",
            latency_ms: elapsedMilliseconds(startedAt),
            outcome: "failed",
            scheduled_work: failure.unit,
            ...errorDiagnostic(failure.cause),
            retry_class: "platform_retry",
          });
          registerDiagnostic(
            executionCtx,
            env,
            scheduledDiagnosticReport(failure.cause, failure.unit),
            scheduledContext,
          );
        }
        throw firstFailure.cause;
      }
      const relayResult = results.outbox as OutboxRelayResult;
      const retention = results.retention as RetentionResult | undefined;
      const partial =
        relayResult.failed > 0 || relayResult.dead > 0 || (retention?.errors ?? 0) > 0;
      log("info", scheduledContext, {
        event: "automation_scheduled",
        account_analytics: results.account_analytics,
        distribution_sweep: results.distribution_sweep,
        due_distributions: results.due_distributions,
        job: "scheduled_maintenance",
        latency_ms: elapsedMilliseconds(startedAt),
        maintenance: results.maintenance,
        outbox: relayResult,
        outcome: partial ? "partial" : "ok",
        provider_sync_sweep: results.provider_sync_sweep,
        reply_reconciliations: results.reply_reconciliations,
        retention,
        retry_class: partial ? "platform_retry" : "none",
      });
    },
  };
}
async function runDirectProgram<A, E>(
  env: AutomationEnv,
  program: Effect.Effect<A, E, QueuePublisher | PublishQueueResolver | ReplyWorkflowDispatcher>,
): Promise<A> {
  const scope = jobScope(
    env,
    makeJobContext({
      jobId: crypto.randomUUID(),
      source: "direct",
      traceId: createTraceId(),
    }),
  );
  const exit = await runJobProgram(Effect.provide(program, scope.runtimeLayer));
  if (Exit.isSuccess(exit)) return exit.value;
  throw recoverJobErrorCause(exit.cause);
}

export class AutomationEntrypoint extends WorkerEntrypoint<AutomationEnv> {
  readonly #handler = createAutomationHandler();

  async relayOutbox(): Promise<OutboxRelayResult> {
    const env = { ...this.env };
    configureJobLogging(env);
    const program = Effect.flatMap(
      Effect.tryPromise({
        catch: (cause) => classifyJobError(cause),
        try: () => import("./outbox"),
      }),
      (module) => module.relayOutbox(env, EAGER_RELAY_BATCH_SIZE),
    );
    return runDirectProgram(env, program);
  }

  async requestCommentsSync(
    organizationId: string,
    distributionId: string | null,
  ): Promise<number> {
    const env = { ...this.env };
    configureJobLogging(env);
    const program = Effect.flatMap(
      Effect.tryPromise({
        catch: (cause) => classifyJobError(cause),
        try: () => import("./provider-sync"),
      }),
      (module) =>
        module.requestOnDemandCommentsSync(env, {
          distributionId,
          organizationId,
        }),
    );
    return runDirectProgram(env, program);
  }

  fetch(request: Request) {
    const handler = this.#handler.fetch;
    return handler(request as Parameters<typeof handler>[0], this.env, this.ctx);
  }

  queue(batch: MessageBatch<unknown>) {
    return this.#handler.queue(batch, this.env, this.ctx);
  }

  scheduled(controller: ScheduledController) {
    return this.#handler.scheduled(controller, this.env, this.ctx);
  }
}

export default AutomationEntrypoint;
