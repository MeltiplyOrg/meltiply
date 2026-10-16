import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
// Stable ownership label the launcher stamps on the devcontainer it runs.
// Names and hostnames are not identity: the launcher assigns a branch
// hostname and renames the owner daemon-side, so only this label can
// distinguish this worktree's devcontainer from its siblings.
const projectLabel = "meltiply.devcontainer.project";

/**
 * Publishes an owned devcontainer listener through the daemon host, so native
 * processors on other Docker bridges can reach it without joining private stacks.
 * The owner is resolved by its exact meltiply.devcontainer.project label —
 * never a hostname or name, which the launcher rewrites — and exactly one
 * running match is required, so a missing or duplicated label fails loudly
 * instead of publishing into a sibling. The relay container itself stays
 * unlabeled with the project label (it must not resolve as an owner), but
 * carries the Compose project and wtdc.owner.workspace labels so launcher
 * cleanup owns it with the worktree.
 * Unused inherited DinD volumes are shadowed by bounded tmpfs mounts, avoiding
 * anonymous disk volumes while this read-only relay runs.
 * Takes an already-listening targetPort in the owner's namespace. A private
 * ingress bridge lets Docker publish only the daemon's gateway, including for
 * callers on the owner's default bridge; host listeners would hit INPUT rules.
 * The relay also joins the owner's default bridge for its fixed upstream.
 * Callers must sign the returned host and port. Requires a host-identical path.
 * Returns host, port, attached child and idempotent cleanup; startup failures reject.
 */
export async function startDockerGatewayRelay(targetPort) {
  const project = process.env.COMPOSE_PROJECT_NAME;
  const workspace = process.env.MELTIPLY_DEVCONTAINER_WORKSPACE;
  if (!project || !workspace)
    throw new Error(
      "Devcontainer relay requires COMPOSE_PROJECT_NAME and MELTIPLY_DEVCONTAINER_WORKSPACE",
    );
  const owners = (
    await exec("docker", ["ps", "-q", "--no-trunc", "--filter", `label=${projectLabel}=${project}`])
  ).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  if (owners.length !== 1)
    throw new Error(
      `Expected one running devcontainer labeled ${projectLabel}=${project}, found ${owners.length}`,
    );
  const { stdout } = await exec("docker", [
    "inspect",
    owners[0],
    "--format",
    '{{.Config.Image}} {{(index .NetworkSettings.Networks "bridge").IPAddress}}',
  ]);
  const [imageRef, target] = stdout.trim().split(/\s+/);
  if (!imageRef || !target) throw new Error("Devcontainer bridge address is unavailable");
  const { stdout: gateway } = await exec("docker", [
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  const host = gateway.trim();
  if (!host) throw new Error("Docker daemon bridge gateway is unavailable");
  // A container's config digest is not a runnable image ID on OCI-index stores.
  const { stdout: imageId } = await exec("docker", [
    "image",
    "inspect",
    imageRef,
    "--format",
    "{{.Id}}",
  ]);
  const image = imageId.trim();
  const name = `meltiply-r2-relay-${randomUUID()}`;
  const relayPort = 8787;
  // Reuse worktree ownership labels, never the label used to resolve the owner.
  const labels = [
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    `wtdc.owner.workspace=${workspace}`,
  ];
  await exec("docker", ["network", "create", ...labels, name]);
  const args = [
    "run",
    "--pull",
    "never",
    "--read-only",
    "--tmpfs",
    "/var/lib/docker:size=16m",
    "--tmpfs",
    "/var/lib/containerd:size=16m",
    "--name",
    name,
    "--network",
    name,
    "--publish",
    `${host}::${relayPort}`,
  ];
  args.push(...labels);
  args.push(
    "--mount",
    `type=bind,source=${fileURLToPath(import.meta.url)},target=/relay.mjs,readonly`,
    "--entrypoint",
    "node",
    image,
    "/relay.mjs",
    "0.0.0.0",
    target,
    String(targetPort),
    String(relayPort),
  );
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "inherit"] });
  let closing;
  /** Removes only this session's relay and ingress bridge; shutdown is idempotent. */
  function close() {
    closing ??= (async () => {
      try {
        await exec("docker", ["rm", "--force", "--volumes", name]);
      } finally {
        await exec("docker", ["network", "rm", name]);
      }
    })();
    return closing;
  }
  try {
    await new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Docker R2 relay exited before readiness (${code})`)),
      );
      lines.once("line", (line) => {
        lines.close();
        if (Number(line) !== relayPort) {
          reject(new Error(`Invalid Docker R2 relay listener port: ${line}`));
        } else resolve();
      });
    });
    // Keep publication on the ingress bridge: choosing the default bridge would
    // bypass DNAT for same-bridge callers and hit the host's INPUT firewall.
    await exec("docker", ["network", "connect", "--gw-priority", "-1", "bridge", name]);
    const { stdout: published } = await exec("docker", [
      "inspect",
      name,
      "--format",
      `{{(index (index .NetworkSettings.Ports "${relayPort}/tcp") 0).HostPort}}`,
    ]);
    const port = Number(published.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`Invalid Docker R2 relay published port: ${published.trim()}`);
    return { host, port, child, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/**
 * Streams TCP bytes unchanged to the owning devcontainer's narrow S3 gateway.
 * Listens on the requested container listenPort and prints it once for readiness;
 * Docker separately allocates the published host port. Socket failures close
 * both ends, and signals stop the listener and connections.
 */
function runRelay(host, target, port, listenPort) {
  const sockets = new Set();
  const server = createServer((incoming) => {
    const upstream = createConnection({ host: target, port: Number(port) });
    sockets.add(incoming);
    sockets.add(upstream);
    incoming.on("error", () => upstream.destroy());
    upstream.on("error", () => incoming.destroy());
    incoming.on("close", () => {
      sockets.delete(incoming);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      incoming.destroy();
    });
    incoming.pipe(upstream).pipe(incoming);
  });
  server.listen(Number(listenPort), host, () => console.log(server.address().port));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host, target, port, listenPort] = process.argv.slice(2);
  if (!host || !target || !port || !listenPort)
    throw new Error("Expected relay host, target, target port, and listen port");
  runRelay(host, target, port, listenPort);
}
