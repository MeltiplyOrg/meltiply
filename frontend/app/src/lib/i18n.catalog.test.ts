import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import type { Node } from "oxc-parser";
import { describe, expect, it } from "vite-plus/test";

import { translate } from "./i18n";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

// These values are deliberately identical in Spanish: product names, proper names,
// technical identifiers, and the hashtag example are not translated.
const intentionalIdenticalValues: Record<string, true> = {
  "#viral #shorts": true,
  "{start}–{end}": true,
  Duet: true,
  English: true,
  Español: true,
  Hashtags: true,
  Plan: true,
  Stitch: true,
  General: true,
  ID: true,
  "ID: {id}": true,
  "Impr.": true,
  "sk_live_…": true,
  YouTube: true,
  Facebook: true,
  Instagram: true,
  Threads: true,
};

const intentionalJsxValues: Record<string, true> = {
  MELTIPLY: true,
  Meltiply: true,
  TikTok: true,
  "⌘K": true,
  s: true,
  M: true,
  P: true,
  "sk_live_…": true,
};

// Dynamic keys are finite values selected by application state. Their source
// expressions are reviewed here so a new dynamic callsite cannot bypass the catalog guard.
const allowedDynamicTranslationExpressions: Record<string, true> = {
  actionError: true,
  'action === "checkout" ? "Opening checkout…" : "Change plan"': true,
  'action === "portal" ? "Opening portal…" : "Manage billing"': true,
  'account.capabilities.notes[0] ?? "Provider actions are currently unavailable."': true,
  "asset.asset_type": true,
  "card.description": true,
  "card.title": true,
  "crumb.label": true,
  'capability.connect_available ? "Ready to connect" : (capability.notes[0] ?? "Connection is not available.")': true,
  day: true,
  genericErrorMessage: true,
  description: true,
  'distribution.attempt_count === 1 ? "{count} attempt" : "{count} attempts"': true,
  'distribution.status === "processing" || distribution.status === "awaiting_provider" ? "Request cancellation" : "Cancel distribution"': true,
  error: true,
  fallback: true,
  'isCancelling ? "Cancelling…" : distribution.status === "processing" || distribution.status === "awaiting_provider" ? "Request cancellation" : "Cancel distribution"': true,
  'isDeleting ? "Deleting {title}" : "Delete {title}"': true,
  'isReplying ? "Sending…" : "Send"': true,
  'isRetrying ? "Retrying…" : "Retry distribution"': true,
  'isUpdating ? "Saving…" : "Save schedule"': true,
  "item.label": true,
  label: true,
  "action.label": true,
  m: true,
  "m.label": true,
  message: true,
  metric: true,
  oauthMessage: true,
  "oauthOutcomes[outcome]": true,
  'planData.limits.analytics_enabled ? "Included" : "Unavailable"': true,
  'planData.limits.inbox_reply_enabled ? "Included" : "Unavailable"': true,
  "privacyLabels[level]": true,
  "publicMessages[code]": true,
  "rangeLabel[option]": true,
  "seriesLabel[series]": true,
  rescheduleError: true,
  scheduleError: true,
  "status.message": true,
  'STEP_LABELS[current] ?? ""': true,
  'submitting ? "Publishing…" : failedIds.length > 0 ? "Retry failed" : "Publish"': true,
  title: true,
  "titles[status.kind]": true,
  'unreplied ? "No unreplied comments." : "No comments yet."': true,
  validationError: true,
  "workflow.description": true,
  "workflow.title": true,
};

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      // The DevBox dock is dev-only chrome — its labels are developer tooling,
      // not user-facing copy, so they are exempt from the translation catalog.
      if (entry.isDirectory() && entry.name === "devbox") return [];
      if (entry.isDirectory()) return sourceFiles(path);
      if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) return [path];
      return [];
    }),
  );
  return nested.flat();
}

function isCovered(message: string): boolean {
  return translate("es", message) !== message || Boolean(intentionalIdenticalValues[message]);
}

describe("Spanish i18n catalog", () => {
  it("covers literal translation calls, accessible attributes, and user-facing JSX text", async () => {
    const missing: string[] = [];
    const dynamic: string[] = [];
    const files = await sourceFiles(sourceRoot);

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const ast = parseSync(file, source, {
        lang: file.endsWith(".tsx") ? "tsx" : "ts",
        sourceType: "module",
      });
      if (ast.errors.length) throw new Error(`${file}: ${ast.errors[0].message}`);

      // oxc emits ESTree-compatible nodes whose children are own object/array
      // properties, so a generic walk replaces the tsc visitor API.
      function visit(node: Node): void {
        if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
          const argumentIndex = node.callee.name === "translate" ? 1 : 0;
          if (node.callee.name === "t" || node.callee.name === "translate") {
            const argument = node.arguments[argumentIndex];
            if (argument && argument.type !== "SpreadElement") {
              if (argument.type === "Literal" && typeof argument.value === "string") {
                if (!isCovered(argument.value)) missing.push(`${file}: ${argument.value}`);
              } else if (argument.type === "TemplateLiteral" && argument.expressions.length === 0) {
                const text = source.slice(argument.start + 1, argument.end - 1);
                if (!isCovered(text)) missing.push(`${file}: ${text}`);
              } else {
                const expression = source
                  .slice(argument.start, argument.end)
                  .replace(/\s+/g, " ")
                  .trim();
                if (!allowedDynamicTranslationExpressions[expression]) {
                  dynamic.push(`${file}: ${expression}`);
                }
              }
            }
          }
        }

        if (
          node.type === "JSXAttribute" &&
          node.name?.type === "JSXIdentifier" &&
          ["aria-label", "placeholder", "title", "alt"].includes(node.name.name)
        ) {
          const initializer = node.value;
          if (
            initializer?.type === "Literal" &&
            typeof initializer.value === "string" &&
            initializer.value &&
            !isCovered(initializer.value)
          ) {
            missing.push(`${file}: ${initializer.value}`);
          }
        }

        if (node.type === "JSXText") {
          const text = node.value.replace(/\s+/g, " ").trim();
          if (/[A-Za-zÀ-ÿ]/.test(text) && !isCovered(text) && !intentionalJsxValues[text]) {
            missing.push(`${file}: ${text}`);
          }
        }

        for (const value of Object.values(node)) {
          if (Array.isArray(value)) {
            for (const child of value) {
              if (child && typeof child === "object" && "type" in child) visit(child as Node);
            }
          } else if (value && typeof value === "object" && "type" in value) {
            visit(value as Node);
          }
        }
      }

      visit(ast.program);
    }

    expect(dynamic, "unapproved dynamic translation callsites").toEqual([]);
    expect(missing, "untranslated Spanish literals").toEqual([]);
  });
});
