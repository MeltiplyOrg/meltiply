import { describe, expect, it } from "vite-plus/test";

import {
  configuredMediaPrefix,
  creatorChoiceUnavailable,
  pullMedia,
  tiktokPublishPlan,
  tiktokPublishRequest,
} from "../src/tiktok/publication";
import type {
  ProviderMedia,
  PublishInput,
  TikTokPublicationRequirements,
  TikTokPublishOptions,
} from "../src/types";
import { failureThrownBy, refused } from "./support";

const prefix = new URL("https://media.example/assets/");
const url = "https://media.example/assets/a";
const video = (patch: Partial<ProviderMedia> = {}) =>
  ({
    contentType: "video/mp4",
    fileSize: 100,
    metadata: { durationSeconds: 30, width: 1_080, height: 1_920 },
    mode: "remote_ingest",
    url,
    ...patch,
  }) as ProviderMedia;
const photo = (patch: Partial<ProviderMedia> = {}) =>
  video({ contentType: "image/jpeg", metadata: { width: 1_080, height: 1_920 }, ...patch });
const choices: TikTokPublishOptions = {
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  brandContent: false,
  brandOrganic: false,
  isAiGenerated: false,
  musicUsageConfirmed: true,
  privacyLevel: "PUBLIC_TO_EVERYONE",
};
const input = (
  media: ProviderMedia[],
  options: Partial<TikTokPublishOptions> = {},
  patch: Partial<PublishInput> = {},
): PublishInput => ({
  caption: "Title\nMore",
  hashtags: [],
  idempotencyKey: "k",
  media,
  providerOptions: { tiktok: { ...choices, ...options } },
  ...patch,
});

describe("configuredMediaPrefix", () => {
  it("an https directory", () => {
    expect(configuredMediaPrefix("https://media.example/assets/").href).toEqual(
      "https://media.example/assets/",
    );
  });

  it.each([
    ["http", "http://media.example/assets/"],
    ["a username", "https://u@media.example/assets/"],
    ["a password", "https://:p@media.example/assets/"],
    ["a query", "https://media.example/assets/?a=1"],
    ["a fragment", "https://media.example/assets/#a"],
    ["a bare origin", "https://media.example/"],
    ["a file", "https://media.example/assets"],
  ])("refuses %s", (_example, value) => {
    expect(() => configuredMediaPrefix(value)).toThrow(
      new TypeError("mediaUrlPrefix must be an exact HTTPS directory prefix"),
    );
  });
});

describe("pullMedia", () => {
  it("media under the prefix", () => {
    expect(pullMedia(video({ contentType: "VIDEO/MP4; x=1" }), prefix)).toEqual({
      contentType: "video/mp4",
      fileSize: 100,
      metadata: { durationSeconds: 30, width: 1_080, height: 1_920 },
      url,
    });
  });

  it.each([
    [
      "an insecure URL",
      video({ url: "http://media.example/assets/a" }),
      "tiktok_pull_media_required",
    ],
    [
      "another origin",
      video({ url: "https://other.example/assets/a" }),
      "tiktok_media_prefix_invalid",
    ],
    [
      "another directory",
      video({ url: "https://media.example/private/a" }),
      "tiktok_media_prefix_invalid",
    ],
  ])("refuses %s", (_example, value, code) => {
    expect(failureThrownBy(() => pullMedia(value, prefix))).toEqual(refused(code));
  });
});

describe("tiktokPublishPlan", () => {
  const pulled = (contentType: string, metadata: object) => ({
    contentType,
    fileSize: 100,
    metadata,
    url,
  });
  const clip = pulled("video/mp4", { durationSeconds: 30, width: 1_080, height: 1_920 });

  it.each([
    ["a direct video", {}, false],
    ["an inbox video", { postMode: "inbox" as const }, true],
  ])("%s", (_example, options, inbox) => {
    expect(tiktokPublishPlan(input([video()], options), prefix)).toEqual({
      choices: { ...choices, ...options },
      first: clip,
      inbox,
      isVideo: true,
      media: [clip],
    });
  });

  it.each([
    [
      "thirty-one hashtags",
      input([video()], {}, { hashtags: Array.from({ length: 31 }, () => "t") }),
      "tiktok_hashtags_invalid",
    ],
    ["no media", input([]), "tiktok_pull_media_required"],
    [
      "an unknown media kind",
      input([video({ contentType: "text/plain" })]),
      "tiktok_asset_type_invalid",
    ],
    ["mixed media", input([video(), photo()]), "tiktok_mixed_media_unsupported"],
    [
      "no creator choices",
      input([video()], {}, { providerOptions: {} }),
      "tiktok_publish_options_invalid",
    ],
    [
      "unconfirmed music usage",
      input([video()], { musicUsageConfirmed: false as never }),
      "tiktok_publish_options_invalid",
    ],
    [
      "no privacy level",
      input([video()], { privacyLevel: undefined }),
      "tiktok_publish_options_invalid",
    ],
    [
      "an unknown post mode",
      input([video()], { postMode: "later" as never }),
      "tiktok_publish_options_invalid",
    ],
    [
      "a missing choice",
      input([video()], { allowDuet: undefined }),
      "tiktok_publish_options_invalid",
    ],
    [
      "a music flag that is not boolean",
      input([photo()], { autoAddMusic: "yes" as never }),
      "tiktok_publish_options_invalid",
    ],
    [
      "private branded content",
      input([video()], { brandContent: true, privacyLevel: "SELF_ONLY" }),
      "tiktok_publish_options_invalid",
    ],
    [
      "automatic music on a video",
      input([video()], { autoAddMusic: true }),
      "tiktok_auto_music_video_unsupported",
    ],
  ])("refuses %s", (_example, value, code) => {
    expect(failureThrownBy(() => tiktokPublishPlan(value, prefix))).toEqual(refused(code));
  });
});

describe("creatorChoiceUnavailable", () => {
  const requirements: TikTokPublicationRequirements = {
    commentAllowed: false,
    creatorDisplayName: "N",
    creatorUsername: "u",
    duetAllowed: false,
    maxVideoDurationSeconds: 60,
    platform: "tiktok",
    privacyLevels: ["PUBLIC_TO_EVERYONE"],
    stitchAllowed: false,
  };

  it.each([
    ["choices the creator allows", {}, false],
    ["no privacy level", { privacyLevel: undefined }, true],
    ["a privacy level not offered", { privacyLevel: "SELF_ONLY" as const }, true],
    ["comments the creator disabled", { allowComment: true }, true],
    ["duets the creator disabled", { allowDuet: true }, true],
    ["stitches the creator disabled", { allowStitch: true }, true],
  ])("%s", (_example, patch, unavailable) => {
    expect(creatorChoiceUnavailable({ ...choices, ...patch }, requirements)).toEqual(unavailable);
  });
});

describe("tiktokPublishRequest", () => {
  const request = (value: PublishInput, requirements?: TikTokPublicationRequirements) =>
    tiktokPublishRequest(tiktokPublishPlan(value, prefix), value.caption, requirements);
  const direct = {
    brand_content_toggle: false,
    brand_organic_toggle: false,
    disable_comment: true,
    privacy_level: "PUBLIC_TO_EVERYONE",
  };
  const pulled = { source: "PULL_FROM_URL", video_url: url };

  it("a direct video", () => {
    expect(request(input([video()]))).toEqual({
      path: "/v2/post/publish/video/init/",
      body: {
        post_info: {
          ...direct,
          disable_duet: true,
          disable_stitch: true,
          is_aigc: false,
          title: "Title\nMore",
        },
        source_info: pulled,
      },
    });
  });

  it("an inbox video with a long caption", () => {
    const value = input([video()], { postMode: "inbox" }, { caption: "x".repeat(3_000) });

    expect(request(value)).toEqual({
      path: "/v2/post/publish/inbox/video/init/",
      body: { source_info: pulled },
    });
  });

  const source = { photo_cover_index: 0, photo_images: [url, url], source: "PULL_FROM_URL" };

  it.each([
    [
      "direct photos",
      {},
      "DIRECT_POST",
      { ...direct, auto_add_music: false, description: "Title\nMore", title: "Title" },
    ],
    [
      "inbox photos",
      { postMode: "inbox" as const },
      "MEDIA_UPLOAD",
      { title: "Title", description: "Title\nMore" },
    ],
  ])("%s", (_example, options, mode, postInfo) => {
    expect(request(input([photo(), photo()], options))).toEqual({
      path: "/v2/post/publish/content/init/",
      body: {
        media_type: "PHOTO",
        is_aigc: false,
        post_info: postInfo,
        post_mode: mode,
        source_info: source,
      },
    });
  });

  const limits = (maxVideoDurationSeconds: number) =>
    ({ maxVideoDurationSeconds }) as TikTokPublicationRequirements;
  const sized = (durationSeconds: number, width = 1_080, height = 1_920) =>
    video({ metadata: { durationSeconds, width, height } });

  it.each([
    ["two videos", input([video(), video()]), undefined],
    ["a direct caption of 2201", input([video()], {}, { caption: "x".repeat(2_201) }), undefined],
    ["a video over the creator's limit", input([sized(61)]), limits(60)],
    ["a video over ten minutes", input([sized(601)]), undefined],
    ["a video of no length", input([sized(0)]), undefined],
    ["a video under 360 pixels wide", input([sized(30, 359)]), undefined],
    ["a video over 4096 pixels tall", input([sized(30, 1_080, 4_097)]), undefined],
    ["a video of another type", input([video({ contentType: "video/avi" })]), undefined],
    ["a video over the size limit", input([video({ fileSize: 524_288_001 })]), undefined],
    ["a video without dimensions", input([video({ metadata: { durationSeconds: 3 } })]), undefined],
  ])("refuses %s", (_example, value, requirements) => {
    expect(failureThrownBy(() => request(value, requirements))).toEqual(
      refused("tiktok_video_invalid"),
    );
  });

  it.each([
    ["photos without a title", input([photo()], {}, { caption: " " })],
    ["a title of 91 characters", input([photo()], {}, { caption: "x".repeat(91) })],
    ["a description of 4001", input([photo()], {}, { caption: `T\n${"x".repeat(3_999)}` })],
    ["duets on a direct photo post", input([photo()], { allowDuet: true })],
    ["thirty-six photos", input(Array.from({ length: 36 }, () => photo()))],
    ["a PNG photo", input([photo({ contentType: "image/png" })])],
    ["a photo over 20 MiB", input([photo({ fileSize: 20_971_521 })])],
    ["a photo without dimensions", input([photo({ metadata: undefined })])],
    [
      "a photo with a short side over 1080",
      input([photo({ metadata: { width: 1_081, height: 1_081 } })]),
    ],
  ])("refuses %s", (_example, value) => {
    expect(failureThrownBy(() => request(value))).toEqual(refused("tiktok_photo_invalid"));
  });
});
