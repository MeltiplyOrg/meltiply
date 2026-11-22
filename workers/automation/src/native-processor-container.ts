import { DurableObject } from "cloudflare:workers";

import type { AutomationEnv } from "./env";
import {
  PROCESSOR_CONTAINER_TIMEOUT_MS,
  PROCESSOR_ENGINE_PORT,
  PROCESSOR_INACTIVITY_TIMEOUT_MS,
  PROCESSOR_READY_TIMEOUT_MS,
  PROCESSOR_TOKEN_KEY,
  validateJob,
  type MediaProcessorRpcOutcome,
  type NativeProcessorFailure,
  type NativeProcessorJob,
  type NativeProcessorSuccess,
} from "./native-processor";

export class MediaProcessorContainer extends DurableObject<AutomationEnv> {
  constructor(ctx: DurableObjectState, env: AutomationEnv) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(PROCESSOR_INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  async #jobToken(): Promise<string> {
    const stored = await this.ctx.storage.get<string>(PROCESSOR_TOKEN_KEY);
    if (stored) return stored;
    const token = crypto.randomUUID();
    await this.ctx.storage.put(PROCESSOR_TOKEN_KEY, token);
    return token;
  }

  async #readyEngine(token: string): Promise<Fetcher> {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("the MEDIA_PROCESSOR container binding is unavailable in this Worker");
    }
    if (!container.running) {
      container.start({
        enableInternet: true,
        env: { PROCESSOR_JOB_TOKEN: token },
      });
      await container.setInactivityTimeout(PROCESSOR_INACTIVITY_TIMEOUT_MS);
    }
    const port = container.getTcpPort(PROCESSOR_ENGINE_PORT);
    const deadline = Date.now() + PROCESSOR_READY_TIMEOUT_MS;
    let lastError: unknown;
    for (;;) {
      try {
        const health = await port.fetch("http://processor/healthz", {
          signal: AbortSignal.timeout(5_000),
        });
        if (health.ok) return port;
      } catch (cause) {
        lastError = cause;
      }
      if (Date.now() >= deadline) {
        throw new Error("the media processor container did not become ready in time", {
          cause: lastError,
        });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }

  async process(job: NativeProcessorJob): Promise<MediaProcessorRpcOutcome> {
    const invalid = validateJob(job);
    if (invalid) {
      return {
        error: { code: "invalid_request", message: invalid, retryable: false },
        ok: false,
      };
    }
    let token: string;
    try {
      token = await this.#jobToken();
      const port = await this.#readyEngine(token);
      const response = await port.fetch("http://processor/process", {
        body: JSON.stringify(job),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(PROCESSOR_CONTAINER_TIMEOUT_MS),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const failure = (payload as { error?: NativeProcessorFailure } | null)?.error;
        return {
          error: {
            code: failure?.code ?? "engine_error",
            message:
              failure?.message ?? `The media processor answered with HTTP ${response.status}.`,
            retryable: failure?.retryable ?? response.status >= 500,
          },
          ok: false,
        };
      }
      return { ok: true, result: payload as NativeProcessorSuccess };
    } catch (cause) {
      return {
        error: {
          code: "engine_error",
          message:
            cause instanceof Error
              ? `The media processor could not complete the job: ${cause.message}`
              : "The media processor could not complete the job.",
          retryable: true,
        },
        ok: false,
      };
    }
  }
}
