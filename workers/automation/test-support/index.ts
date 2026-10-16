/**
 * Controlled-Provider acceptance entry for the automation Worker.
 *
 * Everything this Worker does in a local acceptance run is the production
 * implementation: the same queue consumers, cron dispatchers, outbox relay,
 * Durable Object + Container media processor, and Reply workflow. The single
 * difference is the {@link ProviderRegistry} handed to
 * {@link createAutomationHandler} through its existing optional dependency slot,
 * which is the same injection seam the unit and integration suites already use.
 *
 * Publication therefore still runs the real outbox delivery, job lease claim,
 * `provider_operations.publication_snapshot` freeze, R2 media resolution, and
 * outcome recording. Only the platform on the far side of the boundary is the
 * controlled fixture in `./controlled-provider`, whose durable records are what
 * the acceptance run asserts against.
 *
 * Run with `workers/automation/test-support/wrangler.local.acceptance.jsonc`,
 * which is wired into `frontend/app/playwright.config.ts` for the acceptance
 * project only. The production `src/index.ts` entry and
 * `wrangler.local.jsonc` are untouched.
 */

import type { AutomationEnv } from "../src/env";
import { AutomationEntrypoint, createAutomationHandler, ReplyWorkflow } from "../src/index";
import { MediaProcessorContainer } from "../src/native-processor-container";

import { createControlledProviderRegistry } from "./controlled-provider";

// Wrangler binds `ReplyWorkflow` and `MediaProcessorContainer` by class name, so
// the fixture entry must re-export the production classes unchanged: the reply
// workflow and the container-backed media processor keep their real behaviour,
// including the container engine that actually normalizes uploaded media.
export { MediaProcessorContainer, ReplyWorkflow };

/**
 * Automation Worker entry wired to the controlled external Provider.
 *
 * Extends the production {@link AutomationEntrypoint} so the two service-binding
 * RPC surfaces the API Worker calls (`relayOutbox`, `requestCommentsSync`) keep
 * their production implementations, and overrides only the three event
 * dispatchers so they route through a handler built with the fixture registry.
 *
 * The parent handler is constructed lazily per isolate from `env.ASSETS`, the
 * same bucket the API Worker binds, which is what lets both fixture entries
 * read one durable set of controlled-provider publication records.
 */
class AutomationAcceptanceEntrypoint extends AutomationEntrypoint {
  /**
   * Builds the acceptance handler for one isolate.
   *
   * @param ctx - Cloudflare execution context supplied by workerd.
   * @param env - Automation Worker bindings, including the shared assets bucket.
   * @throws {TypeError} When the shared assets bucket binding is missing.
   */
  constructor(ctx: ExecutionContext, env: AutomationEnv) {
    super(ctx, env);
    if (!env.ASSETS) {
      throw new TypeError("controlled acceptance entry requires the shared ASSETS binding");
    }
    this.acceptanceHandler = createAutomationHandler({
      providerRegistry: createControlledProviderRegistry({
        bucket: env.ASSETS,
      }),
    });
  }

  private readonly acceptanceHandler: ExportedHandler<AutomationEnv, unknown>;

  /**
   * Delegates HTTP requests (health checks) to the acceptance handler.
   *
   * @param request - Incoming HTTP request.
   * @returns Response produced by the production automation handler.
   */
  override fetch(request: Request) {
    const handler = this.acceptanceHandler.fetch!;
    return handler(request as Parameters<typeof handler>[0], this.env, this.ctx);
  }

  /**
   * Delegates queue batches to the acceptance handler.
   *
   * @param batch - Batch of queue messages delivered to this Worker.
   * @returns Promise resolving once the batch is fully processed.
   */
  override queue(batch: MessageBatch<unknown>) {
    return this.acceptanceHandler.queue!(batch, this.env, this.ctx);
  }

  /**
   * Delegates cron invocations to the acceptance handler.
   *
   * @param controller - Scheduled controller carrying the cron expression.
   * @returns Promise resolving once every due scheduled unit completes.
   */
  override scheduled(controller: ScheduledController) {
    return this.acceptanceHandler.scheduled!(controller, this.env, this.ctx);
  }
}

export default AutomationAcceptanceEntrypoint;
