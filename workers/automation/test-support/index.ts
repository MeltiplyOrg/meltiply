import type { AutomationEnv } from "../src/env";
import { AutomationEntrypoint, createAutomationHandler, ReplyWorkflow } from "../src/index";
import { MediaProcessorContainer } from "../src/native-processor-container";

import { createControlledProviderRegistry } from "./controlled-provider";

export { MediaProcessorContainer, ReplyWorkflow };

class AutomationAcceptanceEntrypoint extends AutomationEntrypoint {
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

  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__test__/scheduled" && request.method === "POST") {
      const cron = url.searchParams.get("cron") ?? "0 * * * *";
      await this.acceptanceHandler.scheduled!(
        { cron, noRetry() {}, scheduledTime: Date.now() },
        this.env,
        this.ctx,
      );
      return new Response(null, { status: 204 });
    }
    const handler = this.acceptanceHandler.fetch!;
    return handler(request as Parameters<typeof handler>[0], this.env, this.ctx);
  }

  override queue(batch: MessageBatch<unknown>) {
    return this.acceptanceHandler.queue!(batch, this.env, this.ctx);
  }

  override scheduled(controller: ScheduledController) {
    return this.acceptanceHandler.scheduled!(controller, this.env, this.ctx);
  }
}

export default AutomationAcceptanceEntrypoint;
