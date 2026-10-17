import { WorkerEntrypoint } from "cloudflare:workers";
import { Buffer } from "node:buffer";

type BridgeEnv = { HOST: Fetcher };
type MessageOptions = { contentType?: "json" | "text" | "bytes"; delaySeconds?: number };

/** Serializes queue payloads without relying on process-local queues; only the private host receives them. */
function encode(body: unknown, options: MessageOptions = {}) {
  if (options.contentType === "bytes") {
    if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body))
      throw new TypeError("Expected bytes");
    const bytes =
      body instanceof ArrayBuffer
        ? Buffer.from(body)
        : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return { body: bytes.toString("base64"), ...options };
  }
  return { body, ...options };
}

/** RPC-backed Queue-compatible producer. The host commits batches before resolving this call. */
export class QueueProducer extends WorkerEntrypoint<BridgeEnv, { queue: string }> {
  /** Enqueues one message with the same delay/content-type options as its Cloudflare caller. */
  async send(body: unknown, options?: MessageOptions) {
    await this.sendBatch([{ body, ...options }]);
  }

  /** Submits an atomic bounded batch; invalid payloads or storage failures reject rather than drop work. */
  async sendBatch(
    messages: ({ body: unknown } & MessageOptions)[],
    options?: { delaySeconds?: number },
  ) {
    const response = await this.env.HOST.fetch("http://host/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queue: this.ctx.props.queue,
        messages: messages.map(({ body, ...settings }) =>
          encode(body, { ...options, ...settings }),
        ),
      }),
    });
    if (!response.ok) throw new Error("Durable queue submission failed");
  }
}

/** Preserves the structured SendEmail interface while using an actual SMTP transport on the host. */
export class MailSender extends WorkerEntrypoint<BridgeEnv> {
  /** Submits exactly once; uncertain SMTP failures propagate without automatic resubmission. */
  async send(message: unknown) {
    const response = await this.env.HOST.fetch("http://host/mail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error("SMTP submission failed; delivery may be ambiguous");
    const receipt: unknown = await response.json();
    return receipt;
  }
}

export default {
  /** The bridge has no public HTTP interface; only its named RPC entrypoints are used. */
  fetch() {
    return new Response(null, { status: 404 });
  },
};
