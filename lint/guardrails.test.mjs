import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import landmines from "@interfere/landmines";
import { RuleTester } from "vite-plus/lint/plugins-dev";

RuleTester.describe = describe;
RuleTester.it = it;

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const ruleTester = new RuleTester({ cwd: repositoryRoot });
const testFile = `${repositoryRoot}frontend/app/src/example.test.ts`;

ruleTester.run("landmines/no-fixed-sleep", landmines.rules["no-fixed-sleep"], {
  valid: [
    {
      code: "test('polls', async () => { await vi.advanceTimersByTimeAsync(10_000); });",
      filename: testFile,
    },
    {
      code: "test('loads', async () => { await page.waitForResponse('/api/posts'); });",
      filename: testFile,
    },
  ],
  invalid: [
    {
      code: "test('polls', async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 11_000)); }); });",
      filename: testFile,
      errors: 1,
    },
    {
      code: "test('loads', async () => { await page.waitForTimeout(25); });",
      filename: testFile,
      errors: 1,
    },
  ],
});

ruleTester.run("landmines/no-conditional-expect", landmines.rules["no-conditional-expect"], {
  valid: [
    {
      code: "import { it as check, expect } from 'vite-plus/test'; check('works', () => { expect(result).toBe(true); });",
      filename: testFile,
    },
  ],
  invalid: [
    {
      code: "import { it as check, expect } from 'vite-plus/test'; check('works', () => { if (result) expect(result).toBe(true); });",
      filename: testFile,
      errors: 1,
    },
  ],
});

ruleTester.run("landmines/no-shared-signal", landmines.rules["no-shared-signal"], {
  valid: [
    {
      code: "test('loads', () => { const controller = new AbortController(); request(controller.signal); });",
      filename: testFile,
    },
  ],
  invalid: [
    {
      code: "const controller = new AbortController(); test('loads', () => request(controller.signal));",
      filename: testFile,
      errors: 1,
    },
  ],
});

ruleTester.run("landmines/no-imported-mutation", landmines.rules["no-imported-mutation"], {
  valid: [
    {
      code: "import { options } from './config'; const local = { ...options, enabled: true };",
      filename: testFile,
    },
  ],
  invalid: [
    {
      code: "import { options } from './config'; options.enabled = true;",
      filename: testFile,
      errors: 1,
    },
  ],
});

ruleTester.run("landmines/strict-msw", landmines.rules["strict-msw"], {
  valid: [
    {
      code: "import { setupServer as server } from 'msw/node'; const api = server(); api.listen({ onUnhandledRequest: 'error' });",
      filename: testFile,
    },
  ],
  invalid: [
    {
      code: "import { setupServer as server } from 'msw/node'; const api = server(); api.listen();",
      filename: testFile,
      errors: 1,
    },
  ],
});

it("enforces production guardrails through the pinned Vite+ lint command", () => {
  const directory = mkdtempSync(join(repositoryRoot, "frontend/app/src/lint-guardrails-"));
  const fixture = join(directory, "example.ts");
  const lint = (source) => {
    writeFileSync(fixture, source);
    return spawnSync(
      "bun",
      [
        "run",
        "--no-install",
        "vp",
        "lint",
        fixture,
        "--type-aware",
        "--deny-warnings",
        "--format",
        "json",
      ],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 120_000 },
    );
  };
  try {
    const invalid = lint(`
      export function run() { Promise.resolve(1); }
      export const values = [1, 2].reduce((all, value) => [...all, value], [] as number[]);
      export const forged = {} as unknown as { id: string };
    `);
    assert.equal(invalid.error, undefined);
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    const diagnostics = JSON.parse(invalid.stdout).diagnostics;
    for (const name of [
      "no-floating-promises",
      "no-accumulating-spread",
      "no-chained-type-assertions",
    ]) {
      assert.ok(
        diagnostics.some((diagnostic) => diagnostic.code?.includes(name)),
        invalid.stdout,
      );
    }
    const valid = lint(`
      export async function run() { await Promise.resolve(1); }
      export const values = [1, 2].map(value => value);
      export const typed = { id: 'post' } satisfies { id: string };
    `);
    assert.equal(valid.error, undefined);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
