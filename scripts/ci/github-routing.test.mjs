import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const script = resolve(root, "scripts/ci/github-routing.mjs");
const mapping = readFileSync(resolve(root, ".circleci/config.yml"));

/** Creates an isolated Git history with real routing rules; cleanup never touches the checkout. */
function fixture(t) {
  const dir = mkdtempSync(resolve(tmpdir(), "meltiply-routing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.name", "Routing fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(resolve(dir, ".circleci"));
  writeFileSync(resolve(dir, ".circleci/config.yml"), mapping);
  git("add", ".");
  git("commit", "-qm", "initial");
  const initial = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/master", initial);
  return {
    dir,
    git,
    initial,
    commit(path) {
      mkdirSync(resolve(dir, path, ".."), { recursive: true });
      writeFileSync(resolve(dir, path), "fixture\n");
      git("add", ".");
      git("commit", "-qm", "change");
      return git("rev-parse", "HEAD");
    },
    route(event, name = "push") {
      const eventPath = resolve(dir, "event.json");
      const output = resolve(dir, "output");
      writeFileSync(eventPath, JSON.stringify(event));
      writeFileSync(output, "");
      execFileSync(process.execPath, [script], {
        cwd: dir,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: name,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: output,
        },
      });
      return readFileSync(output, "utf8");
    },
  };
}

/** Supplies the default-branch push range without relying on hosted event fixtures. */
function push(before) {
  return { before, ref: "refs/heads/master", repository: { default_branch: "master" } };
}

test("default-branch pushes select only affected application lanes", (t) => {
  const repo = fixture(t);
  let before = repo.initial;
  for (const [path, expected] of [
    ["docs/example.md", "frontend=false\ncloudflare=false\n"],
    ["frontend/app/example.ts", "frontend=true\ncloudflare=false\n"],
    ["workers/api/example.ts", "frontend=false\ncloudflare=true\n"],
    ["bun.lock", "frontend=true\ncloudflare=true\n"],
    [".github/workflows/example.yml", "frontend=true\ncloudflare=true\n"],
    ["scripts/ci/github-routing.mjs", "frontend=true\ncloudflare=true\n"],
  ]) {
    const head = repo.commit(path);
    assert.equal(repo.route(push(before)), expected, path);
    before = head;
  }
});

test("feature pushes and PRs retain all changes since their merge base", (t) => {
  const repo = fixture(t);
  repo.git("switch", "-qc", "feature");
  repo.commit("frontend/app/example.ts");
  const previous = repo.git("rev-parse", "HEAD");
  const head = repo.commit("docs/example.md");
  assert.equal(
    repo.route({ ...push(previous), ref: "refs/heads/feature" }),
    "frontend=true\ncloudflare=false\n",
  );
  assert.equal(
    repo.route(
      { pull_request: { base: { sha: repo.initial }, head: { sha: head } } },
      "pull_request",
    ),
    "frontend=true\ncloudflare=false\n",
  );
});

test("renames out of a lane and deletions still schedule that lane", (t) => {
  const repo = fixture(t);
  const before = repo.commit("frontend/app/example.ts");
  repo.git("mv", "frontend/app/example.ts", "example.txt");
  repo.git("commit", "-qm", "move");
  assert.equal(repo.route(push(before)), "frontend=true\ncloudflare=false\n");
  const next = repo.commit("workers/api/example.ts");
  repo.git("rm", "workers/api/example.ts");
  repo.git("commit", "-qm", "delete");
  assert.equal(repo.route(push(next)), "frontend=false\ncloudflare=true\n");
});

test("initial pushes, missing ancestry, and manual runs fail closed to both lanes", (t) => {
  const repo = fixture(t);
  for (const before of ["0".repeat(40), "f".repeat(40)]) {
    assert.equal(repo.route(push(before)), "frontend=true\ncloudflare=true\n");
  }
  assert.equal(repo.route({}, "workflow_dispatch"), "frontend=true\ncloudflare=true\n");
});
