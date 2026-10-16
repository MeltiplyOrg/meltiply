// Wrangler's outer dev proxy rejects non-loopback /cdn-cgi Host headers even
// when --local-upstream configures the inner runtime. Expose only the native S3
// route through the Docker-facing listener (or the devcontainer's daemon-host
// relay). Wrangler restores that final signed authority through --local-upstream
// before its S3 handler verifies SigV4.
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, request, validateHeaderValue } from "node:http";
import { createWorkerConfigSession } from "./worker-config-session.mjs";
import { startDockerGatewayRelay } from "./docker-gateway-relay.mjs";

const [gatewayHost, workerHost, workerPort, command, ...args] = process.argv.slice(2);
if (!gatewayHost || !workerHost || !workerPort || !command) {
  throw new Error("Expected gateway host, Worker host, Worker port, and command");
}
const pathPrefix = process.env.LOCAL_R2_S3_PATH_PREFIX || "/cdn-cgi/local/r2/s3";
const downloadResponseHeaders = [
  ["response-content-disposition", "content-disposition"],
  ["response-content-type", "content-type"],
];

/**
 * Streams native S3 requests without changing signed bytes; --local-upstream
 * restores the authority after the outer proxy's loopback Host guard.
 * Miniflare omits download response overrides, so successful GETs apply the
 * two signed download headers only after upstream SigV4 validation. Rejected
 * requests retain their response; malformed header values fail without streaming.
 */
const server = createServer((incoming, outgoing) => {
  if (!incoming.url?.startsWith(`${pathPrefix}/`)) {
    outgoing.writeHead(404).end();
    return;
  }
  const upstream = request(
    {
      hostname: workerHost,
      port: Number(workerPort),
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: `localhost:${workerPort}` },
    },
    (response) => {
      if (incoming.method === "GET" && response.statusCode >= 200 && response.statusCode < 300) {
        const parameters = new URL(incoming.url, "http://localhost").searchParams;
        try {
          for (const [parameter, header] of downloadResponseHeaders) {
            const value = parameters.get(parameter);
            if (value !== null) {
              validateHeaderValue(header, value);
              response.headers[header] = value;
            }
          }
        } catch {
          response.destroy();
          outgoing.writeHead(400).end("Invalid signed download response header");
          return;
        }
      }
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", () => {
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(502).end("Local Worker is unavailable");
  });
  incoming.on("aborted", () => upstream.destroy());
  outgoing.on("close", () => upstream.destroy());
  incoming.pipe(upstream);
});
const inDevcontainer = process.env.MELTIPLY_DEVCONTAINER === "1";
let relay;
let worker;
let stopping = false;
let relayFailed = false;
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, inDevcontainer ? "0.0.0.0" : gatewayHost, resolve);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Local R2 gateway has no TCP address");
}
try {
  if (inDevcontainer) {
    relay = await startDockerGatewayRelay(address.port);
    relay.child.once("exit", () => {
      if (!stopping) {
        relayFailed = true;
        console.error("Docker R2 relay stopped unexpectedly");
        stop("SIGTERM");
      }
    });
    if (stopping || relay.child.exitCode !== null || relay.child.signalCode !== null) {
      await relay.close();
      throw new Error("Docker R2 gateway stopped during startup");
    }
  }
} catch (error) {
  server.close();
  await relay?.close();
  throw error;
}
const authority = `${relay?.host ?? gatewayHost}:${relay?.port ?? address.port}`;
console.log(`Local signed R2 gateway: http://${authority}${pathPrefix}`);

// Secondary Workers ignore CLI env-file/var overrides. Give every config its
// own env lookup in an isolated session layout, never in the user's checkout.
const configIndexes = args.flatMap((arg, index) =>
  arg === "--config" && args[index + 1] ? [index + 1] : [],
);
const envFileIndex = args.indexOf("--env-file");
let session;
try {
  const rootEnv = envFileIndex >= 0 ? await readFile(args[envFileIndex + 1], "utf8") : "";
  session = await createWorkerConfigSession(
    process.cwd(),
    configIndexes.map((index) => resolve(args[index])),
    `${rootEnv}\nR2_ENDPOINT="http://${authority}"\nR2_ENDPOINT_PATH_PREFIX="${pathPrefix}"\n`,
  );
  for (const [position, index] of configIndexes.entries()) {
    args[index] = session.configs[position];
  }
  if (stopping) throw new Error("Local R2 gateway stopped during startup");
} catch (error) {
  server.close();
  await removeSessionEnv();
  await relay?.close();
  throw error;
}

/** Removes this session's private config/env tree, including interrupted startup. */
async function removeSessionEnv() {
  if (session) await rm(session.root, { recursive: true, force: true });
}
worker = spawn(
  command,
  [
    ...args,
    "--var",
    `R2_ENDPOINT:http://${authority}`,
    "--var",
    `R2_ENDPOINT_PATH_PREFIX:${pathPrefix}`,
    "--local-upstream",
    authority,
  ],
  { stdio: "inherit", detached: true },
);

/**
 * Stops the owned Wrangler process group, local gateway, and daemon-host relay.
 * Relay cleanup is idempotent across signals and Worker exit; no sibling stack
 * or daemon-global resources are touched.
 */
function stop(signal) {
  stopping = true;
  if (worker?.pid && worker.exitCode === null && worker.signalCode === null) {
    process.kill(-worker.pid, signal);
  }
  server.close();
  void relay?.close().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
worker.once("error", async (error) => {
  console.error(error);
  stop("SIGTERM");
  process.exitCode = 1;
  try {
    await relay?.close();
  } finally {
    await removeSessionEnv();
  }
});
worker.once("exit", async (code, signal) => {
  stop("SIGTERM");
  process.exitCode = relayFailed ? 1 : (code ?? (signal ? 1 : 0));
  try {
    await relay?.close();
  } finally {
    await removeSessionEnv();
  }
});
