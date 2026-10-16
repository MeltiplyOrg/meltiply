#!/usr/bin/env node
import { createServer } from "node:net";

const minimumPort = 1024;
const maximumPort = 65_535;
const searchLimit = 100;
const reservedPorts = new Set([3001, 3100, 3200, 4317, 4318, 5433, 9090, 9091, 9464]);

/**
 * Parses and validates the user-supplied preferred port number.
 * Ensures the port is within the non-privileged range (1024-65535).
 *
 * @param {string|number} value - Raw port string or number
 * @returns {number} Validated integer port
 * @throws {TypeError} If port is not an integer between 1024 and 65535
 */
function parsePreferredPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < minimumPort || port > maximumPort) {
    throw new TypeError(
      `preferred port must be an integer between ${minimumPort} and ${maximumPort}`,
    );
  }
  return port;
}

/**
 * Computes candidate port with wrapping within the non-privileged range [1024, 65535].
 *
 * @param {number} preferredPort - Base preferred port
 * @param {number} offset - Probe iteration offset
 * @returns {number} Candidate port number
 */
function candidatePort(preferredPort, offset) {
  const portCount = maximumPort - minimumPort + 1;
  return minimumPort + ((preferredPort - minimumPort + offset) % portCount);
}

/**
 * Tests whether a TCP port is currently free to bind on loopback (127.0.0.1).
 *
 * @param {number} port - Port to test
 * @returns {Promise<boolean>} Resolves true if available, false if in use or denied
 */
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

/**
 * Scans up to 100 ports starting from the preferred port, bypassing known reserved ports,
 * and prints the first available port to standard output.
 *
 * @returns {Promise<void>}
 * @throws {Error} If no available port is found within the search limit
 */
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
