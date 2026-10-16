import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

/** Runs Git without a shell; unavailable ancestry fails closed to both lanes. */
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Loads public CI path rules; invalid or incomplete lane configuration fails the routing job. */
function routingRules() {
  const mapping = JSON.parse(readFileSync("scripts/ci/github-paths.json", "utf8"));
  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    Object.keys(mapping).sort().join(",") !== "cloudflare,frontend"
  ) {
    throw new Error("Expected frontend and cloudflare path rules");
  }
  return Object.entries(mapping).flatMap(([lane, patterns]) => {
    if (
      !Array.isArray(patterns) ||
      !patterns.length ||
      patterns.some((pattern) => typeof pattern !== "string" || !pattern.startsWith("^"))
    ) {
      throw new Error(`Invalid ${lane} path rules`);
    }
    return patterns.map((pattern) => ({ pattern: new RegExp(pattern), lane }));
  });
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
    })
      .split("\0")
      .filter(Boolean);
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
}
const output = `frontend=${lanes.has("frontend")}\ncloudflare=${lanes.has("cloudflare")}\n`;
appendFileSync(process.env.GITHUB_OUTPUT, output);
console.log(
  paths === null
    ? "Unavailable diff or manual run: checking both lanes."
    : `Routing ${paths.length} changed paths.`,
);
console.log(output);
