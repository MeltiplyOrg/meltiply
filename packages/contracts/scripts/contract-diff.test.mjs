import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  return JSON.stringify({ info: { title: "Compatibility probe", version: "1.0.0" }, openapi: "3.1.0", paths });
}

/** Executes the real compatibility CLI and comparator, including its policy input files. */
function run() {
  return spawnSync(process.execPath, [script, "--base", base, "--current", current, "--changelog", changelog, "--base-changelog", baseChangelog], { encoding: "utf8" });
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

  writeFileSync(changelog, `## Unreleased\n\n- **Breaking:** [${token}] GET /probe (getProbe) removes response status; regenerate clients.\n`);
  const reviewed = run();
  assert.equal(reviewed.status, 0, `${reviewed.stdout}${reviewed.stderr}`);

  writeFileSync(baseChangelog, `## Unreleased\n\n- **Breaking:** [${token}] Previously reviewed change.\n`);
  assert.equal(run().status, 1, "pre-existing review must not authorize this change");
  writeFileSync(baseChangelog, "## Unreleased\n");
  writeFileSync(current, document({}));
  const different = run();
  assert.equal(different.status, 1, "review must bind the exact base/target contracts");
  assert.match(`${different.stdout}${different.stderr}`, /\/probe/);

  writeFileSync(current, "invalid: [");
  assert.notEqual(run().status, 0, "invalid contracts must fail closed");
  console.log("Compatibility CLI: additive pass; named field/operation removal rejected; exact fresh review passes; stale/mismatched review and malformed contract rejected.");
} finally {
  rmSync(directory, { force: true, recursive: true });
}
