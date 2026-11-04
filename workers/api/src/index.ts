import {
  configureLogSampling,
  createRequestId,
  createTraceId,
  errorDiagnostic,
  log,
} from "@meltiply/observability";
import { createApiApp } from "./app";
import type { ApiWorkerEnv } from "./env";
import { bindingStatuses, validateProductionBindings } from "./env";

const app = createApiApp();

let deployedBindingsValidated = false;

/**
 * Validates deployed Cloudflare bindings once per Worker isolate lifecycle.
 *
 * Local/test requests stay exempt. Successful deployed validation latches until
 * the isolate is replaced; failures remain retryable and never set the latch.
 *
 * @param env - Worker environment bindings.
 * @throws {Error} If any mandatory deployed binding is missing or malformed.
 */
function validateDeployedBindingsOnce(env: ApiWorkerEnv): void {
  if (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test" || deployedBindingsValidated)
    return;
  validateProductionBindings(env);
  deployedBindingsValidated = true;
}

export default {
  /**
   * Cloudflare Workers HTTP entrypoint handling incoming fetch events for the API Worker.
   *
   * Configures observability log sampling rates, performs one-time environment binding validation,
   * logs configuration failures with request tracing headers, and delegates execution to the Hono app.
   * Copies bindings into an invocation-owned scope before database/auth adapters
   * are created, so no driver socket or pending checkout crosses requests.
   *
   * @param request - Incoming HTTP request.
   * @param env - Cloudflare Worker environment bindings.
   * @param executionContext - Cloudflare ExecutionContext providing `waitUntil` and `passThroughOnException`.
   * @returns Outgoing HTTP response.
   */
  fetch(request, env, executionContext) {
    configureLogSampling(env.LOG_SAMPLE_RATE);
    try {
      validateDeployedBindingsOnce(env);
    } catch (cause) {
      const requestId = createRequestId(request.headers.get("X-Request-ID"));
      const traceId = createTraceId(request.headers.get("traceparent"), requestId);
      log(
        "error",
        {
          environment: env.ENVIRONMENT,
          request_id: requestId,
          route: "worker_configuration",
          service: "api",
          trace_id: traceId,
          version: env.VERSION,
        },
        {
          error_code: "configuration_invalid",
          event: "worker_configuration_failed",
          ...errorDiagnostic(cause),
          outcome: "internal_error",
          retry_class: "none",
          unavailable_bindings: bindingStatuses(env)
            .filter((binding) => binding.status === "unavailable")
            .map((binding) => binding.name),
        },
      );
      return new Response("An error has occurred.", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Request-ID": requestId,
        },
        status: 500,
      });
    }
    return app.fetch(request, { ...env }, executionContext);
  },
} satisfies ExportedHandler<ApiWorkerEnv>;
