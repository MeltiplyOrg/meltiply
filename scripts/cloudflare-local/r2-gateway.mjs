import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, request, validateHeaderValue } from "node:http";
import { createWorkerConfigSession } from "./worker-config-session.mjs";

const [gatewayHost, workerHost, workerPort, command, ...args] = process.argv.slice(2);
if (!gatewayHost || !workerHost || !workerPort || !command) {
  throw new Error("Expected gateway host, Worker host, Worker port, and command");
}
const pathPrefix = process.env.LOCAL_R2_S3_PATH_PREFIX || "/cdn-cgi/local/r2/s3";
const downloadResponseHeaders = [
  ["response-content-disposition", "content-disposition"],
  ["response-content-type", "content-type"],
];

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
let worker;
let stopping = false;
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, gatewayHost, resolve);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Local R2 gateway has no TCP address");
}
const authority = `${gatewayHost}:${address.port}`;
console.log(`Local signed R2 gateway: http://${authority}${pathPrefix}`);

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
  throw error;
}

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

function stop(signal) {
  stopping = true;
  if (worker?.pid && worker.exitCode === null && worker.signalCode === null) {
    process.kill(-worker.pid, signal);
  }
  server.close();
}
worker.once("error", async (error) => {
  console.error(error);
  stop("SIGTERM");
  process.exitCode = 1;
  await removeSessionEnv();
});
worker.once("exit", async (code, signal) => {
  stop("SIGTERM");
  process.exitCode = code ?? (signal ? 1 : 0);
  await removeSessionEnv();
});
