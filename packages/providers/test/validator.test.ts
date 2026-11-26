import type { PlatformCapability } from "@meltiply/domain";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderRemoteMedia, PublishInput, TikTokPublishOptions } from "../src/types";
import {
  captionLength,
  composeCaption,
  validatePublishInput,
  type CaptionSource,
} from "../src/validator";

function capability(patch: Partial<PlatformCapability> = {}): PlatformCapability {
  return {
    accepted_mime_types: ["video/mp4", "image/jpeg"],
    analytics: true,
    asset_types: ["image", "video"],
    comments: true,
    connect_available: true,
    max_caption_length: 500,
    max_file_size: 1_000,
    max_hashtags: 3,
    max_media_count: 10,
    max_video_duration_sec: 60,
    min_media_count: 0,
    multi_asset_types: ["image", "video"],
    notes: [],
    platform: "threads",
    publish: true,
    reply: true,
    ...patch,
  };
}

const unlimited = (platform: PlatformCapability["platform"]) =>
  capability({ platform, max_file_size: null, max_video_duration_sec: null });

function video(patch: Partial<ProviderRemoteMedia> = {}): ProviderRemoteMedia {
  return {
    contentType: "video/mp4",
    fileSize: 500,
    metadata: { durationSeconds: 30 },
    mode: "remote_ingest",
    url: "https://cdn.example.com/clip.mp4",
    ...patch,
  };
}

function image(patch: Partial<ProviderRemoteMedia> = {}): ProviderRemoteMedia {
  return {
    contentType: "image/jpeg",
    fileSize: 500,
    mode: "remote_ingest",
    url: "https://cdn.example.com/frame.jpg",
    ...patch,
  };
}

function input(patch: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "launch day",
    hashtags: ["launch"],
    idempotencyKey: "publish-1",
    media: [video()],
    ...patch,
  };
}

const silent = { caption: "", hashtags: [], media: [] };

const tiktok: TikTokPublishOptions = {
  allowComment: true,
  allowDuet: true,
  allowStitch: true,
  brandContent: false,
  brandOrganic: false,
  isAiGenerated: false,
  musicUsageConfirmed: true,
  privacyLevel: "PUBLIC_TO_EVERYONE",
};

const youtubeLive = {
  postType: "live",
  madeForKids: false,
  privacyStatus: "unlisted",
} as const;

const captionIssue = (platform: string, limit: number, actual: number) => ({
  actual,
  constraint: "provider_caption_limit",
  field: "caption",
  limit,
  message: `caption exceeds the ${platform} limit of ${limit} characters`,
});

const unsupportedOptions = (platform: string, field: string, name: string) => ({
  constraint: "unsupported_provider_options",
  field: `providerOptions.${field}`,
  message: `${platform} does not accept ${name} publish options`,
});

describe("captionLength", () => {
  it("emoji and a joined sequence", () => {
    expect(captionLength("🚀é👨‍👩‍👧")).toEqual(7);
  });
});

describe("composeCaption", () => {
  const source: CaptionSource = {
    defaultText: "post body",
    descriptionOverride: null,
    hashtags: ["launch", "beta"],
    title: "post title",
    titleOverride: null,
  };

  it.each([
    ["a title, body and hashtags", {}, "post title\n\npost body\n\n#launch #beta"],
    [
      "a signature",
      { signature: " Follow us. " },
      "post title\n\npost body\n\nFollow us.\n\n#launch #beta",
    ],
    ["a blank signature", { signature: "  ", hashtags: [] }, "post title\n\npost body"],
    [
      "target overrides",
      { descriptionOverride: "override body", titleOverride: "  override title  ", hashtags: [] },
      "override title\n\noverride body",
    ],
    ["a body equal to the title", { defaultText: "post title", hashtags: [] }, "post title"],
    ["no body and a blank title", { defaultText: null, title: " " }, "#launch #beta"],
    ["nothing to say", { defaultText: "   ", hashtags: [], title: "" }, ""],
  ])("%s", (_example, patch, caption) => {
    expect(composeCaption({ ...source, ...patch })).toEqual(caption);
  });
});

describe("validatePublishInput", () => {
  it.each([
    ["a publishable video", capability(), input()],
    ["a text-only publish with no minimum", capability(), input({ media: [] })],
    ["a null minimum", capability({ min_media_count: null }), input({ media: [] })],
    ["a caption of 500 emoji", capability(), input({ caption: "🚀".repeat(500) })],
    [
      "no caption limit",
      capability({ max_caption_length: null }),
      input({ caption: "a".repeat(5_000) }),
    ],
    ["hashtags at the limit", capability(), input({ hashtags: ["a", "b", "c"] })],
    [
      "no hashtag limit",
      capability({ max_hashtags: null }),
      input({ hashtags: ["a", "b", "c", "d"] }),
    ],
    ["a file at the size limit", capability(), input({ media: [video({ fileSize: 1_000 })] })],
    [
      "no file size limit",
      capability({ max_file_size: null }),
      input({ media: [video({ fileSize: 5_000 })] }),
    ],
    [
      "a video at the duration limit",
      capability(),
      input({ media: [video({ metadata: { durationSeconds: 60 } })] }),
    ],
    [
      "no duration limit",
      capability({ max_video_duration_sec: null }),
      input({ media: [video({ metadata: undefined })] }),
    ],
    ["an image with no duration", capability(), input({ media: [image()] })],
    [
      "a media type with parameters and capitals",
      capability({ accepted_mime_types: ["Video/MP4"] }),
      input({ media: [video({ contentType: "VIDEO/mp4; codecs=avc1" })] }),
    ],
    ["a set the platform combines", capability(), input({ media: [image(), video(), image()] })],
    [
      "attachments at the maximum",
      capability({ max_media_count: 2 }),
      input({ media: [image(), image()] }),
    ],
    [
      "no attachment maximum",
      capability({ max_media_count: null }),
      input({ media: [image(), image()] }),
    ],
    [
      "a TikTok video caption of 2200",
      capability({ platform: "tiktok", max_caption_length: 4_000 }),
      input({ caption: "a".repeat(2_200), providerOptions: { tiktok } }),
    ],
    [
      "a long TikTok photo description",
      capability({ platform: "tiktok", max_caption_length: 4_000 }),
      input({ caption: "a".repeat(4_000), media: [image()], providerOptions: { tiktok } }),
    ],
    [
      "a long TikTok inbox draft caption",
      capability({ platform: "tiktok", max_caption_length: 4_000 }),
      input({
        caption: "a".repeat(4_000),
        providerOptions: { tiktok: { ...tiktok, postMode: "inbox" } },
      }),
    ],
    [
      "a YouTube live without media",
      capability({ platform: "youtube", min_media_count: 1 }),
      input({ ...silent, providerOptions: { youtube: youtubeLive } }),
    ],
    [
      "a Facebook link without text",
      capability({ platform: "facebook" }),
      input({ ...silent, providerOptions: { facebook: { link: "https://a.test" } } }),
    ],
    [
      "a Facebook crosspost without text",
      capability({ platform: "facebook" }),
      input({
        ...silent,
        providerOptions: { facebook: { postType: "crosspost", crosspostedVideoId: "123" } },
      }),
    ],
    [
      "a Facebook experiment without text",
      capability({ platform: "facebook" }),
      input({
        ...silent,
        providerOptions: {
          facebook: {
            postType: "ab_test",
            abTest: {
              name: "test",
              controlVideoId: "1",
              experimentVideoIds: ["1", "2"],
              optimizationGoal: "COMMENTS",
            },
          },
        },
      }),
    ],
    [
      "a Facebook live without text",
      capability({ platform: "facebook" }),
      input({ ...silent, providerOptions: { facebook: { postType: "live" } } }),
    ],
    [
      "a Threads repost without text",
      capability(),
      input({ ...silent, providerOptions: { threads: { repost_id: "123" } } }),
    ],
    [
      "a Threads GIF without text",
      capability(),
      input({
        ...silent,
        providerOptions: { threads: { gif_attachment: { provider: "GIPHY", gif_id: "g1" } } },
      }),
    ],
    [
      "a Threads long text without a caption",
      capability(),
      input({
        ...silent,
        providerOptions: { threads: { text_attachment: { plaintext: "Long" } } },
      }),
    ],
    [
      "a Story without text",
      unlimited("instagram"),
      input({ caption: " ", hashtags: [], providerOptions: { instagram: { postType: "story" } } }),
    ],
    [
      "a large video in an Instagram feed carousel",
      unlimited("instagram"),
      input({ media: [image(), video({ fileSize: 400_000_000 })] }),
    ],
    [
      "a Facebook photo of 10 MB",
      unlimited("facebook"),
      input({ media: [image({ fileSize: 10_000_000 })] }),
    ],
    [
      "a Facebook reel of 3 seconds",
      unlimited("facebook"),
      input({ media: [video({ metadata: { durationSeconds: 3 } })] }),
    ],
    [
      "a Facebook reel of 90 seconds",
      unlimited("facebook"),
      input({ media: [video({ metadata: { durationSeconds: 90 } })] }),
    ],
  ] as const)("accepts %s", (_example, platform, publish) => {
    expect(validatePublishInput(platform, publish)).toEqual([]);
  });

  it.each([
    [
      "a missing attachment",
      capability({ min_media_count: 1 }),
      input({ media: [] }),
      {
        constraint: "provider_media_required",
        field: "media",
        limit: 1,
        message:
          "threads requires at least 1 attachment; remove the caption-only target or add media",
      },
    ],
    [
      "two missing attachments",
      capability({ min_media_count: 2 }),
      input({ media: [] }),
      {
        constraint: "provider_media_required",
        field: "media",
        limit: 2,
        message:
          "threads requires at least 2 attachments; remove the caption-only target or add media",
      },
    ],
    [
      "one attachment too many",
      capability({ max_media_count: 2 }),
      input({ media: [image(), image(), image()] }),
      {
        actual: 3,
        constraint: "provider_media_count_limit",
        field: "media",
        limit: 2,
        message: "threads accepts at most 2 attachments; remove 1 for this target",
      },
    ],
    [
      "a combination the platform cannot publish",
      capability({ multi_asset_types: ["image"] }),
      input({ media: [image(), video()] }),
      {
        constraint: "unsupported_media_combination",
        field: "media",
        message:
          "threads cannot combine these attachments; a multi-attachment post accepts image media only",
      },
    ],
    [
      "an unlisted media type",
      capability(),
      input({ media: [video({ contentType: "video/quicktime" })] }),
      {
        constraint: "unsupported_media_type",
        field: "media[0].contentType",
        message: "threads does not accept media type 'video/quicktime'",
      },
    ],
    [
      "an unlisted type at the second position",
      capability(),
      input({ media: [image(), image({ contentType: "image/webp" })] }),
      {
        constraint: "unsupported_media_type",
        field: "media[1].contentType",
        message: "threads does not accept media type 'image/webp'",
      },
    ],
    [
      "an attachment kind the platform lacks",
      capability({ asset_types: ["image"], max_video_duration_sec: null }),
      input(),
      {
        constraint: "unsupported_asset_type",
        field: "media[0].contentType",
        message: "threads does not accept video media",
      },
    ],
    [
      "an empty file",
      capability(),
      input({ media: [video({ fileSize: 0 })] }),
      {
        actual: 0,
        constraint: "provider_file_size_limit",
        field: "media[0].fileSize",
        message: "media file size must be a positive safe integer",
      },
    ],
    [
      "a fractional file size",
      capability(),
      input({ media: [video({ fileSize: 1.5 })] }),
      {
        actual: 1.5,
        constraint: "provider_file_size_limit",
        field: "media[0].fileSize",
        message: "media file size must be a positive safe integer",
      },
    ],
    [
      "a file one byte over the limit",
      capability(),
      input({ media: [video({ fileSize: 1_001 })] }),
      {
        actual: 1_001,
        constraint: "provider_file_size_limit",
        field: "media[0].fileSize",
        limit: 1_000,
        message: "attachment 1 exceeds the threads limit of 1000 bytes",
      },
    ],
    [
      "a video one second over",
      capability(),
      input({ media: [video({ metadata: { durationSeconds: 61 } })] }),
      {
        actual: 61,
        constraint: "provider_video_duration_limit",
        field: "media[0].metadata.durationSeconds",
        limit: 60,
        message: "attachment 1 exceeds the threads limit of 60 seconds",
      },
    ],
    [
      "a video of unknown duration",
      capability(),
      input({ media: [video({ metadata: undefined })] }),
      {
        constraint: "provider_video_duration_limit",
        field: "media[0].metadata.durationSeconds",
        limit: 60,
        message: "threads needs a known video duration to enforce its 60 second limit",
      },
    ],
    [
      "an empty publication",
      capability(),
      input({ caption: "  ", hashtags: [], media: [] }),
      {
        constraint: "provider_empty_publish",
        field: "caption",
        message:
          "threads cannot publish an empty post; add caption text, hashtags, or an attachment",
      },
    ],
    [
      "a caption of 501 characters",
      capability(),
      input({ caption: "a".repeat(501) }),
      captionIssue("threads", 500, 501),
    ],
    [
      "a TikTok video caption of 2201",
      capability({ platform: "tiktok", max_caption_length: 4_000 }),
      input({ caption: "a".repeat(2_201), providerOptions: { tiktok } }),
      captionIssue("tiktok", 2_200, 2_201),
    ],
    [
      "a TikTok video with no capability limit",
      capability({ platform: "tiktok", max_caption_length: null }),
      input({ caption: "a".repeat(2_201), providerOptions: { tiktok } }),
      captionIssue("tiktok", 2_200, 2_201),
    ],
    [
      "a TikTok video with a lower capability limit",
      capability({ platform: "tiktok", max_caption_length: 100 }),
      input({ caption: "a".repeat(101), providerOptions: { tiktok } }),
      captionIssue("tiktok", 100, 101),
    ],
    [
      "four hashtags",
      capability(),
      input({ hashtags: ["a", "b", "c", "d"] }),
      {
        actual: 4,
        constraint: "provider_hashtag_limit",
        field: "hashtags",
        limit: 3,
        message: "threads accepts at most 3 hashtags",
      },
    ],
    [
      "TikTok without creator options",
      capability({ platform: "tiktok" }),
      input({ providerOptions: {} }),
      {
        constraint: "tiktok_publish_options_required",
        field: "providerOptions.tiktok",
        message: "TikTok requires creator publish options on every publish",
      },
    ],
    [
      "YouTube options elsewhere",
      capability(),
      input({ providerOptions: { youtube: youtubeLive } }),
      unsupportedOptions("threads", "youtube", "YouTube"),
    ],
    [
      "TikTok options elsewhere",
      capability(),
      input({ providerOptions: { tiktok } }),
      unsupportedOptions("threads", "tiktok", "TikTok"),
    ],
    [
      "Instagram options elsewhere",
      capability(),
      input({ providerOptions: { instagram: {} } }),
      unsupportedOptions("threads", "instagram", "Instagram"),
    ],
    [
      "Facebook options elsewhere",
      capability(),
      input({ providerOptions: { facebook: {} } }),
      unsupportedOptions("threads", "facebook", "Facebook"),
    ],
    [
      "an Instagram Story with text",
      unlimited("instagram"),
      input({ hashtags: [], providerOptions: { instagram: { postType: "story" } } }),
      {
        constraint: "story_caption_unsupported",
        field: "caption",
        message:
          "Stories do not accept captions or signatures; remove this Channel's text before publishing.",
      },
    ],
    [
      "a Facebook Story with hashtags",
      unlimited("facebook"),
      input({ caption: "", providerOptions: { facebook: { postType: "story" } } }),
      {
        constraint: "story_caption_unsupported",
        field: "caption",
        message:
          "Stories do not accept captions or signatures; remove this Channel's text before publishing.",
      },
    ],
    [
      "a Facebook method that does not fit",
      unlimited("facebook"),
      input({ media: [image()], providerOptions: { facebook: { postType: "reel" } } }),
      {
        constraint: "facebook_post_options_invalid",
        field: "providerOptions.facebook",
        message: "The selected Facebook method does not apply to this content.",
      },
    ],
    [
      "a Facebook photo over 10 MB",
      unlimited("facebook"),
      input({ media: [image({ fileSize: 10_000_001 })] }),
      {
        actual: 10_000_001,
        constraint: "provider_file_size_limit",
        field: "media[0].fileSize",
        limit: 10_000_000,
        message: "Facebook photos cannot exceed 10 MB.",
      },
    ],
    [
      "a Facebook reel under 3 seconds",
      unlimited("facebook"),
      input({ media: [video({ metadata: { durationSeconds: 2 } })] }),
      {
        actual: 2,
        constraint: "provider_video_duration_limit",
        field: "providerOptions.facebook.postType",
        limit: 90,
        message: "Facebook reel videos require a duration from 3 to 90 seconds.",
      },
    ],
    [
      "a Facebook Story over 60 seconds",
      unlimited("facebook"),
      input({
        caption: "",
        hashtags: [],
        media: [video({ metadata: { durationSeconds: 61 } })],
        providerOptions: { facebook: { postType: "story" } },
      }),
      {
        actual: 61,
        constraint: "provider_video_duration_limit",
        field: "providerOptions.facebook.postType",
        limit: 60,
        message: "Facebook story videos require a duration from 3 to 60 seconds.",
      },
    ],
    [
      "a Facebook reel of unknown duration",
      unlimited("facebook"),
      input({ media: [video({ metadata: undefined })] }),
      {
        constraint: "provider_video_duration_limit",
        field: "providerOptions.facebook.postType",
        limit: 90,
        message: "Facebook reel videos require a duration from 3 to 90 seconds.",
      },
    ],
    [
      "Threads options on another Channel",
      unlimited("instagram"),
      input({ providerOptions: { threads: { topic_tag: "news" } } }),
      {
        constraint: "threads_post_options_invalid",
        field: "providerOptions.threads",
        message: "Threads options require a Threads Channel.",
      },
    ],
    [
      "unusable Threads options",
      capability(),
      input({ providerOptions: { threads: { topic_tag: "a.b" } } }),
      {
        constraint: "threads_post_options_invalid",
        field: "providerOptions.threads",
        message: "Threads options are invalid.",
      },
    ],
    [
      "Threads options that clash with the content",
      capability(),
      input({
        providerOptions: { threads: { gif_attachment: { provider: "GIPHY", gif_id: "g" } } },
      }),
      {
        constraint: "threads_post_options_invalid",
        field: "providerOptions.threads",
        message:
          "Polls, GIFs, long-text attachments, ghosts, and link attachments require a text-only Post.",
      },
    ],
    [
      "a single video over the Reel size",
      unlimited("instagram"),
      input({ media: [video({ fileSize: 300_000_001 })] }),
      {
        actual: 300_000_001,
        constraint: "provider_file_size_limit",
        field: "providerOptions.instagram.postType",
        limit: 300_000_000,
        message: "The Asset exceeds this Instagram method's size limit.",
      },
    ],
    [
      "a Story video over its size",
      unlimited("instagram"),
      input({
        caption: "",
        hashtags: [],
        media: [video({ fileSize: 100_000_001 })],
        providerOptions: { instagram: { postType: "story" } },
      }),
      {
        actual: 100_000_001,
        constraint: "provider_file_size_limit",
        field: "providerOptions.instagram.postType",
        limit: 100_000_000,
        message: "The Asset exceeds this Instagram method's size limit.",
      },
    ],
    [
      "an Instagram image over 8 MiB",
      unlimited("instagram"),
      input({ media: [image({ fileSize: 8_388_609 })] }),
      {
        actual: 8_388_609,
        constraint: "provider_file_size_limit",
        field: "providerOptions.instagram.postType",
        limit: 8_388_608,
        message: "The Asset exceeds this Instagram method's size limit.",
      },
    ],
    [
      "an Instagram Reel under 3 seconds",
      unlimited("instagram"),
      input({ media: [video({ metadata: { durationSeconds: 2 } })] }),
      {
        actual: 2,
        constraint: "provider_video_duration_limit",
        field: "providerOptions.instagram.postType",
        limit: 900,
        message: "Instagram reel requires video from 3 to 900 seconds.",
      },
    ],
    [
      "an Instagram Reel of unknown duration",
      unlimited("instagram"),
      input({ media: [video({ metadata: undefined })] }),
      {
        constraint: "provider_video_duration_limit",
        field: "providerOptions.instagram.postType",
        limit: 900,
        message: "Instagram reel requires video from 3 to 900 seconds.",
      },
    ],
    [
      "a trial Reel on an image",
      unlimited("instagram"),
      input({ media: [image()], providerOptions: { instagram: { trialReel: true } } }),
      {
        constraint: "instagram_post_options_invalid",
        field: "providerOptions.instagram",
        message:
          "The selected Instagram post type or trial Reel does not apply to this attachment set",
      },
    ],
  ] as const)("reports %s", (_example, platform, publish, issue) => {
    expect(validatePublishInput(platform, publish)).toEqual([issue]);
  });

  it.each([
    ["no combinations declared", null],
    ["an empty combination list", []],
  ] as const)("reports two attachments with %s", (_example, multi) => {
    const platform = capability({ multi_asset_types: multi && [...multi], max_media_count: 1 });

    expect(validatePublishInput(platform, input({ media: [image(), image()] }))).toEqual([
      {
        actual: 2,
        constraint: "provider_media_count_limit",
        field: "media",
        limit: 1,
        message: "threads accepts at most 1 attachment; remove 1 for this target",
      },
      {
        constraint: "unsupported_media_combination",
        field: "media",
        message: "threads cannot publish more than one attachment per post",
      },
    ]);
  });

  it("an unrecognized type inside a set", () => {
    const publish = input({ media: [image(), video({ contentType: "audio/mpeg" })] });

    expect(validatePublishInput(capability(), publish)).toEqual([
      {
        constraint: "unsupported_media_combination",
        field: "media",
        message:
          "threads cannot combine these attachments; a multi-attachment post accepts image or video media only",
      },
      {
        constraint: "unsupported_media_type",
        field: "media[1].contentType",
        message: "threads does not accept media type 'audio/mpeg'",
      },
    ]);
  });

  it("every unmet constraint at once, in order", () => {
    const publish = input({
      caption: "a".repeat(501),
      hashtags: ["one", "two", "three", "four"],
      media: [
        video({
          contentType: "video/quicktime",
          fileSize: 1_001,
          metadata: { durationSeconds: 61 },
        }),
      ],
    });

    expect(validatePublishInput(capability({ platform: "tiktok" }), publish)).toEqual([
      {
        constraint: "unsupported_media_type",
        field: "media[0].contentType",
        message: "tiktok does not accept media type 'video/quicktime'",
      },
      {
        actual: 1_001,
        constraint: "provider_file_size_limit",
        field: "media[0].fileSize",
        limit: 1_000,
        message: "attachment 1 exceeds the tiktok limit of 1000 bytes",
      },
      {
        actual: 61,
        constraint: "provider_video_duration_limit",
        field: "media[0].metadata.durationSeconds",
        limit: 60,
        message: "attachment 1 exceeds the tiktok limit of 60 seconds",
      },
      captionIssue("tiktok", 500, 501),
      {
        actual: 4,
        constraint: "provider_hashtag_limit",
        field: "hashtags",
        limit: 3,
        message: "tiktok accepts at most 3 hashtags",
      },
      {
        constraint: "tiktok_publish_options_required",
        field: "providerOptions.tiktok",
        message: "TikTok requires creator publish options on every publish",
      },
    ]);
  });

  it("leaves its arguments unchanged", () => {
    const platform = capability();
    const publish = input({ hashtags: ["#bad"] });

    validatePublishInput(platform, publish);

    expect(platform).toEqual(capability());
    expect(publish).toEqual(input({ hashtags: ["#bad"] }));
  });
});
