import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";

import { collectDisciplineFindings } from "./docs-discipline.mjs";

const temporaryRoots = [];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "meltiply-doc-discipline-"));
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

test("flags history instead of current state", () => {
  const root = fixture({
    "guide.md": [
      "> Implementation note (2026-10-19): the owner later changed this.",
      "These supersede the statements below.",
      "Measured on 2026-10-19 with 40 strings.",
      "The shipped branch now keeps the profile selector.",
    ].join("\n"),
  });
  const findings = collectDisciplineFindings(root, ["guide.md"]);
  assert.equal(findings.length, 4, findings.join("\n"));
  assert.match(findings[0], /guide\.md:1: dated implementation note/u);
  assert.match(findings[1], /guide\.md:2: supersession chain/u);
  assert.match(findings[2], /guide\.md:3: dated measurement/u);
  assert.match(findings[3], /guide\.md:4: describes a branch/u);
});

test("accepts current-state prose and ignores code and exempt files", () => {
  const root = fixture({
    "guide.md": [
      "The migration ledger is append-only.",
      "```text",
      "Implementation note (2026-10-19): quoted example inside a fence.",
      "```",
      "Nothing like `Implementation note (2026-10-19)` belongs in prose.",
    ].join("\n"),
    "LICENSE.md": "Implementation note (2026-10-19): legal text is never scanned.",
    "THIRD_PARTY_NOTICES.md": "These supersede the statements below.",
  });
  const findings = collectDisciplineFindings(root, [
    "guide.md",
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
  ]);
  assert.deepEqual(findings, []);
});

test("an info string inside a fence does not close it", () => {
  const root = fixture({
    "guide.md": [
      "```md",
      "Measured on 2026-10-19 inside a fence.",
      "```js",
      "These supersede the statements below.",
      "```",
      "The migration ledger is append-only.",
    ].join("\n"),
  });
  // The nested ```js line carries an info string, so it must not end the block.
  assert.deepEqual(collectDisciplineFindings(root, ["guide.md"]), []);
});

test("a closing fence may be longer than its opener", () => {
  const root = fixture({
    "guide.md": [
      "```",
      "Measured on 2026-10-19.",
      "````",
      "Implementation note (2026-10-19): real finding.",
    ].join("\n"),
  });
  assert.equal(collectDisciplineFindings(root, ["guide.md"]).length, 1);
});

test("double-backtick spans mask their whole content", () => {
  const root = fixture({
    "guide.md": [
      "Inline ``Measured on 2026-10-19`` stays quoted.",
      "Inline ``a `b` These supersede the statements below c`` stays quoted too.",
      "But Measured on 2026-10-19 outside code is a finding.",
    ].join("\n"),
  });
  const findings = collectDisciplineFindings(root, ["guide.md"]);
  assert.equal(findings.length, 1, findings.join("\n"));
  assert.match(findings[0], /guide\.md:3:/u);
});
