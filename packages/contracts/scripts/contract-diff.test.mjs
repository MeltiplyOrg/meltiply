import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./contract-diff.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "meltiply-contract-diff-test-"));
const base = join(directory, "base.json");
const compatible = join(directory, "compatible.json");
const breaking = join(directory, "breaking.json");

const jsonResponse = {
  200: {
    content: {
      "application/json": {
        schema: {
          additionalProperties: false,
          properties: { status: { type: "string" } },
          required: ["status"],
          type: "object",
        },
      },
    },
    description: "Probe response",
  },
};
const operation = (operationId) => ({
  get: { operationId, responses: jsonResponse },
});
const document = (paths) => ({
  info: { title: "Compatibility probe", version: "1.0.0" },
  openapi: "3.1.0",
  paths,
});

function write(path, contents) {
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`);
}

function run(current) {
  return spawnSync(process.execPath, [script, "--base", base, "--current", current], {
    encoding: "utf8",
  });
}

/**
 * Fails when the diff could not execute the comparison at all. The wrapper
 * prints this prefix when `go`/`oasdiff` is missing, which also exits non-zero
 * and would otherwise satisfy the breaking-change assertion for the wrong
 * reason.
 */
function assertDiffRan(result, label) {
  const output = `${result.stdout}${result.stderr}`;
  if (result.error || /unable to run /u.test(output)) {
    throw new Error(
      `${label}: contract diff could not run oasdiff:\n${output}${result.error ?? ""}`,
    );
  }
  return output;
}

try {
  write(base, document({ "/probe": operation("getProbe") }));
  // A genuinely additive change: one new endpoint. Comparing a byte-identical
  // copy would only prove that the wrapper propagates a zero exit status.
  write(
    compatible,
    document({
      "/probe": operation("getProbe"),
      "/probe-extra": operation("getProbeExtra"),
    }),
  );
  write(breaking, document({}));

  const compatibleResult = run(compatible);
  const compatibleOutput = assertDiffRan(compatibleResult, "compatible");
  if (compatibleResult.status !== 0) {
    throw new Error(`compatible contract was rejected:\n${compatibleOutput}`);
  }

  const breakingResult = run(breaking);
  assertDiffRan(breakingResult, "breaking");
  if (breakingResult.status === 0) {
    throw new Error(
      `removed operation was not reported as a breaking change:\n${breakingResult.stdout}${breakingResult.stderr}`,
    );
  }

  console.log("contract diff accepts an additive change and rejects a removed operation");
} finally {
  rmSync(directory, { force: true, recursive: true });
}
