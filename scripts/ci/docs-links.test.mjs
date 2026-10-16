import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";

import { collectLinkFailures, existingMarkdownFiles } from "./docs-links.mjs";

const temporaryRoots = [];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "meltiply-doc-links-"));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("accepts repository files, headings, external URLs, and fenced examples", () => {
  const root = fixture({
    "guide/index.md": [
      "# Guide",
      "[Target](../target.md#named-section)",
      "[External](https://example.com/missing)",
      "```md",
      "[Example only](missing.md)",
      "```",
      "`[Inline example](also-missing.md)`",
    ].join("\n"),
    "target.md": "# Named Section\n",
  });

  assert.deepEqual(collectLinkFailures(root, ["guide/index.md", "target.md"]), {
    failures: [],
    localLinks: 1,
  });
});

test("reports missing files and Markdown headings with source lines", () => {
  const root = fixture({
    "index.md": "[Missing](missing.md)\n[Bad heading](target.md#absent)\n",
    "target.md": "# Present\n",
  });

  assert.deepEqual(collectLinkFailures(root, ["index.md", "target.md"]).failures, [
    "index.md:1: missing.md does not exist",
    "index.md:2: target.md#absent has no matching heading",
  ]);
});

test("rejects a local link that escapes the repository", () => {
  const root = fixture({ "nested/index.md": "[Escape](../../outside.md)\n" });

  assert.deepEqual(collectLinkFailures(root, ["nested/index.md"]).failures, [
    "nested/index.md:1: ../../outside.md escapes the repository",
  ]);
});

test("skips tracked Markdown deleted from the current worktree", () => {
  const root = fixture({ "kept.md": "# Kept\n" });

  assert.deepEqual(existingMarkdownFiles(root, ["kept.md", "deleted.md"]), ["kept.md"]);
});
