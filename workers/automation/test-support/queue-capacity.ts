import { ProviderRegistry } from "@meltiply/providers";
import SelfhostAutomation from "../../../scripts/selfhost/automation";
import { createAutomationHandler } from "../src/index";
import type { AutomationEnv } from "../src/env";

export { ReplyWorkflow } from "../src/index";

interface CapacityEnv extends AutomationEnv {
  PUBLISH_UPSTREAM: Fetcher;
}

/**
 * Runs production Queue dispatch and real publication persistence through the
 * existing private host delivery surface. Only the external Threads Provider is
 * controlled, using a service binding so the probe can observe active calls and
 * inject latency without private diagnostic routes in the production Worker.
 */
export default class CapacityAutomation extends SelfhostAutomation {
  private readonly handler: ExportedHandler<AutomationEnv, unknown>;

  /** Builds one controlled Provider registry; database/job handling stays canonical. */
  constructor(ctx: ExecutionContext, env: CapacityEnv) {
    super(ctx, env);
    const registry = new ProviderRegistry();
    const capability = registry.capabilities().find((entry) => entry.platform === "threads");
    if (!capability) throw new Error("Threads capability is required for capacity smoke");
    registry.register("threads", {
      capability: { ...capability, min_media_count: 0, publish: true },
      transferModes: [],
      async publish(context, credentials, input) {
        const response = await env.PUBLISH_UPSTREAM.fetch("https://controlled-provider/publish", {
          method: "POST",
          body: JSON.stringify({
            account: credentials.accountId,
            operation: context.operationId,
            caption: input.caption,
          }),
        });
        const publicationId = response.headers.get("x-publication-id");
        if (!response.ok || !publicationId)
          throw new Error("Controlled Provider refused publication");
        return { outcome: "confirmed_success", providerPostId: publicationId };
      },
    });
    this.handler = createAutomationHandler({ providerRegistry: registry });
  }

  /** Dispatches host-delivered batches through the real handler with per-invocation bindings. */
  override async queue(batch: MessageBatch<unknown>) {
    await this.handler.queue!(batch, this.env, this.ctx);
  }
}
