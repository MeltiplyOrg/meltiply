import { describe, expect, it } from "vite-plus/test";

import {
  applyInstagramContent,
  defaultInstagramPostType,
  parseInstagramContent,
  resolveInstagramOptions,
  type InstagramContentOptions,
} from "../src/instagram/options";
import type { InstagramPublishOptions } from "../src/types";

const manual = { trialGraduation: "manual", trialReel: false };

describe("parseInstagramContent", () => {
  it.each([
    ["no fields", {}],
    [
      "every field",
      {
        alt_text: "a",
        audio_name: "b",
        cover_url: "https://a.test",
        location_id: "1",
        share_to_feed: true,
        is_ai_generated: false,
        thumb_offset: 0,
        collaborators: ["a", "b", "c"],
        user_tags: [{ username: "a", x: 0, y: 1 }],
      },
    ],
    ["alt text of 1000 emoji", { alt_text: "🚀".repeat(1000) }],
    ["twenty user tags", { user_tags: Array.from({ length: 20 }, () => ({ username: "a" })) }],
  ])("keeps %s", (_example, value) => {
    expect(parseInstagramContent(value)).toEqual(value);
  });

  it.each([
    ["a value that is not an object", "x"],
    ["an unknown key", { music: "x" }],
    ["alt text of 1001 characters", { alt_text: "a".repeat(1001) }],
    ["an audio name that is not text", { audio_name: 1 }],
    ["a flag that is not boolean", { share_to_feed: "yes" }],
    ["a negative thumbnail offset", { thumb_offset: -1 }],
    ["collaborators that are not a list", { collaborators: "a" }],
    ["four collaborators", { collaborators: ["a", "b", "c", "d"] }],
    ["a repeated collaborator", { collaborators: ["a", "a"] }],
    ["a collaborator of 31 characters", { collaborators: ["a".repeat(31)] }],
    ["twenty-one user tags", { user_tags: Array.from({ length: 21 }, () => ({ username: "a" })) }],
    ["a tag that is not an object", { user_tags: ["a"] }],
    ["a tag with an unknown key", { user_tags: [{ username: "a", z: 1 }] }],
    ["a tag without a username", { user_tags: [{ x: 0 }] }],
    ["a tag username of 31 characters", { user_tags: [{ username: "a".repeat(31) }] }],
    ["a coordinate under zero", { user_tags: [{ username: "a", x: -0.1 }] }],
    ["a coordinate over one", { user_tags: [{ username: "a", y: 1.1 }] }],
  ])("refuses %s", (_example, value) => {
    expect(parseInstagramContent(value)).toEqual(null);
  });
});

describe("instagramContentIssue", () => {
  it.each<
    readonly [
      string,
      InstagramContentOptions | undefined,
      "image" | "video",
      "feed" | "reel" | "story",
      boolean,
    ]
  >([
    ["no options", undefined, "image", "feed", false],
    ["alt text on an image", { alt_text: "a" }, "image", "feed", false],
    [
      "tags on a carousel child",
      { user_tags: [{ username: "a", x: 0, y: 0 }] },
      "image",
      "feed",
      true,
    ],
    [
      "Reel-only fields on a Reel",
      { cover_url: "https://a.test", audio_name: "n", share_to_feed: true },
      "video",
      "reel",
      false,
    ],
    [
      "a Story mention without coordinates",
      { user_tags: [{ username: "a" }] },
      "image",
      "story",
      false,
    ],
    ["a video tag without coordinates", { user_tags: [{ username: "a" }] }, "video", "reel", false],
  ])("accepts %s", (_example, content, kind, postType, child) => {
    const publishOptions: InstagramPublishOptions = child
      ? { mediaOptions: content ? [content] : [], postType }
      : { content, postType };
    const kinds = child ? ([kind, kind] as const) : ([kind] as const);
    expect(resolveInstagramOptions(publishOptions, kinds)).toEqual({
      ...manual,
      postType,
    });
  });

  it.each<
    readonly [
      string,
      InstagramContentOptions,
      "image" | "video",
      "feed" | "reel" | "story",
      boolean,
      string,
    ]
  >([
    [
      "unusable metadata",
      { music: 1 } as InstagramContentOptions,
      "image",
      "feed",
      false,
      "Instagram content metadata is invalid.",
    ],
    [
      "a location on a carousel child",
      { location_id: "1" },
      "image",
      "feed",
      true,
      "Carousel item metadata supports only alt text and user tags.",
    ],
    [
      "alt text on a Story",
      { alt_text: "a" },
      "image",
      "story",
      false,
      "Stories support user mentions, not feed metadata, captions, or Reel cover options.",
    ],
    [
      "alt text on a video",
      { alt_text: "a" },
      "video",
      "reel",
      false,
      "Alt text requires an image; carousel images use their per-item metadata.",
    ],
    [
      "a cover on a feed post",
      { cover_url: "https://a.test" },
      "video",
      "feed",
      false,
      "Cover images, original-audio names, and share-to-feed apply only to Reels.",
    ],
    [
      "a thumbnail offset on an image",
      { thumb_offset: 1 },
      "image",
      "feed",
      false,
      "Thumbnail offset requires a video.",
    ],
    [
      "an http cover",
      { cover_url: "http://a.test" },
      "video",
      "reel",
      false,
      "The Reel cover must be a credential-free HTTPS image URL.",
    ],
    [
      "a blank audio name",
      { audio_name: " " },
      "video",
      "reel",
      false,
      "The original-audio name cannot be blank.",
    ],
    [
      "a location that is not numeric",
      { location_id: "abc" },
      "image",
      "feed",
      false,
      "Instagram requires a numeric Facebook location ID.",
    ],
    [
      "a collaborator with a space",
      { collaborators: ["a b"] },
      "image",
      "feed",
      false,
      "Collaborators require valid Instagram usernames.",
    ],
    [
      "an image tag without coordinates",
      { user_tags: [{ username: "a" }] },
      "image",
      "feed",
      false,
      "Image user tags require a username and normalized x/y coordinates.",
    ],
    [
      "a tag username with a space",
      { user_tags: [{ username: "a b", x: 0, y: 0 }] },
      "image",
      "feed",
      false,
      "Image user tags require a username and normalized x/y coordinates.",
    ],
  ])("reports %s", (_example, content, kind, postType, child, _issue) => {
    const publishOptions: InstagramPublishOptions = child
      ? { mediaOptions: [content], postType }
      : { content, postType };
    const kinds = child ? ([kind, kind] as const) : ([kind] as const);
    expect(resolveInstagramOptions(publishOptions, kinds)).toEqual(null);
  });
});

describe("applyInstagramContent", () => {
  it("every kind of value", () => {
    const parameters = new URLSearchParams();

    applyInstagramContent(parameters, {
      alt_text: "a",
      share_to_feed: false,
      collaborators: ["b"],
      location_id: undefined,
    });

    expect([...parameters]).toEqual([
      ["alt_text", "a"],
      ["share_to_feed", "false"],
      ["collaborators", '["b"]'],
    ]);
  });

  it("no options", () => {
    const parameters = new URLSearchParams();

    applyInstagramContent(parameters, undefined);

    expect([...parameters]).toEqual([]);
  });
});

describe("defaultInstagramPostType", () => {
  it.each([
    ["one video", ["video"], "reel"],
    ["one image", ["image"], "feed"],
    ["two videos", ["video", "video"], "feed"],
    ["no attachment", [], "feed"],
  ] as const)("%s", (_example, kinds, postType) => {
    expect(defaultInstagramPostType(kinds)).toEqual(postType);
  });
});

describe("resolveInstagramOptions", () => {
  it.each([
    ["one video by default", undefined, ["video"], { postType: "reel", ...manual }],
    ["a carousel by default", {}, ["image", "video"], { postType: "feed", ...manual }],
    ["a Story", { postType: "story" }, ["image"], { postType: "story", ...manual }],
    [
      "a trial Reel graduating on performance",
      { trialReel: true, trialGraduation: "performance" },
      ["video"],
      { postType: "reel", trialGraduation: "performance", trialReel: true },
    ],
    [
      "metadata for each carousel item",
      { mediaOptions: [{ alt_text: "a" }, {}] },
      ["image", "image"],
      { postType: "feed", ...manual },
    ],
  ] as const)("%s", (_example, options, kinds, resolved) => {
    expect(resolveInstagramOptions(options as InstagramPublishOptions, kinds)).toEqual(resolved);
  });

  it.each([
    ["an unknown method", { postType: "igtv" }, ["video"]],
    ["no attachment", {}, []],
    ["a Story of two items", { postType: "story" }, ["image", "image"]],
    ["a carousel Reel", { postType: "reel" }, ["video", "video"]],
    ["an image Reel", { postType: "reel" }, ["image"]],
    ["a trial feed post", { trialReel: true }, ["image"]],
    ["a graduation without a trial", { trialGraduation: "manual" }, ["video"]],
    ["an unknown graduation", { trialReel: true, trialGraduation: "never" }, ["video"]],
    ["more item metadata than items", { mediaOptions: [{}, {}] }, ["image"]],
    ["unusable post metadata", { content: { alt_text: "a" } }, ["video"]],
    ["unusable item metadata", { mediaOptions: [{}, { location_id: "1" }] }, ["image", "image"]],
  ] as const)("refuses %s", (_example, options, kinds) => {
    expect(resolveInstagramOptions(options as InstagramPublishOptions, kinds)).toEqual(null);
  });
});
