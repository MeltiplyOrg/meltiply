import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./quick-tunnel-url.mjs", import.meta.url));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/**
 * Creates a scratch directory that the afterEach hook removes.
 *
 * @returns {string} Absolute path to a fresh temporary directory.
 */
function scratchDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "quick-tunnel-url-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Runs quick-tunnel-url.mjs and captures its outcome.
 *
 * @param {string[]} args Arguments passed to the script.
 * @returns {{status: number, stdout: string, stderr: string}} Process result.
 */
function runScript(args) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
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

/**
 * Runs quick-tunnel-url.mjs asynchronously, for cases that must observe it
 * waiting on a log that is still being written.
 *
 * @param {string[]} args Arguments passed to the script.
 * @returns {Promise<{stdout: string}>} Resolves with the captured origin.
 */
function execFileAsync(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath, ...args], { encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve({ stdout }),
    );
  });
}

describe("quick-tunnel-url", () => {
  it("extracts the published origin from padded connector output", () => {
    const directory = scratchDirectory();
    const log = join(directory, "cloudflared.log");
    writeFileSync(
      log,
      [
        "2026-09-28T16:46:00Z INF Thank you for trying Cloudflare Tunnel.",
        "2026-09-28T16:46:01Z INF Requesting new quick Tunnel on trycloudflare.com...",
        "2026-09-28T16:46:04Z INF +-------------------------------------+",
        "2026-09-28T16:46:04Z INF |  Your quick Tunnel has been created!  |",
        "2026-09-28T16:46:04Z INF |  https://alpha-bravo-charlie.trycloudflare.com   |.",
        "2026-09-28T16:46:04Z INF +-------------------------------------+",
        "",
      ].join("\n"),
    );

    const result = runScript(["--log", log, "--timeout", "5"]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "https://alpha-bravo-charlie.trycloudflare.com\n");
  });

  it("normalizes the origin case emitted by the connector", () => {
    const directory = scratchDirectory();
    const log = join(directory, "cloudflared.log");
    writeFileSync(log, "INF | https://Mixed-Case-Name.trycloudflare.com |\n");

    const result = runScript(["--log", log, "--timeout", "5"]);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "https://mixed-case-name.trycloudflare.com\n");
  });

  it("blocks until the connector publishes an origin after startup", async () => {
    const directory = scratchDirectory();
    const log = join(directory, "cloudflared.log");
    writeFileSync(log, "INF Requesting new quick Tunnel on trycloudflare.com...\n");
    // The connector only prints the hostname seconds after start, so the
    // helper must poll rather than read once and give up.
    setTimeout(() => {
      writeFileSync(log, "INF | https://delayed-tunnel-host.trycloudflare.com |\n", { flag: "a" });
    }, 750);

    const { stdout } = await execFileAsync(["--log", log, "--timeout", "10"]);

    assert.equal(stdout, "https://delayed-tunnel-host.trycloudflare.com\n");
  });

  it("fails with the connector log when the process dies before publishing", () => {
    const directory = scratchDirectory();
    const log = join(directory, "cloudflared.log");
    writeFileSync(log, "ERR failed to request quick Tunnel: connection refused\n");

    // Reap a real process so the liveness probe observes a genuine ESRCH.
    // PID 0 cannot stand in: signalling process group 0 targets the caller's
    // own group and always succeeds.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;

    const result = runScript(["--log", log, "--pid", String(deadPid), "--timeout", "30"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /exited before publishing a quick tunnel URL/);
    assert.match(result.stderr, /connection refused/);
  });

  it("fails on timeout and echoes the captured output", () => {
    const directory = scratchDirectory();
    const log = join(directory, "cloudflared.log");
    writeFileSync(log, "INF Requesting new quick Tunnel on trycloudflare.com...\n");

    const result = runScript(["--log", log, "--timeout", "1"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /published no quick tunnel URL within 1s/);
    assert.match(result.stderr, /Requesting new quick Tunnel/);
  });

  it("treats a missing log file as not-yet-published", () => {
    const directory = scratchDirectory();
    const result = runScript(["--log", join(directory, "absent.log"), "--timeout", "1"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /published no quick tunnel URL/);
    assert.match(result.stderr, /<no connector output captured>/);
  });

  it("rejects a missing --log and unknown flags", () => {
    assert.match(runScript([]).stderr, /--log <path> is required/);
    assert.match(runScript(["--log", "x", "--nope", "y"]).stderr, /unknown option: --nope/);
  });
});
