#!/usr/bin/env node
// Reads the public origin that `cloudflared` assigns to a Quick Tunnel.
//
// A Quick Tunnel has no configuration file and no API to poll: the connector
// prints the randomly generated `https://<words>.trycloudflare.com` hostname to
// its own stderr a few seconds after start. `make dev` therefore has to turn
// that unstructured log into a value it can export as the canonical frontend
// origin. This helper owns that translation so the dev launcher only deals
// with a URL or a diagnostic.
//
// Usage: quick-tunnel-url.mjs --log <path> [--pid <pid>] [--timeout <seconds>]
import { readFileSync } from "node:fs";

/**
 * Matches the random Quick Tunnel origin inside connector log output. The
 * hostname is always hyphen-separated lowercase words under `trycloudflare.com`,
 * so this deliberately excludes the surrounding box-drawing characters and the
 * trailing punctuation cloudflared pads the line with.
 */
const quickTunnelOrigin = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const pollIntervalMs = 250;
const defaultTimeoutSeconds = 90;
const logTailLines = 20;

/**
 * Parses `--log`, `--pid`, and `--timeout` from argv.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{logPath: string, pid: number|undefined, timeoutSeconds: number}}
 *   Validated options. `pid` is undefined when liveness is not tracked.
 * @throws {Error} On an unknown flag or a missing/invalid value.
 */
function parseArguments(argv) {
  const options = {
    logPath: undefined,
    pid: undefined,
    timeoutSeconds: defaultTimeoutSeconds,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--log":
        options.logPath = value;
        index += 1;
        break;
      case "--pid":
        options.pid = Number(value);
        index += 1;
        break;
      case "--timeout":
        options.timeoutSeconds = Number(value);
        index += 1;
        break;
      default:
        throw new Error(
          `unknown option: ${flag ?? "<empty>"} (expected --log, --pid, or --timeout)`,
        );
    }
  }

  if (!options.logPath) {
    throw new Error("--log <path> is required");
  }
  if (options.pid !== undefined && !Number.isInteger(options.pid)) {
    throw new Error("--pid must be an integer process id");
  }
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 0) {
    throw new Error("--timeout must be a non-negative number of seconds");
  }
  return options;
}

/**
 * Scans connector log output for the first Quick Tunnel origin.
 *
 * A missing log file is an expected state while the connector is still starting
 * up, so it yields `null` rather than throwing; any other read failure is a
 * real error the caller must see.
 *
 * @param {string} logPath Path to the file capturing the connector's output.
 * @returns {string|null} The origin, or null when the log has none yet.
 */
function readQuickTunnelOrigin(logPath) {
  let contents;
  try {
    contents = readFileSync(logPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return quickTunnelOrigin.exec(contents)?.[0].toLowerCase() ?? null;
}

/**
 * Reports whether the supervised connector process is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering a
 * signal. EPERM means the process exists but belongs to another user, which
 * still counts as alive; ESRCH means it is gone.
 *
 * @param {number|undefined} pid Process id to probe, or undefined to skip.
 * @returns {boolean} True when the process is alive or was never supplied.
 */
function isRunning(pid) {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Builds the trailing connector log excerpt shown with a failure.
 *
 * @param {string} logPath Path to the file capturing the connector's output.
 * @returns {string} Newline-separated last lines, or a note when unreadable.
 */
function logTail(logPath) {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-logTailLines)
      .join("\n");
  } catch {
    return "<no connector output captured>";
  }
}

/**
 * Waits for the connector to publish its Quick Tunnel origin.
 *
 * Polls the log because the hostname is only knowable from connector output.
 * Bails out early when the supervised process dies so a broken tunnel reports
 * its own log instead of burning the whole timeout.
 *
 * @param {{logPath: string, pid: number|undefined, timeoutSeconds: number}} options
 *   Parsed CLI options.
 * @returns {Promise<string>} The published origin.
 * @throws {Error} When the connector exits early or the timeout elapses.
 */
async function awaitQuickTunnelOrigin(options) {
  const deadline = Date.now() + options.timeoutSeconds * 1000;

  for (;;) {
    const origin = readQuickTunnelOrigin(options.logPath);
    if (origin) return origin;

    if (!isRunning(options.pid)) {
      throw new Error(
        `cloudflared exited before publishing a quick tunnel URL\n${logTail(options.logPath)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `cloudflared published no quick tunnel URL within ${options.timeoutSeconds}s\n${logTail(options.logPath)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

const options = parseArguments(process.argv.slice(2));
try {
  process.stdout.write(`${await awaitQuickTunnelOrigin(options)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
