import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

/** Runs local Docker metadata commands without mixing status messages into output. */
function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

// Use the same project and devcontainer overlay as database.sh, never a second
// Compose configuration that could select a different stack.
const postgresId = execFileSync(
  fileURLToPath(new URL("./compose.sh", import.meta.url)),
  ["ps", "-q", "postgres"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
).trim();
if (!postgresId) throw new Error("Local PostgreSQL must be started before resolving its endpoint");
const [postgres] = JSON.parse(docker(["inspect", postgresId]));
// A container sharing another container's namespace has no network endpoints of
// its own. Resolve that owner before comparing caller addresses or joining a
// bridge. PGPORT is 5433 in the devcontainer overlay and defaults to 5432.
const networkMode = postgres.HostConfig.NetworkMode;
const namespace = networkMode.startsWith("container:")
  ? JSON.parse(docker(["inspect", networkMode.slice("container:".length)]))[0]
  : postgres;
const postgresPort =
  postgres.Config.Env.find((entry) => entry.startsWith("PGPORT="))?.slice("PGPORT=".length) ||
  "5432";
const localAddresses = new Set(
  Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).filter((address) => !address.internal).map((address) => address.address),
  ),
);
const containerIds = docker(["ps", "-q"]).split("\n").filter(Boolean);
const containers = JSON.parse(docker(["inspect", ...containerIds]));
// Matching a local interface to Docker's assigned container addresses identifies
// the client namespace without assuming a hostname, container name, or Docker host.
const client = containers.find((container) =>
  Object.values(container.NetworkSettings.Networks).some((network) =>
    localAddresses.has(network.IPAddress),
  ),
);
if (client?.Id === namespace.Id) {
  // The caller and PostgreSQL already share loopback; no network mutation or
  // daemon-host port publication is needed.
  process.stdout.write(`127.0.0.1:${postgresPort}`);
} else if (client) {
  const [networkName, network] = Object.entries(namespace.NetworkSettings.Networks)[0] ?? [];
  if (!network?.IPAddress) throw new Error("Local PostgreSQL has no IPv4 network endpoint");
  // Docker isolates bridge networks. Join only this checkout's DB network; the
  // existing loopback port publication stays private and no container is restarted.
  if (!client.NetworkSettings.Networks[networkName]) {
    docker(["network", "connect", networkName, client.Id]);
  }
  process.stdout.write(`${network.IPAddress}:${postgresPort}`);
} else {
  const published = namespace.NetworkSettings.Ports[`${postgresPort}/tcp`]?.find(
    (port) => port.HostIp === "127.0.0.1",
  );
  if (!published) throw new Error("Local PostgreSQL has no loopback port publication");
  process.stdout.write(`127.0.0.1:${published.HostPort}`);
}
