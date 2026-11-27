import { describe, expect, it } from "vite-plus/test";

import { attachmentOverridesFromPost, clampCaption, publishModeAction } from "./composer-content";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type { Post } from "@/types";

const post = contractSuccessBody<Post>("getPost");
const target = post.targets[0]!;

describe("clampCaption", () => {
  it.each([
    ["no limit", "x".repeat(20), null, "x".repeat(20)],
    ["a caption under the limit", "abc", 12, "abc"],
    ["a caption exactly at the limit", "x".repeat(12), 12, "x".repeat(12)],
    ["a caption over the limit", "x".repeat(20), 12, "x".repeat(12)],
    ["emoji counted as one character each", "🎉".repeat(15), 12, "🎉".repeat(12)],
    ["a limit of zero", "abc", 0, ""],
  ])("%s", (_example, text, limit, clamped) => {
    expect(clampCaption(text, limit)).toEqual(clamped);
  });
});

describe("publishModeAction", () => {
  it.each([
    ["a new draft", "draft", null, "Save Draft"],
    ["an existing draft", "draft", "post-1", "Save"],
    ["a schedule", "schedule", null, "Schedule Post"],
    ["a queue", "queue", null, "Add to Queue"],
    ["publishing now", "now", null, "Publish Now"],
  ] as const)("%s", (_example, mode, postId, label) => {
    expect(publishModeAction(mode, postId, (message) => message)).toEqual(label);
  });
});

describe("attachmentOverridesFromPost", () => {
  it.each([
    ["a target with its own selection", ["asset-1"], { account: ["asset-1"] }],
    ["a target with an empty selection", [], { account: [] }],
    ["a target that inherits", null, {}],
  ])("%s", (_example, attachment_ids, overrides) => {
    const source = {
      ...post,
      targets: [{ ...target, platform_account_id: "account", attachment_ids }],
    };

    expect(attachmentOverridesFromPost(source)).toEqual(overrides);
  });

  it("no targets", () => {
    expect(attachmentOverridesFromPost({ ...post, targets: [] })).toEqual({});
  });
});
