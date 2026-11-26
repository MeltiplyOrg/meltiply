import { Effect } from "effect";
import { requireActor } from "./authorization";
import type { EffectTransactionClient } from "@meltiply/database";
import { isoDateTime, isoDateTimeOrNull, isUuid } from "@meltiply/domain";
import type { Hono } from "hono";
import {
  createFlowLedgerRecorder,
  exportOtlpSpan,
  flowDatabaseAvailable,
  flowExplorerEnabled,
} from "@meltiply/observability";

export { exportOtlpSpan, flowDatabaseAvailable, flowExplorerEnabled };

import { lazyWithSystemTransactionEffect } from "./database-module";
import type { ApiWorkerEnvironment, ApiWorkerEnv } from "./env";
import { errorResponse, jsonResponse } from "./responses";

async function runWithSystemTransaction<T, E>(
  env: ApiWorkerEnv,
  operation: (client: EffectTransactionClient) => Effect.Effect<T, E>,
): Promise<T> {
  return Effect.runPromise(lazyWithSystemTransactionEffect(env, operation));
}

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
  flows: string[];
}

interface FlowGraph {
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
];

const FLOW_EDGES: FlowEdgeDefinition[] = [
  { from: "browser", to: "edge", label: "HTTPS request", flows: ["all"] },
  { from: "edge", to: "api", label: "route to Worker", flows: ["all"] },
  { from: "edge", to: "cache", label: "cached response", flows: ["read"] },
  { from: "api", to: "auth", label: "session / Access verify", flows: ["auth"] },
  { from: "api", to: "core", label: "service call", flows: ["all"] },
  { from: "core", to: "database", label: "Hyperdrive SQL", flows: ["all"] },
  { from: "api", to: "outbox", label: "enqueue event", flows: ["publish"] },
  { from: "outbox", to: "queue", label: "publish message", flows: ["publish"] },
  { from: "queue", to: "automation", label: "consume message", flows: ["publish"] },
  { from: "automation", to: "workflow", label: "reply workflow", flows: ["publish"] },
  { from: "automation", to: "database", label: "Hyperdrive SQL", flows: ["publish"] },
  { from: "automation", to: "providers", label: "provider API call", flows: ["publish"] },
  { from: "api", to: "state", label: "OAuth state DO", flows: ["auth"] },
  { from: "api", to: "r2", label: "asset upload / download", flows: ["assets"] },
  { from: "api", to: "providers", label: "provider API call", flows: ["publish", "analytics"] },
];

export const flowGraph = (): FlowGraph => ({
  edges: FLOW_EDGES,
  nodes: FLOW_NODES,
});

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

interface FlowRunRow extends Record<string, unknown> {
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

interface FlowStepRow extends Record<string, unknown> {
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

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function runRowToRecord(row: FlowRunRow): FlowRunRecord {
  return {
    created_at: isoDateTime(row.created_at),
    duration_ms: numberOrNull(row.duration_ms),
    entrypoint: row.entrypoint,
    environment: row.environment,
    error_code: row.error_code,
    finished_at: isoDateTimeOrNull(row.finished_at),
    id: row.id,
    metadata: metadataObject(row.metadata),
    org_id: row.org_id,
    request_id: row.request_id,
    retryable: row.retryable,
    started_at: isoDateTime(row.started_at),
    status: row.status,
    trace_id: row.trace_id,
  };
}

function stepRowToRecord(row: FlowStepRow): FlowStepRecord {
  return {
    attempt: row.attempt,
    duration_ms: numberOrNull(row.duration_ms),
    error_code: row.error_code,
    finished_at: isoDateTimeOrNull(row.finished_at),
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
    started_at: isoDateTime(row.started_at),
    status: row.status,
    trace_id: row.trace_id,
    workflow_id: row.workflow_id,
  };
}

interface FlowRecorder {
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

const recorderCache = new WeakMap<object, FlowRecorder>();

interface PendingSpan {
  attributes: Record<string, unknown>;
  expiresAt: number;
  name: string;
  parentSpanId?: string;
  service: string;
  startTimeMs: number;
  traceId: string;
}

export const pendingSpans = new Map<string, PendingSpan>();

const pendingSpanTimeToLiveMilliseconds = 10 * 60 * 1_000;
const pendingSpanMaximumEntries = 256;

function prunePendingSpans(now: number): void {
  for (const [key, span] of pendingSpans) {
    if (span.expiresAt <= now) pendingSpans.delete(key);
  }
  while (pendingSpans.size >= pendingSpanMaximumEntries) {
    const oldest = pendingSpans.keys().next();
    if (oldest.done) break;
    pendingSpans.delete(oldest.value);
  }
}

export function trackPendingSpan(id: string, span: Omit<PendingSpan, "expiresAt">): void {
  const now = Date.now();
  prunePendingSpans(now);
  pendingSpans.set(id, {
    ...span,
    expiresAt: now + pendingSpanTimeToLiveMilliseconds,
  });
}

async function flushPendingSpan(
  env: ApiWorkerEnv,
  id: string,
  outcome: { errorCode?: string; status: string },
  includeParentSpan: boolean,
): Promise<void> {
  const pending = pendingSpans.get(id);
  if (!pending) return;
  pendingSpans.delete(id);
  await exportOtlpSpan(env, {
    attributes: {
      ...pending.attributes,
      error_code: outcome.errorCode ?? "",
    },
    endTimeMs: Date.now(),
    name: pending.name,
    ...(includeParentSpan ? { parentSpanId: pending.parentSpanId } : {}),
    service: pending.service,
    spanId: id,
    startTimeMs: pending.startTimeMs,
    status: outcome.status === "succeeded" ? "ok" : "error",
    traceId: pending.traceId,
  });
}

export function flowRecorderFor(env: ApiWorkerEnv): FlowRecorder {
  const cacheKey: object = env.DB_SYSTEM ?? env;
  const cached = recorderCache.get(cacheKey);
  if (cached) return cached;
  const ledger = createFlowLedgerRecorder({
    env,
    runTransaction: (operation) => runWithSystemTransaction(env, operation),
    service: "api",
  });
  const recorder: FlowRecorder = {
    async finishRun(runId, outcome) {
      await flushPendingSpan(env, runId, outcome, false);
      await ledger.finishRun(runId, outcome);
    },
    async finishStep(stepId, outcome) {
      await flushPendingSpan(env, stepId, outcome, true);
      await ledger.finishStep(stepId, outcome);
    },
    async recordStep(input) {
      const id = await ledger.recordStep(input);
      if (id) {
        trackPendingSpan(id, {
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
      return id;
    },
    async startRun(input) {
      const id = await ledger.startRunForRequest({
        ...input,
        metadata: input.metadata ?? {},
      });
      if (id) {
        trackPendingSpan(id, {
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
      return id;
    },
  };
  recorderCache.set(cacheKey, recorder);
  return recorder;
}

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
    const limit = Math.min(
      Math.max(Math.trunc(Number(c.req.query("limit") ?? "50")) || 50, 1),
      200,
    );
    const environment = c.req.query("environment");
    const status = c.req.query("status");
    const orgId = requireActor(c).workspace.id;
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
    if (!isUuid(runId)) {
      return errorResponse(c.get("requestId"), 404, "not_found", "The route was not found.");
    }
    const orgId = requireActor(c).workspace.id;
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
    if (!isUuid(runId)) {
      return jsonResponse({ steps: [] }, 200, c.get("requestId"));
    }
    const orgId = requireActor(c).workspace.id;
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
