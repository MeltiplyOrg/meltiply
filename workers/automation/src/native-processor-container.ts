// Durable Object host for the native media processor container (issue #284).
//
// This module is deliberately separate from `./native-processor`, which holds
// the injectable adapter (capability minting, job invocation, result types).
// The split exists because `cloudflare:workers` is a runtime-only module specifier
// that a plain Node/Vitest integration environment cannot resolve: keeping the
// Durable Object class here means the Asset processing pipeline — and every
// suite that imports it — can load the adapter without pulling in the Workers
// runtime.
//
// The container itself remains unreachable from the public network. Jobs arrive
// only over the private `MEDIA_PROCESSOR` Durable Object binding, and the engine
// additionally requires a per-instance bearer secret that is generated here,
// persisted in Durable Object storage, and injected at container start — so it is
// never a Worker secret and stays consistent across restarts.
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

/**
 * Durable Object that owns exactly one processor container instance and the
 * private route to it. Jobs arrive only through this binding, so the container
 * is never addressable from the public network.
 */
export class MediaProcessorContainer extends DurableObject<AutomationEnv> {
  /**
   * Returns this instance's generated job token, minting it on first use. The
   * token lives in Durable Object storage (not memory) so a restarted container
   * is always addressed with the secret it was actually started with.
   *
   * @returns The bearer secret the engine requires on every job.
   */
  async #jobToken(): Promise<string> {
    const stored = await this.ctx.storage.get<string>(PROCESSOR_TOKEN_KEY);
    if (stored) return stored;
    const token = crypto.randomUUID();
    await this.ctx.storage.put(PROCESSOR_TOKEN_KEY, token);
    return token;
  }

  /**
   * Starts the container if it is not running and waits until its health route
   * answers. Container start carries the generated job token as an environment
   * variable; internet access is required because the engine reaches its input
   * and output capabilities over HTTPS.
   *
   * @param token - Per-instance bearer secret injected into the container.
   * @returns The container port once its readiness probe answers.
   * @throws {Error} When the container binding is absent or never becomes ready.
   */
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
    }
    const port = container.getTcpPort(PROCESSOR_ENGINE_PORT);
    const deadline = Date.now() + PROCESSOR_READY_TIMEOUT_MS;
    for (;;) {
      try {
        const health = await port.fetch("http://processor/healthz", {
          signal: AbortSignal.timeout(5_000),
        });
        if (health.ok) return port;
      } catch {
        // The container is still booting; keep polling until the budget ends.
      }
      if (Date.now() >= deadline) {
        throw new Error("the media processor container did not become ready in time");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Runs one processing job inside the container and returns a data outcome
   * instead of throwing, so the caller classifies the engine's error code and
   * retry semantics without depending on RPC error serialization.
   *
   * @param job - Job with signed input/output capabilities and reserved output bytes.
   * @returns Verified success payload, or the engine's failure as data.
   */
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
    } finally {
      // Park the instance when idle so an unused processor is reclaimed instead
      // of billing until the next job arrives.
      await this.ctx.container
        ?.setInactivityTimeout(PROCESSOR_INACTIVITY_TIMEOUT_MS)
        .catch(() => undefined);
    }
  }
}
