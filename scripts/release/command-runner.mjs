import { spawn } from "node:child_process";

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const hasStdin = options.stdin !== undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => reject(new Error(`${command} could not start: ${error.message}`)));
    child.on("close", (code, signal) => {
      const result = {
        code: code ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (code !== 0) {
        const detail =
          result.stderr.trim() || result.stdout.trim() || `signal ${signal ?? "unknown"}`;
        reject(new Error(`${command} failed (${code ?? signal}): ${detail}`));
        return;
      }
      resolve(result);
    });
    if (hasStdin) child.stdin.end(options.stdin);
  });
}
