#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const loopbackHost = "127.0.0.1";
const circleCi = process.env.CIRCLECI?.trim().toLowerCase();

if (circleCi === "true") {
  process.stdout.write(loopbackHost);
  process.exit(0);
}

try {
  const status = JSON.parse(
    process.argv[2] ??
      execFileSync("tailscale", ["status", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
  );
  const dnsName = status?.Self?.DNSName?.replace(/\.$/, "");
  if (
    status?.BackendState === "Running" &&
    status?.Self?.Online === true &&
    typeof dnsName === "string" &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      dnsName,
    )
  ) {
    process.stdout.write(dnsName);
    process.exit(0);
  }
} catch {
  // Tailscale is optional; local development remains available on loopback.
}

process.stdout.write(loopbackHost);
