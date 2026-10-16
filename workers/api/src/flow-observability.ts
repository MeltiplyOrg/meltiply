import { Effect } from "effect";
import type { EffectTransactionClient } from "@meltiply/database";
import type { Hono } from "hono";
import { errorDiagnostic, exportOtlpSpan, log } from "@meltiply/observability";

export { exportOtlpSpan };

import type { ApiWorkerEnvironment, ApiWorkerEnv } from "./env";
import { errorResponse, jsonResponse } from "./responses";

/**
 * Executes an Effect callback within a system database transaction with dynamic database module import.
 *
 * Dynamically imports `./database` to prevent premature `pg` client evaluation in unit
 * tests that lack real Hyperdrive bindings, then runs the transaction at this
 * Promise-facing boundary via `Effect.runPromise`.
 *
 * @param env - Worker environment containing the system database Hyperdrive binding.
 * @param operation - Database transaction callback receiving a system EffectTransactionClient.
 * @returns The resolved outcome of the database operation.
 */
async function runWithSystemTransaction<T, E>(
  env: ApiWorkerEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<T, E>,
): Promise<T> {
  const { withSystemTransactionEffect } = await import("./database");
  return Effect.runPromise(withSystemTransactionEffect(env, operation));
}

/**
 * Non-production flow explorer.
 *
 * A sanitized execution ledger (flow_runs / flow_steps) plus a static flow
 * graph. Traces an operation end to end across the browser, API Worker,
 * queue / workflow, cache and database. Tenant payloads, credentials and
 * provider tokens never enter this schema: steps record node, service,
 * operation, status, durations and small whitelisted metadata only.
 *
 * Enabled only for local and test environments. Staging and production keep
 * the flag off so no write path and no route exists there.
 */

export const flowExplorerEnabled = (env: ApiWorkerEnv): boolean =>
  env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test";

/**
 * True when the system Hyperdrive binding is actually usable. The unit-test
 * pool passes `{} as Hyperdrive`, which is truthy but has no
 * `connectionString`; reaching `systemPoolFor()` with that would build a real
 * pg pool with an undefined connection string and throw. Mirrors the
 * middleware guard in app.ts.
 */
export const flowDatabaseAvailable = (env: ApiWorkerEnv): boolean => {
  const binding = env.DB_SYSTEM as { connectionString?: string } | undefined;
  return Boolean(binding?.connectionString);
};

interface FlowNodeDefinition {
  key: string;
  label: string;
  kind:
    | "client"
    | "edge"
    | "api"
    | "service"
    | "database"
    | "queue"
    | "workflow"
    | "storage"
    | "provider"
    | "auth";
}

interface FlowEdgeDefinition {
  from: string;
  to: string;
  label: string;
  /** Contexts this edge is part of, e.g. "publish", "billing", "auth". */
  flows: string[];
}

export interface FlowGraph {
  nodes: FlowNodeDefinition[];
  edges: FlowEdgeDefinition[];
}

const FLOW_NODES: FlowNodeDefinition[] = [
  { key: "browser", label: "Browser (React app)", kind: "client" },
  { key: "edge", label: "Cloudflare Edge", kind: "edge" },
  { key: "api", label: "API Worker", kind: "api" },
  { key: "core", label: "Core services", kind: "service" },
  { key: "auth", label: "Better Auth / Cloudflare Access", kind: "auth" },
  { key: "database", label: "PostgreSQL (Hyperdrive)", kind: "database" },
  { key: "outbox", label: "Outbox", kind: "database" },
  { key: "queue", label: "Cloudflare Queue", kind: "queue" },
  { key: "automation", label: "Automation Worker", kind: "workflow" },
  { key: "workflow", label: "Cloudflare Workflow", kind: "workflow" },
  { key: "state", label: "State DO (OAuth)", kind: "workflow" },
  { key: "r2", label: "R2 Storage", kind: "storage" },
  { key: "cache", label: "Edge / KV cache", kind: "storage" },
  { key: "providers", label: "Social providers", kind: "provider" },
  { key: "polar", label: "Polar billing", kind: "provider" },
];

const FLOW_EDGES: FlowEdgeDefinition[] = [
  { from: "browser", to: "edge", label: "HTTPS request", flows: ["all"] },
  { from: "edge", to: "api", label: "route to Worker", flows: ["all"] },
  { from: "edge", to: "cache", label: "cached response", flows: ["read"] },
  {
    from: "api",
    to: "auth",
    label: "session / Access verify",
    flows: ["auth"],
  },
  { from: "api", to: "core", label: "service call", flows: ["all"] },
  { from: "core", to: "database", label: "Hyperdrive SQL", flows: ["all"] },
  { from: "api", to: "outbox", label: "enqueue event", flows: ["publish"] },
  { from: "outbox", to: "queue", label: "publish message", flows: ["publish"] },
  {
    from: "queue",
    to: "automation",
    label: "consume message",
    flows: ["publish"],
  },
  {
    from: "automation",
    to: "workflow",
    label: "reply workflow",
    flows: ["publish"],
  },
  {
    from: "automation",
    to: "database",
    label: "Hyperdrive SQL",
    flows: ["publish"],
  },
  {
    from: "automation",
    to: "providers",
    label: "provider API call",
    flows: ["publish"],
  },
  { from: "api", to: "state", label: "OAuth state DO", flows: ["auth"] },
  {
    from: "api",
    to: "r2",
    label: "asset upload / download",
    flows: ["assets"],
  },
  {
    from: "api",
    to: "providers",
    label: "provider API call",
    flows: ["publish", "analytics"],
  },
  { from: "api", to: "polar", label: "checkout / portal", flows: ["billing"] },
  {
    from: "edge",
    to: "polar",
    label: "webhook (Standard Webhooks)",
    flows: ["billing"],
  },
];

export const flowGraph = (): FlowGraph => ({
  edges: FLOW_EDGES,
  nodes: FLOW_NODES,
});

const FLOW_NODE_KINDS = new Map(FLOW_NODES.map((node) => [node.key, node.kind]));

/**
 * Resolves the architectural node kind (e.g. `'client'`, `'api'`, `'database'`) for a node key.
 *
 * Falls back to `'service'` if the node key is not in the predefined `FLOW_NODES` inventory.
 *
 * @param nodeKey - Unique node identifier string.
 * @returns Corresponding architectural node kind.
 */
function nodeTypeFor(nodeKey: string): string {
  return FLOW_NODE_KINDS.get(nodeKey) ?? "service";
}

interface FlowRunRecord {
  created_at: string;
  duration_ms: number | null;
  entrypoint: string;
  environment: string;
  error_code: string | null;
  finished_at: string | null;
  id: string;
  metadata: Record<string, unknown>;
  org_id: string | null;
  request_id: string;
  retryable: boolean | null;
  started_at: string;
  status: string;
  trace_id: string;
}

interface FlowStepRecord {
  attempt: number;
  duration_ms: number | null;
  error_code: string | null;
  finished_at: string | null;
  id: string;
  job_id: string | null;
  metadata: Record<string, unknown>;
  node_key: string;
  node_type: string;
  operation: string;
  org_id: string | null;
  parent_step_id: string | null;
  provider: string | null;
  queue_name: string | null;
  request_id: string | null;
  retryable: boolean | null;
  service: string;
  started_at: string;
  status: string;
  trace_id: string;
  workflow_id: string | null;
}

interface FlowRunRow {
  [key: string]: unknown;
  created_at: string | Date;
  duration_ms: string | number | null;
  entrypoint: string;
  environment: string;
  error_code: string | null;
  finished_at: string | Date | null;
  id: string;
  metadata: unknown;
  org_id: string | null;
  request_id: string;
  retryable: boolean | null;
  started_at: string | Date;
  status: string;
  trace_id: string;
}

interface FlowStepRow {
  [key: string]: unknown;
  attempt: number;
  duration_ms: string | number | null;
  error_code: string | null;
  finished_at: string | Date | null;
  id: string;
  job_id: string | null;
  metadata: unknown;
  node_key: string;
  node_type: string;
  operation: string;
  org_id: string | null;
  parent_step_id: string | null;
  provider: string | null;
  queue_name: string | null;
  request_id: string | null;
  retryable: boolean | null;
  service: string;
  started_at: string | Date;
  status: string;
  trace_id: string;
  workflow_id: string | null;
}

/**
 * Normalizes a Date object or timestamp string into an ISO-8601 formatted string.
 *
 * @param value - Date instance or parsable date string.
 * @returns ISO-8601 formatted string.
 */
function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Coerces a numeric or string value to a finite number, returning null for empty or non-finite inputs.
 *
 * @param value - Candidate numeric value, string, or null.
 * @returns Finite number, or `null` if invalid or empty.
 */
function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validates and casts an unknown value to a non-array metadata record.
 *
 * @param value - Unknown candidate metadata value.
 * @returns Key-value metadata record, or empty object `{}` if invalid.
 */
function metadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Converts a database `flow_runs` row into an API `FlowRunRecord`.
 *
 * Formats timestamps, duration numbers, and metadata JSON objects.
 *
 * @param row - Raw database row from `flow_runs`.
 * @returns Sanitized API `FlowRunRecord` entity.
 */
function runRowToRecord(row: FlowRunRow): FlowRunRecord {
  return {
    created_at: iso(row.created_at),
    duration_ms: numberOrNull(row.duration_ms),
    entrypoint: row.entrypoint,
    environment: row.environment,
    error_code: row.error_code,
    finished_at: row.finished_at === null ? null : iso(row.finished_at),
    id: row.id,
    metadata: metadataObject(row.metadata),
    org_id: row.org_id,
    request_id: row.request_id,
    retryable: row.retryable,
    started_at: iso(row.started_at),
    status: row.status,
    trace_id: row.trace_id,
  };
}

/**
 * Converts a database `flow_steps` row into an API `FlowStepRecord`.
 *
 * Formats duration numbers, timestamps, and sanitizes metadata attributes.
 *
 * @param row - Raw database row from `flow_steps`.
 * @returns Sanitized API `FlowStepRecord` entity.
 */
function stepRowToRecord(row: FlowStepRow): FlowStepRecord {
  return {
    attempt: row.attempt,
    duration_ms: numberOrNull(row.duration_ms),
    error_code: row.error_code,
    finished_at: row.finished_at === null ? null : iso(row.finished_at),
    id: row.id,
    job_id: row.job_id,
    metadata: metadataObject(row.metadata),
    node_key: row.node_key,
    node_type: row.node_type,
    operation: row.operation,
    org_id: row.org_id,
    parent_step_id: row.parent_step_id,
    provider: row.provider,
    queue_name: row.queue_name,
    request_id: row.request_id,
    retryable: row.retryable,
    service: row.service,
    started_at: iso(row.started_at),
    status: row.status,
    trace_id: row.trace_id,
    workflow_id: row.workflow_id,
  };
}

/**
 * Non-production recorder bound to the API Worker system database.
 * Every write is best-effort and never fails the operation it observes.
 */
export interface FlowRecorder {
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
  startRun(input: {
    entrypoint: string;
    metadata?: Record<string, unknown>;
    orgId?: string;
    requestId: string;
    traceId: string;
  }): Promise<string | null>;
}

const recorderCache = new WeakMap<ApiWorkerEnv, FlowRecorder>();

interface PendingSpan {
  attributes: Record<string, unknown>;
  name: string;
  parentSpanId?: string;
  service: string;
  startTimeMs: number;
  traceId: string;
}

const pendingSpans = new Map<string, PendingSpan>();

/**
 * Factory returning a cached, best-effort `FlowRecorder` instance for the worker environment.
 *
 * Caches recorder instances per `ApiWorkerEnv` using a WeakMap. All persistence writes
 * are executed best-effort so ledger failures never break observed user operations.
 *
 * @param env - Worker environment bindings.
 * @returns Configured `FlowRecorder` instance.
 */
export function flowRecorderFor(env: ApiWorkerEnv): FlowRecorder {
  const cached = recorderCache.get(env);
  if (cached) return cached;
  const recorder: FlowRecorder = {
    /**
     * Finalizes an active flow run, recording final status, error codes, and flushing OTLP spans.
     *
     * @param runId - Unique identifier of the flow run to finish.
     * @param outcome - Final execution outcome containing status, errorCode, and retryable flag.
     * @returns Resolves when ledger update completes or fails silently.
     */
    async finishRun(runId, outcome) {
      const pending = pendingSpans.get(runId);
      if (pending) {
        pendingSpans.delete(runId);
        await exportOtlpSpan(env, {
          attributes: {
            ...pending.attributes,
            error_code: outcome.errorCode ?? "",
          },
          endTimeMs: Date.now(),
          name: pending.name,
          service: pending.service,
          spanId: runId,
          startTimeMs: pending.startTimeMs,
          status: outcome.status === "succeeded" ? "ok" : "error",
          traceId: pending.traceId,
        });
      }
      await bestEffort(env, (client) =>
        client
          .query(
            `UPDATE flow_runs
             SET status = $1, error_code = $2, retryable = $3,
                 finished_at = now(), duration_ms = round(extract(epoch from (now() - started_at)) * 1000)
           WHERE id = $4`,
            [outcome.status, outcome.errorCode ?? null, outcome.retryable ?? null, runId],
          )
          .pipe(Effect.asVoid),
      );
    },
    /**
     * Completes a recorded step within a flow run, updating duration and outcome status.
     *
     * @param stepId - Unique step ID to complete.
     * @param outcome - Step outcome containing status (`failed`, `succeeded`, or `skipped`).
     * @returns Resolves when database update completes or fails silently.
     */
    async finishStep(stepId, outcome) {
      const pending = pendingSpans.get(stepId);
      if (pending) {
        pendingSpans.delete(stepId);
        await exportOtlpSpan(env, {
          attributes: {
            ...pending.attributes,
            error_code: outcome.errorCode ?? "",
          },
          endTimeMs: Date.now(),
          name: pending.name,
          parentSpanId: pending.parentSpanId,
          service: pending.service,
          spanId: stepId,
          startTimeMs: pending.startTimeMs,
          status: outcome.status === "succeeded" ? "ok" : "error",
          traceId: pending.traceId,
        });
      }
      await bestEffort(env, (client) =>
        client
          .query(
            `UPDATE flow_steps
             SET status = $1, error_code = $2, retryable = $3,
                 finished_at = now(), duration_ms = round(extract(epoch from (now() - started_at)) * 1000)
           WHERE id = $4`,
            [outcome.status, outcome.errorCode ?? null, outcome.retryable ?? null, stepId],
          )
          .pipe(Effect.asVoid),
      );
    },
    /**
     * Records an execution step within a flow run ledger and exports an OTLP trace span.
     *
     * The `orgId` input is the internal workspace UUID supplied by actor resolution;
     * it is stored verbatim because the ledger only records resolved tenant scope.
     *
     * @param input - Step parameters (runId, nodeKey, service, operation, metadata, etc.).
     * @returns Created step UUID or `null` if ledger recording is skipped or failed.
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
      if (id) {
        pendingSpans.set(id, {
          attributes: {
            job_id: input.jobId ?? "",
            node_key: input.nodeKey,
            operation: input.operation,
            provider: input.provider ?? "",
            queue_name: input.queueName ?? "",
            request_id: input.requestId ?? "",
            workflow_id: input.workflowId ?? "",
          },
          name: `${input.nodeKey}.${input.operation}`,
          parentSpanId: input.parentStepId ?? input.runId,
          service: input.service,
          startTimeMs: Date.now(),
          traceId: input.traceId,
        });
      }
      return id ?? null;
    },
    /**
     * Initiates a new flow run ledger entry and tracks an active pending span.
     *
     * The `orgId` input is the internal workspace UUID supplied by actor resolution.
     *
     * @param input - Flow run parameters (entrypoint, requestId, traceId, orgId, metadata).
     * @returns Created run UUID or `null` if recording is skipped or failed.
     */
    async startRun(input) {
      const id = await bestEffort(env, (client) =>
        client
          .query<{ id: string }>(
            `INSERT INTO flow_runs
             (environment, trace_id, request_id, org_id, entrypoint, status, metadata)
           VALUES ($1, $2, $3, $4, $5, 'running', $6)
           ON CONFLICT (environment, request_id) DO UPDATE
             SET entrypoint = EXCLUDED.entrypoint, metadata = EXCLUDED.metadata
           WHERE flow_runs.org_id IS NOT DISTINCT FROM EXCLUDED.org_id
           RETURNING id`,
            [
              env.ENVIRONMENT,
              input.traceId,
              input.requestId,
              input.orgId ?? null,
              input.entrypoint,
              input.metadata ?? {},
            ],
          )
          .pipe(Effect.map((result) => result.rows[0]?.id ?? null)),
      );
      if (id) {
        pendingSpans.set(id, {
          attributes: {
            entrypoint: input.entrypoint,
            request_id: input.requestId,
          },
          name: input.entrypoint,
          service: "api",
          startTimeMs: Date.now(),
          traceId: input.traceId,
        });
      }
      return id ?? null;
    },
  };
  recorderCache.set(env, recorder);
  return recorder;
}

/**
 * Executes a database callback swallowing and logging any thrown errors.
 *
 * Guarantees that diagnostic and observability writes never fail the parent request.
 *
 * @param env - Worker environment bindings.
 * @param operation - Database callback receiving an Effect transaction client.
 * @returns Result of the operation, or `null` if execution encountered an error.
 */
async function bestEffort<T, E>(
  env: ApiWorkerEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<T, E>,
): Promise<T | null> {
  try {
    return await runWithSystemTransaction(env, operation);
  } catch (cause) {
    log(
      "error",
      {
        environment: env.ENVIRONMENT,
        service: "api",
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

/**
 * Mounts non-production flow explorer HTTP endpoints onto the Hono application router.
 *
 * Registers `/api/v1/flows/graph`, `/api/v1/flows/runs`, `/api/v1/flows/runs/:runId`,
 * and `/api/v1/flows/runs/:runId/steps`. All routes return 404 in production/staging
 * environments. Reads are scoped to the resolved actor's workspace because the
 * system pool bypasses RLS.
 *
 * @param app - Root or sub-router Hono application instance.
 */
export function registerFlowRoutes(app: Hono<ApiWorkerEnvironment>): void {
  app.get("/api/v1/flows/graph", (c) => {
    if (!flowExplorerEnabled(c.env)) {
      return errorResponse(c.get("requestId"), 404, "not_found", "The route was not found.");
    }
    return jsonResponse(flowGraph(), 200, c.get("requestId"));
  });

  app.get("/api/v1/flows/runs", async (c) => {
    if (!flowExplorerEnabled(c.env)) {
      return errorResponse(c.get("requestId"), 404, "not_found", "The route was not found.");
    }
    if (!flowDatabaseAvailable(c.env)) {
      return jsonResponse({ runs: [] }, 200, c.get("requestId"));
    }
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50") || 50, 1), 200);
    const environment = c.req.query("environment");
    const status = c.req.query("status");
    const orgId = c.get("actor").workspace.id;
    const runs = await runWithSystemTransaction(c.env, (client) =>
      Effect.gen(function* () {
        const parameters: unknown[] = [orgId];
        const clauses: string[] = [`org_id = $1`];
        if (environment) {
          parameters.push(environment);
          clauses.push(`environment = $${parameters.length}`);
        }
        if (status) {
          parameters.push(status);
          clauses.push(`status = $${parameters.length}`);
        }
        parameters.push(limit);
        const result = yield* client.query<FlowRunRow>(
          `SELECT id, environment, trace_id, request_id, org_id, entrypoint, status,
                  error_code, retryable, started_at, finished_at, duration_ms, metadata, created_at
             FROM flow_runs
             WHERE ${clauses.join(" AND ")}
             ORDER BY created_at DESC
             LIMIT $${parameters.length}`,
          parameters,
        );
        return result.rows.map(runRowToRecord);
      }),
    );
    return jsonResponse({ runs }, 200, c.get("requestId"));
  });

  app.get("/api/v1/flows/runs/:runId", async (c) => {
    if (!flowExplorerEnabled(c.env)) {
      return errorResponse(c.get("requestId"), 404, "not_found", "The route was not found.");
    }
    if (!flowDatabaseAvailable(c.env)) {
      return errorResponse(c.get("requestId"), 404, "not_found", "The route was not found.");
    }
    const runId = c.req.param("runId");
    const orgId = c.get("actor").workspace.id;
    const run = await runWithSystemTransaction(c.env, (client) =>
      client
        .query<FlowRunRow>(
          `SELECT id, environment, trace_id, request_id, org_id, entrypoint, status,
                  error_code, retryable, started_at, finished_at, duration_ms, metadata, created_at
             FROM flow_runs
             WHERE id = $1
               AND org_id = $2`,
          [runId, orgId],
        )
        .pipe(Effect.map((result) => (result.rows[0] ? runRowToRecord(result.rows[0]) : null))),
    );
    if (!run) {
      return errorResponse(c.get("requestId"), 404, "not_found", "The route was not found.");
    }
    return jsonResponse({ run }, 200, c.get("requestId"));
  });

  app.get("/api/v1/flows/runs/:runId/steps", async (c) => {
    if (!flowExplorerEnabled(c.env)) {
      return errorResponse(c.get("requestId"), 404, "not_found", "The route was not found.");
    }
    if (!flowDatabaseAvailable(c.env)) {
      return jsonResponse({ steps: [] }, 200, c.get("requestId"));
    }
    const runId = c.req.param("runId");
    const orgId = c.get("actor").workspace.id;
    const steps = await runWithSystemTransaction(c.env, (client) =>
      client
        .query<FlowStepRow>(
          `SELECT id, run_id, parent_step_id, org_id, node_key, node_type, service, operation,
                  status, attempt, request_id, trace_id, job_id, workflow_id, queue_name, provider,
                  started_at, finished_at, duration_ms, error_code, retryable, metadata
             FROM flow_steps
             WHERE run_id = $1
               AND org_id = $2
             ORDER BY started_at, id`,
          [runId, orgId],
        )
        .pipe(Effect.map((result) => result.rows.map(stepRowToRecord))),
    );
    return jsonResponse({ steps }, 200, c.get("requestId"));
  });
}
