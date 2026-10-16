import { createServer } from "node:http";
import { chmod, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
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
  z.object({ action: z.literal("probe-write"), id: z.uuid(), organizationId: z.uuid() }).strict(),
  z.object({ action: z.literal("probe-read"), id: z.uuid(), organizationId: z.uuid() }).strict(),
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
        const diagnostics = await runtime.getWorker("diagnostics");
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
          const response = await diagnostics.fetch("http://diagnostics/internal", {
            method: "POST",
            body: JSON.stringify(command),
          });
          if (!response.ok) throw new Error("Resource preparation failed");
          result = await response.json();
          jobs.enqueue(queue, [{ body: payload, delaySeconds: 300 }]);
        } else {
          const pending = jobs.db
            .prepare(
              "SELECT id FROM jobs WHERE queue = ? AND json_extract(body, '$.event_id') = ? LIMIT 1",
            )
            .get(queue, command.id);
          if (!pending) throw new Error("Delayed queue message did not survive restart");
          const response = await diagnostics.fetch("http://diagnostics/internal", {
            method: "POST",
            body: JSON.stringify(command),
          });
          if (!response.ok) throw new Error("Resource recovery failed");
          const recovered = await response.json();
          jobs.db.prepare("DELETE FROM jobs WHERE id = ?").run(pending.id);
          result = { ...recovered, queue: "recovered" };
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
