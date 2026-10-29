import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { readBoundedJsonResponse } from "../release/release-http.mjs";

const MAXIMUM_API_RESPONSE_BYTES = 1024 * 1024;

export const KNOWN_QUEUE_WORKLOADS = Object.freeze([
  "analytics",
  "asset-processing",
  "channel-revocation",
  "comments",
  "notifications",
  "publish-facebook",
  "publish-instagram",
  "publish-threads",
  "publish-tiktok",
  "publish-youtube",
  "replies",
  "token-refresh",
]);
const workloads = new Set(KNOWN_QUEUE_WORKLOADS);

/**
 * Retrieves a non-empty trimmed value for a required environment variable.
 *
 * @param {string} name - Variable name
 * @param {Record<string, string | undefined>} environment - Environment lookup object
 * @returns {string} Trimmed environment variable value
 * @throws {Error} If the variable is unset or contains only whitespace
 */
function requiredEnvironment(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Validates and parses a positive integer within an inclusive maximum bound [1, maximum].
 *
 * @param {string | number} value - Input value to parse
 * @param {string} name - Option name for error reporting
 * @param {number} maximum - Maximum allowed integer value
 * @returns {number} Parsed positive integer
 * @throws {TypeError} If the value is not an integer within the range [1, maximum]
 */
function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

/**
 * Validates and parses a non-negative integer (>= 0).
 *
 * @param {string | number} value - Input value to parse
 * @param {string} name - Option name for error reporting
 * @returns {number} Parsed non-negative integer
 * @throws {TypeError} If the value is not an integer >= 0
 */
function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return parsed;
}

/**
 * Parses and validates command-line arguments for queue operations (`metrics` or `replay-dlq`).
 * Enforces DNS-safe environment names, recognized queue workload types, operator identification,
 * justification reason text limits (8 to 500 characters), and mandatory confirmation string
 * (`replay <workload> <environment>`) when mutating with `--apply`.
 *
 * @param {Array<string>} argv - Command-line argument vector
 * @returns {object} Validated options object for metrics or DLQ replay
 * @throws {TypeError} If unknown options, missing values, or invalid inputs are supplied
 */
export function parseQueueArguments(argv) {
  const [command, ...rawArguments] = argv;
  if (command !== "metrics" && command !== "replay-dlq") {
    throw new TypeError("command must be metrics or replay-dlq");
  }
  const rest = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  const allowedOptions =
    command === "metrics"
      ? new Set(["environment", "max-age-seconds", "max-backlog", "workload"])
      : new Set(["confirm", "environment", "limit", "operator", "reason", "workload"]);
  const values = new Map();
  let apply = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--apply") {
      if (command !== "replay-dlq") {
        throw new TypeError("--apply is only valid for replay-dlq");
      }
      apply = true;
      continue;
    }
    if (!argument?.startsWith("--")) {
      throw new TypeError(`unexpected argument: ${argument ?? ""}`);
    }
    const option = argument.slice(2);
    if (!allowedOptions.has(option)) {
      throw new TypeError(`unknown option: ${argument}`);
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TypeError(`${argument} requires a value`);
    }
    values.set(option, value);
    index += 1;
  }

  const environment = values.get("environment")?.trim();
  const workload = values.get("workload")?.trim();
  if (!environment || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(environment)) {
    throw new TypeError("--environment must be a DNS-safe environment name");
  }
  if (!workload || !workloads.has(workload)) {
    throw new TypeError(`--workload must be one of ${[...workloads].join(", ")}`);
  }

  if (command === "metrics") {
    return {
      command,
      environment,
      maxAgeSeconds: nonNegativeInteger(values.get("max-age-seconds") ?? "60", "--max-age-seconds"),
      maxBacklog: nonNegativeInteger(values.get("max-backlog") ?? "100", "--max-backlog"),
      workload,
    };
  }

  const operator = values.get("operator")?.trim();
  const reason = values.get("reason")?.trim();
  if (!operator || operator.length > 200) {
    throw new TypeError("--operator is required and must be at most 200 characters");
  }
  if (!reason || reason.length < 8 || reason.length > 500) {
    throw new TypeError("--reason must contain between 8 and 500 characters");
  }
  const confirmation = `replay ${workload} ${environment}`;
  if (apply && values.get("confirm") !== confirmation) {
    throw new TypeError(`--apply requires --confirm "${confirmation}"`);
  }
  return {
    apply,
    command,
    environment,
    limit: positiveInteger(values.get("limit") ?? "10", "--limit", 100),
    operator,
    reason,
    workload,
  };
}

/**
 * Derives canonical Cloudflare Queue names for a workload and its dead-letter queue.
 *
 * @param {{ environment: string, workload: string }} options - Workload and environment options
 * @returns {{ source: string, target: string }} Source DLQ name and target workload queue name
 */
function queueNames(options) {
  const target = `meltiply-${options.workload}-${options.environment}`;
  return { source: `${target}-dlq`, target };
}

/**
 * Computes a SHA-256 hex digest of a message's content type and raw body.
 * Enables deterministic audit tracking without storing or logging sensitive plaintext payload data.
 *
 * @param {object} message - Message object
 * @param {string} contentType - Content-Type header string
 * @returns {string} Hexadecimal SHA-256 digest
 */
function messageDigest(message, contentType) {
  return createHash("sha256").update(`${contentType}\0${message.body}`).digest("hex");
}

/**
 * Extracts non-sensitive audit metadata from a dead-letter queue message.
 *
 * @param {object} message - Raw message object pulled from Cloudflare Queue
 * @returns {{ attempts: number, digest: string | null, id: string, timestamp_ms: number }} Sanitized audit record
 */
function auditMessage(message) {
  const contentType = String(message?.metadata?.["CF-Content-Type"] ?? "json").toLowerCase();
  return {
    attempts: Number(message?.attempts ?? 0),
    digest: typeof message?.body === "string" ? messageDigest(message, contentType) : null,
    id: String(message?.id ?? "unknown"),
    timestamp_ms: Number(message?.timestamp_ms ?? 0),
  };
}

/**
 * Decodes a JSON message body from either direct JSON text or base64-encoded JSON.
 *
 * @param {string} body - Raw string payload
 * @returns {any} Parsed JavaScript value
 * @throws {TypeError} If the payload is neither valid JSON nor valid base64-encoded JSON
 */
function decodeJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    try {
      return JSON.parse(Buffer.from(body, "base64").toString("utf8"));
    } catch {
      throw new TypeError("DLQ JSON message body is neither JSON nor base64 JSON");
    }
  }
}

/**
 * Normalizes and validates a dead-letter queue message into a push payload and an audit record.
 * Handles both JSON and plain-text payloads; rejects unsupported content types.
 *
 * @param {object} message - DLQ message object containing body, lease_id, and metadata
 * @returns {{ audit: object, push: { body: any, content_type: string } }} Structured replay bundle
 * @throws {TypeError} If message structure, lease_id, or content type are invalid
 */
export function replayPayload(message) {
  if (!message || typeof message !== "object") {
    throw new TypeError("DLQ message must be an object");
  }
  if (typeof message.body !== "string" || typeof message.lease_id !== "string") {
    throw new TypeError("DLQ message requires string body and lease_id fields");
  }
  const rawContentType = message.metadata?.["CF-Content-Type"] ?? "json";
  const contentType = String(rawContentType).toLowerCase();
  if (contentType === "json") {
    return {
      audit: auditMessage(message),
      push: { body: decodeJsonBody(message.body), content_type: "json" },
    };
  }
  if (contentType === "text") {
    return {
      audit: auditMessage(message),
      push: { body: message.body, content_type: "text" },
    };
  }
  throw new TypeError(`DLQ content type ${contentType} cannot be safely replayed`);
}

/**
 * Constructs an authenticated HTTP client for interacting with the Cloudflare Queues v4 REST API.
 * Provides wrappers for acknowledge, list, metrics, pull, and push with bounded response parsing,
 * a ten-second transport deadline, and no credential-bearing redirects.
 *
 * @param {object} params - Client options
 * @param {string} params.accountId - Cloudflare account ID
 * @param {string} params.apiToken - Cloudflare API token
 * @param {typeof fetch} params.fetchImpl - HTTP fetch implementation
 * @returns {object} Queues API client interface
 */
function apiClient({ accountId, apiToken, fetchImpl }) {
  const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues`;
  const call = async (path, init = {}) => {
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
    });
    const envelope = await readBoundedJsonResponse(
      response,
      MAXIMUM_API_RESPONSE_BYTES,
      "Cloudflare Queues response",
    );
    if (!response.ok || envelope.success !== true) {
      const messages = (envelope.errors ?? [])
        .map((error) => error?.message)
        .filter(Boolean)
        .join("; ");
      throw new Error(
        `Cloudflare Queues request failed (${response.status})${messages ? `: ${messages}` : ""}`,
      );
    }
    return envelope.result;
  };
  return {
    acknowledge: (queueId, body) =>
      call(`/${queueId}/messages/ack`, {
        body: JSON.stringify(body),
        method: "POST",
      }),
    list: () => call("?per_page=1000"),
    metrics: (queueId) => call(`/${queueId}/metrics`),
    pull: (queueId, body) =>
      call(`/${queueId}/messages/pull`, {
        body: JSON.stringify(body),
        method: "POST",
      }),
    push: (queueId, body) =>
      call(`/${queueId}/messages`, {
        body: JSON.stringify(body),
        method: "POST",
      }),
  };
}

/**
 * Resolves both source DLQ and target workload Cloudflare Queue records from the Cloudflare account.
 *
 * @param {object} client - Cloudflare Queues API client
 * @param {{ source: string, target: string }} names - Canonical source and target queue names
 * @returns {Promise<{ source: object, target: object }>} Resolved Cloudflare queue descriptor objects
 * @throws {TypeError} If the queue list response is invalid
 * @throws {Error} If either required queue is missing from the account
 */
async function resolveQueues(client, names) {
  const queues = await client.list();
  if (!Array.isArray(queues)) throw new TypeError("Cloudflare Queue list is invalid");
  const byName = new Map(queues.map((queue) => [queue.queue_name, queue]));
  const source = byName.get(names.source);
  const target = byName.get(names.target);
  if (!source?.queue_id || !target?.queue_id) {
    throw new Error(`expected both ${names.source} and ${names.target}`);
  }
  return { source, target };
}

/**
 * Normalizes raw Cloudflare Queue metric counters into a consistent snapshot.
 * Computes oldest-message age; rejects missing/non-finite counters instead of
 * converting an incomplete monitoring response into a healthy empty Queue.
 *
 * @param {string} name - Queue name
 * @param {object} metrics - Raw metrics object from Cloudflare API
 * @param {number} now - Current epoch timestamp in milliseconds
 * @returns {{ backlog_bytes: number, backlog_count: number, name: string, oldest_age_seconds: number }} Normalized metric snapshot
 * @throws {TypeError} If counters or a nonempty Queue's oldest timestamp are invalid.
 */
function metricSnapshot(name, metrics, now) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new TypeError("Cloudflare Queue metrics are invalid");
  }
  for (const field of ["backlog_bytes", "backlog_count"]) {
    if (!Number.isSafeInteger(metrics[field]) || metrics[field] < 0) {
      throw new TypeError(`Cloudflare Queue ${field} is missing or invalid`);
    }
  }
  const oldest = metrics.oldest_message_timestamp_ms ?? 0;
  if (!Number.isSafeInteger(oldest) || oldest < 0 || (metrics.backlog_count > 0 && oldest === 0)) {
    throw new TypeError("Cloudflare Queue oldest timestamp is missing or invalid");
  }
  return {
    backlog_bytes: metrics.backlog_bytes,
    backlog_count: metrics.backlog_count,
    name,
    oldest_age_seconds: oldest > 0 ? Math.max(0, Math.floor((now - oldest) / 1_000)) : 0,
  };
}

/**
 * Collects and evaluates health metrics for a target workload queue and its associated DLQ.
 * Flags backlog or message age threshold breaches as active alerts.
 *
 * @param {object} client - Cloudflare Queues API client
 * @param {object} options - Queue options containing workload, environment, maxBacklog, maxAgeSeconds
 * @param {number} now - Current epoch timestamp in milliseconds
 * @returns {Promise<object>} Combined metrics health report with alert status
 */
async function queueMetrics(client, options, now) {
  const names = queueNames(options);
  const queues = await resolveQueues(client, names);
  const [workloadMetrics, dlqMetrics] = await Promise.all([
    client.metrics(queues.target.queue_id),
    client.metrics(queues.source.queue_id),
  ]);
  const workload = metricSnapshot(names.target, workloadMetrics, now);
  const deadLetter = metricSnapshot(names.source, dlqMetrics, now);
  const alerts = [];
  if (workload.backlog_count > options.maxBacklog) alerts.push("workload_backlog");
  if (workload.oldest_age_seconds > options.maxAgeSeconds) alerts.push("workload_age");
  if (deadLetter.backlog_count > 0) alerts.push("dead_letter_backlog");
  return {
    alerts,
    command: "metrics",
    dead_letter: deadLetter,
    environment: options.environment,
    healthy: alerts.length === 0,
    thresholds: {
      max_age_seconds: options.maxAgeSeconds,
      max_backlog: options.maxBacklog,
    },
    workload,
  };
}

/**
 * Releases unacknowledged message leases on a Cloudflare Queue by requesting immediate retries.
 * Used to avoid message starvation and restore messages to the queue after inspection or failure.
 *
 * @param {object} client - Cloudflare Queues API client
 * @param {string} queueId - Source queue identifier
 * @param {Array<object>} messages - Array of pulled message objects containing lease_ids
 * @returns {Promise<void>}
 */
async function releaseLeases(client, queueId, messages) {
  if (messages.length === 0) return;
  await client.acknowledge(queueId, {
    acks: [],
    retries: messages.map((message) => ({ lease_id: message.lease_id })),
  });
}

/**
 * Builds a structured, tamper-evident audit record of a dead-letter replay attempt.
 * Includes operator identity, justification reason, message digests, and execution outcome.
 *
 * @param {object} options - Command options (apply, operator, reason, workload, environment)
 * @param {{ source: string, target: string }} names - Source and target queue names
 * @param {Array<object>} messages - Raw messages examined during the operation
 * @param {number} now - Operation timestamp in milliseconds
 * @param {object} outcome - Outcome details (name, counts, errorCode)
 * @returns {object} Formatted audit object
 */
function replayAudit(options, names, messages, now, outcome) {
  return {
    acknowledged_count: outcome.acknowledgedCount,
    applied: options.apply,
    command: "replay-dlq",
    environment: options.environment,
    error_code: outcome.errorCode ?? null,
    message_count: messages.length,
    messages: messages.map(auditMessage),
    occurred_at: new Date(now).toISOString(),
    operator: options.operator,
    outcome: outcome.name,
    reason: options.reason,
    replayed_count: outcome.replayedCount,
    retried_count: outcome.retriedCount,
    source_queue: names.source,
    target_queue: names.target,
    unsettled_count: outcome.unsettledCount,
    workload: options.workload,
  };
}

/**
 * Performs dead-letter queue inspection, validation, and optional message replay.
 * Pulls a batch of messages from the DLQ, validates payload structures, and either simulates
 * replay (dry-run) by releasing leases, or pushes messages into the target workload queue
 * and acknowledges original DLQ messages upon success.
 *
 * @param {object} client - Cloudflare Queues API client
 * @param {object} options - Execution options (apply, limit, operator, reason, workload, environment)
 * @param {number} now - Execution timestamp in milliseconds
 * @returns {Promise<object>} Structured audit result describing the operation
 */
async function replayDeadLetter(client, options, now) {
  const names = queueNames(options);
  const queues = await resolveQueues(client, names);
  const pulled = await client.pull(queues.source.queue_id, {
    batch_size: options.limit,
    visibility_timeout_ms: 300_000,
  });
  const messages = Array.isArray(pulled.messages) ? pulled.messages : [];
  let payloads;
  try {
    payloads = messages.map(replayPayload);
  } catch {
    try {
      await releaseLeases(client, queues.source.queue_id, messages);
      return replayAudit(options, names, messages, now, {
        acknowledgedCount: 0,
        errorCode: "unsafe_payload",
        name: "rejected",
        replayedCount: 0,
        retriedCount: messages.length,
        unsettledCount: 0,
      });
    } catch {
      return replayAudit(options, names, messages, now, {
        acknowledgedCount: 0,
        errorCode: "unsafe_payload_settlement_failed",
        name: "settlement_failed",
        replayedCount: 0,
        retriedCount: 0,
        unsettledCount: messages.length,
      });
    }
  }

  if (!options.apply) {
    try {
      await releaseLeases(client, queues.source.queue_id, messages);
      return replayAudit(options, names, messages, now, {
        acknowledgedCount: 0,
        name: "dry_run",
        replayedCount: 0,
        retriedCount: messages.length,
        unsettledCount: 0,
      });
    } catch {
      return replayAudit(options, names, messages, now, {
        acknowledgedCount: 0,
        errorCode: "settlement_failed",
        name: "settlement_failed",
        replayedCount: 0,
        retriedCount: 0,
        unsettledCount: messages.length,
      });
    }
  } else {
    const pushed = [];
    try {
      for (const [index, payload] of payloads.entries()) {
        await client.push(queues.target.queue_id, payload.push);
        pushed.push(messages[index]);
      }
    } catch {
      try {
        await client.acknowledge(queues.source.queue_id, {
          acks: pushed.map((message) => ({ lease_id: message.lease_id })),
          retries: messages.slice(pushed.length).map((message) => ({ lease_id: message.lease_id })),
        });
        return replayAudit(options, names, messages, now, {
          acknowledgedCount: pushed.length,
          errorCode: "push_failed",
          name: "partial",
          replayedCount: pushed.length,
          retriedCount: messages.length - pushed.length,
          unsettledCount: 0,
        });
      } catch {
        return replayAudit(options, names, messages, now, {
          acknowledgedCount: 0,
          errorCode: "push_and_settlement_failed",
          name: "settlement_failed",
          replayedCount: pushed.length,
          retriedCount: 0,
          unsettledCount: messages.length,
        });
      }
    }
    if (messages.length > 0) {
      try {
        await client.acknowledge(queues.source.queue_id, {
          acks: messages.map((message) => ({ lease_id: message.lease_id })),
          retries: [],
        });
      } catch {
        return replayAudit(options, names, messages, now, {
          acknowledgedCount: 0,
          errorCode: "settlement_failed",
          name: "settlement_failed",
          replayedCount: messages.length,
          retriedCount: 0,
          unsettledCount: messages.length,
        });
      }
    }
  }

  return replayAudit(options, names, messages, now, {
    acknowledgedCount: messages.length,
    name: "completed",
    replayedCount: messages.length,
    retriedCount: 0,
    unsettledCount: 0,
  });
}

/**
 * Top-level dispatcher for queue operations commands ('metrics' or 'replay-dlq').
 * Injects environment variables and fetch dependencies to perform Cloudflare Queues operations.
 *
 * @param {object} options - Parsed command options
 * @param {object} [dependencies={}] - Injected dependencies
 * @param {Record<string, string | undefined>} [dependencies.environment=process.env] - Environment variable lookup
 * @param {typeof fetch} [dependencies.fetchImpl=fetch] - HTTP fetch implementation
 * @param {() => number} [dependencies.now=() => Date.now()] - Timestamp generator
 * @returns {Promise<object>} Command execution result report
 */
export async function runQueueCommand(options, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const client = apiClient({
    accountId: requiredEnvironment("CLOUDFLARE_ACCOUNT_ID", environment),
    apiToken: requiredEnvironment("CLOUDFLARE_API_TOKEN", environment),
    fetchImpl: dependencies.fetchImpl ?? fetch,
  });
  const now = dependencies.now?.() ?? Date.now();
  return options.command === "metrics"
    ? queueMetrics(client, options, now)
    : replayDeadLetter(client, options, now);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseQueueArguments(process.argv.slice(2));
    const result = await runQueueCommand(options);
    console.log(JSON.stringify(result));
    if (
      (result.command === "metrics" && !result.healthy) ||
      (result.command === "replay-dlq" &&
        result.outcome !== "completed" &&
        result.outcome !== "dry_run")
    ) {
      process.exitCode = 2;
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "Queue operation failed");
    process.exitCode = 1;
  }
}
