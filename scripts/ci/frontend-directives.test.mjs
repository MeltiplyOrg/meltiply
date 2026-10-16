// Guards AUD-031: this is a pure Vite SPA — React Server Components
// directives are inert noise and must not come back.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(repositoryRoot, "frontend/app/src");

function collectFiles(root, files = []) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      collectFiles(path, files);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

test("frontend source contains no React Server Components directives", () => {
  const offenders = [];
  for (const file of collectFiles(sourceRoot)) {
    const firstLine = readFileSync(file, "utf8").split("\n")[0] ?? "";
    if (firstLine.includes("use client") || firstLine.includes("use server")) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "frontend/app/src must not contain 'use client'/'use server' directives (AUD-031)",
  );
});
