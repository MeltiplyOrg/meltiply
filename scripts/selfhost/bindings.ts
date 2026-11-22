import { WorkerEntrypoint } from "cloudflare:workers";
import { Buffer } from "node:buffer";

type BridgeEnv = { HOST: Fetcher };
type MessageOptions = { contentType?: "json" | "text" | "bytes"; delaySeconds?: number };

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

export class QueueProducer extends WorkerEntrypoint<BridgeEnv, { queue: string }> {
  async send(body: unknown, options?: MessageOptions) {
    await this.sendBatch([{ body, ...options }]);
  }

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

export class MailSender extends WorkerEntrypoint<BridgeEnv> {
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
  fetch() {
    return new Response(null, { status: 404 });
  },
};
