// Guards AUD-031: this is a pure Vite SPA — React Server Components
// directives are inert noise and must not come back.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(repositoryRoot, "frontend/app/src");
const sourceExtension = /\.(?:ts|tsx|js|jsx|mts|mjs)$/;
const directive = /^(['"])use (?:client|server)\1\s*;?$/;

/** Collects every source module under one directory. */
function collectFiles(root, files = []) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      collectFiles(path, files);
    } else if (sourceExtension.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Returns the first statement a module executes, ignoring the leading comments
 * and blank lines that every file in this repo starts with.
 *
 * @param {string} source Module source.
 * @returns {string} First non-comment line, or "" when the file is only comments.
 */
function firstStatement(source) {
  let remainder = source;
  for (;;) {
    const trimmed = remainder.replace(/^\s+/, "");
    if (trimmed.startsWith("//")) {
      const newline = trimmed.indexOf("\n");
      remainder = newline === -1 ? "" : trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const close = trimmed.indexOf("*/");
      remainder = close === -1 ? "" : trimmed.slice(close + 2);
      continue;
    }
    return trimmed.split("\n")[0] ?? "";
  }
}

test("frontend source contains no React Server Components directives", () => {
  const offenders = [];
  for (const file of collectFiles(sourceRoot)) {
    if (directive.test(firstStatement(readFileSync(file, "utf8")).trim())) {
      offenders.push(relative(repositoryRoot, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "frontend/app/src must not contain 'use client'/'use server' directives (AUD-031)",
  );
});
