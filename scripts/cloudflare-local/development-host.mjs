#!/usr/bin/env node

// Bind locally unless the operator explicitly opts into a network hostname.
// Reject URL syntax and shell metacharacters before callers form origins from it.
const host = process.env.MELTIPLY_DEV_HOST?.trim() || "127.0.0.1";
if (
  host !== "127.0.0.1" &&
  host !== "localhost" &&
  !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)
) {
  throw new Error("MELTIPLY_DEV_HOST must be a hostname, not a URL");
}
process.stdout.write(host);
