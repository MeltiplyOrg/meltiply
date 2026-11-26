import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(repositoryRoot, "frontend/app/src");
const sourceExtension = /\.(?:ts|tsx|js|jsx|mts|mjs)$/;
const directive = /^(['"])use (?:client|server)\1\s*;?$/;

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
