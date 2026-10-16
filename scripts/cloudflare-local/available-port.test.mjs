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
