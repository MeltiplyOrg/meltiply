#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillsRoot = join(repositoryRoot, ".agents", "skills");

const pack = "Essential-kit/skills";
const packRef = "936efac7e8e2ba2bb4413edf0fa530c2cff1eed8";
const skillsCli = "skills@1.7.4";
const agent = "opencode";

/**
 * Skills synchronized from the Essential Kit pack. `pr` is deliberately absent:
 * it is repository-owned because it follows this repo's completion gate and PR
 * template instead of the pack's standalone PR-body guide.
 */
const managedSkills = [
  "code-review",
  "codebase-design",
  "diagnosing-bugs",
  "domain-modeling",
  "grill-with-docs",
  "grilling",
  "handoff",
  "implement",
  "implement-spec",
  "improve-codebase-architecture",
  "research",
  "tdd",
  "to-spec",
  "to-tickets",
  "writing-for-agents",
];

/**
 * The pack addresses a generic domain document while this repository keeps its
 * `CONTEXT.md` naming. Each replacement is an exact filename, so the order does
 * not overlap with the others.
 */
const contextNames = [
  ["GLOSSARY-FORMAT.md", "CONTEXT-FORMAT.md"],
  ["GLOSSARY-MAP.md", "CONTEXT-MAP.md"],
  ["GLOSSARY.md", "CONTEXT.md"],
];

/**
 * Yields every regular file below a directory, recursively.
 *
 * @param {string} directory - Absolute directory to walk
 * @returns {AsyncGenerator<string>} Absolute file paths
 */
async function* walkFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

/**
 * Replaces the pack's domain-document names with this repository's names in
 * every text file below the staged skills directory, then renames the format
 * file itself. The pack contains only Markdown, YAML, and shell files, so every
 * file is safe to read as UTF-8.
 *
 * @param {string} directory - Staged `.agents/skills` directory
 * @returns {Promise<void>} Resolves after all matches are rewritten
 */
async function applyContextNames(directory) {
  for (const skill of managedSkills) {
    const skillDirectory = join(directory, skill);
    for await (const file of walkFiles(skillDirectory)) {
      const source = await readFile(file, "utf8");
      let updated = source;
      for (const [from, to] of contextNames) {
        updated = updated.replaceAll(from, to);
      }
      if (updated !== source) {
        await writeFile(file, updated);
      }
    }
    const glossaryFormat = join(skillDirectory, "GLOSSARY-FORMAT.md");
    if (existsSync(glossaryFormat)) {
      await rename(glossaryFormat, join(skillDirectory, "CONTEXT-FORMAT.md"));
    }
  }
}

/**
 * Installs the pinned pack into a staging directory with the `skills` CLI.
 * The CLI is invoked outside the repository so a failed install cannot leave
 * partial skill directories behind.
 *
 * @param {string} directory - Empty staging directory
 * @returns {void}
 * @throws {Error} When the CLI fails or omits one of the managed skills
 */
function installPack(directory) {
  const args = ["--yes", skillsCli, "add", `${pack}#${packRef}`, "-a", agent, "-y"];
  for (const skill of managedSkills) {
    args.push("-s", skill);
  }
  try {
    execFileSync("npx", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(`skills install failed${stderr ? `:\n${stderr}` : ""}`, { cause: error });
  }
  for (const skill of managedSkills) {
    if (!existsSync(join(directory, ".agents", "skills", skill, "SKILL.md"))) {
      throw new Error(`skills install did not produce ${skill}/SKILL.md`);
    }
  }
}

/**
 * Installs the pack into a temporary directory and applies this repository's
 * context naming.
 *
 * @returns {Promise<{staging: string, skills: string}>} Staged install
 */
async function stagePack() {
  const staging = await mkdtemp(join(tmpdir(), "meltiply-skills-"));
  try {
    installPack(staging);
    const skills = join(staging, ".agents", "skills");
    await applyContextNames(skills);
    return { staging, skills };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Replaces the managed skill directories with the staged copies. Deleting
 * first removes files the upstream pack no longer ships.
 *
 * @param {string} stagedSkills - Staged `.agents/skills` directory
 * @returns {Promise<void>} Resolves after every managed directory is replaced
 */
async function installStaged(stagedSkills) {
  for (const skill of managedSkills) {
    const target = join(skillsRoot, skill);
    await rm(target, { recursive: true, force: true });
    await cp(join(stagedSkills, skill), target, { recursive: true });
  }
}

/**
 * Lists file paths relative to a directory, sorted for stable comparisons.
 *
 * @param {string} directory - Directory to list
 * @returns {Promise<Array<string>>} Sorted relative paths
 */
async function listRelativeFiles(directory) {
  const files = [];
  for await (const file of walkFiles(directory)) {
    files.push(relative(directory, file).split(sep).join("/"));
  }
  return files.sort();
}

/**
 * Compares two skill directories file by file.
 *
 * @param {string} expected - Freshly staged skill directory
 * @param {string} actual - Committed skill directory
 * @returns {Promise<Array<string>>} Human-readable differences
 */
async function compareDirectories(expected, actual) {
  if (!existsSync(actual)) {
    return [`missing directory: ${relative(repositoryRoot, actual)}`];
  }
  const expectedFiles = await listRelativeFiles(expected);
  const actualFiles = await listRelativeFiles(actual);
  const failures = [];
  for (const file of expectedFiles) {
    if (!actualFiles.includes(file)) {
      failures.push(`missing file: ${relative(repositoryRoot, join(actual, file))}`);
      continue;
    }
    const [expectedContent, actualContent] = await Promise.all([
      readFile(join(expected, file)),
      readFile(join(actual, file)),
    ]);
    if (!expectedContent.equals(actualContent)) {
      failures.push(`outdated file: ${relative(repositoryRoot, join(actual, file))}`);
    }
  }
  for (const file of actualFiles) {
    if (!expectedFiles.includes(file)) {
      failures.push(`unexpected file: ${relative(repositoryRoot, join(actual, file))}`);
    }
  }
  return failures;
}

/**
 * Verifies the committed skills match a fresh install of the pinned pack.
 * Never writes to the repository.
 *
 * @returns {Promise<void>} Resolves when everything matches
 * @throws {Error} When skill files drift from the pinned pack
 */
async function check() {
  const staged = await stagePack();
  try {
    const failures = [];
    for (const skill of managedSkills) {
      failures.push(
        ...(await compareDirectories(join(staged.skills, skill), join(skillsRoot, skill))),
      );
    }
    if (failures.length > 0) {
      throw new Error(
        `Skills drift from ${pack}@${packRef}:\n${failures.join("\n")}\nRun \`bun run skills:sync\`.`,
      );
    }
    process.stdout.write(
      `Skills match ${pack}@${packRef.slice(0, 7)} (${managedSkills.length} skills).\n`,
    );
  } finally {
    await rm(staged.staging, { recursive: true, force: true });
  }
}

/**
 * Installs the pinned pack, reapplies this repository's context naming, and
 * writes the managed skill directories.
 *
 * @returns {Promise<void>} Resolves after the repository is updated
 */
async function sync() {
  const staged = await stagePack();
  try {
    await installStaged(staged.skills);
    process.stdout.write(
      `Synced ${managedSkills.length} skills from ${pack}@${packRef.slice(0, 7)}.\n`,
    );
  } finally {
    await rm(staged.staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes("--check")) {
      await check();
    } else {
      await sync();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
