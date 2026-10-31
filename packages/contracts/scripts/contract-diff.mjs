import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import YAML from "yaml";

import { breakingReviewToken, contractDigest, git, latestContractTag } from "./contract-source.mjs";

/** Reports compatibility impact in logs and the existing CI job summary for PR reviewers. */
function report(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Contract compatibility\n\n${message}\n\n`);
  }
}

/** Reads an explicit option without treating a missing argument as a usable ref/path. */
function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/** Selects the diff base and, for PRs, the latest release reachable from the target branch. */
function ciBase() {
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
    : undefined;
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    if (!event?.pull_request?.base?.sha || !event?.pull_request?.head?.sha) {
      throw new Error("pull_request event is missing base/head commits");
    }
    return {
      base: git("merge-base", event.pull_request.base.sha, event.pull_request.head.sha),
      releaseBase: latestContractTag(event.pull_request.base.sha),
    };
  }
  if (
    process.env.GITHUB_EVENT_NAME === "push" &&
    process.env.GITHUB_REF === `refs/heads/${event?.repository?.default_branch}`
  ) {
    return { base: latestContractTag() };
  }
  if (
    process.env.GITHUB_EVENT_NAME === "push" &&
    process.env.GITHUB_REF?.startsWith("refs/tags/contract-v")
  ) {
    return { base: latestContractTag("HEAD", process.env.GITHUB_REF.slice("refs/tags/".length)) };
  }
  return {};
}

/** Compares contracts; a fresh breaking bullet must cover both the PR diff and cumulative release span. */
function main() {
  const ci = process.argv.includes("--ci");
  const explicitBase = option("--base");
  const { base, releaseBase } = explicitBase ? { base: explicitBase } : ci ? ciBase() : {};
  if (!base) {
    if (ci) {
      report(
        "Contract compatibility: skipped explicitly; no PR merge base or previous default-branch contract release is available.",
      );
      return 0;
    }
    throw new Error(
      "usage: bun run contract:diff --base <git-ref-or-openapi-file> [--current <file>] | --ci",
    );
  }
  const current = resolve(option("--current") ?? "packages/contracts/openapi.yaml");
  const baseIsFile = existsSync(base);
  const baseText = baseIsFile
    ? readFileSync(base, "utf8")
    : git("show", `${base}:packages/contracts/openapi.yaml`);
  const before = YAML.parse(baseText);
  const after = YAML.parse(readFileSync(current, "utf8"));
  if (!before?.paths || !after?.paths || !before?.info || !after?.info)
    throw new Error("Both contracts must be OpenAPI documents");
  if (contractDigest(before) === contractDigest(after)) {
    report(`Contract compatibility: unchanged against ${base}.`);
    return 0;
  }
  const directory = mkdtempSync(join(tmpdir(), "meltiply-contract-diff-"));
  try {
    const baseFile = join(directory, "base.yaml");
    writeFileSync(baseFile, baseText);
    const binary = process.env.OASDIFF_BIN;
    const args = ["breaking", "--fail-on", "ERR", "--format", "text", baseFile, current];
    const result = spawnSync(
      binary ?? "go",
      binary ? args : ["run", "github.com/oasdiff/oasdiff@v1.17.0", ...args],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (process.env.GITHUB_STEP_SUMMARY && (result.stdout || result.stderr)) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n\`\`\`text\n${`${result.stdout}${result.stderr}`.slice(0, 64_000)}\n\`\`\`\n`,
      );
    }
    if (result.error) throw result.error;
    if (result.status === 0) {
      report(`Contract compatibility: no breaking changes against ${base}.`);
      return 0;
    }
    // oasdiff exits 1 for breaking ERR findings; parser/tool errors cannot be waived.
    if (result.status !== 1 || !result.stdout.trim())
      throw new Error(`oasdiff failed (${result.status})`);
    const token = breakingReviewToken(before, after);
    const tokens = [token];
    if (releaseBase) {
      const released = YAML.parse(git("show", `${releaseBase}:packages/contracts/openapi.yaml`));
      const cumulativeToken = breakingReviewToken(released, after);
      if (cumulativeToken !== token) tokens.push(cumulativeToken);
    }
    const changelog = readFileSync(
      resolve(option("--changelog") ?? "packages/contracts/CHANGELOG.md"),
      "utf8",
    );
    const baseChangelogFile = option("--base-changelog");
    const previous = baseChangelogFile
      ? readFileSync(baseChangelogFile, "utf8")
      : baseIsFile
        ? ""
        : git("show", `${base}:packages/contracts/CHANGELOG.md`);
    const eligible = changelog
      .split(/^## /m)
      .filter(
        (section) =>
          section.startsWith("Unreleased\n") || section.startsWith(`${after.info.version} - `),
      )
      .join("\n## ");
    const acknowledged = (eligible.match(/^- .*(?:\n(?!- |#{1,6}(?:[ \t]|$)).+)*/gm) ?? [])
      .map((entry) => entry.replace(/\n\s*/g, " "))
      .some(
        (bullet) =>
          bullet.startsWith("- **Breaking:** ") &&
          tokens.every((required) => bullet.includes(`[${required}]`)) &&
          tokens.reduce((description, required) => description.replaceAll(`[${required}]`, ""), bullet)
            .length > 40,
      );
    if (acknowledged && !previous.includes(token)) {
      report(
        `Contract compatibility: intentional breaking change reviewed in CHANGELOG.md ${tokens.map((required) => `[${required}]`).join(" ")}.`,
      );
      return 0;
    }
    report(
      `Unreviewed breaking change. Add one NEW Unreleased entry describing affected operations/fields, migration and deprecation policy, with every token in the same bullet:\n- **Breaking:** ${tokens.map((required) => `[${required}]`).join(" ")} <change and client migration>`,
    );
    return 1;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
