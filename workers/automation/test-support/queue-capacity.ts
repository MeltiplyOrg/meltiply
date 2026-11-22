import { ProviderRegistry } from "@meltiply/providers";
import SelfhostAutomation from "../../../scripts/selfhost/automation";
import { createAutomationHandler } from "../src/index";
import type { AutomationEnv } from "../src/env";

export { ReplyWorkflow } from "../src/index";

interface CapacityEnv extends AutomationEnv {
  PUBLISH_UPSTREAM: Fetcher;
}

export default class CapacityAutomation extends SelfhostAutomation {
  private readonly handler: ExportedHandler<AutomationEnv, unknown>;

  constructor(ctx: ExecutionContext, env: CapacityEnv) {
    super(ctx, env);
    const registry = new ProviderRegistry();
    const capability = registry.capabilities().find((entry) => entry.platform === "threads");
    if (!capability) throw new Error("Threads capability is required for capacity smoke");
    registry.register("threads", {
      capability: {
        ...capability,
        min_media_count: 0,
        max_media_count: 0,
        asset_types: [],
        analytics: false,
        comments: false,
        reply: false,
        connect_available: false,
        publish: true,
      },
      retryPolicy: { maxAttempts: 1, baseDelaySeconds: 1, maxDelaySeconds: 1 },
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
      async lookupPublication(context) {
        const url = new URL("https://controlled-provider/lookup");
        url.searchParams.set("operation", context.operationId);
        const response = await env.PUBLISH_UPSTREAM.fetch(url);
        const providerPostId = response.headers.get("x-publication-id");
        if (response.status === 404) return { state: "not_found" };
        if (!response.ok || !providerPostId) throw new Error("Controlled lookup failed");
        return { state: "published", result: { outcome: "confirmed_success", providerPostId } };
      },
    });
    this.handler = createAutomationHandler({ providerRegistry: registry });
  }

  override async queue(batch: MessageBatch<unknown>) {
    const consume = this.handler.queue;
    if (!consume) throw new Error("Production Queue handler is unavailable");
    await consume(batch, this.env, this.ctx);
  }
}
