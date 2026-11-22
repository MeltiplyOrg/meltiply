import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { AutomationEntrypoint } from "../../workers/automation/src/index";
import type {
  NativeProcessorJob,
  MediaProcessorRpcOutcome,
} from "../../workers/automation/src/native-processor";
import { processNativeJob } from "../lib/processor-client";

export { ReplyWorkflow } from "../../workers/automation/src/index";

export class MediaProcessorContainer extends DurableObject<{ PROCESSOR_JOB_TOKEN: string }> {
  async process(job: NativeProcessorJob): Promise<MediaProcessorRpcOutcome> {
    return processNativeJob(job, this.env.PROCESSOR_JOB_TOKEN);
  }
}

type Delivery = {
  id: string;
  body: unknown;
  content_type: string;
  created: number;
  attempts: number;
};

export default class SelfhostAutomation extends AutomationEntrypoint {
  /** Miniflare's synchronous RPC discovery would block its Node event loop, so the host dispatches over fetch. */
  async fetch(request: Request) {
    if (request.method !== "POST") return new Response(null, { status: 404 });
    const payload: unknown = await request.json();
    const command = z
      .discriminatedUnion("action", [
        z.object({
          action: z.literal("deliver"),
          queue: z.string(),
          rows: z
            .array(
              z.object({
                id: z.string(),
                body: z.unknown(),
                content_type: z.string(),
                created: z.number(),
                attempts: z.number(),
              }),
            )
            .max(100),
          metrics: z.object({
            backlogCount: z.number(),
            backlogBytes: z.number(),
            oldestMessageTimestamp: z.string().optional(),
          }),
        }),
        z.object({ action: z.literal("schedule"), cron: z.string(), scheduledTime: z.number() }),
      ])
      .parse(payload);
    if (command.action === "schedule")
      return Response.json(await this.runScheduled(command.cron, command.scheduledTime));
    const { oldestMessageTimestamp, ...metrics } = command.metrics;
    return Response.json(
      await this.deliver(command.queue, command.rows, {
        ...metrics,
        ...(oldestMessageTimestamp
          ? { oldestMessageTimestamp: new Date(oldestMessageTimestamp) }
          : {}),
      }),
    );
  }

  async deliver(queue: string, rows: Delivery[], metrics: MessageBatchMetrics) {
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
    } catch {
      outcome = "exception";
    }
    if (ackAll)
      for (const row of rows)
        if (!retryMessages.some((retry) => retry.msgId === row.id)) explicitAcks.push(row.id);
    return { outcome, explicitAcks, retryMessages, retryBatch };
  }

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
