import { spawn } from "node:child_process";

/**
 * Executes a subprocess boundary command without invoking a system shell (`shell: false`).
 * Opens a piped stdin stream only when input is explicitly supplied via `options.stdin`
 * (otherwise leaving it ignored to prevent hanging), buffers stdout and stderr asynchronously,
 * and rejects with aggregated diagnostic output if the process exits with a non-zero status.
 *
 * @param {string} command - Command executable name or path
 * @param {Array<string>} args - Argument list
 * @param {object} [options={}] - Execution options
 * @param {string} [options.cwd] - Working directory for the subprocess
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment variables
 * @param {string | Buffer} [options.stdin] - Optional input data to write to standard input
 * @returns {Promise<{ code: number, stderr: string, stdout: string }>} Process exit status and standard streams
 * @throws {Error} If process spawning fails or exits with a non-zero code or termination signal
 */
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
