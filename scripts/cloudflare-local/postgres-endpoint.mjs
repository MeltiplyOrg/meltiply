import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

const postgresId = execFileSync(
  fileURLToPath(new URL("./compose.sh", import.meta.url)),
  ["ps", "-q", "postgres"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
).trim();
if (!postgresId) throw new Error("Local PostgreSQL must be started before resolving its endpoint");
const [postgres] = JSON.parse(docker(["inspect", postgresId]));
const namespace = postgres;
const postgresPort =
  postgres.Config.Env.find((entry) => entry.startsWith("PGPORT="))?.slice("PGPORT=".length) ||
  "5432";
if (postgres.HostConfig.NetworkMode === "host") {
  process.stdout.write(`127.0.0.1:${postgresPort}`);
} else {
  const localAddresses = new Set(
    Object.values(networkInterfaces()).flatMap((addresses) =>
      (addresses ?? []).filter((address) => !address.internal).map((address) => address.address),
    ),
  );
  const containerIds = docker(["ps", "-q"]).split("\n").filter(Boolean);
  const containers = JSON.parse(docker(["inspect", ...containerIds]));
  const client = containers.find((container) =>
    Object.values(container.NetworkSettings.Networks).some((network) =>
      localAddresses.has(network.IPAddress),
    ),
  );
  if (client?.Id === namespace.Id) {
    process.stdout.write(`127.0.0.1:${postgresPort}`);
  } else if (client) {
    const [networkName, network] = Object.entries(namespace.NetworkSettings.Networks)[0] ?? [];
    if (!network?.IPAddress) throw new Error("Local PostgreSQL has no IPv4 network endpoint");
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
}
