#!/usr/bin/env node
// Derives the names a per-branch Cloudflare Tunnel publishes: the tunnel itself,
// the app and public hostnames, and the DNS record(s) each needs.
//
// A named tunnel's names are configured rather than discovered, which is the
// whole point: the dev launcher can set FRONTEND_URL, the Vite allowedHosts
// list, and the API CORS allowlist before the connector even starts.
//
// Each branch gets its own tunnel, named `<prefix>-<branch>`, and its own
// explicit DNS records. That is a correctness requirement, not a preference: a
// wildcard record such as `*.dev.meltiply.com` points at exactly one
// `<UUID>.cfargotunnel.com` target, so two per-branch tunnels could never both
// be reachable through it — the first record created would capture every
// branch. A wildcard only works with a single shared tunnel, which
// `MELTIPLY_TUNNEL_SHARED=1` opts into.
//
// Two hostname layouts are supported:
//
//   wildcard (default)  <branch>.dev.meltiply.com
//                       <branch>-public.dev.meltiply.com
//     Keeps the shared `dev` as its own DNS label, so one Cloudflare Access
//     application on `*.dev.meltiply.com` covers every branch even though each
//     has its own tunnel.
//
//   flat                <branch>-dev.meltiply.com
//                       <branch>-public-dev.meltiply.com
//     The literal `<branch>-dev.<domain>` form. Access would then need a
//     `*.meltiply.com` wildcard, which is broader.
//
// Usage: tunnel-hostname.mjs [--domain D] [--kind app|public] [--branch B]
//                             [--style wildcard|flat] [--dev-label L]
//                             [--coverage] [--shared] [--tunnel-name]
import { execFileSync } from "node:child_process";

/** RFC 1035 label ceiling; a single label cannot exceed it. */
const maximumLabelLength = 63;
/** Hostname kinds this script can derive, in the order a human reads them. */
const kinds = new Set(["app", "public"]);
/**
 * Hostname layouts. `wildcard` keeps the shared label as its own DNS label so a
 * single wildcard record covers every branch; `flat` is the literal
 * `<branch>-dev.<domain>` form and cannot be wildcard-backed.
 */
const styles = new Set(["wildcard", "flat"]);
const defaultDomain = "meltiply.com";
/** Label every dev hostname hangs under, so one wildcard covers them all. */
const defaultDevLabel = "";
/** Namespace prefix for per-branch tunnel names. */
const defaultTunnelNamePrefix = "meltiply-dev";
/** Longest branch slug kept, leaving room for the `-public` suffix. */
const maximumBranchLabelLength = 40;

/**
 * Normalizes a git branch name into a DNS label fragment.
 *
 * Lowercases, replaces every character outside `[a-z0-9-]` with a hyphen,
 * collapses runs of hyphens, and trims the ends. The result is truncated so the
 * longest suffix (`-public-dev`, 11 characters) still fits inside a DNS label.
 *
 * @param {string} branch Raw branch name, e.g. `feat/dev_tunnel!`.
 * @returns {string} A non-empty DNS-safe fragment.
 * @throws {Error} When the branch name contains no usable characters.
 */
export function branchLabelFrom(branch) {
  const normalized = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximumBranchLabelLength)
    .replace(/-+$/g, "");
  if (!normalized) {
    throw new Error(`branch name ${JSON.stringify(branch)} has no DNS-safe characters`);
  }
  return normalized;
}

/**
 * Rejects hostnames that DNS or Cloudflare would refuse later, where the
 * failure would otherwise surface as an opaque tunnel or Access error.
 *
 * @param {string} hostname Candidate hostname.
 * @returns {string} The hostname, unchanged, once valid.
 * @throws {Error} On an empty label, an over-long label, or trailing garbage.
 */
export function assertValidHostname(hostname) {
  if (hostname.length > 253) {
    throw new Error(`hostname exceeds 253 characters: ${hostname}`);
  }
  for (const label of hostname.split(".")) {
    if (!label) throw new Error(`hostname has an empty label: ${hostname}`);
    if (label.length > maximumLabelLength) {
      throw new Error(`hostname label exceeds ${maximumLabelLength} characters: ${label}`);
    }
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new Error(`hostname label is not DNS-safe: ${label}`);
    }
  }
  return hostname;
}

/**
 * Builds the public hostname for one dev service.
 *
 * `wildcard` places the shared dev label in its own DNS position so a single
 * wildcard record covers every branch; `flat` folds it into the branch label to
 * produce the literal `<branch>-dev.<domain>` form at the cost of per-branch
 * DNS records.
 *
 * @param {object} options
 * @param {string} options.branch Branch name to derive the slug from.
 * @param {string} options.domain Registrable domain, e.g. `meltiply.com`.
 * @param {"app"|"public"} options.kind Which service the hostname fronts.
 * @param {"wildcard"|"flat"} [options.style] Hostname layout.
 * @param {string} [options.devLabel] Label the dev hostnames hang under.
 * @returns {string} A validated hostname, e.g. `dev-tunnel.dev.meltiply.com`.
 */
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
  // A blank dev label puts the hostname one label under the zone, which is
  // required for Cloudflare's default Universal SSL certificate: it covers the
  // apex and `*.<zone>` and nothing deeper, so `<branch>.dev.<zone>` would fail
  // the TLS handshake with alert 40 (unrecognized_name) while
  // `<branch>.<zone>` is covered by the same `*.<zone>` certificate.
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
 * Returns the DNS record or ingress hostname that covers a whole branch.
 *
 * A per-branch tunnel must be reached by explicit records: a wildcard record has
 * a single CNAME target, so it can only ever point at one tunnel and the first
 * record created would capture every other branch. In shared-tunnel mode a
 * single wildcard is correct and is also what one Access application matches.
 *
 * @param {object} options Same shape as {@link hostnameFor}, plus `shared`.
 * @returns {string[]} One wildcard in shared mode, else the concrete hostnames.
 */
export function coverageHostnames({
  branch,
  domain,
  style = "wildcard",
  devLabel = defaultDevLabel,
  shared = false,
}) {
  const concrete = () =>
    ["app", "public"].map((kind) => hostnameFor({ branch, domain, kind, style, devLabel }));
  if (shared && style === "wildcard") {
    // A blank dev label collapses the wildcard onto the zone itself, which is
    // the only depth Cloudflare's default Universal SSL certificate covers.
    return [devLabel ? `*.${devLabel}.${domain}` : `*.${domain}`];
  }
  return concrete();
}

/**
 * Builds the Cloudflare Tunnel name for this branch.
 *
 * Cloudflare tunnel names accept letters, digits, hyphens, underscores, and
 * periods. The branch is sanitized exactly as it is for hostnames, so a branch
 * called `feat/x!` still yields a valid, addressable tunnel name.
 *
 * @param {object} options
 * @param {string} options.branch Branch name to derive the slug from.
 * @param {string} [options.prefix] Namespace prefix, e.g. `meltiply-dev`.
 * @returns {string} Tunnel name, e.g. `meltiply-dev-dev-tunnel`.
 */
export function tunnelNameFor({ branch, prefix = defaultTunnelNamePrefix }) {
  const name = `${prefix}-${branchLabelFrom(branch)}`;
  if (name.length > 100) {
    throw new Error(`tunnel name is too long (${name.length} > 100): ${name}`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`tunnel name has unsupported characters: ${name}`);
  }
  return name;
}

/**
 * Reads the checked-out branch name.
 *
 * Prefers an explicit override so the launcher works in environments without
 * git, then falls back to the checked-out ref. Returns an empty string when
 * neither is available, which the caller must handle.
 *
 * @returns {string} Branch name, or "" when it cannot be determined.
 */
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

/**
 * Parses CLI flags, falling back to the environment and then to defaults.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{branch: string, domain: string, devLabel: string, kind: string, style: string}}
 *   Resolved options.
 * @throws {Error} On an unknown flag or a missing flag value.
 */
function parseArguments(argv) {
  const options = {
    branch: currentBranch(),
    domain: process.env.MELTIPLY_TUNNEL_DOMAIN?.trim() || defaultDomain,
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
    // coverageHostnames returns every service hostname in per-branch mode and a
    // single wildcard in shared mode; --kind selects one of them.
    const printed = options.tunnelName
      ? tunnelNameFor(options)
      : options.coverage
        ? // Shared mode returns one wildcard covering every service, so a kind
          // whose index is out of range still maps onto that wildcard.
          (coverageHostnames(options)[["app", "public"].indexOf(options.kind)] ??
          coverageHostnames(options)[0])
        : hostnameFor(options);
    process.stdout.write(`${printed}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
