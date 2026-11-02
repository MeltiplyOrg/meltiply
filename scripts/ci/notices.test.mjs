import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildNoticeBundle, parseNoticeArgs } from "./notices.mjs";

const script = fileURLToPath(new URL("./notices.mjs", import.meta.url));

// A distributed bundle must carry runtime notices and must not inherit the
// development-only tools that the production graph deliberately excludes.
// Package presence is the contract; exact versions are not, because a routine
// dependency bump must not require editing this test.
test("notice bundle covers runtime dependencies and excludes development tools", () => {
  const text = buildNoticeBundle("frontend/public");
  assert.match(text, /^Meltiply — Third-party notices/m);
  assert.match(text, /^License: GNU Affero General Public License v3\.0 or later$/m);
  for (const dependency of ["react", "dompurify", "fumadocs-ui"]) {
    assert.match(
      text,
      new RegExp(`^${dependency}@\\S+$`, "m"),
      `${dependency} must appear as an installed production dependency`,
    );
  }
  // Copied and adapted interface code is listed by name even where it is not an
  // installed package, so those sections are asserted by heading.
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

// Byte-for-byte stability keeps generated notice changes reviewable. The
// comparison must cross process boundaries: a single process cannot observe
// hash- or filesystem-order nondeterminism that the other invocation would.
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

// The CLI must fail closed instead of writing a partial or default destination.
test("notice CLI requires both project and output paths", () => {
  assert.throws(() => parseNoticeArgs([]), /usage/);
  assert.throws(() => parseNoticeArgs(["--project", "frontend/app"]), /usage/);
  assert.throws(() => parseNoticeArgs(["--project", "frontend/app", "--bogus", "x"]), /usage/);
  assert.deepEqual(parseNoticeArgs(["--project", "frontend/app", "--output", "out.txt"]), {
    project: "frontend/app",
    output: "out.txt",
  });
});
