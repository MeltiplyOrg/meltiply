import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildNoticeBundle, parseNoticeArgs } from "./notices.mjs";

const script = fileURLToPath(new URL("./notices.mjs", import.meta.url));

test("notice bundle covers runtime dependencies and excludes development tools", () => {
  const text = buildNoticeBundle("frontend/public");
  assert.match(text, /^Meltiply — Third-party notices/m);
  assert.match(text, /^License: GNU Affero General Public License v3\.0 or later$/m);
  for (const dependency of ["react", "astro", "fumadocs-ui"]) {
    assert.match(
      text,
      new RegExp(`^${dependency}@\\S+$`, "m"),
      `${dependency} must appear as an installed production dependency`,
    );
  }
  assert.match(text, /^Copied interface code$/m);
  for (const copied of ["shadcn/ui", "sileo", "Lucide \\/ Feather", "Gr8r Studio"]) {
    assert.match(text, new RegExp(`^${copied}$`, "m"));
  }
  assert.match(text, /GNU LESSER GENERAL PUBLIC LICENSE/);
  for (const developmentOnly of ["agentation", "react-doctor"]) {
    assert.doesNotMatch(
      text,
      new RegExp(`^${developmentOnly}@`, "m"),
      `${developmentOnly} is development-only and must not ship notices`,
    );
  }
});

test("notice bundle is deterministic across processes", () => {
  const render = () =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { buildNoticeBundle } from ${JSON.stringify(pathToFileURL(script).href)};
         process.stdout.write(buildNoticeBundle("frontend/app"));`,
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  assert.equal(render(), render());
});

test("notice CLI requires both project and output paths", () => {
  assert.throws(() => parseNoticeArgs([]), /usage/);
  assert.throws(() => parseNoticeArgs(["--project", "frontend/app"]), /usage/);
  assert.throws(() => parseNoticeArgs(["--project", "frontend/app", "--bogus", "x"]), /usage/);
  assert.deepEqual(parseNoticeArgs(["--project", "frontend/app", "--output", "out.txt"]), {
    project: "frontend/app",
    output: "out.txt",
  });
});
