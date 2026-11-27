import { describe, expect, it } from "vite-plus/test";

import {
  carouselItemParameters,
  instagramAttachment,
  instagramPublishPlan,
  instagramPublishWarnings,
  singleParameters,
} from "../src/instagram/publication";
import type { ProviderMedia, PublishInput } from "../src/types";
import { failureThrownBy, refused } from "./support";

const URL_ = "https://assets.example/a";
const media = (contentType: string, fileSize = 100, url = URL_): ProviderMedia => ({
  contentType,
  fileSize,
  mode: "remote_ingest",
  url,
});
const input = (patch: Partial<PublishInput> = {}): PublishInput => ({
  caption: " hello ",
  hashtags: [],
  idempotencyKey: "k",
  media: [media("image/jpeg")],
  ...patch,
});
const image = { kind: "image", url: URL_ } as const;
const video = { kind: "video", url: URL_ } as const;
const shape = (postType: "feed" | "reel" | "story", trialReel = false) => ({
  postType,
  trialGraduation: "manual" as const,
  trialReel,
});

describe("instagramAttachment", () => {
  it.each([
    ["a JPEG image", media("image/jpeg"), "feed", image],
    ["an MP4 video", media("video/mp4"), "feed", video],
    ["a QuickTime video with parameters", media("VIDEO/QUICKTIME; x=1"), "feed", video],
    ["an image of 8 MiB", media("image/jpeg", 8_388_608), "feed", image],
    ["a feed video of 500 MiB", media("video/mp4", 524_288_000), "feed", video],
    ["a Reel of 300 MB", media("video/mp4", 300_000_000), "reel", video],
    ["a Story video of 100 MB", media("video/mp4", 100_000_000), "story", video],
  ])("%s", (_example, value, postType, attachment) => {
    expect(instagramAttachment(value, postType)).toEqual(attachment);
  });

  it.each([
    ["an image one byte over", media("image/jpeg", 8_388_609), "feed"],
    ["a feed video one byte over", media("video/mp4", 524_288_001), "feed"],
    ["a Reel one byte over", media("video/mp4", 300_000_001), "reel"],
    ["a Story video one byte over", media("video/mp4", 100_000_001), "story"],
    ["an empty file", media("image/jpeg", 0), "feed"],
    ["a PNG image", media("image/png"), "feed"],
    ["an insecure URL", media("image/jpeg", 100, "http://assets.example/a"), "feed"],
  ])("refuses %s", (_example, value, postType) => {
    expect(failureThrownBy(() => instagramAttachment(value, postType))).toEqual(
      refused("instagram_media_invalid"),
    );
  });

  it("refuses streamed media", () => {
    const stream: ProviderMedia = {
      body: new ReadableStream<Uint8Array>(),
      contentType: "video/mp4",
      fileSize: 1,
      mode: "byte_upload",
    };

    expect(failureThrownBy(() => instagramAttachment(stream, "feed"))).toEqual(
      refused("instagram_remote_media_required"),
    );
  });
});

describe("instagramPublishPlan", () => {
  it("a single image", () => {
    expect(instagramPublishPlan(input())).toEqual({
      attachments: [image],
      options: shape("feed"),
      text: "hello",
    });
  });

  it("a single video becomes a Reel", () => {
    expect(instagramPublishPlan(input({ media: [media("video/mp4")] }))).toEqual({
      attachments: [video],
      options: shape("reel"),
      text: "hello",
    });
  });

  it.each([
    ["a caption of 2200 characters", input({ caption: "x".repeat(2_200) })],
    ["thirty hashtags", input({ hashtags: Array.from({ length: 30 }, () => "t") })],
  ])("accepts %s", (_example, value) => {
    expect(instagramPublishPlan(value).options).toEqual(shape("feed"));
  });

  it.each([
    ["no media", input({ media: [] }), "instagram_media_required"],
    [
      "twenty-one attachments",
      input({ media: Array.from({ length: 21 }, () => media("image/jpeg")) }),
      "instagram_carousel_too_large",
    ],
    [
      "a caption of 2201 characters",
      input({ caption: "x".repeat(2_201) }),
      "instagram_content_invalid",
    ],
    [
      "thirty-one hashtags",
      input({ hashtags: Array.from({ length: 31 }, () => "t") }),
      "instagram_content_invalid",
    ],
    [
      "a trial feed post",
      input({ providerOptions: { instagram: { postType: "feed", trialReel: true } } }),
      "instagram_post_options_invalid",
    ],
    [
      "a Story with a caption",
      input({ providerOptions: { instagram: { postType: "story" } } }),
      "instagram_story_caption_unsupported",
    ],
    [
      "a Story with hashtags",
      input({
        caption: "",
        hashtags: ["t"],
        providerOptions: { instagram: { postType: "story" } },
      }),
      "instagram_story_caption_unsupported",
    ],
  ])("refuses %s", (_example, value, code) => {
    expect(failureThrownBy(() => instagramPublishPlan(value))).toEqual(refused(code));
  });
});

describe("carouselItemParameters", () => {
  it.each([
    [
      "an image",
      image,
      [
        ["is_carousel_item", "true"],
        ["image_url", URL_],
      ],
    ],
    [
      "a video",
      video,
      [
        ["is_carousel_item", "true"],
        ["media_type", "VIDEO"],
        ["video_url", URL_],
      ],
    ],
  ])("%s", (_example, item, entries) => {
    expect([...carouselItemParameters(item)]).toEqual(entries);
  });
});

describe("singleParameters", () => {
  const reel = [
    ["caption", "hi"],
    ["video_url", URL_],
    ["media_type", "REELS"],
    ["share_to_feed", "true"],
  ];

  it.each([
    [
      "a captioned image",
      image,
      "hi",
      shape("feed"),
      [
        ["caption", "hi"],
        ["image_url", URL_],
      ],
    ],
    ["an image without a caption", image, "", shape("feed"), [["image_url", URL_]]],
    [
      "a Story image drops its text",
      image,
      "hi",
      shape("story"),
      [
        ["image_url", URL_],
        ["media_type", "STORIES"],
      ],
    ],
    [
      "a Story video",
      video,
      "",
      shape("story"),
      [
        ["video_url", URL_],
        ["media_type", "STORIES"],
      ],
    ],
    [
      "a feed video",
      video,
      "hi",
      shape("feed"),
      [
        ["caption", "hi"],
        ["video_url", URL_],
        ["media_type", "VIDEO"],
      ],
    ],
    ["a Reel", video, "hi", shape("reel"), reel],
    [
      "a manual trial Reel",
      video,
      "hi",
      shape("reel", true),
      [...reel, ["trial_params", '{"graduation_strategy":"MANUAL"}']],
    ],
    [
      "a performance trial Reel",
      video,
      "hi",
      { ...shape("reel", true), trialGraduation: "performance" as const },
      [...reel, ["trial_params", '{"graduation_strategy":"SS_PERFORMANCE"}']],
    ],
  ])("%s", (_example, item, text, options, entries) => {
    expect([...singleParameters(item, text, options)]).toEqual(entries);
  });
});

describe("instagramPublishWarnings", () => {
  it.each([
    ["a caption that was not attached", { config_issue: "CAPTION_NOT_ATTACHED" }],
    ["a failed user tag", { config_issue: "USER_TAGGING_FAILURE" }],
    ["a failed poll", { caption_add_on_attachment_status: "POLL_CREATION_FAILURE" }],
    ["a failed prompt", { caption_add_on_attachment_status: "PROMPT_CREATION_FAILURE" }],
  ])("%s", (_example, body) => {
    expect(instagramPublishWarnings(body)).toEqual(["instagram_publish_partial"]);
  });

  it.each([
    ["no issue", {}],
    ["an unrelated issue", { config_issue: "OTHER" }],
  ])("%s", (_example, body) => {
    expect(instagramPublishWarnings(body)).toEqual(undefined);
  });
});
