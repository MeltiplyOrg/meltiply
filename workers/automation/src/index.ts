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
import type { OutboxRelayResult } from "./outbox";
import type { ProviderDueResult } from "./provider-sync";
import type { RetentionResult } from "./retention";

/**

 * Bound on the eager relay a single API request performs. Anything left behind
 * stays pending and is delivered by the hourly sweep.
 */
const EAGER_RELAY_BATCH_SIZE = 50;

export class ReplyWorkflow extends WorkflowEntrypoint<AutomationEnv, ReplyWorkflowPayload> {
  /**
   * Executes a durable workflow step to deliver or reconcile a social media comment reply.
   *
   * Enforces exponential backoff across up to 10 retries within a 5-minute timeout window,
   * isolating long-running provider API calls and reconciliation loops from worker queue timeouts.
   * Provider programs execute in the same job fiber as the step, retaining its
   * logger/tracer context through database preparation and outcome recording.
   *
   * @param event - Durable workflow event wrapping the ReplyWorkflowPayload and instance metadata.
   * @param step - Cloudflare Workflow step handle used to schedule idempotent retryable steps.
   * @returns Resolves to an object containing the terminal outcome of the reply processing attempt.
   * @throws Rethrows any unhandled error caught during reply processing to trigger workflow retry.
   */
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
        // Approved boundary: the workflow step body runs as one Effect program
        // through the same mapper as queue/scheduled paths. Ambiguous provider
        // writes surface as AmbiguousJobError and must NOT trigger the
        // workflow retry: rethrow only retryable failures so reconciliation
        // owns ambiguous outcomes instead of duplicating remote writes.
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
          // Ambiguous: park on reconciliation instead of workflow retry. The
          // reply processor armed the next lookup; return the ambiguous marker
          // so the step succeeds without duplicating the remote write.
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
        // Terminal (poison) payloads must not burn the 10-retry workflow
        // budget: surface and succeed the step so the DLQ path owns them.
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

// The Container-backed media processor runs as its own Durable Object, so
// Wrangler binds the class re-exported from this module. Jobs reach it only
// through the private MediaProcessor binding used by the Asset job processor;
// no public route accepts arbitrary processor work.
//
// It is re-exported from `./native-processor-container` rather than
// `./native-processor` on purpose: that module owns the only `cloudflare:workers`
// import in this pipeline, so the injectable adapter stays loadable from plain
// Node/Vitest integration suites.
export { MediaProcessorContainer } from "./native-processor-container";

export interface AutomationDependencies {
  /** Selects publication adapters; omission uses the environment-configured registry. */
  providerRegistry?: ProviderRegistry;
  assetProcessorFor?: (env: AutomationEnv) => AssetJobProcessor | Promise<AssetJobProcessor>;
  /** Overrides the bounded hourly follower-history sweep for tests. */
  sweepAccountAnalytics?: (
    env: AutomationEnv,
  ) => Effect.Effect<{ failed: number; recorded: number; scanned: number }, unknown>;
  relay?: (env: AutomationEnv) => Effect.Effect<OutboxRelayResult, unknown>;
  enqueueDue?: (env: AutomationEnv) => Effect.Effect<number, unknown>;
  sweepDue?: (env: AutomationEnv) => Effect.Effect<number, unknown>;
  sweepProviderDue?: (env: AutomationEnv) => Effect.Effect<ProviderDueResult, unknown>;
  enqueueDueReplyReconciliations?: (env: AutomationEnv) => Effect.Effect<number, unknown>;
  runRetention?: (env: AutomationEnv) => Effect.Effect<RetentionResult, unknown>;
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
  | "retention";

interface ScheduledWorkUnit {
  /** Result reported for this unit when its tier does not run. */
  empty: unknown;
  /** Log field carrying this unit's result in automation_scheduled events. */
  field: string;
  name: ScheduledWorkName;
  /**
   * Unit program executed as one Effect inside the invocation's job scope.
   * Production units call the migrated module functions directly; injected
   * Effect-valued test doubles are adapted at declaration with
   * Effect.suspend + classifyJobError so the scheduled loop runs a single
   * uniform program shape.
   */
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

/**
 * Assembles a standardized logging context object from environment bindings and correlation identifiers.
 *
 * Ensures consistent metadata formatting across all structured logs emitted by the automation worker.
 *
 * @param env - Automation worker environment bindings containing environment and version.
 * @param traceId - Distributed tracing identifier for the active operation.
 * @param correlation - Optional correlation IDs including jobId, requestId, and workflowId.
 * @returns Structured object containing service name, environment, version, trace, and correlation IDs.
 */
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

/**
 * Extracts correlation and tracing identifiers from an incoming queue message payload.
 *
 * Prefers the message's internal event_id and request_id if present in recognized payload formats,
 * falling back to the queue envelope messageId to ensure traceable execution.
 *
 * @param body - Raw queue message body.
 * @param messageId - Cloudflare Queue envelope message identifier.
 * @returns Object containing the extracted jobId, requestId, and derived traceId.
 */
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

/**
 * Determines the high-level event categorization string for an incoming queue message.
 *
 * Inspects payload structure and topic prefixes to classify messages into provider sync,
 * distribution, channel revocation, comment reply, asset processing, or unsupported categories.
 *
 * @param body - Raw queue message body to inspect.
 * @returns String identifier classifying the event type for logging and metric emission.
 */
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
    return "asset_job";
  }
  return "unsupported_queue_message";
}

/**
 * Resolves the specific granular job or workload name from a queue message payload.
 *
 * Maps provider sync workloads or outbox message topics to their operational job name,
 * returning "unsupported" for unrecognized message shapes.
 *
 * @param body - Raw queue message payload.
 * @returns String indicating the specific operation or topic name.
 */
function queueJob(body: unknown): string {
  if (isProviderSyncMessage(body)) return body.workload;
  if (isOutboxMessage(body)) return body.topic;
  return "unsupported";
}

/**
 * Parses the target social media provider name from a Cloudflare Queue name.
 *
 * Matches queue names following the `publish-{provider}` pattern (e.g. facebook, instagram,
 * threads, tiktok, youtube) to associate log and telemetry events with the respective provider.
 *
 * @param queue - Name of the Cloudflare Queue receiving the message batch.
 * @returns Extracted provider name string, or undefined if the queue is not provider-specific.
 */
function queueProvider(queue: string): string | undefined {
  return /publish-(facebook|instagram|threads|tiktok|youtube)(?:-|$)/.exec(queue)?.[1];
}

/**
 * Emits a unified structured info log recording the completion of a queue message dispatch.
 *
 * Consolidates logging attributes across provider sync, distribution, reply, and asset jobs,
 * tracking delivery latency, retry attempt counters, queue origins, and outcomes.
 *
 * @param env - Automation worker environment bindings.
 * @param correlation - Tracing and correlation identifiers for the operation.
 * @param opts - Dispatch details including attempts, latency, queue name, and execution outcome.
 */
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

/**
 * Initializes best-effort flow explorer ledger recording for a queue message processing lifecycle.
 *
 * Links asynchronous queue execution to the originating API request trace if correlation is present
 * and database bindings are available. Returns an object with a `finish(outcome)` callback that closes
 * open ledger steps and runs upon completion.
 *
 * @param env - Automation worker environment bindings.
 * @param input - Flow tracking metadata including correlation IDs, event type, queue, and org ID.
 * @returns Object containing a `finish(outcome)` method to finalize flow steps, or null if tracing is inactive.
 */
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
  /** Raw queue body, narrowed inside dispatchQueueMessage by the payload guards. */
  body: unknown;
  /** Publication adapters selected by the Worker factory, not by queue payloads. */
  providerRegistry?: ProviderRegistry;
  /**
   * Reply-workflow enqueue as an Effect: the production path resolves the
   * ReplyWorkflowDispatcher service (supplied by the job scope runtime
   * layer); the Effect-valued test override is adapted at the call site.
   */
  enqueueReplyWorkflow: (
    env: AutomationEnv,
    message: OutboxMessage,
  ) => Effect.Effect<"enqueued", AutomationJobError, ReplyWorkflowDispatcher>;
  /**
   * Provider sync processor program; the production path calls the module
   * function while tests inject an Effect override adapted at the call site.
   */
  processProviderSync: (
    env: AutomationEnv,
    message: ProviderSyncMessage,
  ) => Effect.Effect<
    "processed" | "skipped",
    AutomationJobError | ProviderAdapterError,
    QueuePublisher
  >;
  /**
   * Channel revocation processor program; the production path calls the
   * channel-revocation module while tests inject an Effect override adapted
   * at the call site, mirroring processProviderSync.
   */
  processChannelRevocation: (
    env: AutomationEnv,
    message: OutboxMessage,
  ) => Effect.Effect<"processed" | "skipped", unknown>;
  /**
   * Per-batch memoized asset processor factory: the queue handler caches the
   * Promise once per batch so N asset messages share one object store
   * instead of constructing a processor per message.
   */
  processorFor: () => Promise<AssetJobProcessor>;
}

/**
 * Dispatches one queue message to its dedicated processor as an Effect program.
 *
 * Provider programs compose directly in the job fiber; the asset processor
 * factory stays a Promise adapter converted once at this boundary.
 * Publication uses the factory's registry when supplied; queue payloads never
 * select adapters or replace the real claim, snapshot, or delivery lifecycle.
 * Payload guards route known shapes — provider sync, distribution, channel
 * revocation, comment reply, then generic asset outbox events; any body
 * matching neither guard fails with a terminal unknown_message_type error so
 * the queue boundary records the producer-contract bug as rejected instead of
 * retrying it.
 *
 * @param env - Automation worker environment bindings.
 * @param input - Raw message body plus injected processor overrides.
 * @returns Effect resolving to the processor outcome label
 *   ("processed"/"skipped"/"enqueued"), failing with AutomationJobError.
 */
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

/**
 * Factory creating the Cloudflare Worker exported handler for the automation service.
 *
 * Assembles HTTP health check (`fetch`), queue consumption (`queue`), and cron trigger (`scheduled`)
 * dispatchers, accepting dependency injection overrides for testability without loading Node pg in tests.
 * Composes production provider programs in the invocation fiber; Effect test
 * overrides are adapted here without spawning a second Effect runtime.
 *
 * @param dependencies - Optional task, processor, workflow, and publication-registry dependencies.
 * @returns Cloudflare Worker ExportedHandler object implementing fetch, queue, and scheduled.
 */
export function createAutomationHandler(
  dependencies: AutomationDependencies = {},
): ExportedHandler<AutomationEnv, unknown> {
  const processorFor =
    dependencies.assetProcessorFor ??
    (async (env) => (await import("./assets")).createAssetJobProcessor(env));
  // Each unit of scheduled work is resolved by name from this list;
  // injected test doubles override individual units instead of switching
  // production branches off. Production units call the migrated module
  // functions (already Effects) through a classified dynamic import so tests
  // never evaluate the Node pg client; Effect-valued overrides are adapted
  // per unit with Effect.suspend + classifyJobError.
  const scheduledWork: readonly ScheduledWorkUnit[] = [
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
      // The asset processor factory stays a Promise adapter: construction is
      // converted here via tryPromise, while runMaintenance is already an
      // Effect composed through flatMap.
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
  // pg-backed scheduled modules stay behind dynamic imports so injected
  // unit tests never load the Node pg module; overrides replace units
  // individually instead of disabling them.
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
    /**
     * Handles HTTP requests for the automation worker, serving basic health check metadata.
     *
     * @param _request - Incoming HTTP Request object.
     * @param env - Automation worker environment bindings.
     * @returns JSON response reporting worker service name, environment, version, and "ok" status.
     */
    fetch(_request, env) {
      configureJobLogging(env);
      return Response.json({
        environment: env.ENVIRONMENT,
        service: "automation",
        status: "ok",
        version: env.VERSION,
      });
    },

    /**
     * Consumes batches of messages from Cloudflare Queues and routes them to dedicated processors.
     *
     * Dispatches provider sync tasks, scheduled distribution jobs, channel
     * revocation commands, comment reply workflow triggers, and asset
     * maintenance jobs. Automatically logs outcomes and applies exponential
     * retry backoff
     * (`min(3600s, 15s * 2^attempts)`) on transient failures. Every body flows through
     * dispatchQueueMessage: unroutable shapes fail terminally there and surface through the
     * rejected branch below (ack-and-surface, AUD-039).
     *
     * @param batch - Batch of incoming queue messages with delivery attempt metadata and queue name.
     * @param bindings - Automation worker bindings, copied into this invocation's ownership scope.
     */
    async queue(batch, bindings) {
      const env = { ...bindings };
      configureJobLogging(env);
      // One asset processor per batch: construction builds the configured
      // object storage store, so the dispatcher resolves it lazily through this
      // memoized thunk rather than paying per message.
      let assetProcessor: Promise<AssetJobProcessor> | undefined;
      for (const message of batch.messages) {
        const startedAt = performance.now();
        const correlation = queueCorrelation(message.body, message.id);
        const event = queueEvent(message.body);
        const job = queueJob(message.body);
        const provider = queueProvider(batch.queue);
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
        // Approved boundary: exactly one Effect program per queue message;
        // runJobProgram owns the single Effect.run* call.
        const program = dispatchQueueMessage(env, {
          body,
          enqueueReplyWorkflow,
          processChannelRevocation,
          processProviderSync,
          providerRegistry: dependencies.providerRegistry,
          processorFor: () => (assetProcessor ??= Promise.resolve(processorFor(env))),
        });
        const exit = await runJobProgram(Effect.provide(program, scope.runtimeLayer));
        const { diagnostic, outcome } = exitToJobOutcome(exit);
        const latencyMs = elapsedMilliseconds(startedAt);
        if (outcome === "processed") {
          message.ack();
          await flow?.finish("succeeded");
          // Log the processor's own success label: "skipped" redeliveries
          // (dedup hits) must not be flattened to "processed", and the reply
          // branch reports "enqueued".
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
          continue;
        }
        if (outcome === "rejected") {
          // Terminal: ack-and-surface producer-contract bugs (AUD-039), and
          // close the flow ledger as failed — a rejected poison message must
          // not mark the run succeeded.
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
          continue;
        }
        if (outcome === "ambiguous") {
          // Ambiguous provider writes must never auto-retry: the distribution
          // and reply processors already armed the next lookup/reconciliation,
          // so ack here to avoid a duplicate remote write on redelivery.
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
          continue;
        }
        await flow?.finish("failed");
        // Deliberate: mirrors the outbox's own exponential backoff
        // (2^attempts * 15s, capped at 1h) so ailing work re-delivers on the
        // same schedule the database retry path uses. The Terraform-managed
        // consumer still enforces max_retries and the DLQ; this only
        // overrides the fixed retry_delay between attempts (AUD-040).
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
      }
    },

    /**
     * Dispatches cron-triggered background maintenance tasks across hourly and daily tiers.
     *
     * Executes outbox relay, asset cleanup, distribution sweep, due distribution scan, provider sync
     * sweep, reply reconciliation, and data retention based on the trigger's cron schedule. Isolates
     * failures so subsequent scheduled units continue running before reporting errors.
     *
     * @param _controller - ScheduledController providing the triggering cron pattern, or null for direct invocation.
     * @param bindings - Automation worker bindings, copied into this invocation's ownership scope.
     * @throws Rethrows the first encountered scheduled task failure after all due units have finished.
     */
    async scheduled(_controller, bindings) {
      const env = { ...bindings };
      configureJobLogging(env);
      const startedAt = performance.now();
      const jobId = crypto.randomUUID();
      const scheduledContext = context(env, jobId, { jobId });
      const cron = _controller?.cron;
      // A missing controller or expression (direct invocation) dispatches
      // every tier; an unrecognized expression dispatches nothing.
      const tierRuns: Record<ScheduledTier, boolean> = {
        daily: !cron || cron === SCHEDULED_TIERS.daily,
        hourly: !cron || cron === SCHEDULED_TIERS.hourly,
      };
      const dueWork = scheduledWork.filter((unit) => tierRuns[unit.tier]);
      const results: Record<string, unknown> = Object.fromEntries(
        scheduledWork.map((unit) => [unit.field, unit.empty]),
      );
      // Units run independently: a failure is reported and the remaining
      // scheduled work for this invocation still executes. Each unit runs as
      // one Effect program through the same boundary mapper as queue messages
      // (runJobProgram + exitToJobOutcome), so retryable/terminal/ambiguous
      // classification is uniform across entry points; the original throw is
      // preserved for the failure log and rethrow below.
      const failures: Array<{ cause: unknown; unit: ScheduledWorkName }> = [];
      for (const unit of dueWork) {
        const unitScope: JobScope = jobScope(
          env,
          makeJobContext({ jobId, source: "scheduled", traceId: jobId }),
        );
        // suspend defers the unit factory so a synchronous throw lands in the
        // Exit cause (defect → retry) instead of escaping the loop.
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
        // The failure log and rethrow below need the original throw, not the
        // typed wrapper: recoverJobErrorCause unwraps the classified error so
        // errorDiagnostic groups on the real error type.
        const cause = recoverJobErrorCause(programExit.cause);
        failures.push({ cause, unit: unit.name });
      }
      const [firstFailure] = failures;
      if (firstFailure) {
        for (const failure of failures) {
          // failures already store the unwrapped error, so errorDiagnostic
          // reads the original throw's name and message directly.
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
/**
 * Runs one module program at the service-binding RPC boundary.
 *
 * Builds a fresh "direct" job scope so the program resolves the same queue
 * services the queue/scheduled paths use, then translates the finished Exit
 * back into the RPC contract: the success value resolves the call, while a
 * failure rejects with the original throw — recoverJobErrorCause restores the
 * name/message classifyJobError stored on the typed wrapper so callers see
 * the pre-migration error shape.
 *
 * @param env - Automation worker environment bindings.
 * @param program - Module Effect to run within the scope's runtime layer.
 * @returns The program's success value.
 * @throws The unwrapped program failure or defect.
 */
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

  /**
   * Eager Outbox relay invoked by the API Worker over its Service Binding on
   * the request's background continuation, immediately after the mutating
   * transaction commits. Entries this bounded batch does not reach — or that it
   * fails to publish — stay pending for the hourly sweep, so the delivery
   * guarantee is unchanged.
   *
   * The relay module returns an Effect; this boundary runs it through the
   * direct-scope program runner and returns its result (or rejects with the
   * unwrapped failure).
   *
   * @returns Counts of outbox messages claimed, published, failed, and dead during eager relay.
   */
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

  /**
   * Demand-driven Comment fetch invoked by the API Worker over its Service
   * Binding when a creator opens the Inbox, on that request's background
   * continuation. Distributions past `demandDrivenCommentsAgeSeconds` have no
   * scheduled Comment sync, so this is what fetches their Comments.
   *
   * Both identifiers are already validated by the API Worker and are bound as
   * `::uuid` statement parameters. The claim is bounded and rate limited per
   * Distribution, so the number of Provider calls one open can cause does not
   * depend on the caller. The provider-sync module returns an Effect; this
   * boundary runs it through the direct-scope program runner and returns the
   * enqueued count (or rejects with the unwrapped failure).
   *
   * @param organizationId - UUID of the organization requesting comment synchronization.
   * @param distributionId - Optional UUID of a specific distribution, or null to synchronize all due distributions.
   * @returns Number of distributions enqueued for comment synchronization.
   */
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

  /**
   * Delegates incoming HTTP requests to the internal automation handler.
   *
   * @param request - Incoming HTTP Request.
   * @returns Response generated by the automation handler.
   */
  fetch(request: Request) {
    const handler = this.#handler.fetch!;
    return handler(request as Parameters<typeof handler>[0], this.env, this.ctx);
  }

  /**
   * Delegates incoming Cloudflare Queue message batches to the internal automation queue consumer.
   *
   * @param batch - Batch of queue messages delivered to this worker.
   * @returns Promise resolving when batch processing finishes.
   */
  queue(batch: MessageBatch<unknown>) {
    return this.#handler.queue!(batch, this.env, this.ctx);
  }

  /**
   * Delegates cron trigger invocations to the internal automation scheduled task dispatcher.
   *
   * @param controller - ScheduledController containing the triggering cron expression.
   * @returns Promise resolving when all due scheduled work units complete.
   */
  scheduled(controller: ScheduledController) {
    return this.#handler.scheduled!(controller, this.env, this.ctx);
  }
}

export default AutomationEntrypoint;
