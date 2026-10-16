import { createServer } from "node:http";
import { chmod, rm } from "node:fs/promises";
import { randomUUID, createHmac } from "node:crypto";
import { z } from "zod";

const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({ action: z.literal("token"), email: z.email(), subject: z.string().min(1).max(200) })
    .strict(),
  z
    .object({
      action: z.literal("replay"),
      queue: z.string(),
      limit: z.number().int().min(1).max(1000).default(100),
    })
    .strict(),
  z.object({ action: z.literal("probe-write"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("probe-read"), id: z.uuid() }).strict(),
]);

/**
 * Private Unix-socket operations for container administrators, never public HTTP.
 * Probe writes use reserved diagnostic object/state names and nonexistent reply
 * identifiers; they cannot call a Provider. Read verifies restart recovery and
 * removes probe objects. The same socket supports queue recovery and token minting.
 */
export async function startControl(runtime, jobs, queuePolicies, secret) {
  const socket = "/tmp/meltiply-admin.sock";
  await rm(socket, { force: true });
  const server = createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) {
        text += chunk;
        if (Buffer.byteLength(text) > 4096) throw new TypeError("Command too large");
      }
      const command = commandSchema.parse(JSON.parse(text));
      let result;
      if (command.action === "status") result = { queues: jobs.counts() };
      else if (command.action === "token") {
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
          "base64url",
        );
        const payload = Buffer.from(
          JSON.stringify({
            iss: "meltiply-selfhost",
            aud: "meltiply-operator",
            sub: command.subject,
            email: command.email,
            iat: now,
            exp: now + 900,
          }),
        ).toString("base64url");
        const signature = createHmac("sha256", secret)
          .update(`${header}.${payload}`)
          .digest("base64url");
        result = { token: `${header}.${payload}.${signature}`, expiresAt: now + 900 };
      } else if (command.action === "replay")
        result = { replayed: jobs.replay(command.queue, command.limit) };
      else {
        const api = await runtime.getBindings("api");
        const automation = await runtime.getBindings("automation");
        const key = `_selfhost-diagnostics/${command.id}`;
        const state = api.OAUTH_STATE.get(api.OAUTH_STATE.idFromName(key));
        const queue = Object.keys(queuePolicies)[0];
        const payload = {
          type: "outbox.event",
          version: 1,
          event_id: command.id,
          aggregate_id: command.id,
          organization_id: command.id,
          topic: "selfhost.diagnostic",
          payload: {},
        };
        if (command.action === "probe-write") {
          await api.ASSETS.put(key, command.id);
          await state.create(key, {
            brand_profile_id: command.id,
            organization_id: command.id,
            user_id: command.id,
            provider: "facebook",
            redirect_path: "/diagnostic",
            expires_at: Date.now() + 600000,
          });
          await automation[queuePolicies[queue].binding].send(payload, { delaySeconds: 300 });
          const workflow = await automation.REPLY_WORKFLOW.create({
            id: `diagnostic-${command.id}`,
            params: {
              type: "reply.workflow",
              version: 1,
              event_id: randomUUID(),
              comment_id: command.id,
              organization_id: command.id,
            },
          });
          // Pausing fences pending execution across restart. A workflow that
          // already completed has no remaining work to fence.
          try {
            await workflow.pause();
          } catch (error) {
            if ((await workflow.status()).status !== "complete") throw error;
          }
          result = { prepared: true, workflowId: workflow.id };
        } else {
          const object = await api.ASSETS.get(key);
          if (!object || (await object.text()) !== command.id)
            throw new Error("R2 object did not survive restart");
          const stored = await state.consume(key);
          if (stored?.organization_id !== command.id || (await state.consume(key)) !== null)
            throw new Error("OAuth state recovery or single-use consumption failed");
          const pending = jobs.db
            .prepare(
              "SELECT id FROM jobs WHERE queue = ? AND json_extract(body, '$.event_id') = ? LIMIT 1",
            )
            .get(queue, command.id);
          if (!pending) throw new Error("Delayed queue message did not survive restart");
          const workflow = await automation.REPLY_WORKFLOW.get(`diagnostic-${command.id}`);
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
            await new Promise((resolve) => setTimeout(resolve, 250));
          } while (Date.now() < deadline);
          if (after.status !== "complete") throw new Error("Workflow did not resume to completion");
          await api.ASSETS.delete(key);
          jobs.db.prepare("DELETE FROM jobs WHERE id = ?").run(pending.id);
          result = {
            storage: "recovered",
            oauth: "single-use",
            queue: "recovered",
            workflow: "complete",
          };
        }
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(
          JSON.stringify({ error: error instanceof Error ? error.message : "Operation failed" }),
        );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  return server;
}
