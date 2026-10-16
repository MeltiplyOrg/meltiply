import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertValidHostname,
  branchLabelFrom,
  coverageHostnames,
  hostnameFor,
  tunnelNameFor,
} from "./tunnel-hostname.mjs";

const scriptPath = fileURLToPath(new URL("./tunnel-hostname.mjs", import.meta.url));

afterEach(() => {
  delete process.env.MELTIPLY_TUNNEL_BRANCH;
  delete process.env.MELTIPLY_TUNNEL_DOMAIN;
});

/**
 * Runs the script as a subprocess.
 *
 * @param {string[]} args Arguments passed to the script.
 * @param {object} [env] Extra environment entries.
 * @returns {{status: number, stdout: string, stderr: string}} Process result.
 */
function runScript(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
      env: { ...process.env, MELTIPLY_TUNNEL_DOMAIN: "meltiply.com", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

describe("branchLabelFrom", () => {
  it("lowercases and keeps DNS-safe branch names verbatim", () => {
    assert.equal(branchLabelFrom("dev-tunnel"), "dev-tunnel");
    assert.equal(branchLabelFrom("main"), "main");
  });

  it("replaces every unsafe character with a single hyphen", () => {
    assert.equal(branchLabelFrom("feat/dev_tunnel!"), "feat-dev-tunnel");
    assert.equal(branchLabelFrom("fix//double__underscore"), "fix-double-underscore");
  });

  it("trims leading and trailing hyphens", () => {
    assert.equal(branchLabelFrom("--weird--"), "weird");
    assert.equal(branchLabelFrom("/leading"), "leading");
  });

  it("rejects a branch with no usable characters", () => {
    assert.throws(() => branchLabelFrom("///"), /no DNS-safe characters/);
  });

  it("leaves room for the longest suffix inside a DNS label", () => {
    const label = branchLabelFrom("b".repeat(80));
    // `-public-dev` is the longest suffix that is ever appended.
    assert.ok(label.length <= 40);
    assert.equal(`${label}-public-dev.meltiply.com`.split(".")[0].length <= 63, true);
  });
});

describe("assertValidHostname", () => {
  it("accepts a normal hostname", () => {
    assert.equal(assertValidHostname("dev-tunnel-app.meltiply.com"), "dev-tunnel-app.meltiply.com");
  });

  it("rejects empty labels, over-long labels, and illegal characters", () => {
    assert.throws(() => assertValidHostname("a..b"), /empty label/);
    assert.throws(() => assertValidHostname(`${"a".repeat(64)}.com`), /exceeds 63/);
    assert.throws(() => assertValidHostname("a_b.com"), /not DNS-safe/);
    assert.throws(() => assertValidHostname("-lead.com"), /not DNS-safe/);
  });
});

describe("hostnameFor", () => {
  it("places the dev label in its own DNS label so one wildcard covers it", () => {
    assert.equal(
      hostnameFor({
        branch: "dev-tunnel",
        domain: "meltiply.com",
        kind: "app",
      }),
      "dev-tunnel.meltiply.com",
    );
    assert.equal(
      hostnameFor({
        branch: "dev-tunnel",
        domain: "meltiply.com",
        kind: "public",
      }),
      "dev-tunnel-public.meltiply.com",
    );
  });

  it("matches the literal <branch>-dev.<domain> form in flat style", () => {
    assert.equal(
      hostnameFor({
        branch: "dev-tunnel",
        domain: "meltiply.com",
        kind: "app",
        style: "flat",
      }),
      "dev-tunnel-app.meltiply.com",
    );
    assert.equal(
      hostnameFor({
        branch: "dev-tunnel",
        domain: "meltiply.com",
        kind: "public",
        style: "flat",
      }),
      "dev-tunnel-public.meltiply.com",
    );
  });

  it("keeps every branch hostname under one wildcard label in wildcard style", () => {
    // `*.dev.meltiply.com` must cover both, which requires `dev` to be a label
    // of its own rather than part of the branch label.
    for (const kind of ["app", "public"]) {
      const hostname = hostnameFor({
        branch: "dev-tunnel",
        domain: "meltiply.com",
        kind,
      });
      assert.equal(`*.${hostname.split(".").slice(1).join(".")}`, "*.meltiply.com");
    }
  });

  it("cannot wildcard the flat layout, because `dev` is inside the branch label", () => {
    // This is the constraint that makes `wildcard` the default: Access and
    // cloudflared both refuse wildcards in the middle of a hostname.
    const hostname = hostnameFor({
      branch: "dev-tunnel",
      domain: "meltiply.com",
      kind: "app",
      style: "flat",
    });
    assert.equal(hostname, "dev-tunnel-app.meltiply.com");
    assert.notEqual(hostname.split(".")[0], "dev");
  });

  it("honours a custom dev label", () => {
    assert.equal(
      hostnameFor({
        branch: "main",
        domain: "meltiply.com",
        kind: "app",
        devLabel: "previews",
      }),
      "main.previews.meltiply.com",
    );
  });

  it("keeps the hostname one label deep by default so Universal SSL covers it", () => {
    // Cloudflare's default certificate is `meltiply.com` + `*.meltiply.com`.
    // A hostname two labels deep matches neither and the edge fails the TLS
    // handshake with alert 40, so the default must add no extra label.
    const domain = "meltiply.com";
    const app = hostnameFor({ branch: "dev-tunnel", domain, kind: "app" });
    const extraLabels = app.split(".").length - domain.split(".").length;
    assert.equal(extraLabels, 1, `${app} must be one label above ${domain}`);
  });

  it("rejects an unknown kind and an unknown style", () => {
    assert.throws(
      () => hostnameFor({ branch: "x", domain: "meltiply.com", kind: "api" }),
      /kind must be one of/,
    );
    assert.throws(
      () =>
        hostnameFor({
          branch: "x",
          domain: "meltiply.com",
          kind: "app",
          style: "nested",
        }),
      /style must be one of/,
    );
  });
});

describe("coverageHostnames", () => {
  it("returns explicit hostnames for a per-branch tunnel", () => {
    // A wildcard CNAME has one target, so it can only ever point at a single
    // tunnel. A per-branch tunnel must therefore be reached by explicit records,
    // otherwise the first record created would capture every other branch.
    assert.deepEqual(coverageHostnames({ branch: "dev-tunnel", domain: "meltiply.com" }), [
      "dev-tunnel.meltiply.com",
      "dev-tunnel-public.meltiply.com",
    ]);
  });

  it("returns a single wildcard only in shared mode", () => {
    assert.deepEqual(
      coverageHostnames({
        branch: "dev-tunnel",
        domain: "meltiply.com",
        shared: true,
      }),
      ["*.meltiply.com"],
    );
  });

  it("returns explicit hostnames in shared mode with the flat layout", () => {
    assert.deepEqual(
      coverageHostnames({
        branch: "dev-tunnel",
        domain: "meltiply.com",
        shared: true,
        style: "flat",
      }),
      ["dev-tunnel-app.meltiply.com", "dev-tunnel-public.meltiply.com"],
    );
  });
});

describe("tunnelNameFor", () => {
  it("namespaces the tunnel after the branch", () => {
    assert.equal(tunnelNameFor({ branch: "dev-tunnel" }), "meltiply-dev-dev-tunnel");
  });

  it("sanitizes the branch so the name is always valid", () => {
    assert.equal(
      tunnelNameFor({ branch: "feat/AB 12!", prefix: "meltiply-dev" }),
      "meltiply-dev-feat-ab-12",
    );
  });

  it("honours a custom prefix", () => {
    assert.equal(tunnelNameFor({ branch: "main", prefix: "acme" }), "acme-main");
  });

  it("rejects a branch with no usable characters", () => {
    assert.throws(() => tunnelNameFor({ branch: "///" }), /no DNS-safe characters/);
  });
});

describe("tunnel-hostname CLI", () => {

  it("honours MELTIPLY_TUNNEL_DOMAIN and MELTIPLY_TUNNEL_DEV_LABEL", () => {
    const result = runScript(["--branch", "dev-tunnel"], {
      MELTIPLY_TUNNEL_DOMAIN: "staging.example.test",
      MELTIPLY_TUNNEL_DEV_LABEL: "previews",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "dev-tunnel.previews.staging.example.test\n");
  });

  it("prefers an explicit --branch over the environment", () => {
    const result = runScript(["--branch", "from-flag"], {
      MELTIPLY_TUNNEL_BRANCH: "from-env",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "from-flag.meltiply.com\n");
  });

  it("prints the per-branch tunnel name", () => {
    const result = runScript(["--branch", "dev-tunnel", "--tunnel-name"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "meltiply-dev-dev-tunnel\n");
  });

  it("prints an explicit coverage hostname per branch, never a wildcard", () => {
    const result = runScript(["--branch", "dev-tunnel", "--kind", "app", "--coverage"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "dev-tunnel.meltiply.com\n");
    assert.doesNotMatch(result.stdout, /\*/);
  });

  it("prints the wildcard coverage hostname in shared mode", () => {
    const result = runScript(["--branch", "dev-tunnel", "--kind", "app", "--coverage", "--shared"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "*.meltiply.com\n");
  });


  it("refuses hostname generation without an explicitly configured owned domain", () => {
    const result = runScript(["--branch", "dev-tunnel"], { MELTIPLY_TUNNEL_DOMAIN: "" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  });
  it("rejects an unknown flag and a missing value", () => {
    assert.match(runScript(["--nope", "x"]).stderr, /unknown option: --nope/);
    assert.match(runScript(["--branch"]).stderr, /--branch requires a value/);
  });

  it("fails when the branch cannot be determined and none is supplied", () => {
    // Outside a git checkout, with no override, the script must say how to fix
    // it rather than emit a hostname built from an empty branch.
    let failure;
    try {
      execFileSync("bash", ["-c", `cd /tmp && exec "${process.execPath}" "${scriptPath}"`], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "expected a non-zero exit outside a git checkout");
    assert.equal(failure.status, 1);
    assert.match(failure.stderr.toString(), /could not determine the branch/);
    assert.match(failure.stderr.toString(), /MELTIPLY_TUNNEL_BRANCH/);
  });
});
