import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { preparePullRequest } from "./pr-body.mjs";

/**
 * Report unusable CLI input separately from content/quality failures.
 * The exitCode marks usage and file/JSON-read errors as 2 without publishing.
 */
function inputError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

/**
 * Read a JSON document from a file or explicit stdin (-), preserving content.
 * JSON parse/read failures are input errors; schema validation happens later.
 */
async function readInput(path) {
  try {
    let text;
    if (path === "-") {
      text = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) text += chunk;
    } else {
      text = await readFile(path, "utf8");
    }
    return JSON.parse(text);
  } catch (error) {
    throw inputError(`Cannot read PR JSON from ${path}: ${error.message}`);
  }
}

/**
 * Extract the guard-only JSON option and keep ordinary gh creation flags intact.
 * Title/body generation has one source: JSON. Conflicting body/title, automatic
 * filling, templates, recovery and interactive editor flags are rejected before
 * validation or GitHub access. Exactly one file or stdin JSON input is required.
 */
function creationOptions(args) {
  let path;
  const ghArgs = [];
  const blocked =
    /^(?:--(?:body|body-file|title|fill|fill-first|fill-verbose|template|recover|editor|web)(?:=|$)|-[dh]*[bfFtTwe](?:.|$))/;
  const valueFlags = new Set([
    "--base",
    "-B",
    "--head",
    "-H",
    "--label",
    "-l",
    "--reviewer",
    "-r",
    "--assignee",
    "-a",
    "--milestone",
    "-m",
    "--project",
    "-p",
    "--repo",
    "-R",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--body-json" || arg.startsWith("--body-json=")) {
      if (path !== undefined) throw inputError("Supply --body-json exactly once.");
      path = arg === "--body-json" ? args[++index] : arg.slice("--body-json=".length);
      if (!path || (path !== "-" && path.startsWith("-"))) {
        throw inputError("--body-json requires a JSON file path or - for stdin.");
      }
    } else {
      if (blocked.test(arg) || arg === "--") {
        throw inputError(`${arg} conflicts with JSON-first PR creation; use --body-json <file>.`);
      }
      ghArgs.push(arg);
      if (valueFlags.has(arg)) {
        const value = args[++index];
        if (!value || value.startsWith("-")) {
          throw inputError(`${arg} requires a value.`);
        }
        ghArgs.push(value);
      } else if (!arg.startsWith("-")) {
        throw inputError(`Unexpected creation argument: ${arg}`);
      }
    }
  }
  if (path === undefined)
    throw inputError(
      "PR creation requires --body-json <file>; Markdown/interactive creation is blocked.",
    );
  return { path, ghArgs };
}

/**
 * Run check/render locally, or perform the guard-only create handoff.
 * Creation passes the checked in-memory body on stdin (no editable intermediate
 * file) and the JSON title as argv. All checks finish before spawning real gh;
 * its stdout/stderr and exit status are preserved without retries or auto-merge.
 */
async function main(args) {
  const [command, ...options] = args;
  if (command === "check" || command === "render") {
    if (options.length !== 1) throw inputError("Usage: pr.mjs check|render <json-file>|-");
    const { body } = await preparePullRequest(await readInput(options[0]));
    process.stdout.write(
      command === "render" ? body : "PR JSON passed schema, diagram, format, and typo checks.\n",
    );
    return;
  }
  if (command === "create") {
    const [realGh, ...creationArgs] = options;
    if (!realGh) throw inputError("The gh guard must supply the real gh executable.");
    const { path, ghArgs } = creationOptions(creationArgs);
    const { title, body } = await preparePullRequest(await readInput(path));
    const result = spawnSync(
      realGh,
      ["pr", "create", ...ghArgs, "--title", title, "--body-file", "-"],
      {
        input: body,
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`gh terminated with ${result.signal}.`);
    process.exitCode = result.status;
    return;
  }
  throw inputError("Usage: pr.mjs check|render <json-file>|-");
}

// CLI errors retain their usage/content distinction; none can trigger a gh call.
try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`pr-gate: ${error.message}`);
  process.exitCode = error.exitCode ?? 1;
}
