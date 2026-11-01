import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertValidHostname,
  branchLabelFrom,
  coverageHostnames,
  hostnameFor,
  tunnelNameFor,
} from "./tunnel-hostname.mjs";

const scriptPath = fileURLToPath(new URL("./tunnel-hostname.mjs", import.meta.url));

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
    // `-public-dev` is the longest suffix any layout appends, so the truncated
    // slug plus that suffix must still fit RFC 1035's 63-character label. A
    // longer slug limit would make this hostname fail validation outright.
    const hostname = hostnameFor({
      branch: "b".repeat(80),
      domain: "meltiply.com",
      kind: "public",
      style: "flat",
      devLabel: "dev",
    });
    const [label] = hostname.split(".");
    assert.ok(label.length <= 63, `${label} exceeds a DNS label`);
    assert.ok(label.endsWith("-public-dev"));
    assert.ok(label.length > "b".repeat(20).length, "the branch slug was truncated to nothing");
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

  it("folds the service suffix into the branch label in flat style", () => {
    // A branch name without "dev" in it keeps the expected shapes unambiguous.
    for (const [kind, expected] of [
      ["app", "feature-app.meltiply.com"],
      ["public", "feature-public.meltiply.com"],
    ]) {
      assert.equal(
        hostnameFor({ branch: "feature", domain: "meltiply.com", kind, style: "flat" }),
        expected,
      );
    }
    // A dev label is folded into the same label rather than gaining a level.
    assert.equal(
      hostnameFor({
        branch: "feature",
        domain: "meltiply.com",
        kind: "app",
        style: "flat",
        devLabel: "dev",
      }),
      "feature-app-dev.meltiply.com",
    );
  });

  it("keeps every branch hostname under one wildcard label in wildcard style", () => {
    // One `*.<domain>` record covers both services only when they share the
    // parent domain and differ in the first label; a layout that pushed one
    // service under an extra label would need a second record.
    const domain = "meltiply.com";
    const hostnames = ["app", "public"].map((kind) =>
      hostnameFor({ branch: "feature", domain, kind }),
    );
    assert.deepEqual(hostnames, ["feature.meltiply.com", "feature-public.meltiply.com"]);
    for (const hostname of hostnames) {
      assert.equal(hostname.slice(hostname.indexOf(".") + 1), domain);
    }
    assert.notEqual(
      hostnames[0].split(".")[0],
      hostnames[1].split(".")[0],
      "services must be distinguishable within the wildcard",
    );
  });

  it("cannot wildcard the flat layout, because both services claim label one", () => {
    // In flat style the service suffix sits inside the branch label, so app and
    // public already differ in the first label and no single wildcard covers
    // both. That is what makes `wildcard` the default layout.
    const domain = "meltiply.com";
    const app = hostnameFor({ branch: "feature", domain, kind: "app", style: "flat" });
    const pub = hostnameFor({ branch: "feature", domain, kind: "public", style: "flat" });
    assert.notEqual(app.split(".")[0], pub.split(".")[0]);
    assert.equal(app.split(".").slice(1).join("."), domain);
    assert.equal(pub.split(".").slice(1).join("."), domain);
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
