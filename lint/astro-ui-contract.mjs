#!/usr/bin/env node
/**
 * `.astro` companion to the `boundaries/*` oxlint rules: oxlint cannot parse
 * landing/docs/shared Astro surfaces. Its frontmatter is sliced at the `---`
 * fences and parsed with `oxc-parser` (the Rust parser behind Vite+ —
 * TypeScript 7 removed its programmatic API);
 * names/allowlists come from `lint/ui-contract-lib.mjs` like the plugin.
 * Flags app-dir specifiers, Radix, deep @meltiply/ui internals, cross-workspace
 * paths, and canonical-basename clones. Raw interactive markup is NOT banned —
 * landing/docs ship sanctioned script-driven native controls.
 * Usage: `node lint/astro-ui-contract.mjs [dir …]` — exit 0 when clean.
 */
import { readdirSync, readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_COMPONENT_STEMS,
  SANCTIONED_APP_COMPONENTS,
  normalizePath,
  normalizeStem,
  stemOf,
} from "./ui-contract-lib.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const SKIP = Object.freeze({
  node_modules: true,
  dist: true,
  ".astro": true,
  ".wrangler": true,
});
const COMPONENT_EXT = /\.(astro|tsx|jsx)$/;

/** Returns violation objects for one .astro file's source. */
export function checkAstroSource(source, file) {
  const filename = normalizePath(file);
  const violations = [];
  const flag = (code, line, message) => violations.push({ file: filename, line, code, message });

  if (
    filename.includes("/frontend/") &&
    !filename.includes("/frontend/shared/") &&
    !filename.includes(".test.") &&
    CANONICAL_COMPONENT_STEMS[normalizeStem(stemOf(filename))] === true
  ) {
    flag(
      "nameClone",
      1,
      `${stemOf(filename)} re-implements a canonical shared component — import it from @meltiply/ui instead.`,
    );
  }

  const frontmatter = source.match(FRONTMATTER)?.[1];
  if (!frontmatter) return violations;
  const ast = parseSync("fm.ts", frontmatter, { lang: "ts", sourceType: "module" });
  for (const st of ast.program.body) {
    if (
      st.type !== "ImportDeclaration" &&
      st.type !== "ExportNamedDeclaration" &&
      st.type !== "ExportAllDeclaration"
    )
      continue;
    const spec = st.source;
    if (!spec || spec.type !== "Literal" || typeof spec.value !== "string") continue;
    const line = frontmatter.slice(0, spec.start).split("\n").length;
    const value = spec.value.split(/[?#]/)[0];
    const resolved = /^\.{1,2}\//.test(value)
      ? normalizePath(join(dirname(filename), value))
      : null;
    const retiredMatch =
      value.match(/^@\/components\/(ui|atoms|primitives)\/(.+)$/) ??
      resolved?.match(/\/frontend\/app\/src\/components\/(ui|atoms|primitives)\/([^/]+)$/);
    if (retiredMatch) {
      const sanctioned =
        SANCTIONED_APP_COMPONENTS[retiredMatch[1]]?.[stemOf(retiredMatch[2])] === true;
      const sameWs =
        resolved === null ||
        filename.match(/\/frontend\/(\w+)\//)?.[1] === resolved.match(/\/frontend\/(\w+)\//)?.[1];
      // Sanctioned app files are fine from inside frontend/app (relative) or
      // via the app-only @/ alias; anything else hits the retired namespace.
      if (!sanctioned || !sameWs) {
        flag(
          "obsoleteSpecifier",
          line,
          `\`${value}\` targets the retired app component dirs — use @meltiply/ui/<basename>.`,
        );
      }
    } else if (/^(?:@radix-ui\/|radix-ui(?:\/|$))/.test(value)) {
      flag(
        "radixBypass",
        line,
        `\`${value}\` — Radix belongs to the canonical wrappers in frontend/shared/src/components/ui.`,
      );
    } else if (value.startsWith("@meltiply/ui/") && /\/(?:src|dist|components)\//.test(value)) {
      flag(
        "deepSpecifier",
        line,
        `\`${value}\` reaches into @meltiply/ui internals — use the flat package specifier.`,
      );
    } else if (resolved?.includes("/frontend/")) {
      const importerWs = filename.match(/\/frontend\/(\w+)\//)?.[1];
      const targetWs = resolved.match(/\/frontend\/(\w+)\//)?.[1];
      if (targetWs && importerWs && targetWs !== importerWs) {
        flag(
          targetWs === "shared" ? "bypassSpecifier" : "crossWorkspace",
          line,
          `\`${value}\` crosses frontend workspaces — share via @meltiply/ui.`,
        );
      } else if (
        COMPONENT_EXT.test(resolved) &&
        CANONICAL_COMPONENT_STEMS[normalizeStem(stemOf(resolved))] === true
      ) {
        flag(
          "cloneImport",
          line,
          `\`${value}\` imports a local clone of a canonical component — use @meltiply/ui/<basename>.`,
        );
      }
    }
  }
  return violations;
}

/** Recursively collects .astro files under dir. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP[entry.name] !== true) out.push(...collect(path));
    } else if (entry.name.endsWith(".astro")) {
      out.push(path);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const targets = dirs.length
    ? dirs.map((d) => join(root, d))
    : ["frontend/public/src", "frontend/shared"].map((d) => join(root, d));
  const violations = targets
    .flatMap((d) => collect(d))
    .flatMap((f) => checkAstroSource(readFileSync(f, "utf8"), f));
  for (const v of violations) console.log(`${v.file}:${v.line} ${v.code} — ${v.message}`);
  console.log(`astro-ui-contract: ${violations.length} violation(s)`);
  process.exitCode = violations.length ? 1 : 0;
}
