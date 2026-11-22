import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { markdownLines, maskInlineCode, trackedMarkdownFiles } from "./markdown-source.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Prose patterns that record change history instead of current truth. Each is a
 * defect under the documentation discipline in AGENTS.md: a dated note, a
 * revision marker, or an explicit supersession chain means the superseded text
 * should have been edited or deleted.
 */
const forbiddenPatterns = [
  {
    pattern: /\bImplementation note\s*\(\d{4}-?\d{2}-?\d{2}/iu,
    reason: "dated implementation note; edit the claim instead of appending history",
  },
  {
    pattern: /\b(?:revision|revised)\s*\(\d{4}-?\d{2}-?\d{2}/iu,
    reason: "dated revision marker; the current text is the only version",
  },
  {
    pattern: /\bMeasured on \d{4}-\d{2}-\d{2}\b/iu,
    reason: "dated measurement; keep the decision, not the run log",
  },
  {
    pattern: /\bsupersed(?:es|ed|ing)\b[^.\n]{0,40}\b(?:below|above|section)\b/iu,
    reason: "supersession chain; delete the superseded text",
  },
  {
    pattern: /\bthese supersede\b/iu,
    reason: "supersession chain; delete the superseded text",
  },
  {
    pattern: /\b(?:the )?shipped branch (?:now )?keeps\b/iu,
    reason: "describes a branch rather than the product",
  },
];

/**
 * Documentation that must never be trimmed by heuristic or agent edits.
 * Legal notices and the verbatim license text are obligations, not prose.
 */
const exempt = [
  /^LICENSE\.md$/u,
  /^THIRD_PARTY_NOTICES\.md$/u,
  /^LICENSES\//u,
  /third-party-notices\.txt$/u,
  /^CHANGELOG\.md$/u,
];

/**
 * Returns whether a path is exempt from the discipline scan.
 *
 * @param {string} path - Repository-relative path
 * @returns {boolean} True when the file is exempt
 */
function isExempt(path) {
  return exempt.some((pattern) => pattern.test(path));
}

/**
 * Scans tracked Markdown for documentation-discipline violations.
 *
 * @param {string} root - Repository root
 * @param {Array<string>} files - Repository-relative Markdown paths
 * @returns {Array<string>} Sorted `path:line: reason` findings
 */
export function collectDisciplineFindings(root, files) {
  const findings = [];
  for (const file of files) {
    if (isExempt(file)) continue;
    const lines = markdownLines(readFileSync(resolve(root, file), "utf8"));
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      const text = maskInlineCode(line);
      for (const { pattern, reason } of forbiddenPatterns) {
        if (pattern.test(text)) {
          findings.push(`${file}:${index + 1}: ${reason}`);
          break;
        }
      }
    }
  }
  return findings.sort();
}

/**
 * Gate entrypoint: fails when a doc records history instead of current truth.
 *
 * @returns {{ files: number }} Number of scanned files
 * @throws {Error} When findings exist
 */
export function runDocumentationDisciplineGate() {
  const files = trackedMarkdownFiles(repositoryRoot);
  const findings = collectDisciplineFindings(repositoryRoot, files);
  if (findings.length > 0) {
    throw new Error(
      `Documentation discipline check failed. Edit or delete the stale text rather than ` +
        `appending history (see AGENTS.md#documentation-discipline):\n${findings.join("\n")}`,
    );
  }
  return { files: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runDocumentationDisciplineGate();
    process.stdout.write(`Documentation discipline check passed (${result.files} files).\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : "check failed"}\n`);
    process.exitCode = 1;
  }
}
