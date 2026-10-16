import { Cause, Effect, Exit } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { DatabaseError } from "@meltiply/domain";
import { errorDiagnostic, log } from "@meltiply/observability";

import type { AutomationEnv } from "./env";

/**
 * Lazy-loads the database layer and executes an Effect transaction at this Promise boundary.
 * Same lazy pattern as the API Worker's flow-observability module: importing this module must
 * never evaluate the `pg` client in the @cloudflare/vitest-plugin unit-test pool, which runs without
 * real Hyperdrive bindings — so only `./database` (the module that pulls in `@meltiply/database`
 * and therefore `pg`) is imported dynamically. The transaction itself runs through
 * `withSystemTransactionEffect`; runPromiseExit plus Cause.squash rethrows the original
 * DatabaseError (not a FiberFailure) so bestEffort's diagnostics keep the real error identity.
 *
 * @param env - Automation worker environment.
 * @param operation - Function returning an Effect given the scoped EffectTransactionClient.
 * @returns Result from the transactional Effect.
 */
async function runWithSystemTransaction<T>(
  env: AutomationEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<T, DatabaseError>,
): Promise<T> {
  const { withSystemTransactionEffect } = await import("./database");
  const exit = await Effect.runPromiseExit(withSystemTransactionEffect(env, operation));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/**
 * Checks whether the non-production flow explorer ledger is enabled.
 * Constrained strictly to "local" and "test" environments.
 *
 * @param env - Automation worker environment.
 * @returns True if running in local development or automated test mode.
 */
export const flowExplorerEnabled = (env: AutomationEnv): boolean =>
  env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";

/**
 * Checks whether the system database connection string binding is present.
 *
 * @param env - Automation worker environment.
 * @returns True if DB_SYSTEM provides a non-empty connection string.
 */
export const flowDatabaseAvailable = (env: AutomationEnv): boolean => {
  const binding = env.DB_SYSTEM as { connectionString?: string } | undefined;
  return Boolean(binding?.connectionString);
};

export interface AutomationFlowRecorder {
  finishStep(
    stepId: string,
    outcome: {
      errorCode?: string;
      retryable?: boolean;
      status: "failed" | "succeeded" | "skipped";
    },
  ): Promise<void>;
  finishRun(
    runId: string,
    outcome: {
      errorCode?: string;
      retryable?: boolean;
      status: "cancelled" | "failed" | "succeeded";
    },
  ): Promise<void>;
  recordStep(input: {
    attempt?: number;
    jobId?: string;
    metadata?: Record<string, unknown>;
    nodeKey: string;
    operation: string;
    orgId?: string;
    parentStepId?: string;
    provider?: string;
    queueName?: string;
    requestId?: string;
    runId: string;
    service: string;
    traceId: string;
    workflowId?: string;
  }): Promise<string | null>;
  startRunForRequest(input: {
    entrypoint: string;
    orgId?: string;
    requestId: string;
    traceId: string;
  }): Promise<string | null>;
}

const recorderCache = new WeakMap<AutomationEnv, AutomationFlowRecorder>();

/**
 * Returns or instantiates the isolate-cached AutomationFlowRecorder.
 * Records sanitized execution steps into flow_runs and flow_steps tables.
 * Each method composes its writes as an Effect transaction and runs it at the
 * method's Promise boundary via bestEffort, so callers in the Worker's
 * Promise-facing dispatch path keep the same async contract.
 *
 * @param env - Automation worker environment.
 * @returns AutomationFlowRecorder instance.
 */
export function flowRecorderFor(env: AutomationEnv): AutomationFlowRecorder {
  const cached = recorderCache.get(env);
  if (cached) return cached;
  const recorder: AutomationFlowRecorder = {
    /**
     * Marks a flow run completed with its final outcome and duration.
     *
     * @param runId - Primary key of the flow run in flow_runs.
     * @param outcome - Final status, error code, and retryability flag.
     */
    async finishRun(runId, outcome) {
      await bestEffort(env, (client) =>
        client.query(
          `UPDATE flow_runs
             SET status = $1, error_code = $2, retryable = $3,
                 finished_at = now(), duration_ms = round(extract(epoch from (now() - started_at)) * 1000)
           WHERE id = $4`,
          [outcome.status, outcome.errorCode ?? null, outcome.retryable ?? null, runId],
        ),
      );
    },
    /**
     * Updates an individual flow step to a terminal status and calculates duration.
     *
     * @param stepId - Primary key of the step in flow_steps.
     * @param outcome - Step outcome status, optional error code, and retryability.
     */
    async finishStep(stepId, outcome) {
      await bestEffort(env, (client) =>
        client.query(
          `UPDATE flow_steps
             SET status = $1, error_code = $2, retryable = $3,
                 finished_at = now(), duration_ms = round(extract(epoch from (now() - started_at)) * 1000)
           WHERE id = $4`,
          [outcome.status, outcome.errorCode ?? null, outcome.retryable ?? null, stepId],
        ),
      );
    },
    /**
     * Records a new execution step in flow_steps under an active run.
     *
     * @param input - Step configuration including nodeKey, operation, runId, traceId, and metadata.
     * @returns Created step ID string, or null on error.
     */
    async recordStep(input) {
      const id = await bestEffort(env, (client) =>
        client
          .query<{ id: string }>(
            `INSERT INTO flow_steps
             (run_id, parent_step_id, org_id, node_key, node_type, service, operation, status,
              attempt, request_id, trace_id, job_id, workflow_id, queue_name, provider, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id`,
            [
              input.runId,
              input.parentStepId ?? null,
              input.orgId ?? null,
              input.nodeKey,
              nodeTypeFor(input.nodeKey),
              input.service,
              input.operation,
              input.attempt ?? 1,
              input.requestId ?? null,
              input.traceId,
              input.jobId ?? null,
              input.workflowId ?? null,
              input.queueName ?? null,
              input.provider ?? null,
              input.metadata ?? {},
            ],
          )
          .pipe(Effect.map((result) => result.rows[0]?.id ?? null)),
      );
      return id ?? null;
    },
    /**
     * Upserts a flow run keyed by (environment, request_id) to link queue work to the originating API call.
     *
     * @param input - Run configuration containing entrypoint, requestId, traceId, and optional orgId.
     * @returns Run ID string, or null on error.
     */
    async startRunForRequest(input) {
      const id = await bestEffort(env, (client) =>
        client
          .query<{ id: string }>(
            `INSERT INTO flow_runs
             (environment, trace_id, request_id, org_id, entrypoint, status, metadata)
           VALUES ($1, $2, $3, $4, $5, 'running', $6)
           ON CONFLICT (environment, request_id) DO UPDATE
             SET started_at = flow_runs.started_at
           WHERE flow_runs.org_id IS NOT DISTINCT FROM EXCLUDED.org_id
           RETURNING id`,
            [
              env.ENVIRONMENT,
              input.traceId,
              input.requestId,
              input.orgId ?? null,
              input.entrypoint,
              {},
            ],
          )
          .pipe(Effect.map((result) => result.rows[0]?.id ?? null)),
      );
      return id ?? null;
    },
  };
  recorderCache.set(env, recorder);
  return recorder;
}

/**
 * Executes an Effect database operation with error suppression and structured failure logging.
 * Guarantees that flow explorer ledger persistence errors never disrupt primary queue processing.
 *
 * @param env - Automation worker environment.
 * @param operation - Function returning an Effect given the scoped EffectTransactionClient.
 * @returns Result from the Effect, or null if execution failed.
 */
async function bestEffort<T>(
  env: AutomationEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<T, DatabaseError>,
): Promise<T | null> {
  try {
    return await runWithSystemTransaction(env, operation);
  } catch (cause) {
    log(
      "error",
      {
        environment: env.ENVIRONMENT,
        service: "automation",
        trace_id: "flow-observability",
        version: env.VERSION,
      },
      {
        error_code: "flow_ledger_write_failed",
        event: "flow_ledger_write_failed",
        ...errorDiagnostic(cause),
        outcome: "internal_error",
        retry_class: "none",
      },
    );
    return null;
  }
}

const FLOW_NODE_KINDS: Record<string, string> = {
  browser: "client",
  edge: "edge",
  api: "api",
  core: "service",
  auth: "auth",
  database: "database",
  outbox: "database",
  queue: "queue",
  automation: "workflow",
  workflow: "workflow",
  state: "workflow",
  r2: "storage",
  cache: "storage",
  providers: "provider",
  polar: "provider",
};

/**
 * Maps a flow node key to its standardized architectural node category.
 *
 * @param nodeKey - Architectural node identifier (e.g. "browser", "api", "queue", "database").
 * @returns Node kind classification (e.g. "client", "service", "queue", "database", "storage").
 */
function nodeTypeFor(nodeKey: string): string {
  return FLOW_NODE_KINDS[nodeKey] ?? "service";
}
