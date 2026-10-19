import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertAllowedLicenses, javascriptCatalog } from "./supply-chain.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const projectLicensePath = join(repositoryRoot, "LICENSE.md");

const SPDX_LICENSE_URLS = {
  "Apache-2.0": "https://spdx.org/licenses/Apache-2.0.html",
  "BSD-2-Clause": "https://spdx.org/licenses/BSD-2-Clause.html",
  "BSD-3-Clause": "https://spdx.org/licenses/BSD-3-Clause.html",
  ISC: "https://spdx.org/licenses/ISC.html",
  MIT: "https://spdx.org/licenses/MIT.html",
  "MPL-2.0": "https://spdx.org/licenses/MPL-2.0.html",
};

/**
 * Canonical texts for licenses whose installed platform packages omit a license
 * file. LGPLv3 incorporates GPLv3 by reference, so both texts ship together.
 */
const CANONICAL_LICENSE_FILES = {
  "LGPL-3.0-or-later": ["LICENSES/LGPL-3.0-or-later.txt", "LICENSES/GPL-3.0-or-later.txt"],
};

const LICENSE_FILE_PATTERNS = [
  "LICENSE*",
  "license*",
  "LICENCE*",
  "licence*",
  "COPYING*",
  "NOTICE*",
  "notice*",
  "AUTHORS*",
  "licenses/**",
  "LICENSES/**",
];

/**
 * Copied or adapted interface code that is not represented by an installed npm
 * package. The generated dependency section already covers lucide-react; this
 * list keeps the copied geometry and the permission-only Gr8r adaptation visible
 * in every distributed notice bundle.
 */
const COPIED_INTERFACE_NOTICES = [
  {
    name: "shadcn/ui",
    license: "MIT",
    note: "Shared controls in frontend/shared are derived from shadcn/ui.",
    licenseFile: "LICENSES/shadcn-ui.txt",
  },
  {
    name: "sileo",
    license: "MIT",
    note: "The physics-based toast surface, store, and styles in frontend/shared are adapted from hiaaryan/sileo.",
    licenseFile: "LICENSES/sileo.txt",
  },
  {
    name: "Lucide / Feather",
    license: "ISC / MIT",
    note: "Animated icon geometry derives from Lucide and its Feather-derived icons. The installed lucide-react dependency is also listed below.",
    licenseFile: "LICENSES/lucide.txt",
  },
  {
    name: "Gr8r Studio",
    license: "Used with written permission",
    note: "The workspace layout and component styling adapt Gr8r Studio revision 904205c626918ee96054eb35495c394a60c0c601. The upstream repository publishes no general license; Meltiply's repository owner obtained permission for this reuse. That permission is limited to Meltiply and does not grant rights to third parties.",
    licenseFile: null,
  },
];

/**
 * Normalizes line endings and trailing whitespace so the generated bundle is
 * stable across platforms and can be compared byte-for-byte in checks.
 *
 * @param {string} text - License or notice text.
 * @returns {string} Normalized text without a trailing newline.
 */
function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

/**
 * Finds every license-like file shipped inside an installed package.
 *
 * @param {string} directory - Absolute installed package directory.
 * @returns {Array<string>} Sorted package-relative file paths.
 */
function licenseFiles(directory) {
  const files = new Set();
  for (const pattern of LICENSE_FILE_PATTERNS) {
    for (const path of globSync(pattern, { cwd: directory })) {
      if (statSync(join(directory, path)).isFile()) files.add(path);
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

/**
 * Renders the repository URL from the shapes used by npm package metadata.
 *
 * @param {string | { url?: string } | undefined} repository - Package repository metadata.
 * @returns {string | undefined} Repository URL when present.
 */
function repositoryUrl(repository) {
  if (typeof repository === "string") return repository;
  return repository?.url;
}

/**
 * Renders a package author from the string or object forms used by npm.
 *
 * @param {string | { name?: string, email?: string } | undefined} author - Package author metadata.
 * @returns {string | undefined} Author label when present.
 */
function authorLabel(author) {
  if (typeof author === "string") return author;
  if (!author) return undefined;
  return [author.name, author.email && `<${author.email}>`].filter(Boolean).join(" ");
}

/**
 * Converts one installed package into a self-contained notice section. Repeats
 * identical license texts by reference so standard MIT/Apache files do not grow
 * the bundle unnecessarily while each package keeps its own copyright header.
 *
 * @param {object} entry - Collected package metadata.
 * @param {Map<string, string>} seenTexts - Hash to first package/file label.
 * @returns {string} Notice section.
 */
function packageSection(entry, seenTexts) {
  const lines = ["=".repeat(80), `${entry.name}@${entry.version}`, `License: ${entry.license}`];
  const repository = repositoryUrl(entry.repository);
  if (repository) lines.push(`Repository: ${repository}`);
  if (entry.homepage) lines.push(`Homepage: ${entry.homepage}`);
  lines.push("-".repeat(80));

  if (entry.files.length === 0) {
    lines.push("The installed package did not include a standalone license file.");
    const author = authorLabel(entry.author);
    if (author) lines.push(`Author: ${author}`);
    const canonical = CANONICAL_LICENSE_FILES[entry.license] ?? [];
    const url = SPDX_LICENSE_URLS[entry.license];
    if (canonical.length === 0) {
      if (url) lines.push(`License text: ${url}`);
      lines.push("");
      return lines.join("\n");
    }
    lines.push("Canonical license text:", "");
    for (const path of canonical) {
      const text = normalizeText(readFileSync(join(repositoryRoot, path), "utf8"));
      const hash = createHash("sha256").update(text).digest("hex");
      const previous = seenTexts.get(hash);
      lines.push(`File: ${path}`);
      lines.push("");
      if (previous) {
        lines.push(`License text: identical to ${previous}.`);
      } else {
        seenTexts.set(hash, `${path} (canonical)`);
        lines.push(text);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  for (const file of entry.files) {
    const text = normalizeText(readFileSync(join(entry.directory, file), "utf8"));
    const hash = createHash("sha256").update(text).digest("hex");
    const previous = seenTexts.get(hash);
    lines.push(`File: ${file}`);
    lines.push("");
    if (previous) {
      lines.push(`License text: identical to ${previous}.`);
      lines.push("");
      continue;
    }
    seenTexts.set(hash, `${entry.name}@${entry.version} (${file})`);
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Reproduces Meltiply's own license ahead of the third-party notices so a
 * recipient cannot mistake the permissive dependency grants for a grant to the
 * project. The full text is embedded rather than linked because compiled
 * artifacts are distributed without the repository.
 *
 * @returns {string} Project license section.
 */
function projectLicenseSection() {
  return [
    "=".repeat(80),
    "Meltiply",
    "License: Sustainable Use License 1.0",
    "-".repeat(80),
    "Original Meltiply code and branding are source-available under the Sustainable",
    "Use License 1.0. The license permits personal/non-commercial and internal",
    "business use; it does not grant a right to sell or provide hosted Meltiply.",
    "The third-party notices below do not relicense Meltiply material.",
    "",
    normalizeText(readFileSync(projectLicensePath, "utf8")),
    "",
    "The repository-relative links in the license text refer to the source",
    "distribution; this bundle reproduces those notices and licenses below.",
  ].join("\n");
}

/**
 * Renders the copied-code section, embedding the preserved license text when
 * the repository ships one. Gr8r has no public license, so it records the
 * permission basis instead of inventing terms.
 *
 * @returns {string} Copied-interface notice section.
 */
function copiedInterfaceSection() {
  const sections = COPIED_INTERFACE_NOTICES.map((notice) => {
    const lines = [
      "=".repeat(80),
      notice.name,
      `License: ${notice.license}`,
      "-".repeat(80),
      notice.note,
      "",
    ];
    if (notice.licenseFile) {
      const path = join(repositoryRoot, notice.licenseFile);
      if (existsSync(path)) {
        lines.push(`File: ${notice.licenseFile}`, "");
        lines.push(normalizeText(readFileSync(path, "utf8")));
        lines.push("");
      } else {
        lines.push(`License text: ${notice.licenseFile} is missing from this checkout.`, "");
      }
    }
    return lines.join("\n");
  });
  return ["Copied interface code", "", ...sections].join("\n");
}

/**
 * Builds a deterministic third-party notice bundle for one production project.
 *
 * @param {string} project - Repository-relative or absolute project directory.
 * @param {object} [options] - Overrides for tests and alternate checkouts.
 * @param {string} [options.workspaceRoot=repositoryRoot] - Repository root used to identify private workspace packages.
 * @param {string} [options.policyPath] - License policy file.
 * @returns {string} Complete text bundle.
 * @throws {Error} If the project has no manifest, a production license is unapproved, or required metadata is missing.
 */
export function buildNoticeBundle(
  project,
  {
    workspaceRoot = repositoryRoot,
    policyPath = join(repositoryRoot, "scripts/ci/allowed-licenses.json"),
  } = {},
) {
  const projectPath = resolve(repositoryRoot, project);
  if (!existsSync(join(projectPath, "package.json"))) {
    throw new Error(`Project manifest not found: ${projectPath}/package.json`);
  }

  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const entries = [];
  const catalog = javascriptCatalog(projectPath, {
    workspaceRoot: resolve(workspaceRoot),
    licenseMetadata: policy.licenseMetadata,
    onPackage({ manifestPath, metadata, license }) {
      entries.push({
        author: metadata.author,
        directory: dirname(manifestPath),
        files: licenseFiles(dirname(manifestPath)),
        homepage: metadata.homepage,
        license,
        name: metadata.name,
        repository: metadata.repository,
        version: metadata.version,
      });
    },
  });
  assertAllowedLicenses(catalog, policy.javascript, "Notice bundle production JavaScript");

  entries.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
  const seenTexts = new Map();
  const dependencySections = entries.map((entry) => packageSection(entry, seenTexts));
  const header = [
    "Meltiply — Third-party notices",
    "",
    `Project: ${relative(repositoryRoot, projectPath) || "."}`,
    "Generated from the installed production dependency graph. Do not edit by hand.",
    "Regenerate with: bun run notices",
    "",
    "This bundle covers npm dependencies that may be distributed with the compiled",
    "application, plus copied interface code. Some build-time or platform-specific",
    "packages may appear even when the final bundle does not contain them; retaining",
    "their notices is intentional.",
    "",
  ].join("\n");

  return [
    header,
    "Project license",
    "",
    projectLicenseSection(),
    "",
    copiedInterfaceSection(),
    "",
    "Installed production dependencies",
    "",
    ...dependencySections,
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

/**
 * Parses the two required CLI paths.
 *
 * @param {Array<string>} argv - CLI arguments.
 * @returns {{ project: string, output: string }} Parsed paths.
 * @throws {TypeError} If arguments are missing or unknown.
 */
export function parseNoticeArgs(argv) {
  let project;
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project") {
      project = argv[++index];
    } else if (argument === "--output") {
      output = argv[++index];
    } else {
      throw new TypeError("usage: notices.mjs --project <path> --output <path>");
    }
  }
  if (!project || !output) {
    throw new TypeError("usage: notices.mjs --project <path> --output <path>");
  }
  return { project, output };
}

/**
 * Builds and writes one notice bundle.
 *
 * @param {Array<string>} argv - CLI arguments.
 * @returns {{ bytes: number, output: string, project: string }} Written bundle metadata.
 */
export function writeNoticeBundle(argv) {
  const { project, output } = parseNoticeArgs(argv);
  const text = buildNoticeBundle(project);
  const destination = resolve(repositoryRoot, output);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text, "utf8");
  return {
    bytes: Buffer.byteLength(text),
    output: destination,
    project: resolve(repositoryRoot, project),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = writeNoticeBundle(process.argv.slice(2));
    process.stdout.write(`Wrote ${result.bytes} bytes to ${result.output}\n`);
  } catch (cause) {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : "notice generation failed"}\n`,
    );
    process.exitCode = 1;
  }
}
