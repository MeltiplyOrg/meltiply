import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { markdownLines, maskInlineCode, trackedMarkdownFiles } from "./markdown-source.mjs";

const imageLinkPattern = /!\[([^\]]*)\]\([^)]*\)/gu;
const markdownLinkPattern = /\[([^\]]+)\]\([^)]*\)/gu;
const htmlTagPattern = /<[^>]+>/gu;
const markdownEmphasisPattern = /[*_~`]/gu;
const headingPunctuationPattern = /[^\p{L}\p{M}\p{N}\-_ ]/gu;
const headingWhitespacePattern = /\s+/gu;
const headingPattern = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
const htmlAnchorPattern = /<a\s+(?:name|id)=["']([^"']+)["']/giu;
const leadingSlashesPattern = /^\/+/;

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const markdownLink = /\]\(\s*(<[^>\n]+>|[^)\s\n]+)(?:\s+["'][^"'\n]*["'])?\s*\)/g;
const externalTarget = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Converts heading text to a GitHub-compatible URL anchor slug.
 * Strips Markdown links, images, HTML tags, formatting punctuation, and converts spaces to hyphens.
 *
 * @param {string} value - Raw heading text
 * @returns {string} Normalized lowercase anchor slug
 */
function headingSlug(value) {
  return value
    .replace(imageLinkPattern, "$1")
    .replace(markdownLinkPattern, "$1")
    .replace(htmlTagPattern, "")
    .replace(markdownEmphasisPattern, "")
    .trim()
    .toLowerCase()
    .replace(headingPunctuationPattern, "")
    .replace(headingWhitespacePattern, "-");
}

/**
 * Extracts all valid anchor targets from Markdown content, including headings and explicit HTML anchor tags.
 * Resolves duplicate heading slugs by appending numerical suffixes (-1, -2, etc.).
 *
 * @param {string} content - Markdown file content
 * @returns {Set<string>} Set of lowercase anchor strings
 */
function headingAnchors(content) {
  const anchors = new Set();
  const duplicates = new Map();
  const visibleLines = markdownLines(content);
  for (const line of visibleLines) {
    const heading = line.match(headingPattern)?.[1];
    if (!heading) continue;
    const base = headingSlug(heading);
    if (!base) continue;
    const duplicate = duplicates.get(base) ?? 0;
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
    duplicates.set(base, duplicate + 1);
  }
  const visibleContent = visibleLines.join("\n");
  for (const match of visibleContent.matchAll(htmlAnchorPattern)) {
    anchors.add(match[1].toLowerCase());
  }
  return anchors;
}

/**
 * Normalizes a raw link destination by stripping wrapping angle brackets and decoding URI percent-encoding.
 *
 * @param {string} raw - Raw link URL or path from Markdown syntax
 * @returns {string} Cleaned destination string
 */
function normalizedDestination(raw) {
  const destination = raw.startsWith("<") ? raw.slice(1, -1) : raw;
  try {
    return decodeURIComponent(destination);
  } catch {
    return destination;
  }
}

/**
 * Verifies whether a resolved filesystem target lies strictly within the repository root boundary.
 * Prevents directory traversal outside the worktree.
 *
 * @param {string} root - Absolute repository root path
 * @param {string} target - Absolute resolved target file path
 * @returns {boolean} True if target is within root, false if it escapes
 */
function insideRoot(root, target) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

/**
 * Scans Markdown files for broken local links, missing heading anchors, and path traversals escaping the repo.
 * Ignores external links and code blocks while resolving relative and absolute paths against the repository root.
 *
 * @param {string} root - Repository root directory path
 * @param {Array<string>} markdownFiles - List of relative Markdown file paths to scan
 * @returns {{ failures: Array<string>, localLinks: number }} Sorted failure descriptions and count of verified local links
 */
export function collectLinkFailures(root, markdownFiles) {
  const absoluteRoot = resolve(root);
  const failures = [];
  let localLinks = 0;
  const anchorCache = new Map();

  for (const file of [...markdownFiles].sort()) {
    const absoluteFile = resolve(absoluteRoot, file);
    const content = readFileSync(absoluteFile, "utf8");
    const lines = markdownLines(content);
    for (const [index, line] of lines.entries()) {
      for (const match of maskInlineCode(line).matchAll(markdownLink)) {
        const destination = normalizedDestination(match[1]);
        if (externalTarget.test(destination)) continue;
        localLinks += 1;
        const hashIndex = destination.indexOf("#");
        const rawPath = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
        const fragment = hashIndex === -1 ? "" : destination.slice(hashIndex + 1);
        const queryIndex = rawPath.indexOf("?");
        const linkPath = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
        const target = linkPath
          ? resolve(
              linkPath.startsWith("/") ? absoluteRoot : dirname(absoluteFile),
              linkPath.replace(leadingSlashesPattern, ""),
            )
          : absoluteFile;
        const source = relative(absoluteRoot, absoluteFile);
        const location = `${source}:${index + 1}`;

        if (!insideRoot(absoluteRoot, target)) {
          failures.push(`${location}: ${destination} escapes the repository`);
          continue;
        }
        if (!existsSync(target)) {
          failures.push(`${location}: ${destination} does not exist`);
          continue;
        }
        if (fragment && extname(target).toLowerCase() === ".md") {
          let anchors = anchorCache.get(target);
          if (!anchors) {
            anchors = headingAnchors(readFileSync(target, "utf8"));
            anchorCache.set(target, anchors);
          }
          if (!anchors.has(fragment.toLowerCase())) {
            failures.push(`${location}: ${destination} has no matching heading`);
          }
        }
      }
    }
  }
  return { failures: failures.sort(), localLinks };
}

/**
 * Filters a list of file paths to those that exist on disk relative to root.
 *
 * @param {string} root - Base directory path
 * @param {Array<string>} files - File paths to check
 * @returns {Array<string>} Files that exist on disk
 */
export function existingMarkdownFiles(root, files) {
  return files.filter((file) => existsSync(resolve(root, file)));
}

/**
 * High-level gate entrypoint that runs link validation across all tracked Markdown files.
 * Enforces zero broken links or missing anchors before PR merge or release.
 *
 * @returns {{ files: number, localLinks: number }} Number of scanned files and verified local links
 * @throws {Error} If any link failure or missing anchor is detected
 */
export function runDocumentationLinkGate() {
  const files = trackedMarkdownFiles(repositoryRoot);
  const result = collectLinkFailures(repositoryRoot, files);
  if (result.failures.length > 0) {
    throw new Error(`Documentation link check failed:\n${result.failures.join("\n")}`);
  }
  return { files: files.length, localLinks: result.localLinks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runDocumentationLinkGate();
    process.stdout.write(
      `Documentation link check passed (${result.files} files, ${result.localLinks} local links).\n`,
    );
  } catch (cause) {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : "documentation link check failed"}\n`,
    );
    process.exitCode = 1;
  }
}
