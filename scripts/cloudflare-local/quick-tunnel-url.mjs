#!/usr/bin/env node
import { readFileSync } from "node:fs";

const quickTunnelOrigin = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const pollIntervalMs = 250;
const defaultTimeoutSeconds = 90;
const logTailLines = 20;

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

function isRunning(pid) {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

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
