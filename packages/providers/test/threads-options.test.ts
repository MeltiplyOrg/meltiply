import { describe, expect, it } from "vite-plus/test";

import {
  applyThreadsOptions,
  parseThreadsOptions,
  parseThreadsPostOptions,
  threadsOptionsIssue,
  type ThreadsPublishOptions,
} from "../src/threads/options";

const bold = (offset: number, length: number) => ({ offset, length, styling_info: ["bold"] });
const spoiler = (offset: number, length: number) => ({ entity_type: "SPOILER", offset, length });
const styled = (...spans: object[]) => ({
  text_attachment: { plaintext: "0123456789", text_with_styling_info: spans },
});

describe("parseThreadsPostOptions", () => {
  it.each([
    ["no options", {}],
    ["an unfinished poll draft", { post_type: "poll", poll_attachment: { option_a: "" } }],
    [
      "every kind of field",
      {
        post_type: "post",
        reply_control: "everyone",
        topic_tag: "news",
        is_spoiler_media: true,
        allowlisted_country_codes: ["GB", "VN"],
        gif_attachment: { provider: "GIPHY" },
        text_attachment: { plaintext: "x", text_with_styling_info: [bold(0, 1)] },
        text_entities: [spoiler(0, 500)],
      },
    ],
  ])("keeps %s", (_example, value) => {
    expect(parseThreadsPostOptions(value)).toEqual(value);
  });

  it.each([
    ["a list", []],
    ["an unknown key", { music: 1 }],
    ["a topic tag of 51 characters", { topic_tag: "a".repeat(51) }],
    ["a flag that is not boolean", { is_ghost_post: "yes" }],
    ["an unknown post type", { post_type: "story" }],
    ["an unknown reply control", { reply_control: "nobody" }],
    ["no country code", { allowlisted_country_codes: [] }],
    ["a repeated country code", { allowlisted_country_codes: ["GB", "GB"] }],
    ["a lowercase country code", { allowlisted_country_codes: ["gb"] }],
    ["a fifth poll option", { poll_attachment: { option_e: "x" } }],
    ["a poll option of 26 characters", { poll_attachment: { option_a: "a".repeat(26) } }],
    ["a GIF from another provider", { gif_attachment: { provider: "TENOR" } }],
    [
      "a GIF ID of 201 characters",
      { gif_attachment: { provider: "GIPHY", gif_id: "a".repeat(201) } },
    ],
    ["long text of 10001 characters", { text_attachment: { plaintext: "a".repeat(10_001) } }],
    ["a styled span past 10000", styled(bold(9_999, 2))],
    ["a span of zero length", styled(bold(0, 0))],
    ["a span without a style", styled({ offset: 0, length: 1, styling_info: [] })],
    ["an unknown style", styled({ offset: 0, length: 1, styling_info: ["blink"] })],
    ["a repeated style", styled({ offset: 0, length: 1, styling_info: ["bold", "bold"] })],
    ["101 styled spans", styled(...Array.from({ length: 101 }, () => bold(0, 1)))],
    ["eleven spoilers", { text_entities: Array.from({ length: 11 }, () => spoiler(0, 1)) }],
    ["an unknown entity type", { text_entities: [{ entity_type: "LINK", offset: 0, length: 1 }] }],
    ["a spoiler past 500", { text_entities: [spoiler(500, 1)] }],
  ])("refuses %s", (_example, value) => {
    expect(parseThreadsPostOptions(value)).toEqual(null);
  });
});

describe("parseThreadsOptions", () => {
  it.each([
    ["no options", {}],
    [
      "IDs, a tag and a secure link",
      { reply_to_id: "a_1-2", topic_tag: "news", link_attachment: "https://a.test" },
    ],
    [
      "a full poll",
      { poll_attachment: { option_a: "a", option_b: "b", option_c: "c", option_d: "d" } },
    ],
    ["a two-option poll", { poll_attachment: { option_a: "a", option_b: "b" } }],
    ["a GIF", { gif_attachment: { provider: "GIPHY", gif_id: "g" } }],
    [
      "long text with a link and adjacent spans",
      {
        text_attachment: {
          plaintext: "0123456789",
          link_attachment_url: "https://a.test",
          text_with_styling_info: [bold(0, 5), bold(5, 5)],
        },
      },
    ],
  ])("keeps %s", (_example, value) => {
    expect(parseThreadsOptions(value)).toEqual(value);
  });

  it.each([
    ["an unusable draft", { music: 1 }],
    ["a blank value", { alt_text: " " }],
    ["an ID with a space", { quote_post_id: "a b" }],
    ["a topic tag with a dot", { topic_tag: "a.b" }],
    ["an http link", { link_attachment: "http://a.test" }],
    ["a poll without a second option", { poll_attachment: { option_a: "a" } }],
    [
      "a blank third poll option",
      { poll_attachment: { option_a: "a", option_b: "b", option_c: " " } },
    ],
    [
      "a fourth option without a third",
      { poll_attachment: { option_a: "a", option_b: "b", option_d: "d" } },
    ],
    ["a GIF without an ID", { gif_attachment: { provider: "GIPHY" } }],
    ["long text without plaintext", { text_attachment: {} }],
    [
      "an http long-text link",
      { text_attachment: { plaintext: "a", link_attachment_url: "http://a.test" } },
    ],
    ["a span past the plaintext", styled(bold(9, 2))],
    ["overlapping spans", styled(bold(0, 5), bold(4, 2))],
  ])("refuses %s", (_example, value) => {
    expect(parseThreadsOptions(value)).toEqual(null);
  });
});

describe("threadsOptionsIssue", () => {
  const incomplete = "Complete the selected Threads publishing method before sending.";
  const textOnly =
    "Polls, GIFs, long-text attachments, ghosts, and link attachments require a text-only Post.";
  const ghost =
    "A ghost Post supports only text and text spoilers, not replies, quotes, or attachments.";
  const gif = { provider: "GIPHY", gif_id: "g" } as const;
  const poll = { option_a: "a", option_b: "b" };

  it.each([
    ["no options", {}, "caption", 0],
    ["a bare repost", { post_type: "repost", repost_id: "1" }, "  ", 0],
    ["alt text with media", { alt_text: "a" }, "caption", 1],
    [
      "a spoiler ending with the caption",
      { text_entities: [{ entity_type: "SPOILER", offset: 0, length: 7 }] },
      "caption",
      0,
    ],
  ] as const)("accepts %s", (_example, options, caption, media) => {
    expect(threadsOptionsIssue(options as ThreadsPublishOptions, caption, media)).toEqual(null);
  });

  it.each([
    ["a poll method without a poll", { post_type: "poll" }, "", 0, incomplete],
    ["a GIF method without a GIF", { post_type: "gif" }, "", 0, incomplete],
    ["a long-text method without text", { post_type: "long_text" }, "", 0, incomplete],
    ["a quote method without a quote", { post_type: "quote" }, "", 0, incomplete],
    ["a reply method without a reply", { post_type: "reply" }, "", 0, incomplete],
    ["a repost method without a source", { post_type: "repost" }, "", 0, incomplete],
    ["a ghost method without the flag", { post_type: "ghost" }, "", 0, incomplete],
    [
      "a repost with a caption",
      { repost_id: "1" },
      "hi",
      0,
      "A repost requires only the source Post ID, with no caption, attachments, or other options.",
    ],
    [
      "a poll with a GIF",
      { poll_attachment: poll, gif_attachment: gif },
      "",
      0,
      "Polls, GIFs, and long-text attachments cannot be combined.",
    ],
    ["a GIF with media", { gif_attachment: gif }, "", 1, textOnly],
    ["a link with media", { link_attachment: "https://a.test" }, "", 1, textOnly],
    [
      "alt text without media",
      { alt_text: "a" },
      "",
      0,
      "Alt text and media spoilers require an image or video.",
    ],
    ["a ghost reply", { is_ghost_post: true, reply_to_id: "1" }, "hi", 0, ghost],
    [
      "two long-text links",
      {
        link_attachment: "https://a.test",
        text_attachment: { plaintext: "a", link_attachment_url: "https://b.test" },
      },
      "",
      0,
      "Choose one link attachment, not links on both the Post and its long text.",
    ],
    [
      "both cross-share appearances",
      { crossreshare_to_ig: true, crossreshare_to_ig_dark_mode: true },
      "hi",
      0,
      "Choose one Instagram Story cross-share appearance.",
    ],
    [
      "a quoted reply",
      { quote_post_id: "1", reply_to_id: "2" },
      "hi",
      0,
      "A Post cannot be both a reply and a quote.",
    ],
    [
      "a spoiler past the caption",
      { text_entities: [{ entity_type: "SPOILER", offset: 0, length: 8 }] },
      "caption",
      0,
      "A spoiler range extends beyond the caption.",
    ],
  ] as const)("reports %s", (_example, options, caption, media, issue) => {
    expect(threadsOptionsIssue(options as ThreadsPublishOptions, caption, media)).toEqual(issue);
  });
});

describe("applyThreadsOptions", () => {
  it("every kind of value", () => {
    const parameters = new URLSearchParams();

    applyThreadsOptions(parameters, {
      post_type: "post",
      repost_id: "1",
      topic_tag: "news",
      is_spoiler_media: false,
      allowlisted_country_codes: ["GB", "VN"],
      poll_attachment: { option_a: "a", option_b: "b" },
      alt_text: undefined,
    });

    expect([...parameters]).toEqual([
      ["topic_tag", "news"],
      ["is_spoiler_media", "false"],
      ["allowlisted_country_codes", "GB,VN"],
      ["poll_attachment", '{"option_a":"a","option_b":"b"}'],
    ]);
  });
});
