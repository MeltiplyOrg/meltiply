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
