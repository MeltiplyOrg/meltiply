#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const unsafeLabelCharactersPattern = /[^a-z0-9-]+/g;
const repeatedHyphensPattern = /-+/g;
const edgeHyphensPattern = /^-+|-+$/g;
const trailingHyphensPattern = /-+$/g;
const hostnamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const tunnelNamePattern = /^[a-zA-Z0-9._-]+$/;

/** RFC 1035 label length limit. */
const maximumLabelLength = 63;
const kinds = new Set(["app", "public"]);
const styles = new Set(["wildcard", "flat"]);
const defaultDevLabel = "";
const defaultTunnelNamePrefix = "meltiply-dev";
const maximumBranchLabelLength = 40;

export function branchLabelFrom(branch) {
  const normalized = branch
    .toLowerCase()
    .replace(unsafeLabelCharactersPattern, "-")
    .replace(repeatedHyphensPattern, "-")
    .replace(edgeHyphensPattern, "")
    .slice(0, maximumBranchLabelLength)
    .replace(trailingHyphensPattern, "");
  if (!normalized) {
    throw new Error(`branch name ${JSON.stringify(branch)} has no DNS-safe characters`);
  }
  return normalized;
}

export function assertValidHostname(hostname) {
  if (hostname.length > 253) {
    throw new Error(`hostname exceeds 253 characters: ${hostname}`);
  }
  for (const label of hostname.split(".")) {
    if (!label) throw new Error(`hostname has an empty label: ${hostname}`);
    if (label.length > maximumLabelLength) {
      throw new Error(`hostname label exceeds ${maximumLabelLength} characters: ${label}`);
    }
    if (!hostnamePattern.test(label)) {
      throw new Error(`hostname label is not DNS-safe: ${label}`);
    }
  }
  return hostname;
}

export function hostnameFor({
  branch,
  domain,
  kind,
  style = "wildcard",
  devLabel = defaultDevLabel,
}) {
  if (!kinds.has(kind)) {
    throw new Error(`kind must be one of ${[...kinds].join(", ")}, got ${kind}`);
  }
  if (!styles.has(style)) {
    throw new Error(`style must be one of ${[...styles].join(", ")}, got ${style}`);
  }
  const slug = branchLabelFrom(branch);
  // Cloudflare's default Universal SSL certificate covers the apex and `*.<zone>`
  // only; a deeper hostname fails the TLS handshake with alert 40.
  const suffix = devLabel ? `.${devLabel}` : "";
  if (style === "wildcard") {
    const service = kind === "app" ? slug : `${slug}-${kind}`;
    return assertValidHostname(`${service}${suffix}.${domain}`);
  }
  const flat = kind === "app" ? "app" : kind;
  return assertValidHostname(
    devLabel ? `${slug}-${flat}-${devLabel}.${domain}` : `${slug}-${flat}.${domain}`,
  );
}

/**
 * A wildcard DNS record has one CNAME target, so it can reach only one tunnel;
 * per-branch tunnels need explicit records.
 */
export function coverageHostnames({
  branch,
  domain,
  kind,
  style = "wildcard",
  devLabel = defaultDevLabel,
  shared = false,
}) {
  if (!styles.has(style)) {
    throw new Error(`style must be one of ${[...styles].join(", ")}, got ${style}`);
  }
  if (kind !== undefined && !kinds.has(kind)) {
    throw new Error(`kind must be one of ${[...kinds].join(", ")}, got ${kind}`);
  }
  const concrete = () =>
    ["app", "public"].map((serviceKind) =>
      hostnameFor({ branch, domain, kind: serviceKind, style, devLabel }),
    );
  if (shared && style === "wildcard") {
    return [devLabel ? `*.${devLabel}.${domain}` : `*.${domain}`];
  }
  return concrete();
}

/** Cloudflare tunnel names accept letters, digits, hyphens, underscores, and periods. */
export function tunnelNameFor({ branch, prefix = defaultTunnelNamePrefix }) {
  const name = `${prefix}-${branchLabelFrom(branch)}`;
  if (name.length > 100) {
    throw new Error(`tunnel name is too long (${name.length} > 100): ${name}`);
  }
  if (!tunnelNamePattern.test(name)) {
    throw new Error(`tunnel name has unsupported characters: ${name}`);
  }
  return name;
}

function currentBranch() {
  const override = process.env.MELTIPLY_TUNNEL_BRANCH?.trim();
  if (override) return override;
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function parseArguments(argv) {
  const options = {
    branch: currentBranch(),
    domain: process.env.MELTIPLY_TUNNEL_DOMAIN?.trim() || "",
    devLabel: process.env.MELTIPLY_TUNNEL_DEV_LABEL?.trim() || defaultDevLabel,
    kind: "app",
    style: process.env.MELTIPLY_TUNNEL_HOST_STYLE?.trim() || "wildcard",
    shared: process.env.MELTIPLY_TUNNEL_SHARED === "1",
    prefix: process.env.MELTIPLY_TUNNEL_NAME_PREFIX?.trim() || defaultTunnelNamePrefix,
    coverage: false,
    tunnelName: false,
  };
  const flags = {
    "--branch": "branch",
    "--dev-label": "devLabel",
    "--domain": "domain",
    "--kind": "kind",
    "--prefix": "prefix",
    "--style": "style",
  };
  const booleanFlags = new Set(["--coverage", "--shared", "--tunnel-name"]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleanFlags.has(flag)) {
      if (flag === "--coverage") options.coverage = true;
      else if (flag === "--shared") options.shared = true;
      else options.tunnelName = true;
      continue;
    }
    const key = flags[flag];
    if (!key) {
      throw new Error(`unknown option: ${flag ?? "<empty>"}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    options[key] = value.trim();
    index += 1;
  }
  return options;
}

if (process.argv[1] === import.meta.filename) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (!options.branch) {
      throw new Error(
        "could not determine the branch; set MELTIPLY_TUNNEL_BRANCH or pass --branch",
      );
    }
    if (!options.tunnelName && !options.domain) {
      throw new Error("Set MELTIPLY_TUNNEL_DOMAIN or --domain to a domain you own.");
    }
    const printed = options.tunnelName
      ? tunnelNameFor(options)
      : options.coverage
        ? (coverageHostnames(options)[["app", "public"].indexOf(options.kind)] ??
          coverageHostnames(options)[0])
        : hostnameFor(options);
    process.stdout.write(`${printed}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
