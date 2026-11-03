import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  /^docs\/research\//u,
  /^docs\/benchmarks\//u,
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
 * Masks fenced code blocks and inline code so quoted examples cannot trip the scan.
 * Inline code is replaced with spaces, keeping offsets stable.
 *
 * A closing fence carries no info string: only a run of the same character that is at
 * least as long, followed by nothing but whitespace, ends the block. Treating
 * ```js as a closer would end the block early and expose its content to the scan.
 *
 * @param {string} content - Full Markdown content
 * @returns {Array<string>} Lines as `lineNumber:text`, or "" for fenced content
 */
function markdownLines(content) {
  let fence;
  return content.split("\n").map((line, index) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      const isCloser =
        fence !== undefined &&
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        line.trim() === marker;
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (isCloser) fence = undefined;
      return "";
    }
    if (fence) return "";
    return `${index + 1}:${maskInlineCode(line)}`;
  });
}

/**
 * Replaces inline code spans with spaces of equal length. A span opens with a run of
 * backticks and closes with the next run of exactly the same length, so
 * ``a `b` c`` masks as one span instead of three fragments. Unmatched runs stay
 * literal.
 *
 * @param {string} line - Single Markdown line
 * @returns {string} Line with inline code blanked
 */
function maskInlineCode(line) {
  let masked = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      masked += line[index];
      index += 1;
      continue;
    }
    let runLength = 0;
    while (line[index + runLength] === "`") runLength += 1;
    const delimiter = "`".repeat(runLength);
    const close = line.indexOf(delimiter, index + runLength);
    // The closing run must be exactly this long, so a longer run is a different span.
    if (close === -1 || line[close + runLength] === "`") {
      masked += delimiter;
      index += runLength;
      continue;
    }
    masked += " ".repeat(close + runLength - index);
    index = close + runLength;
  }
  return masked;
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
    for (const entry of markdownLines(readFileSync(resolve(root, file), "utf8"))) {
      if (!entry) continue;
      const separator = entry.indexOf(":");
      const lineNumber = entry.slice(0, separator);
      const text = entry.slice(separator + 1);
      for (const { pattern, reason } of forbiddenPatterns) {
        if (pattern.test(text)) {
          findings.push(`${file}:${lineNumber}: ${reason}`);
          break;
        }
      }
    }
  }
  return findings.sort();
}

/**
 * Lists Git-tracked Markdown files that exist in the working tree, collapsing
 * symlinked aliases (such as `CLAUDE.md` pointing at `AGENTS.md`) so one file
 * reports findings once.
 *
 * @returns {Array<string>} Repository-relative paths
 */
function trackedMarkdownFiles() {
  const seen = new Set();
  return execFileSync("git", ["ls-files", "-z", "--", ":(glob)**/*.md"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => {
      let identity;
      try {
        identity = realpathSync(resolve(repositoryRoot, file));
      } catch {
        // Tracked but absent from the working tree: a deletion or an unresolved
        // rename. Scanning it would throw, so skip it.
        return false;
      }
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

/**
 * Gate entrypoint: fails when a doc records history instead of current truth.
 *
 * @returns {{ files: number }} Number of scanned files
 * @throws {Error} When findings exist
 */
export function runDocumentationDisciplineGate() {
  const files = trackedMarkdownFiles();
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
