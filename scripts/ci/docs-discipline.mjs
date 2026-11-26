import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { markdownLines, maskInlineCode, trackedMarkdownFiles } from "./markdown-source.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

const exempt = [
  /^LICENSE\.md$/u,
  /^THIRD_PARTY_NOTICES\.md$/u,
  /^LICENSES\//u,
  /third-party-notices\.txt$/u,
  /^CHANGELOG\.md$/u,
];

function isExempt(path) {
  return exempt.some((pattern) => pattern.test(path));
}

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
