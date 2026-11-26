import { describe, expect, it } from "vite-plus/test";

import {
  threadsAttachment,
  threadsMediaParameters,
  threadsPublishPlan,
  threadsPublishWarnings,
  threadsTextParameters,
} from "../src/threads/publication";
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
  media: [],
  ...patch,
});
const streamed: ProviderMedia = {
  body: new ReadableStream<Uint8Array>(),
  contentType: "video/mp4",
  fileSize: 1,
  mode: "byte_upload",
};
const image = { kind: "image", url: URL_ } as const;
const video = { kind: "video", url: URL_ } as const;
const gif = { gif_id: "g", provider: "GIPHY" } as const;

describe("threadsAttachment", () => {
  it.each([
    ["a JPEG image", media("image/jpeg"), image],
    ["a PNG image of 8 MiB", media("image/png", 8_388_608), image],
    ["an MP4 video of 500 MiB", media("VIDEO/MP4; x=1", 524_288_000), video],
    ["a QuickTime video", media("video/quicktime"), video],
  ])("%s", (_example, value, attachment) => {
    expect(threadsAttachment(value)).toEqual(attachment);
  });

  it.each([
    ["an image one byte over", media("image/png", 8_388_609), "threads_media_invalid"],
    ["a video one byte over", media("video/mp4", 524_288_001), "threads_media_invalid"],
    ["an unsupported type", media("image/gif"), "threads_media_invalid"],
    ["an insecure URL", media("image/png", 1, "http://a.test"), "threads_media_url_invalid"],
    ["streamed media", streamed, "threads_remote_media_required"],
  ])("refuses %s", (_example, value, code) => {
    expect(failureThrownBy(() => threadsAttachment(value))).toEqual(refused(code));
  });
});

describe("threadsMediaParameters", () => {
  it.each([
    ["an image", image, { media_type: "IMAGE", image_url: URL_ }],
    ["a video", video, { media_type: "VIDEO", video_url: URL_ }],
  ])("%s", (_example, item, parameters) => {
    expect(threadsMediaParameters(item)).toEqual(parameters);
  });
});

describe("threadsTextParameters", () => {
  it.each([
    [
      "text",
      "hi",
      {},
      [
        ["text", "hi"],
        ["media_type", "TEXT"],
      ],
    ],
    ["a GIF without text", "", { gif_attachment: gif }, [["media_type", "TEXT"]]],
    [
      "long text without a caption",
      "",
      { text_attachment: { plaintext: "long" } },
      [["media_type", "TEXT"]],
    ],
  ])("%s", (_example, text, options, entries) => {
    expect([...threadsTextParameters(text, options)]).toEqual(entries);
  });

  it("refuses nothing to say", () => {
    expect(failureThrownBy(() => threadsTextParameters("", {}))).toEqual(
      refused("threads_text_invalid"),
    );
  });
});

describe("threadsPublishPlan", () => {
  it("a text post", () => {
    expect(threadsPublishPlan(input())).toEqual({ attachments: [], options: {}, text: "hello" });
  });

  it("twenty attachments", () => {
    const value = input({ media: Array.from({ length: 20 }, () => media("image/png")) });

    expect(threadsPublishPlan(value).attachments).toEqual(Array.from({ length: 20 }, () => image));
  });

  it("a caption of 500 emoji", () => {
    expect(threadsPublishPlan(input({ caption: "🚀".repeat(500) })).text).toEqual("🚀".repeat(500));
  });

  it.each([
    [
      "twenty-one attachments",
      input({ media: Array.from({ length: 21 }, () => media("image/png")) }),
      "threads_carousel_too_large",
    ],
    ["a caption of 501 characters", input({ caption: "x".repeat(501) }), "threads_content_invalid"],
    [
      "unusable options",
      input({ providerOptions: { threads: { topic_tag: "a.b" } } }),
      "threads_publish_options_invalid",
    ],
    [
      "options that clash",
      input({
        providerOptions: {
          threads: {
            poll_attachment: { option_a: "A", option_b: "B" },
            text_attachment: { plaintext: "x" },
          },
        },
      }),
      "threads_publish_options_invalid",
    ],
    [
      "an incomplete ghost post",
      input({ providerOptions: { threads: { post_type: "ghost" } } }),
      "threads_publish_options_invalid",
    ],
  ])("refuses %s", (_example, value, code) => {
    expect(failureThrownBy(() => threadsPublishPlan(value))).toEqual(refused(code));
  });
});

describe("threadsPublishWarnings", () => {
  it.each([
    [
      "a failed cross-share",
      { crossreshare_to_ig_status: "FAILED" },
      ["instagram_crossshare_failed"],
    ],
    ["a successful cross-share", { crossreshare_to_ig_status: "OK" }, undefined],
    ["no cross-share", {}, undefined],
  ])("%s", (_example, body, warnings) => {
    expect(threadsPublishWarnings(body)).toEqual(warnings);
  });
});
