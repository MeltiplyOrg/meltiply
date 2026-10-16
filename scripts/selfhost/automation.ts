import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { AutomationEntrypoint } from "../../workers/automation/src/index";
import {
  PROCESSOR_CONTAINER_TIMEOUT_MS,
  validateJob,
  type NativeProcessorJob,
  type MediaProcessorRpcOutcome,
} from "../../workers/automation/src/native-processor";

export { ReplyWorkflow } from "../../workers/automation/src/index";

const successSchema = z.object({
  engine: z.object({ duration_ms: z.number(), ffmpeg: z.string(), vips: z.string() }),
  input: z.object({ bytes: z.number(), sha256: z.string() }),
  job_id: z.string(),
  media: z.object({
    animated: z.boolean(),
    content_type: z.string(),
    duration_seconds: z.number().nullable(),
    frame_count: z.number().nullable(),
    has_audio: z.boolean(),
    height: z.number().nullable(),
    width: z.number().nullable(),
  }),
  output: z
    .object({
      bytes: z.number(),
      content_type: z.string(),
      etag: z.string().nullable(),
      sha256: z.string(),
    })
    .nullable(),
  replayed: z.boolean().optional(),
  result: z.enum(["optimized", "original_compatible"]),
  status: z.literal("succeeded"),
});
const failureSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
});

/** Addresses the Compose processor over its private network; bucket credentials never enter the processor. */
export class MediaProcessorContainer extends DurableObject<{ PROCESSOR_JOB_TOKEN: string }> {
  /** Validates jobs and engine responses, retaining the Cloudflare adapter's failure classification and deadline. */
  async process(job: NativeProcessorJob): Promise<MediaProcessorRpcOutcome> {
    const invalid = validateJob(job);
    if (invalid)
      return { ok: false, error: { code: "invalid_request", message: invalid, retryable: false } };
    try {
      console.log("[DEBUG-selfhost-processor]", "begin");
      const response = await fetch("http://127.0.0.1:8082/process", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.env.PROCESSOR_JOB_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(PROCESSOR_CONTAINER_TIMEOUT_MS),
      });
      console.log("[DEBUG-selfhost-processor]", "response", response.status);
      const payload: unknown = await response.json();
      if (!response.ok) return { ok: false, error: failureSchema.parse(payload).error };
      return { ok: true, result: successSchema.parse(payload) };
    } catch {
      return {
        ok: false,
        error: {
          code: "engine_error",
          message: "The self-hosted processor could not complete the job.",
          retryable: true,
        },
      };
    }
  }
}

type Delivery = {
  id: string;
  body: unknown;
  content_type: string;
  created: number;
  attempts: number;
};

/** Keeps the canonical automation handler and exposes private RPC for durable host delivery and schedules. */
export default class SelfhostAutomation extends AutomationEntrypoint {
  /** Runs the real queue handler, collecting per-message decisions for the durable broker's transaction. */
  async deliver(queue: string, rows: Delivery[], metrics: MessageBatchMetrics) {
    console.log("[DEBUG-selfhost-queue]", "begin", queue);
    const explicitAcks: string[] = [];
    const retryMessages: { msgId: string; delaySeconds?: number }[] = [];
    let retryBatch: { retry: boolean; delaySeconds?: number } = { retry: false };
    let ackAll = false;
    const messages = rows.map((row) => ({
      id: row.id,
      timestamp: new Date(row.created),
      attempts: row.attempts,
      body:
        row.content_type === "bytes" && typeof row.body === "string"
          ? Uint8Array.from(atob(row.body), (character) => character.charCodeAt(0)).buffer
          : row.body,
      ack: () => {
        if (
          !explicitAcks.includes(row.id) &&
          !retryMessages.some((retry) => retry.msgId === row.id)
        )
          explicitAcks.push(row.id);
      },
      retry: (options?: { delaySeconds?: number }) => {
        if (
          !explicitAcks.includes(row.id) &&
          !retryMessages.some((retry) => retry.msgId === row.id)
        )
          retryMessages.push({ msgId: row.id, ...options });
      },
    }));
    let outcome = "ok";
    try {
      await this.queue({
        queue,
        messages,
        metadata: { metrics },
        ackAll: () => {
          if (!retryBatch.retry) ackAll = true;
        },
        retryAll: (options?: { delaySeconds?: number }) => {
          if (!ackAll) retryBatch = { retry: true, ...options };
        },
      });
      console.log("[DEBUG-selfhost-queue]", "end", queue);
    } catch {
      outcome = "exception";
    }
    if (ackAll)
      for (const row of rows)
        if (!retryMessages.some((retry) => retry.msgId === row.id)) explicitAcks.push(row.id);
    return { outcome, explicitAcks, retryMessages, retryBatch };
  }

  /** Executes canonical scheduled tiers; the host records and retries schedule jobs durably. */
  async runScheduled(cron: string, scheduledTime: number) {
    let retry = true;
    try {
      await this.scheduled({
        cron,
        scheduledTime,
        noRetry() {
          retry = false;
        },
      });
      return { outcome: "ok" };
    } catch {
      return { outcome: retry ? "exception" : "ok" };
    }
  }
}
