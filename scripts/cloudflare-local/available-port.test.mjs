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

test("selects another bindable port when the preferred port is occupied", async (context) => {
  const occupiedServer = createServer();
  await listen(occupiedServer);
  context.after(() => close(occupiedServer));

  const address = occupiedServer.address();
  assert(address && typeof address === "object");

  const { stdout } = await execFileAsync(process.execPath, [scriptPath, String(address.port)]);
  const selectedPort = Number(stdout.trim());

  assert(Number.isInteger(selectedPort));
  assert.notEqual(selectedPort, address.port);

  const selectedServer = createServer();
  await listen(selectedServer, selectedPort);
  await close(selectedServer);
});

test("skips ports reserved by services that start later", async () => {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "3001"]);
  const selectedPort = Number(stdout.trim());

  assert.notEqual(selectedPort, 3001);

  const selectedServer = createServer();
  await listen(selectedServer, selectedPort);
  await close(selectedServer);
});

test("prefers the online Tailscale FQDN outside CircleCI", async () => {
  const status = JSON.stringify({
    BackendState: "Running",
    Self: {
      DNSName: "oracle-worker-1.tailc861a9.ts.net.",
      HostName: "oracle-worker-1",
      Online: true,
    },
  });
  const { stdout } = await execFileAsync(process.execPath, [developmentHostPath, status], {
    env: { ...process.env, CI: "true", CIRCLECI: "false" },
  });

  assert.equal(stdout, "oracle-worker-1.tailc861a9.ts.net");
});

test("uses loopback in CircleCI even when Tailscale is online", async () => {
  const status = JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "oracle-worker-1.tailc861a9.ts.net.", Online: true },
  });
  const { stdout } = await execFileAsync(process.execPath, [developmentHostPath, status], {
    env: { ...process.env, CIRCLECI: "true" },
  });

  assert.equal(stdout, "127.0.0.1");
});

test("uses loopback when Tailscale is unavailable", async () => {
  const { stdout } = await execFileAsync(process.execPath, [developmentHostPath, "{}"], {
    env: { ...process.env, CIRCLECI: "false" },
  });

  assert.equal(stdout, "127.0.0.1");
});

test("rejects an invalid preferred port", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "not-a-port"]),
    /preferred port must be an integer between 1024 and 65535/,
  );
});
