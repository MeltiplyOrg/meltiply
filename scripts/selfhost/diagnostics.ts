import { setTimeout } from "node:timers/promises";
import { z } from "zod";
// Bun's isolated linker scopes workspace packages to their declaring workspace.
import {
  createObjectStoreFromEnv,
  type ConfiguredObjectStore,
  type ObjectStorageEnv,
} from "../../packages/storage/src/index";
import type { ApiWorkerEnv } from "../../workers/api/src/env";
import type { AutomationEnv } from "../../workers/automation/src/env";

type DiagnosticEnv = AutomationEnv &
  ObjectStorageEnv &
  Required<Pick<ApiWorkerEnv, "OAUTH_STATE"> & Pick<AutomationEnv, "REPLY_WORKFLOW">>;
const commandSchema = z
  .object({ action: z.enum(["probe-write", "probe-read"]), id: z.uuid(), organizationId: z.uuid() })
  .strict();

async function writeMarker(store: ConfiguredObjectStore, key: string): Promise<void> {
  const upload = await store.createMultipartUpload(key, "application/octet-stream");
  await upload.complete([await upload.uploadPart(1, new TextEncoder().encode(key))]);
}

export default {
  async fetch(request: Request, env: DiagnosticEnv): Promise<Response> {
    const { action, id, organizationId } = commandSchema.parse(await request.json());
    const key = `_selfhost-diagnostics/${id}`;
    const state = env.OAUTH_STATE.get(env.OAUTH_STATE.idFromName(key));
    const workflowId = `diagnostic-${id}`;
    const store = createObjectStoreFromEnv(env);
    if (action === "probe-write") {
      await writeMarker(store, key);
      await state.create(key, {
        organization_id: organizationId,
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
          organization_id: organizationId,
        },
      });
      try {
        await workflow.pause();
      } catch (error) {
        if ((await workflow.status()).status !== "complete") throw error;
      }
      return Response.json({ prepared: true, workflowId });
    }
    const object = await store.read(key);
    if (!object || (await new Response(object.body).text()) !== key) {
      throw new Error("Object storage did not survive restart");
    }
    const stored = await state.consume(key);
    if (stored?.organization_id !== organizationId || (await state.consume(key)) !== null)
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
    await store.delete(key);
    return Response.json({ storage: "recovered", oauth: "single-use", workflow: "complete" });
  },
};
