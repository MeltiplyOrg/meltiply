#!/usr/bin/env node
import { createServer } from "node:net";

const minimumPort = 1024;
const maximumPort = 65_535;
const searchLimit = 100;
const reservedPorts = new Set([3001, 3100, 3200, 4317, 4318, 5433, 9090, 9091, 9464]);

function parsePreferredPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < minimumPort || port > maximumPort) {
    throw new TypeError(
      `preferred port must be an integer between ${minimumPort} and ${maximumPort}`,
    );
  }
  return port;
}

function candidatePort(preferredPort, offset) {
  const portCount = maximumPort - minimumPort + 1;
  return minimumPort + ((preferredPort - minimumPort + offset) % portCount);
}

function isAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

async function main() {
  const preferredPort = parsePreferredPort(process.argv[2] ?? "8787");
  for (let offset = 0; offset < searchLimit; offset += 1) {
    const port = candidatePort(preferredPort, offset);
    if (!reservedPorts.has(port) && (await isAvailable(port))) {
      process.stdout.write(`${port}\n`);
      return;
    }
  }
  throw new Error(`no available port found after ${searchLimit} attempts from ${preferredPort}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
