import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import nodemailer from "nodemailer";
import { z } from "zod";
import { JobStore } from "./jobs.mjs";
import { startControl } from "./control.mjs";

const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist/selfhost");
const metadata = JSON.parse(await readFile(resolve(dist, "metadata.json"), "utf8"));
const config = z
  .object({
    SELFHOST_DATA: z.string().default("/data"),
    SELFHOST_ORIGIN: z.url().default("http://localhost:8080"),
    SELFHOST_PUBLIC_ORIGIN: z.url().default("http://localhost:8081"),
    SELFHOST_DB_SYSTEM_PASSWORD: z.string().min(32),
    SELFHOST_DB_AUTHENTICATED_PASSWORD: z.string().min(32),
    BETTER_AUTH_SECRET: z.string().min(32),
    TOKEN_ENCRYPTION_KEY: z.string().min(32),
    SELFHOST_OPERATOR_SECRET: z.string().min(32),
    PROCESSOR_JOB_TOKEN: z.string().min(32),
    R2_ACCESS_KEY_ID: z.string().min(16),
    R2_SECRET_ACCESS_KEY: z.string().min(32),
    MAIL_FROM_ADDRESS: z.email(),
    SELFHOST_SMTP_URL: z.string().url(),
  })
  .parse(process.env);
await mkdir(config.SELFHOST_DATA, { recursive: true, mode: 0o700 });
const queuePolicies = JSON.parse(await readFile(resolve(dist, "queues.json"), "utf8"));
const queues = { ...queuePolicies };
for (const [name, policy] of Object.entries(queuePolicies))
  queues[policy.deadLetterQueue] = { deadLetter: true, source: name };
for (const name of ["schedule-hourly", "schedule-daily"]) {
  queues[name] = {
    maxBatchSize: 1,
    maxRetries: 10,
    retryDelay: 60,
    deadLetterQueue: `${name}-dlq`,
  };
  queues[`${name}-dlq`] = { deadLetter: true, source: name };
}
const jobs = new JobStore(resolve(config.SELFHOST_DATA, "jobs.sqlite"), queues);
const mail = nodemailer.createTransport(config.SELFHOST_SMTP_URL);
await mail.verify();
const address = z.union([
  z.email(),
  z.object({ email: z.email(), name: z.string().max(200).optional() }),
]);
const mailSchema = z
  .object({
    from: address,
    to: z.union([address, z.array(address).min(1).max(50)]),
    subject: z.string().max(1000),
    text: z.string().max(1000000),
    html: z.string().max(1000000),
  })
  .strict();
const enqueueSchema = z
  .object({ queue: z.string(), messages: z.array(z.unknown()).max(100) })
  .strict();

/** Handles private binding calls only; it is a Miniflare host callback, not a network listener. */
async function host(request) {
  try {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.text();
    if (Buffer.byteLength(body) > 2100000) return new Response(null, { status: 413 });
    const payload = JSON.parse(body);
    if (path === "/queue") {
      const batch = enqueueSchema.parse(payload);
      jobs.enqueue(batch.queue, batch.messages);
      return Response.json({ committed: true });
    }
    if (path === "/mail") {
      const message = mailSchema.parse(payload);
      const from = typeof message.from === "string" ? message.from : message.from.email;
      if (from !== config.MAIL_FROM_ADDRESS) return new Response(null, { status: 403 });
      /** Maps Cloudflare structured identities onto Nodemailer's explicit address fields. */
      const smtpAddress = (value) =>
        typeof value === "string" ? value : { address: value.email, name: value.name ?? "" };
      const receipt = await mail.sendMail({
        ...message,
        from: smtpAddress(message.from),
        to: Array.isArray(message.to) ? message.to.map(smtpAddress) : smtpAddress(message.to),
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (receipt.rejected?.length || !receipt.messageId)
        throw new Error("SMTP recipient rejected");
      return Response.json({ messageId: receipt.messageId });
    }
    return new Response(null, { status: 404 });
  } catch {
    console.error(JSON.stringify({ event: "selfhost_binding_failed" }));
    return new Response(null, { status: 503 });
  }
}

const bindings = {
  ENVIRONMENT: "staging",
  DATABASE_POOL_MODE: "request",
  VERSION: process.env.VERSION || "selfhost",
  FRONTEND_URL: new URL(config.SELFHOST_ORIGIN).origin,
  PUBLIC_API_URL: new URL(config.SELFHOST_ORIGIN).origin,
  BETTER_AUTH_URL: new URL(config.SELFHOST_ORIGIN).origin,
  ALLOWED_ORIGINS: new URL(config.SELFHOST_ORIGIN).origin,
  OPERATOR_HOSTNAME: new URL(config.SELFHOST_ORIGIN).hostname,
  BETTER_AUTH_SECRET: config.BETTER_AUTH_SECRET,
  TOKEN_ENCRYPTION_KEY: config.TOKEN_ENCRYPTION_KEY,
  SELFHOST_OPERATOR_SECRET: config.SELFHOST_OPERATOR_SECRET,
  PROCESSOR_JOB_TOKEN: config.PROCESSOR_JOB_TOKEN,
  R2_ACCESS_KEY_ID: config.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: config.R2_SECRET_ACCESS_KEY,
  R2_ACCOUNT_ID: "selfhost",
  R2_BUCKET_NAME: "meltiply-assets",
  R2_ENDPOINT: new URL(config.SELFHOST_ORIGIN).origin,
  R2_ENDPOINT_PATH_PREFIX: "/cdn-cgi/local/r2/s3",
  MAIL_FROM_ADDRESS: config.MAIL_FROM_ADDRESS,
  MAIL_FROM_NAME: process.env.MAIL_FROM_NAME || "Meltiply",
};
for (const name of [
  "FACEBOOK_CLIENT_ID",
  "FACEBOOK_CLIENT_SECRET",
  "FACEBOOK_LIVE_ACCEPTED",
  "INSTAGRAM_CLIENT_ID",
  "INSTAGRAM_CLIENT_SECRET",
  "INSTAGRAM_LIVE_ACCEPTED",
  "INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED",
  "THREADS_CLIENT_ID",
  "THREADS_CLIENT_SECRET",
  "THREADS_LIVE_ACCEPTED",
  "THREADS_ENGAGEMENT_LIVE_ACCEPTED",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_LIVE_ACCEPTED",
  "TIKTOK_MEDIA_URL_PREFIX",
  "YOUTUBE_SHORTS_CLIENT_ID",
  "YOUTUBE_SHORTS_CLIENT_SECRET",
  "YOUTUBE_LIVE_ACCEPTED",
  "TOKEN_ENCRYPTION_KEYRING",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "POLAR_ENV",
  "LOG_SAMPLE_RATE",
]) {
  if (process.env[name]) bindings[name] = process.env[name];
}
const credentials = {
  accessKeyId: config.R2_ACCESS_KEY_ID,
  secretAccessKey: config.R2_SECRET_ACCESS_KEY,
};
const storage = { ASSETS: { id: "meltiply-assets", s3Credentials: credentials } };
/** Creates direct PostgreSQL URLs, keeping passwords escaped and distinct RLS/system roles intact. */
function databaseUrl(role, password) {
  const url = new URL("postgresql://postgres:5432/meltiply");
  url.username = role;
  url.password = password;
  return url.href;
}
/** Points at immutable Wrangler output; imports/chunks are resolved by the runtime, never rebuilt at startup. */
function worker(name) {
  const built = metadata[name];
  return {
    name,
    modules: true,
    scriptPath: resolve(dist, name, built.entry),
    compatibilityDate: built.compatibilityDate,
    compatibilityFlags: built.compatibilityFlags,
    bindings:
      name === "api" || name === "automation"
        ? bindings
        : { ENVIRONMENT: bindings.ENVIRONMENT, VERSION: bindings.VERSION },
  };
}
const proxySecret = randomBytes(32).toString("hex");
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    host: "127.0.0.1",
    port: 0,
    cf: {},
    logRequests: false,
    telemetry: { enabled: false },
    resourcePersistencePath: resolve(config.SELFHOST_DATA, "resources"),
    unsafeLocalExplorer: false,
    unsafeProxySharedSecret: proxySecret,
    workers: [
      {
        ...worker("frontend"),
        serviceBindings: { API: "api" },
        assets: {
          directory: resolve(dist, "app"),
          binding: "ASSETS",
          routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
          assetConfig: { not_found_handling: "single-page-application" },
        },
      },
      {
        ...worker("api"),
        r2Buckets: storage,
        hyperdrives: {
          DB_SYSTEM: databaseUrl("meltiply_system", config.SELFHOST_DB_SYSTEM_PASSWORD),
          DB_AUTHENTICATED: databaseUrl("meltiply_rls", config.SELFHOST_DB_AUTHENTICATED_PASSWORD),
        },
        durableObjects: {
          OAUTH_STATE: { className: "OAuthStateCoordinator", scriptName: "state", useSQLite: true },
        },
        serviceBindings: {
          AUTOMATION: "automation",
          MAIL: { name: "bindings", entrypoint: "MailSender" },
        },
      },
      {
        ...worker("automation"),
        r2Buckets: storage,
        hyperdrives: {
          DB_SYSTEM: databaseUrl("meltiply_system", config.SELFHOST_DB_SYSTEM_PASSWORD),
        },
        durableObjects: {
          MEDIA_PROCESSOR: { className: "MediaProcessorContainer", useSQLite: true },
        },
        workflows: {
          REPLY_WORKFLOW: { name: "meltiply-reply-selfhost", className: "ReplyWorkflow" },
        },
        serviceBindings: Object.fromEntries(
          Object.entries(queuePolicies).map(([queue, policy]) => [
            policy.binding,
            { name: "bindings", entrypoint: "QueueProducer", props: { queue } },
          ]),
        ),
      },
      {
        ...worker("state"),
        durableObjects: { OAUTH_STATE: { className: "OAuthStateCoordinator", useSQLite: true } },
      },
      { ...worker("bindings"), bindings: {}, serviceBindings: { HOST: host } },
      {
        name: "public",
        modules: true,
        script: "export default { fetch(request, env) { return env.ASSETS.fetch(request); } };",
        compatibilityDate: metadata.frontend.compatibilityDate,
        assets: { directory: resolve(dist, "public"), binding: "ASSETS" },
      },
    ],
  }),
);
await runtime.ready;
const frontend = await runtime.getWorker("frontend");
const api = await runtime.getWorker("api");
const publicSite = await runtime.getWorker("public");
const automation = await runtime.getWorker("automation");
const control = await startControl(runtime, jobs, queuePolicies, config.SELFHOST_OPERATOR_SECRET);
let stopping = false;

/** Dispatches all queues serially, preserving per-provider concurrency limits and avoiding unbounded work. */
async function dispatch() {
  while (!stopping) {
    jobs.schedule("schedule-hourly", 3600000, "0 * * * *");
    jobs.schedule("schedule-daily", 86400000, "0 0 * * *");
    for (const name of Object.keys(queues)) {
      if (stopping) break;
      const rows = jobs.claim(name);
      if (!rows.length) continue;
      let result;
      try {
        if (name.startsWith("schedule-")) {
          result = await automation.runScheduled(rows[0].body.cron, rows[0].body.scheduledTime);
        } else result = await automation.deliver(name, rows, jobs.metrics(name));
      } catch {
        console.error(JSON.stringify({ event: "selfhost_dispatch_failed", queue: name }));
        result = { outcome: "exception" };
      }
      jobs.settle(name, rows, result);
    }
    await delay(250);
  }
}

/** Streams requests/responses with backpressure; only signed S3 paths can enter runtime-internal routes. */
function listener(isPublic) {
  return createServer(async (incoming, outgoing) => {
    try {
      const origin = isPublic ? config.SELFHOST_PUBLIC_ORIGIN : config.SELFHOST_ORIGIN;
      const url = new URL(incoming.url ?? "/", origin);
      if (url.origin !== new URL(origin).origin) {
        outgoing.writeHead(400).end();
        return;
      }
      if (
        url.pathname.startsWith("/cdn-cgi/") &&
        !url.pathname.startsWith("/cdn-cgi/local/r2/s3/")
      ) {
        outgoing.writeHead(404).end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (
          value !== undefined &&
          !name.startsWith("mf-") &&
          ![
            "host",
            "connection",
            "transfer-encoding",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "cf-connecting-ip",
          ].includes(name)
        )
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("cf-connecting-ip", incoming.socket.remoteAddress || "unknown");
      // The internal runtime transport must not replace SigV4's signed public authority.
      headers.set("host", url.host);
      if (!isPublic && url.pathname.startsWith("/cdn-cgi/local/r2/s3/")) {
        headers.set("MF-Proxy-Shared-Secret", proxySecret);
      }
      const controller = new AbortController();
      incoming.on("aborted", () => controller.abort());
      outgoing.on("close", () => {
        if (!outgoing.writableFinished) controller.abort();
      });
      const init = { method: incoming.method, headers, signal: controller.signal };
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        init.body = Readable.toWeb(incoming);
        init.duplex = "half";
      }
      const response =
        url.pathname.startsWith("/cdn-cgi/local/r2/s3/") && !isPublic
          ? await runtime.dispatchFetch(url.href, init)
          : await (
              isPublic ? publicSite : url.pathname.startsWith("/operator/") ? api : frontend
            ).fetch(new Request(url, init));
      const responseHeaders = Object.fromEntries(response.headers);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) responseHeaders["set-cookie"] = cookies;
      if (
        response.ok &&
        incoming.method === "GET" &&
        url.pathname.startsWith("/cdn-cgi/local/r2/s3/")
      ) {
        for (const [parameter, name] of [
          ["response-content-type", "content-type"],
          ["response-content-disposition", "content-disposition"],
        ]) {
          const value = url.searchParams.get(parameter);
          if (value !== null) responseHeaders[name] = value;
        }
      }
      outgoing.writeHead(response.status, responseHeaders);
      if (response.body)
        Readable.fromWeb(response.body)
          .on("error", () => outgoing.destroy())
          .pipe(outgoing);
      else outgoing.end();
    } catch {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502).end("Application unavailable");
    }
  });
}
const appServer = listener(false);
const publicServer = listener(true);
await Promise.all([
  new Promise((resolve, reject) => {
    appServer.once("error", reject);
    appServer.listen(8080, "0.0.0.0", resolve);
  }),
  new Promise((resolve, reject) => {
    publicServer.once("error", reject);
    publicServer.listen(8081, "0.0.0.0", resolve);
  }),
]);
const dispatching = dispatch();
dispatching.catch((error) => {
  console.error(error);
  void shutdown(1);
});
console.log(JSON.stringify({ event: "selfhost_ready", runtime: "workerd" }));

/** Stops ingress, drains the active job, then closes the runtime and durable broker; Compose allows ten minutes. */
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  appServer.close();
  publicServer.close();
  control.close();
  await dispatching.catch(() => {});
  await runtime.dispose();
  jobs.close();
  mail.close();
  process.exitCode = code;
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
