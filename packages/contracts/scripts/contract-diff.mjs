import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
const currentIndex = args.indexOf("--current");
const currentArgument = currentIndex >= 0 ? args[currentIndex + 1] : undefined;

if (!base) {
  console.error(
    "usage: bun run contract:diff --base <git-ref-or-openapi-file> [--current <openapi-file>]",
  );
  process.exit(2);
}
if (currentIndex >= 0 && !currentArgument) {
  console.error("--current requires an OpenAPI file");
  process.exit(2);
}

const current = resolve(currentArgument ?? "packages/contracts/openapi.yaml");
let baseFile = resolve(base);
let temporaryDirectory;

if (!base.endsWith(".yaml") && !base.endsWith(".yml") && !base.endsWith(".json")) {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "meltiply-contract-diff-"));
  baseFile = join(temporaryDirectory, "openapi.yaml");
  const shown = spawnSync("git", ["show", `${base}:packages/contracts/openapi.yaml`], {
    encoding: "utf8",
  });
  if (shown.status !== 0) {
    console.error(shown.stderr.trim() || `unable to read contract from ${base}`);
    rmSync(temporaryDirectory, { force: true, recursive: true });
    process.exit(shown.status ?? 1);
  }
  writeFileSync(baseFile, shown.stdout);
}

const oasdiffBin = process.env.OASDIFF_BIN;
const oasdiffArgs = ["breaking", "--fail-on", "ERR", "--format", "text", baseFile, current];
const result = spawnSync(
  oasdiffBin ?? "go",
  oasdiffBin ? oasdiffArgs : ["run", "github.com/oasdiff/oasdiff@v1.17.0", ...oasdiffArgs],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(
    `unable to run ${oasdiffBin ? oasdiffBin : "go (set OASDIFF_BIN to a prebuilt oasdiff binary)"}: ${result.error.message}`,
  );
}

if (temporaryDirectory) {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

process.exit(result.status ?? 1);
