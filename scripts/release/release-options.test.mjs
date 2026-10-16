import assert from "node:assert/strict";
import { test } from "node:test";

import { parseReleaseArguments } from "./release-options.mjs";

test("release options preserve repeated approval metadata and reject ambiguity", () => {
  const parsed = parseReleaseArguments(
    [
      "deploy",
      "--input",
      "release.json",
      "--iac-outputs",
      "outputs.json",
      "--phase",
      "api-update",
      "--step",
      "upload",
      "--approval-metadata",
      "release-approval.json",
      "--approval-metadata",
      "traffic-approval.json",
      "--plan-digest",
      "a".repeat(64),
      "--confirm",
      `release staging ${"b".repeat(40)}`,
      "--apply",
    ],
    {},
  );
  assert.equal(parsed.apply, true);
  assert.equal(parsed.phase, "api-update");
  assert.equal(parsed.step, "upload");
  assert.equal(parsed.approvalMetadata.length, 2);
  assert.throws(
    () =>
      parseReleaseArguments(["preflight", "--input", "first.json", "--input", "second.json"], {}),
    /--input may be specified only once/,
  );
});

test("release options allow only rollout percentages", () => {
  for (const percentage of ["5", "25", "50", "100"]) {
    assert.equal(
      parseReleaseArguments(
        [
          "deploy",
          "--input",
          "release.json",
          "--iac-outputs",
          "outputs.json",
          "--percentage",
          percentage,
        ],
        {},
      ).percentage,
      Number(percentage),
    );
  }
  assert.throws(
    () =>
      parseReleaseArguments(
        [
          "deploy",
          "--input",
          "release.json",
          "--iac-outputs",
          "outputs.json",
          "--percentage",
          "10",
        ],
        {},
      ),
    /must be 5, 25, 50, or 100/,
  );
});
