import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const codeFencePattern = /^\s{0,3}(`{3,}|~{3,})/u;
const closingFencePattern = /^\s{0,3}(`{3,}|~{3,})\s*$/u;

/**
 * Vendored third-party agent skill directories excluded from repository Markdown
 * gates, matching the ignore scope in `vite.config.ts` and `knip.json`.
 */
const vendoredMarkdownPrefixes = [".agents/", ".claude/", ".opencode/", ".kiro/", ".omp/"];

/**
 * Masks fenced code blocks with empty strings while preserving 1:1 line indices.
 *
 * Follows CommonMark closing fence rules: a closing fence uses the same fence
 * character, has at least as many characters as the opener, and carries no info
 * string (only optional leading/trailing whitespace).
 *
 * @param {string} content - Full Markdown file content
 * @returns {Array<string>} Array of lines with fenced blocks replaced by ""
 */
export function markdownLines(content) {
  let fence;
  return content.split("\n").map((line) => {
    const marker = line.match(codeFencePattern)?.[1];
    if (marker) {
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
        return "";
      }
      const closer = line.match(closingFencePattern)?.[1];
      if (closer && closer[0] === fence.character && closer.length >= fence.length) {
        fence = undefined;
      }
      return "";
    }
    if (fence) return "";
    return line;
  });
}

/**
 * Replaces backtick-delimited inline code spans with spaces of equal length.
 * A span opens with a run of backticks and closes with the next run of the exact
 * same length, so ``a `b` c`` masks as one span. Unmatched runs stay literal.
 *
 * @param {string} line - Single Markdown line
 * @returns {string} Line with inline code spans replaced by spaces
 */
export function maskInlineCode(line) {
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
    let searchFrom = index + runLength;
    let close = -1;
    while (searchFrom < line.length) {
      const candidate = line.indexOf(delimiter, searchFrom);
      if (candidate === -1) break;
      const beforeIsBacktick = candidate > 0 && line[candidate - 1] === "`";
      const afterIsBacktick = line[candidate + runLength] === "`";
      if (!beforeIsBacktick && !afterIsBacktick) {
        close = candidate;
        break;
      }
      searchFrom = candidate + 1;
    }
    if (close === -1) {
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
 * Lists existing Git-tracked repository Markdown files, excluding vendored
 * third-party agent skill directories (`.agents/**`, `.claude/**`, etc.) and
 * deduplicating symlinked aliases (such as `CLAUDE.md` -> `AGENTS.md`).
 *
 * @param {string} repositoryRoot - Absolute repository root directory path
 * @returns {Array<string>} Repository-relative Markdown file paths
 */
export function trackedMarkdownFiles(repositoryRoot) {
  const seen = new Set();
  return execFileSync("git", ["ls-files", "-z", "--", ":(glob)**/*.md"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => !vendoredMarkdownPrefixes.some((prefix) => file.startsWith(prefix)))
    .filter((file) => {
      let identity;
      try {
        identity = realpathSync(resolve(repositoryRoot, file));
      } catch {
        return false;
      }
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}
