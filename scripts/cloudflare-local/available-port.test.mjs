import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./available-port.mjs", import.meta.url));
const developmentHostPath = fileURLToPath(new URL("./development-host.mjs", import.meta.url));

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// Finds a port that is free right now so the selection is predictable; OS
// assigned ports above the reserved set keep the expected value deterministic.
async function freePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = createServer();
    await listen(probe, 0);
    const address = probe.address();
    await close(probe);
    if (!address || typeof address !== "object") continue;
    // Stay clear of the reserved ports (3001, 3100, 3200, 4317, 4318, 5433,
    // 9090, 9091, 9464) and of the port the scanner would otherwise probe.
    if (address.port > 20_000) return address.port;
  }
  throw new Error("could not find a free high port for the scanner fixture");
}

// The scanner is deterministic apart from port occupancy, so a free preferred
// port pins the chosen value exactly: returning any other port (a hardcoded
// default, an unrelated offset) must fail rather than merely differ.
test("keeps a free preferred port", async () => {
  const preferred = await freePort();
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, String(preferred)]);
  assert.equal(Number(stdout.trim()), preferred);
});

test("selects the next bindable port when the preferred port is occupied", async (context) => {
  // Bind a port whose successor is also free, so "skip exactly one" is a
  // deterministic expectation rather than a race with a busy neighbour.
  let occupied;
  let next;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = await freePort();
    const server = createServer();
    try {
      await listen(server, candidate);
    } catch {
      continue;
    }
    const neighbour = createServer();
    try {
      await listen(neighbour, candidate + 1);
    } catch {
      await close(server);
      continue;
    }
    await close(neighbour);
    occupied = server;
    next = candidate + 1;
    context.after(() => close(occupied));
    break;
  }
  assert(occupied, "could not reserve a port with a free successor");

  const { stdout } = await execFileAsync(process.execPath, [scriptPath, String(next - 1)]);
  // Occupied means "skip by one", not "pick any other port".
  assert.equal(Number(stdout.trim()), next);
});

test("skips ports reserved by services that start later", async () => {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "3001"]);
  const selectedPort = Number(stdout.trim());

  // 3001 is reserved for a service that starts after the frontend, so the scan
  // must land on the immediately following port.
  assert.equal(selectedPort, 3002);
});

test("uses only an explicitly configured network hostname", async () => {
  const { stdout } = await execFileAsync(process.execPath, [developmentHostPath], {
    env: { ...process.env, MELTIPLY_DEV_HOST: "workstation.example.test" },
  });
  assert.equal(stdout, "workstation.example.test");
});

test("rejects URL-shaped development hosts", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [developmentHostPath], {
      env: { ...process.env, MELTIPLY_DEV_HOST: "https://example.test/path" },
    }),
    /MELTIPLY_DEV_HOST must be a hostname, not a URL/,
  );
});

test("rejects an invalid preferred port", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "not-a-port"]),
    /preferred port must be an integer between 1024 and 65535/,
  );
});
