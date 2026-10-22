import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import type { Node } from "oxc-parser";
import { describe, expect, it } from "vite-plus/test";

import glossary from "../locales/glossary.json";
import sourceCatalog from "../locales/en/ui.json";
import { translate } from "./i18n";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

// The shared glossary is the single source for terms that are deliberately
// identical across languages. It also feeds generation and the Shipi18n check.
const intentionalIdenticalValues: Record<string, true> = Object.fromEntries(
  [...Object.keys(glossary.keepVerbatim), ...glossary.intentionallyIdentical].map((term) => [
    term,
    true,
  ]),
);

// English is the translation key: every translatable callsite must be present
// in the source catalog, which the locale check then requires in each target.

// Dynamic keys are finite values selected by application state. Their source
// expressions are reviewed here so a new dynamic callsite cannot bypass the catalog guard.
const allowedDynamicTranslationExpressions: Record<string, true> = {
  "asset.asset_type": true,
  "card.definition": true,
  'grouping === "day" ? "Day" : grouping === "week" ? "Week" : "Month"': true,
  "FORMAT_LABELS[format]": true,
  "card.label": true,
  genericErrorMessage: true,
  error: true,
  "item.label": true,
  "action.label": true,
  message: true,
  "METRIC_LABELS[metric]": true,
  "oauthOutcomes[outcome]": true,
  "publicMessages[code]": true,
  "RANGE_LABELS[range]": true,
  "status.message": true,
  "titles[status.kind]": true,
};

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      // The DevBox dock is dev-only chrome — its labels are developer tooling,
      // not user-facing copy, so they are exempt from the translation catalog.
      if (entry.isDirectory() && entry.name === "devbox") return [];
      // EvilCharts registry source is vendored third-party implementation; its
      // internal loading chrome is not an authored product surface. The page
      // passes translated labels into the chart instead of changing the source.
      if (entry.isDirectory() && entry.name === "evilcharts") return [];
      if (entry.isDirectory()) return sourceFiles(path);
      if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) return [path];
      return [];
    }),
  );
  return nested.flat();
}

/**
 * Reports whether a translatable callsite is registered in the English source
 * catalog or explicitly allowed to stay identical by the shared glossary.
 *
 * @param message English source string found in the app.
 * @returns True when the catalog guard may accept the string.
 */
function isCovered(message: string): boolean {
  return Object.hasOwn(sourceCatalog, message) || Boolean(intentionalIdenticalValues[message]);
}

describe("Spanish i18n catalog", () => {
  it("resolves Spanish from locale data and falls back to the English key", () => {
    expect(translate("es", "Dashboard")).toBe("Panel");
    expect(translate("en", "Dashboard")).toBe("Dashboard");
    expect(translate("es", "Not a catalog key")).toBe("Not a catalog key");
  });

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
          if (/[A-Za-zÀ-ÿ]/.test(text) && !isCovered(text) && !intentionalIdenticalValues[text]) {
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
    expect(missing, "unregistered translatable literals").toEqual([]);
  });
});
