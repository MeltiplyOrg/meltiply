import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNoticeBundle, parseNoticeArgs } from "./notices.mjs";

// A distributed bundle must carry runtime notices and must not inherit the
// development-only tools that the production graph deliberately excludes.
test("notice bundle covers runtime dependencies and excludes development tools", () => {
  const text = buildNoticeBundle("frontend/public");
  assert.match(text, /^Meltiply — Third-party notices/m);
  assert.match(text, /Sustainable Use License 1\.0/);
  assert.match(text, /^react@19\.2\.4$/m);
  assert.match(text, /^dompurify@3\.4\.17$/m);
  assert.match(text, /^fumadocs-ui@/m);
  assert.match(text, /shadcn\/ui/);
  assert.match(text, /^sileo$/m);
  assert.match(text, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.doesNotMatch(text, /^agentation@/m);
  assert.doesNotMatch(text, /^react-doctor@/m);
});

// Byte-for-byte stability keeps generated notice changes reviewable and lets
// CI detect a stale checked-in bundle without a timestamp.
test("notice bundle is deterministic", () => {
  assert.equal(buildNoticeBundle("frontend/app"), buildNoticeBundle("frontend/app"));
});

// The CLI must fail closed instead of writing a partial or default destination.
test("notice CLI requires both project and output paths", () => {
  assert.throws(() => parseNoticeArgs([]), /usage/);
  assert.throws(() => parseNoticeArgs(["--project", "frontend/app"]), /usage/);
  assert.deepEqual(parseNoticeArgs(["--project", "frontend/app", "--output", "out.txt"]), {
    project: "frontend/app",
    output: "out.txt",
  });
});
