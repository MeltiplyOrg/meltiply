import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./contract-diff.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "meltiply-contract-diff-test-"));
const base = join(directory, "base.json");
const current = join(directory, "current.json");
const changelog = join(directory, "CHANGELOG.md");
const baseChangelog = join(directory, "BASE.md");
const operation = {
  get: {
    operationId: "getProbe",
    responses: {
      200: {
        content: {
          "application/json": {
            schema: {
              properties: { status: { type: "string" } },
              required: ["status"],
              type: "object",
            },
          },
        },
        description: "Probe response",
      },
    },
  },
};

/** Writes a standalone OpenAPI fixture for observable CLI compatibility outcomes. */
function document(paths) {
  return JSON.stringify({
    info: { title: "Compatibility probe", version: "1.0.0" },
    openapi: "3.1.0",
    paths,
  });
}

/** Executes the real compatibility CLI and comparator, including its policy input files. */
function run() {
  return spawnSync(
    process.execPath,
    [
      script,
      "--base",
      base,
      "--current",
      current,
      "--changelog",
      changelog,
      "--base-changelog",
      baseChangelog,
    ],
    { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
  );
}

try {
  writeFileSync(base, document({ "/probe": operation }));
  writeFileSync(baseChangelog, "## Unreleased\n\n- **Breaking:** historical unrelated change\n");
  writeFileSync(changelog, "## Unreleased\n\n- **Breaking:** historical unrelated change\n");
  const extra = structuredClone(operation);
  extra.get.operationId = "getExtra";
  writeFileSync(current, document({ "/probe": operation, "/extra": extra }));
  const additive = run();
  assert.equal(additive.status, 0, `${additive.stdout}${additive.stderr}`);

  const removedField = structuredClone(operation);
  delete removedField.get.responses[200].content["application/json"].schema.properties.status;
  removedField.get.responses[200].content["application/json"].schema.required = [];
  writeFileSync(current, document({ "/probe": removedField }));
  const unreviewed = run();
  const diagnostic = `${unreviewed.stdout}${unreviewed.stderr}`;
  assert.equal(unreviewed.status, 1, diagnostic);
  assert.match(diagnostic, /\/probe/);
  assert.match(diagnostic, /status/);
  const token = diagnostic.match(/contract-change:[a-f0-9]{64}/)?.[0];
  assert.ok(token, diagnostic);

  const reviewedChangelog = `## Unreleased\n\n- **Breaking:** [${token}] GET /probe (getProbe) removes response status; regenerate clients.\n`;
  writeFileSync(changelog, reviewedChangelog);
  const reviewed = run();
  assert.equal(reviewed.status, 0, `${reviewed.stdout}${reviewed.stderr}`);

  for (const bullet of [
    `- **Breaking:** [${token}]\n  GET /probe (getProbe) removes response status; regenerate clients.`,
    `- **Breaking:**\n  [${token}] GET /probe (getProbe) removes response status; regenerate clients.`,
  ]) {
    writeFileSync(changelog, `## Unreleased\n\n${bullet}\n`);
    const wrapped = run();
    assert.equal(wrapped.status, 0, `${wrapped.stdout}${wrapped.stderr}`);
  }
  for (const boundary of ["- Another change", "### Other changes"]) {
    writeFileSync(
      changelog,
      `## Unreleased\n\n- **Breaking:** GET /probe removes status.\n${boundary}\n  [${token}] Regenerate clients for this unrelated change.\n`,
    );
    const separated = run();
    assert.equal(separated.status, 1, "review must not cross a bullet or section boundary");
  }
  writeFileSync(changelog, reviewedChangelog);

  writeFileSync(
    baseChangelog,
    `## Unreleased\n\n- **Breaking:** [${token}] Previously reviewed change.\n`,
  );
  assert.equal(run().status, 1, "pre-existing review must not authorize this change");
  writeFileSync(baseChangelog, "## Unreleased\n");
  writeFileSync(current, document({}));
  const different = run();
  assert.equal(different.status, 1, "review must bind the exact base/target contracts");
  assert.match(`${different.stdout}${different.stderr}`, /\/probe/);

  writeFileSync(current, "invalid: [");
  assert.notEqual(run().status, 0, "invalid contracts must fail closed");

  // Diverging branch histories distinguish a PR merge base from the base branch's tip.
  const repository = join(directory, "repository");
  const contracts = join(repository, "packages/contracts");
  mkdirSync(contracts, { recursive: true });
  /** Executes fixture Git operations in an isolated repository and returns their output. */
  const fixtureGit = (...args) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  /** Commits the fixture contract without relying on global Git author configuration. */
  const commit = () => {
    fixtureGit("add", ".");
    fixtureGit(
      "-c",
      "user.name=Contract test",
      "-c",
      "user.email=contract-test@example.test",
      "commit",
      "-m",
      "fixture",
    );
    return fixtureGit("rev-parse", "HEAD");
  };
  const source = join(contracts, "openapi.yaml");
  const notes = join(contracts, "CHANGELOG.md");
  const eventPath = join(directory, "event.json");
  fixtureGit("init", "--quiet");
  writeFileSync(source, document({ "/probe": operation }));
  writeFileSync(notes, "## Unreleased\n");
  const common = commit();
  fixtureGit("tag", "contract-v1.0.0");
  writeFileSync(source, document({ "/probe": operation, "/extra": extra }));
  const baseTip = commit();
  fixtureGit("checkout", "--detach", common);
  const head = fixtureGit("rev-parse", "HEAD");
  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { base: { sha: baseTip }, head: { sha: head } } }),
  );
  /** Invokes CI baseline selection through event metadata, with no mocked comparator or Git calls. */
  const ci = (name, ref = "refs/heads/feature") =>
    spawnSync(process.execPath, [script, "--ci"], {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: name,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REF: ref,
        GITHUB_STEP_SUMMARY: "",
      },
    });
  const mergeBase = ci("pull_request");
  assert.equal(mergeBase.status, 0, `${mergeBase.stdout}${mergeBase.stderr}`);
  assert.match(mergeBase.stdout, new RegExp(`unchanged against ${common}`));
  writeFileSync(source, document({}));
  writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: "master" } }));
  const pushBreak = ci("push", "refs/heads/master");
  assert.equal(pushBreak.status, 1, `${pushBreak.stdout}${pushBreak.stderr}`);
  assert.match(`${pushBreak.stdout}${pushBreak.stderr}`, /\/probe/);
  fixtureGit("tag", "contract-v1.1.0");
  const tagBreak = ci("push", "refs/tags/contract-v1.1.0");
  assert.equal(tagBreak.status, 1, `${tagBreak.stdout}${tagBreak.stderr}`);
  assert.match(`${tagBreak.stdout}${tagBreak.stderr}`, /\/probe/);
  fixtureGit("tag", "-d", "contract-v1.1.0");

  // A PR based on unreleased changes needs both scopes in one breaking entry.
  fixtureGit("checkout", "--detach", "--force", baseTip);
  writeFileSync(source, document({}));
  const breakingHead = commit();
  writeFileSync(eventPath, JSON.stringify({
    pull_request: { base: { sha: baseTip }, head: { sha: breakingHead } },
  }));
  /** Obtains the exact-change review token from the real CLI's rejection diagnostics. */
  const reviewToken = (ref) => {
    const result = spawnSync(process.execPath, [script, "--base", ref], {
      cwd: repository, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
    });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    const value = `${result.stdout}${result.stderr}`.match(/contract-change:[a-f0-9]{64}/)?.[0];
    assert.ok(value);
    return value;
  };
  const mergeToken = reviewToken(baseTip);
  const releaseToken = reviewToken("contract-v1.0.0");
  assert.notEqual(mergeToken, releaseToken);
  writeFileSync(notes, `## Unreleased\n\n- **Breaking:** [${mergeToken}] Remove probe operations; regenerate clients immediately.\n`);
  const mergeOnly = ci("pull_request");
  assert.equal(mergeOnly.status, 1, "PR review must also cover the cumulative release span");
  assert.match(`${mergeOnly.stdout}${mergeOnly.stderr}`, new RegExp(releaseToken));
  writeFileSync(notes, `## Unreleased\n\n- **Breaking:** [${mergeToken}] Remove probe operations; regenerate clients immediately.\n- **Breaking:** [${releaseToken}] Separate release acknowledgement must not waive the PR.\n`);
  assert.equal(ci("pull_request").status, 1, "both tokens must occur in the same breaking entry");
  writeFileSync(notes, `## Unreleased\n\n- **Breaking:** [${mergeToken}]\n  [${releaseToken}] Remove probe operations; regenerate clients immediately.\n`);
  const bothScopes = ci("pull_request");
  assert.equal(bothScopes.status, 0, `${bothScopes.stdout}${bothScopes.stderr}`);
  writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: "master" } }));
  const cumulativePush = ci("push", "refs/heads/master");
  assert.equal(cumulativePush.status, 0, `${cumulativePush.stdout}${cumulativePush.stderr}`);
  fixtureGit("tag", "-d", "contract-v1.0.0");
  const initial = ci("push", "refs/heads/master");
  assert.equal(initial.status, 0, initial.stderr);
  assert.match(initial.stdout, /skipped explicitly/);
  writeFileSync(eventPath, "{}");
  assert.equal(ci("pull_request").status, 2, "missing PR ancestry must fail closed, not skip");
  console.log(
    "Compatibility CLI: additive pass; named field/operation removal rejected; exact fresh review passes; stale/mismatched review and malformed contract rejected.",
  );
} finally {
  rmSync(directory, { force: true, recursive: true });
}
