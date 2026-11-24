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

ruleTester.run("landmines/no-unsignaled-poll", landmines.rules["no-unsignaled-poll"], {
  valid: [
    {
      code: "test('saves', async () => { await recorder.waitForSaveAfter(seen); expect(mutations.length).toBe(seen + 1); });",
      filename: testFile,
    },
    {
      code: "test('renders', async () => { await expect.poll(() => view.current.status).toBe('ready'); });",
      filename: testFile,
    },
  ],
  invalid: [
    {
      code: "test('saves', async () => { await expect.poll(() => mutations.length).toBeGreaterThan(seen); });",
      filename: testFile,
      errors: 1,
    },
  ],
});

ruleTester.run("landmines/no-silent-catch", landmines.rules["no-silent-catch"], {
  valid: [
    {
      code: "async function cleanup() { await reader.cancel().catch(() => undefined); }",
      filename: `${repositoryRoot}frontend/app/src/components/composer/example.ts`,
    },
    {
      code: "void save().catch(error => report(error));",
      filename: `${repositoryRoot}frontend/app/src/components/composer/example.ts`,
    },
  ],
  invalid: [
    {
      code: "void save().catch(() => {});",
      filename: `${repositoryRoot}frontend/app/src/components/composer/example.ts`,
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

const guardrailCases = [
  {
    name: "production promise, assertion, and allocation checks",
    directory: "frontend/app/src/components/composer",
    filename: "example.ts",
    invalid: `
      export function run() { Promise.resolve(1); }
      export const values = [1, 2].reduce((all, value) => [...all, value], [] as number[]);
      export const forged = {} as unknown as { id: string };
      export function hideFailure() { void Promise.reject(new Error()).catch(() => {}); }
    `,
    valid: `
      export async function run() { await Promise.resolve(1); }
      export const values = [1, 2].map(value => value);
      export const typed = { id: 'post' } satisfies { id: string };
    `,
    rules: [
      "no-floating-promises",
      "no-accumulating-spread",
      "no-chained-type-assertions",
      "no-silent-catch",
    ],
  },
  {
    name: "cache sleep, signal isolation, and MSW checks",
    directory: "frontend/app/src/lib",
    filename: "browser-cache.test.tsx",
    invalid: `
      import { it, vi } from 'vite-plus/test';
      import { setupServer } from 'msw/node';
      vi.useFakeTimers({ toFake: ['Date'] });
      const controller = new AbortController();
      setupServer().listen();
      it('waits', async () => {
        await new Promise(resolve => setTimeout(resolve, 11_000));
        controller.abort();
      });
    `,
    valid: `
      import { it, vi } from 'vite-plus/test';
      import { setupServer } from 'msw/node';
      setupServer().listen({ onUnhandledRequest: 'error' });
      it('advances time', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        await vi.advanceTimersByTimeAsync(10_000);
        controller.abort();
      });
    `,
    rules: ["no-promise-sleep", "no-shared-signal", "strict-msw"],
  },
  {
    name: "browser completion-signal checks",
    directory: "frontend/app/e2e",
    filename: "posts-composer.spec.ts",
    invalid: `
      import { test, expect } from '@playwright/test';
      test('saves', async ({ page }) => {
        const mutations: string[] = [];
        await page.waitForTimeout(25);
        await expect.poll(() => mutations.length).toBeGreaterThan(0);
      });
    `,
    valid: `
      import { test, expect } from '@playwright/test';
      test('saves', async ({ page }) => {
        const saved = page.waitForResponse(response => response.url().endsWith('/posts'));
        await page.getByRole('button', { name: 'Save' }).click();
        expect((await saved).ok()).toBe(true);
      });
    `,
    rules: ["no-fixed-sleep", "no-unsignaled-poll"],
  },
];

for (const scenario of guardrailCases) {
  it(`registers ${scenario.name} through the pinned Vite+ lint command`, () => {
    const directory = mkdtempSync(join(repositoryRoot, scenario.directory, "lint-guardrails-"));
    const fixture = join(directory, scenario.filename);
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
      const invalid = lint(scenario.invalid);
      assert.equal(invalid.error, undefined);
      assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
      const diagnostics = JSON.parse(invalid.stdout).diagnostics;
      for (const name of scenario.rules) {
        assert.ok(
          diagnostics.some((diagnostic) => diagnostic.code?.includes(name)),
          invalid.stdout,
        );
      }
      const valid = lint(scenario.valid);
      assert.equal(valid.error, undefined);
      assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
