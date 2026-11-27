import { emitsLine, samplingRate, type LogLevel } from "./sampling";
import { sanitizeErrorText, sanitizeRecord, serializeError } from "./sanitize";

const messageSeparatorsPattern = /_+/g;
const maxJsonString = 2_048;
let logSamplingRate = 1;

/** Sets the info/debug sampling rate, clamped to [0, 1]; missing or unparseable input restores 1. */
export function configureLogSampling(rate: string | number | undefined): void {
  logSamplingRate = samplingRate(rate);
}

export interface LogContext {
  environment: string;
  job_id?: string;
  request_id?: string;
  route?: string;
  service: string;
  trace_id: string;
  user_id?: string;
  version: string;
  workflow_id?: string;
}

export type RetryClass =
  | "client_retry"
  | "none"
  | "platform_retry"
  | "provider_backoff"
  | "queue_backoff"
  | "reconciliation"
  | "workflow_backoff";

export interface LogFields extends Record<string, unknown> {
  error_code?: string;
  event: string;
  job?: string;
  latency_ms?: number;
  outcome: number | string;
  provider?: string;
  retry_class: RetryClass;
}

export function isLocalOrTestEnvironment(environment: string | undefined): boolean {
  return environment === "local" || environment === "test";
}

function deriveMessage(fields: LogFields): string {
  const explicit = fields.message;
  if (typeof explicit === "string" && explicit !== "") {
    return sanitizeErrorText(explicit, maxJsonString);
  }
  return fields.event.replace(messageSeparatorsPattern, " ").trim() || "log event";
}

/**
 * Writes one sanitized JSON line to `console[level]` (and to the local Loki receiver when
 * `environment` is `local`). `fields.message` and `fields.error` are hoisted; every other field
 * lands under `context`. Info and debug lines are sampled per trace; warn and error always emit.
 */
export function log(level: LogLevel, context: LogContext, fields: LogFields): void {
  if (!emitsLine(level, context.trace_id, logSamplingRate)) return;

  const { error, ...contextFields } = fields;
  delete contextFields.message;
  if (context.route !== undefined) contextFields.route = context.route;
  const payload = {
    context: sanitizeRecord(contextFields),
    environment: context.environment,
    error: error === undefined ? undefined : serializeError(error, 0, new Set()),
    job_id: context.job_id,
    level,
    message: deriveMessage(fields),
    request_id: context.request_id,
    service: context.service,
    timestamp: new Date().toISOString(),
    trace_id: context.trace_id,
    user_id: context.user_id,
    version: context.version,
    workflow_id: context.workflow_id,
  };

  const line = JSON.stringify(payload);
  console[level](line);
  if (context.environment === "local") {
    void shipLogToLoki(level, context, line);
  }
}

async function shipLogToLoki(level: LogLevel, context: LogContext, line: string): Promise<void> {
  const stream = {
    environment: context.environment,
    job: "meltiply-worker",
    level,
    service: context.service,
  };
  const timestampNanoseconds = String(BigInt(Date.now()) * 1_000_000n);
  await fetch("http://127.0.0.1:3100/loki/api/v1/push", {
    body: JSON.stringify({ streams: [{ stream, values: [[timestampNanoseconds, line]] }] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }).catch(() => undefined);
}
