import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";
import YAML from "yaml";

import { canonical, contractDigest, git, latestContractTag } from "./contract-source.mjs";

const root = resolve("packages/contracts");
const sourcePath = resolve(root, "openapi.yaml");
const manifestPath = resolve(root, "release.json");
const releaseDirectory = resolve(root, "dist/release");
const names = ["SHA256SUMS", "changelog.json", "openapi.json", "openapi.yaml"];

/** Computes the digest of the exact distributed bytes, not of a reserialized document. */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}


/** Splits Markdown bullets with their continuation text into machine-readable change entries. */
function changesIn(section) {
  return (section.match(/^- .*(?:\n(?!- |## ).+)*/gm) ?? []).map((entry) =>
    entry.slice(2).replace(/\n\s*/g, " ").trim(),
  );
}

/** Determines SemVer severity from explicit breaking/patch notes; other contract changes are additive. */
function severity(changes) {
  if (changes.some((change) => change.startsWith("**Breaking:**"))) return "major";
  return changes.every((change) => change.startsWith("**Patch:**")) ? "patch" : "minor";
}

/** Computes the only allowed next stable version; the first public release starts at 1.0.0. */
function nextVersion(previous, changeType) {
  if (!previous) return "1.0.0";
  if (!/^\d+\.\d+\.\d+$/.test(previous))
    throw new Error("Previous release must have a stable semantic version");
  const [major, minor, patch] = previous.split(".").map(Number);
  if (changeType === "major") return `${major + 1}.0.0`;
  if (changeType === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Reads canonical source and a reachable previous release; rejects malformed version history. */
async function releaseState(excludeCurrentVersion = true) {
  const source = await readFile(sourcePath, "utf8");
  const document = YAML.parse(source);
  if (typeof document?.info?.version !== "string")
    throw new Error("OpenAPI info.version is required");
  const tag = latestContractTag("HEAD", excludeCurrentVersion ? `contract-v${document.info.version}` : undefined);
  const previous = tag
    ? YAML.parse(git("show", `${tag}:packages/contracts/openapi.yaml`))
    : undefined;
  if (previous && tag !== `contract-v${previous.info.version}`)
    throw new Error("Previous release tag disagrees with OpenAPI version");
  return { source, document, tag, previous };
}

/** Prepares or refreshes one untagged release; preserves its notes and never edits a published version. */
async function prepare() {
  const { source, document, tag, previous } = await releaseState(false);
  if (previous && contractDigest(previous) === contractDigest(document)) {
    throw new Error("No contract content changed since the latest release; nothing to publish");
  }
  const changelogPath = resolve(root, "CHANGELOG.md");
  const changelog = await readFile(changelogPath, "utf8");
  const match = /^## Unreleased\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(changelog);
  if (!match) throw new Error("CHANGELOG.md must have an Unreleased section");
  const preparedText = await readFile(manifestPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const prepared = preparedText ? JSON.parse(preparedText) : undefined;
  const pending =
    prepared?.version === document.info.version &&
    prepared?.previousVersion === (previous?.info.version ?? null) &&
    tag !== `contract-v${document.info.version}`;
  const preparedSection = pending
    ? changelog.split(/^## /m).find((section) => section.startsWith(`${document.info.version} - `))
    : undefined;
  if (pending && !preparedSection)
    throw new Error("Prepared release notes are missing from CHANGELOG.md");
  const priorNotes = preparedSection?.slice(preparedSection.indexOf("\n") + 1).trim() ?? "";
  const releaseNotes = [match[1].trim(), priorNotes].filter(Boolean).join("\n\n");
  const changes = changesIn(releaseNotes);
  if (changes.length === 0)
    throw new Error("A changed contract requires new Unreleased changelog notes");
  if (
    pending &&
    prepared.contractSha256 === contractDigest(document) &&
    canonical(prepared.changes) === canonical(changes)
  ) {
    validateManifest(prepared, document, tag, previous);
    console.log(`Contract ${prepared.version} is already prepared.`);
    return;
  }
  const changeType = previous ? severity(changes) : "initial";
  const version = nextVersion(previous?.info.version, changeType);
  const existing = git("tag", "--list", `contract-v${version}`);
  if (existing) throw new Error(`Version ${version} already has an immutable release tag`);
  const parsed = YAML.parseDocument(source);
  const scalar = parsed.getIn(["info", "version"], true);
  if (!scalar?.range) throw new Error("Cannot locate OpenAPI info.version");
  await writeFile(
    sourcePath,
    `${source.slice(0, scalar.range[0])}${version}${source.slice(scalar.range[1])}`,
  );
  const catalogPath = resolve(root, "operation-readiness.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.contractVersion = version;
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  const manifest = {
    schemaVersion: 1,
    version,
    previousVersion: previous?.info.version ?? null,
    changeType,
    contractSha256: contractDigest(document),
    changes,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const date = new Date().toISOString().slice(0, 10);
  await writeFile(
    changelogPath,
    (preparedSection ? changelog.replace(`## ${preparedSection}`, "") : changelog).replace(
      match[0],
      `## Unreleased\n\n## ${version} - ${date}\n\n${releaseNotes}\n\n`,
    ),
  );
  console.log(
    `Prepared contract-v${version} (${changeType}); regenerate, validate and commit the source before tagging.`,
  );
}

/** Validates source-bound release notes and the automatic SemVer decision against the prior tag. */
function validateManifest(manifest, document, tag, previous) {
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== document.info.version ||
    !Array.isArray(manifest.changes) ||
    manifest.changes.length === 0 ||
    manifest.changes.some((change) => typeof change !== "string" || !change.trim()) ||
    manifest.contractSha256 !== contractDigest(document) ||
    manifest.previousVersion !== (previous?.info.version ?? null)
  ) {
    throw new Error(
      "Release metadata is stale; run contract:release:prepare for the changed contract",
    );
  }
  const changeType = previous ? severity(manifest.changes) : "initial";
  if (
    manifest.changeType !== changeType ||
    manifest.version !== nextVersion(previous?.info.version, changeType)
  ) {
    throw new Error(
      `Version must advance automatically from ${tag ?? "the initial release"} with ${changeType} severity`,
    );
  }
}

/** Produces only allowlisted public assets from the existing validated bundle, with exact checksums. */
async function artifacts(tagArgument) {
  const { document, tag, previous } = await releaseState();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest, document, tag, previous);
  if (!/^\d+\.\d+\.\d+$/.test(document.info.version))
    throw new Error("Release version must be stable SemVer");
  if (tagArgument) {
    if (tagArgument !== `contract-v${document.info.version}`)
      throw new Error("Release tag must equal OpenAPI info.version");
    if (git("rev-parse", `${tagArgument}^{commit}`) !== git("rev-parse", "HEAD"))
      throw new Error("Release tag must identify the checked-out source");
    git("diff", "--exit-code", "HEAD", "--", "packages/contracts");
  }
  const yaml = await readFile(resolve(root, "dist/openapi.yaml"));
  const json = await readFile(resolve(root, "dist/openapi.json"));
  const yamlDocument = YAML.parse(yaml.toString());
  const jsonDocument = JSON.parse(json.toString());
  if (
    canonical(yamlDocument) !== canonical(jsonDocument) ||
    canonical(yamlDocument) !== canonical(document)
  ) {
    throw new Error("Release bundle differs from the checked-in OpenAPI contract");
  }
  await SwaggerParser.validate(structuredClone(jsonDocument));
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(resolve(releaseDirectory, "openapi.yaml"), yaml);
  await writeFile(resolve(releaseDirectory, "openapi.json"), json);
  await writeFile(
    resolve(releaseDirectory, "changelog.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const sums = [];
  for (const name of names.filter((name) => name !== "SHA256SUMS")) {
    sums.push(`${sha256(await readFile(resolve(releaseDirectory, name)))}  ${name}`);
  }
  await writeFile(resolve(releaseDirectory, "SHA256SUMS"), `${sums.join("\n")}\n`);
  await verify();
}

/** Verifies the actual distribution inventory, document equivalence, version and all asset checksums. */
async function verify() {
  if (canonical((await readdir(releaseDirectory)).sort()) !== canonical(names))
    throw new Error("Unexpected release asset; internal files must not be published");
  const sums = (await readFile(resolve(releaseDirectory, "SHA256SUMS"), "utf8")).trim().split("\n");
  if (sums.length !== 3) throw new Error("Release checksums must cover exactly the public assets");
  for (const name of names.filter((name) => name !== "SHA256SUMS")) {
    const digest = sha256(await readFile(resolve(releaseDirectory, name)));
    if (!sums.includes(`${digest}  ${name}`)) throw new Error(`Checksum mismatch: ${name}`);
  }
  const source = YAML.parse(await readFile(sourcePath, "utf8"));
  const yaml = YAML.parse(await readFile(resolve(releaseDirectory, "openapi.yaml"), "utf8"));
  const json = JSON.parse(await readFile(resolve(releaseDirectory, "openapi.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(releaseDirectory, "changelog.json"), "utf8"));
  const state = await releaseState();
  validateManifest(manifest, source, state.tag, state.previous);
  if (canonical(source) !== canonical(yaml) || canonical(source) !== canonical(json))
    throw new Error("Distributed documents do not match source");
  await SwaggerParser.validate(structuredClone(json));
  console.log(
    `Verified contract-v${source.info.version}: public JSON/YAML, source equivalence, automatic version, machine changelog and SHA-256 checksums.`,
  );
}

try {
  const command = process.argv[2];
  if (command === "prepare") await prepare();
  else if (command === "artifacts") {
    const index = process.argv.indexOf("--tag");
    if (index >= 0 && !process.argv[index + 1]) throw new Error("--tag requires a value");
    await artifacts(index >= 0 ? process.argv[index + 1] : undefined);
  } else if (command === "verify") await verify();
  else
    throw new Error(
      "usage: contract-release.mjs prepare | artifacts [--tag contract-vX.Y.Z] | verify",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
