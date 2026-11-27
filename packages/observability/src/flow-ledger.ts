import { Effect } from "effect";

import { errorDiagnostic, isLocalOrTestEnvironment, log } from "./log";

export interface FlowLedgerQueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface FlowLedgerClient {
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Effect.Effect<FlowLedgerQueryResult<Row>, unknown>;
}

export type FlowLedgerTransactionRunner = <T>(
  operation: (client: FlowLedgerClient) => Effect.Effect<T, unknown>,
) => Promise<T>;

export interface FlowLedgerEnvironment {
  readonly DB_SYSTEM?: { readonly connectionString?: string };
  readonly ENVIRONMENT?: string;
  readonly VERSION?: string;
}

export interface FlowLedgerRecorder {
  finishRun(
    runId: string,
    outcome: {
      errorCode?: string;
      retryable?: boolean;
      status: "cancelled" | "failed" | "succeeded";
    },
  ): Promise<void>;
  finishStep(
    stepId: string,
    outcome: {
      errorCode?: string;
      retryable?: boolean;
      status: "failed" | "skipped" | "succeeded";
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
    metadata?: Record<string, unknown>;
    orgId?: string;
    requestId: string;
    traceId: string;
  }): Promise<string | null>;
}

const FLOW_NODE_KINDS: Readonly<Record<string, string>> = {
  api: "api",
  auth: "auth",
  automation: "workflow",
  browser: "client",
  cache: "storage",
  core: "service",
  database: "database",
  edge: "edge",
  outbox: "database",
  providers: "provider",
  queue: "queue",
  r2: "storage",
  state: "workflow",
  workflow: "workflow",
};

export function flowNodeTypeFor(nodeKey: string): string {
  return FLOW_NODE_KINDS[nodeKey] ?? "service";
}

export function flowExplorerEnabled(env: FlowLedgerEnvironment): boolean {
  return isLocalOrTestEnvironment(env.ENVIRONMENT);
}

export function flowDatabaseAvailable(env: FlowLedgerEnvironment): boolean {
  return Boolean(env.DB_SYSTEM?.connectionString);
}

/**
 * Creates a best-effort ledger recorder backed by `flow_runs` and `flow_steps`.
 * Ledger failures are logged and swallowed so flow tracing never disrupts live work.
 */
export function createFlowLedgerRecorder(options: {
  readonly env: FlowLedgerEnvironment;
  readonly runTransaction: FlowLedgerTransactionRunner;
  readonly service: string;
}): FlowLedgerRecorder {
  const { env, runTransaction, service } = options;

  async function bestEffort<T>(
    operation: (client: FlowLedgerClient) => Effect.Effect<T, unknown>,
  ): Promise<T | null> {
    try {
      return await runTransaction(operation);
    } catch (cause) {
      log(
        "error",
        {
          environment: env.ENVIRONMENT ?? "unknown",
          service,
          trace_id: "flow-observability",
          version: env.VERSION ?? "unknown",
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

  return {
    async finishRun(runId, outcome) {
      await bestEffort((client) =>
        client.query(
          `UPDATE flow_runs
             SET status = $1, error_code = $2, retryable = $3,
                 finished_at = now(), duration_ms = round(extract(epoch from (now() - started_at)) * 1000)
           WHERE id = $4`,
          [outcome.status, outcome.errorCode ?? null, outcome.retryable ?? null, runId],
        ),
      );
    },
    async finishStep(stepId, outcome) {
      await bestEffort((client) =>
        client.query(
          `UPDATE flow_steps
             SET status = $1, error_code = $2, retryable = $3,
                 finished_at = now(), duration_ms = round(extract(epoch from (now() - started_at)) * 1000)
           WHERE id = $4`,
          [outcome.status, outcome.errorCode ?? null, outcome.retryable ?? null, stepId],
        ),
      );
    },
    async recordStep(input) {
      const id = await bestEffort((client) =>
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
              flowNodeTypeFor(input.nodeKey),
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
    async startRunForRequest(input) {
      const hasMetadata = input.metadata !== undefined;
      const sql = hasMetadata
        ? `INSERT INTO flow_runs
             (environment, trace_id, request_id, org_id, entrypoint, status, metadata)
           VALUES ($1, $2, $3, $4, $5, 'running', $6)
           ON CONFLICT (environment, request_id) DO UPDATE
             SET entrypoint = EXCLUDED.entrypoint, metadata = EXCLUDED.metadata
           WHERE flow_runs.org_id IS NOT DISTINCT FROM EXCLUDED.org_id
           RETURNING id`
        : `INSERT INTO flow_runs
             (environment, trace_id, request_id, org_id, entrypoint, status, metadata)
           VALUES ($1, $2, $3, $4, $5, 'running', $6)
           ON CONFLICT (environment, request_id) DO UPDATE
             SET started_at = flow_runs.started_at
           WHERE flow_runs.org_id IS NOT DISTINCT FROM EXCLUDED.org_id
           RETURNING id`;
      const id = await bestEffort((client) =>
        client
          .query<{ id: string }>(sql, [
            env.ENVIRONMENT ?? "unknown",
            input.traceId,
            input.requestId,
            input.orgId ?? null,
            input.entrypoint,
            input.metadata ?? {},
          ])
          .pipe(Effect.map((result) => result.rows[0]?.id ?? null)),
      );
      return id ?? null;
    },
  };
}
