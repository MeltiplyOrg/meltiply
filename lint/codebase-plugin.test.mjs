import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { RuleTester } from "vite-plus/lint/plugins-dev";

import codebasePlugin from "./codebase-plugin.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const ruleTester = new RuleTester({ cwd: repositoryRoot });
const workerFile = `${repositoryRoot}workers/api/src/example.ts`;
const componentFile = `${repositoryRoot}frontend/app/src/components/example.tsx`;
const rule = (name) => codebasePlugin.rules[name];

ruleTester.run("meltiply/no-unknown-double-cast", rule("no-unknown-double-cast"), {
  valid: [
    { code: "const value = input as unknown;", filename: workerFile },
    { code: "const value = input as Record<string, string>;", filename: workerFile },
    { code: "const value = (input as unknown) satisfies unknown;", filename: workerFile },
  ],
  invalid: [
    {
      code: "const env = { DB: 1 } as unknown as ApiWorkerEnv;",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run(
  "meltiply/no-error-message-classification",
  rule("no-error-message-classification"),
  {
    valid: [
      { code: "if (cause instanceof TokenCiphertextError) handle();", filename: workerFile },
      { code: "if (labels.includes('verify')) handle();", filename: workerFile },
      { code: "const text = cause.message;", filename: workerFile },
    ],
    invalid: [
      {
        code: "if (error.message.includes('unknown key')) handle();",
        filename: workerFile,
        errors: [{ messageId: "restricted" }],
      },
      {
        code: "if (message.toLowerCase().includes('verify')) handle();",
        filename: workerFile,
        errors: [{ messageId: "restricted" }],
      },
      {
        code: "if (cause.message.toLowerCase().startsWith('timeout')) handle();",
        filename: workerFile,
        errors: [{ messageId: "restricted" }],
      },
      {
        code: "if (/rate limit/.test(cause.message)) handle();",
        filename: workerFile,
        errors: [{ messageId: "restricted" }],
      },
    ],
  },
);

ruleTester.run("meltiply/prefer-error-message-helper", rule("prefer-error-message-helper"), {
  valid: [
    { code: "const message = errorMessage(cause, 'Failed');", filename: workerFile },
    { code: "const value = cause instanceof Error ? cause : null;", filename: workerFile },
  ],
  invalid: [
    {
      code: "const message = cause instanceof Error ? cause.message : 'Failed';",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run("meltiply/no-platform-roster-literal", rule("no-platform-roster-literal"), {
  valid: [
    { code: "const pair = ['tiktok', 'youtube'];", filename: workerFile },
    { code: "const icons = [['tiktok', 'tiktok'], ['youtube', 'youtube']];", filename: workerFile },
    {
      code: "export const PLATFORM_IDS = ['tiktok', 'youtube', 'instagram', 'facebook', 'threads'];",
      filename: `${repositoryRoot}packages/domain/src/index.ts`,
    },
  ],
  invalid: [
    {
      code: "const platforms = ['tiktok', 'youtube', 'instagram', 'facebook', 'threads'];",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "const order = ['facebook', 'instagram', 'threads'];",
      filename: componentFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run("meltiply/no-sql-conditional-fragment", rule("no-sql-conditional-fragment"), {
  valid: [
    { code: "client.query(`SELECT 1 FROM t WHERE id = $1`, [id]);", filename: workerFile },
    { code: "client.query(lock ? lockedSql : plainSql, [id]);", filename: workerFile },
    { code: "client.query(`SELECT ${columns} FROM t`, []);", filename: workerFile },
  ],
  invalid: [
    {
      code: "client.query(`SELECT * FROM t WHERE id ${lock ? 'FOR UPDATE' : ''}`);",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "query(`SELECT * FROM t ${archived && 'WHERE deleted_at IS NOT NULL'}`);",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run("meltiply/no-codepoint-spread-length", rule("no-codepoint-spread-length"), {
  valid: [
    { code: "const count = codePointLength(text);", filename: workerFile },
    { code: "const count = [...a, ...b].length;", filename: workerFile },
    { code: "const count = text.length;", filename: workerFile },
  ],
  invalid: [
    {
      code: "const count = [...text].length;",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run("meltiply/no-json-parse-cast", rule("no-json-parse-cast"), {
  valid: [
    { code: "const parsed = JSON.parse(raw) as unknown;", filename: workerFile },
    { code: "const parsed: unknown = JSON.parse(raw);", filename: workerFile },
  ],
  invalid: [
    {
      code: "const parsed = JSON.parse(raw) as Partial<DevBoxState>;",
      filename: componentFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run("meltiply/no-time-derived-key", rule("no-time-derived-key"), {
  valid: [
    { code: "const entry = { key: `upload-${crypto.randomUUID()}` };", filename: componentFile },
    { code: "const label = `saved-${Date.now()}`;", filename: componentFile },
  ],
  invalid: [
    {
      code: "const entry = { key: `upload-${Date.now()}-${file.name}` };",
      filename: componentFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "const row = <li key={`row-${Date.now()}`} />;",
      filename: componentFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run("meltiply/no-history-comments", rule("no-history-comments"), {
  valid: [
    { code: "// Pools are reused per connection string.\nconst a = 1;", filename: workerFile },
    { code: "/** Lease claims are single-flight. */\nconst b = 2;", filename: workerFile },
  ],
  invalid: [
    {
      code: "// Deployed isolates retain pools (AUD-044).\nconst a = 1;",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "/* Compatibility for issue #256 rows. */\nconst b = 2;",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

const packageFile = `${repositoryRoot}packages/domain/src/example.ts`;
const scriptFile = `${repositoryRoot}scripts/ci/example.mjs`;

ruleTester.run("meltiply/no-export-star", rule("no-export-star"), {
  valid: [{ code: "export { a, type B } from './a';", filename: packageFile }],
  invalid: [
    { code: "export * from './a';", filename: packageFile, errors: [{ messageId: "restricted" }] },
  ],
});

ruleTester.run("meltiply/no-jsdoc-type-tags", rule("no-jsdoc-type-tags"), {
  valid: [
    { code: "/** Encrypts a token for storage. */\nexport function f() {}", filename: packageFile },
  ],
  invalid: [
    {
      code: "/**\n * Encrypts.\n * @param value - Plain text.\n */\nexport function f(value) {}",
      filename: packageFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "/** @returns {string} */\nfunction f() {}",
      filename: scriptFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run(
  "meltiply/no-doc-comment-outside-package-contract",
  rule("no-doc-comment-outside-package-contract"),
  {
    valid: [
      {
        code: "/** Encrypts a token for storage. */\nexport function f() {}",
        filename: packageFile,
      },
      { code: "/** @license MIT */\nconst a = 1;", filename: workerFile },
      { code: "// Vendor rejects batches above 50 items.\nconst a = 1;", filename: workerFile },
      {
        code: "/** Vendored chart. */\nexport const a = 1;",
        filename: `${repositoryRoot}frontend/app/src/components/evilcharts/chart.tsx`,
      },
    ],
    invalid: [
      {
        code: "/** Loads the user. */\nexport function f() {}",
        filename: workerFile,
        errors: [{ messageId: "restricted" }],
      },
      {
        code: "/** Internal helper. */\nfunction f() {}",
        filename: packageFile,
        errors: [{ messageId: "restricted" }],
      },
    ],
  },
);

ruleTester.run("meltiply/no-banner-comments", rule("no-banner-comments"), {
  valid: [
    { code: "// Vendor rejects batches above 50 items.\nconst a = 1;", filename: workerFile },
  ],
  invalid: [
    {
      code: "// ---------------------------------\nconst a = 1;",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "// ===== Helpers =====\nconst a = 1;",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run("meltiply/no-commented-out-code", rule("no-commented-out-code"), {
  valid: [
    { code: "// Vendor rejects batches above 50 items.\nconst a = 1;", filename: workerFile },
    { code: "// prettier-ignore\nconst a = 1;", filename: workerFile },
  ],
  invalid: [
    {
      code: "// const legacy = load();\nconst a = 1;",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "// await client.query(sql);\nconst a = 1;",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run("meltiply/no-sql-date-column", rule("no-sql-date-column"), {
  valid: [
    {
      code: "client.query(`SELECT (at AT TIME ZONE 'UTC')::date::text AS day FROM t`);",
      filename: workerFile,
    },
    { code: "client.query(`SELECT $1::date FROM t`);", filename: workerFile },
  ],
  invalid: [
    {
      code: "client.query(`SELECT date_trunc('day', at)::date AS day FROM t`);",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      code: "const fragment = 'SELECT at::date as day';",
      filename: workerFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

ruleTester.run("meltiply/no-workerd-fs-module-cache", rule("no-workerd-fs-module-cache"), {
  valid: [
    {
      code: "import { defineConfig } from 'vite-plus'; export default defineConfig({ test: { fsModuleCache: true } });",
      filename: `${repositoryRoot}frontend/app/vitest.config.ts`,
    },
    {
      code: "import { cloudflareTest } from '@cloudflare/vitest-plugin'; export default { test: { clearMocks: false } };",
      filename: `${repositoryRoot}workers/state/vitest.config.ts`,
    },
  ],
  invalid: [
    {
      code: "import { cloudflareTest } from '@cloudflare/vitest-plugin'; export default { test: { fsModuleCache: true } };",
      filename: `${repositoryRoot}workers/state/vitest.config.ts`,
      errors: [{ messageId: "restricted" }],
    },
  ],
});
