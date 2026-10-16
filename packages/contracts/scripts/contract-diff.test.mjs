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

const operation = {
  get: {
    operationId: "getProbe",
    responses: {
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
    },
  },
};
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

try {
  write(base, document({ "/probe": operation }));
  write(compatible, document({ "/probe": operation }));
  write(breaking, document({}));

  const compatibleResult = run(compatible);
  if (compatibleResult.status !== 0) {
    throw new Error(
      `compatible contract was rejected:\n${compatibleResult.stdout}${compatibleResult.stderr}`,
    );
  }

  const breakingResult = run(breaking);
  if (breakingResult.status === 0) {
    throw new Error("removed operation was not reported as a breaking change");
  }

  console.log("contract diff accepts compatibility and rejects a removed operation");
} finally {
  rmSync(directory, { force: true, recursive: true });
}
