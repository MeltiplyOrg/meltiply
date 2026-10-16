import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import type { ApiWorkerEnv } from "../../workers/api/src/env";
import type { AutomationEnv } from "../../workers/automation/src/env";

type DiagnosticEnv = Required<
  Pick<ApiWorkerEnv, "ASSETS" | "OAUTH_STATE"> & Pick<AutomationEnv, "REPLY_WORKFLOW">
>;
const commandSchema = z
  .object({ action: z.enum(["probe-write", "probe-read"]), id: z.uuid() })
  .strict();

export default {
  /** Private service-only restart probe: exercises real R2, coordinator RPC and workflow bindings inside workerd, never Miniflare's synchronous Node RPC proxy. */
  async fetch(request: Request, env: DiagnosticEnv): Promise<Response> {
    const { action, id } = commandSchema.parse(await request.json());
    const key = `_selfhost-diagnostics/${id}`;
    const state = env.OAUTH_STATE.get(env.OAUTH_STATE.idFromName(key));
    const workflowId = `diagnostic-${id}`;
    if (action === "probe-write") {
      await env.ASSETS.put(key, id);
      await state.create(key, {
        brand_profile_id: id,
        organization_id: id,
        user_id: id,
        provider: "facebook",
        redirect_path: "/diagnostic",
        expires_at: Date.now() + 600000,
      });
      const workflow = await env.REPLY_WORKFLOW.create({
        id: workflowId,
        params: {
          type: "reply.workflow",
          version: 1,
          event_id: crypto.randomUUID(),
          comment_id: id,
          organization_id: id,
        },
      });
      try {
        await workflow.pause();
      } catch (error) {
        if ((await workflow.status()).status !== "complete") throw error;
      }
      return Response.json({ prepared: true, workflowId });
    }
    const object = await env.ASSETS.get(key);
    if (!object || (await object.text()) !== id)
      throw new Error("R2 object did not survive restart");
    const stored = await state.consume(key);
    if (stored?.organization_id !== id || (await state.consume(key)) !== null)
      throw new Error("OAuth state recovery or single-use consumption failed");
    const workflow = await env.REPLY_WORKFLOW.get(workflowId);
    const before = await workflow.status();
    if (!["paused", "complete"].includes(before.status))
      throw new Error(`Workflow recovery failed: ${before.status}`);
    if (before.status === "paused") await workflow.resume();
    const deadline = Date.now() + 60000;
    let after;
    do {
      after = await workflow.status();
      if (after.status === "complete") break;
      if (["errored", "terminated"].includes(after.status))
        throw new Error(`Workflow failed: ${after.status}`);
      await setTimeout(250);
    } while (Date.now() < deadline);
    if (after.status !== "complete") throw new Error("Workflow did not resume to completion");
    await env.ASSETS.delete(key);
    return Response.json({ storage: "recovered", oauth: "single-use", workflow: "complete" });
  },
};
