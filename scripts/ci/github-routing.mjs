import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

/** Runs Git without a shell; unavailable ancestry fails closed to both lanes. */
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Reads the retained canonical fast-lane mapping, rejecting unsupported rules. */
function routingRules() {
  const lines = readFileSync(".circleci/config.yml", "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === "mapping: |");
  if (start === -1) throw new Error("Missing fast-lane path mapping");
  const indent = lines[start].search(/\S/);
  const rules = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (line.search(/\S/) <= indent) break;
    const [pattern, parameter, value, ...extra] = line.trim().split(/\s+/);
    if (extra.length || value !== "true" || !["run-frontend", "run-cloudflare"].includes(parameter)) {
      throw new Error(`Unsupported routing rule: ${line.trim()}`);
    }
    rules.push({ pattern: new RegExp(pattern), lane: parameter.slice(4) });
  }
  if (!rules.length) throw new Error("Empty fast-lane path mapping");
  return rules;
}

/** Resolves PR/branch merge bases or the default-branch push range; missing history runs both lanes. */
function changedPaths(event) {
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") return null;
  try {
    let base;
    let head = "HEAD";
    if (event.pull_request) {
      head = event.pull_request.head.sha;
      base = git("merge-base", event.pull_request.base.sha, head);
    } else if (event.ref === `refs/heads/${event.repository.default_branch}`) {
      base = event.before;
      if (!base || /^0+$/.test(base)) return null;
    } else {
      base = git("merge-base", `origin/${event.repository.default_branch}`, head);
    }
    // Report both sides of renames, including deletions, without whitespace splitting.
    return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head], {
      encoding: "utf8",
    }).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const paths = changedPaths(event);
const rules = routingRules();
const lanes = new Set(paths === null ? ["frontend", "cloudflare"] : []);
for (const path of paths ?? []) {
  for (const rule of rules) if (rule.pattern.test(path)) lanes.add(rule.lane);
  // Workflow/runtime changes must exercise both consumers, including this router.
  if (path.startsWith(".github/") || /^scripts\/ci\/github-routing(?:\.test)?\.mjs$/.test(path)) {
    lanes.add("frontend");
    lanes.add("cloudflare");
  }
}
const output = `frontend=${lanes.has("frontend")}\ncloudflare=${lanes.has("cloudflare")}\n`;
appendFileSync(process.env.GITHUB_OUTPUT, output);
console.log(paths === null ? "Unavailable diff or manual run: checking both lanes." : `Routing ${paths.length} changed paths.`);
console.log(output);
