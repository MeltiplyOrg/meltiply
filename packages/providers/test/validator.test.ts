import type { PlatformCapability } from "@meltiply/domain";
import { describe, expect, it } from "vite-plus/test";

import {
  captionLength,
  composeCaption,
  validatePublishInput,
  type CaptionSource,
  type ProviderRemoteMedia,
  type PublishInput,
  type TikTokPublishOptions,
  type ValidationIssue,
} from "../src";

/** A Threads-shaped capability: text-only allowed, images and videos combinable. */
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

function video(patch: Partial<ProviderRemoteMedia> = {}): ProviderRemoteMedia {
  return {
    contentType: "video/mp4",
    fileSize: 500,
    metadata: { durationSeconds: 30 },
    mode: "remote_ingest",
    url: "https://cdn.example.com/clip.mp4?token=1",
    ...patch,
  };
}

function image(patch: Partial<ProviderRemoteMedia> = {}): ProviderRemoteMedia {
  return {
    contentType: "image/jpeg",
    fileSize: 500,
    mode: "remote_ingest",
    url: "https://cdn.example.com/frame.jpg?token=1",
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

const tiktokOptions: TikTokPublishOptions = {
  allowComment: true,
  allowDuet: true,
  allowStitch: true,
  brandContent: false,
  brandOrganic: false,
  isAiGenerated: false,
  musicUsageConfirmed: true,
  privacyLevel: "PUBLIC_TO_EVERYONE",
};

/** Assert a single issue was reported and return it. */
function only(issues: ValidationIssue[]): ValidationIssue {
  expect(issues).toHaveLength(1);
  return issues[0]!;
}

describe("captionLength", () => {
  it("counts codepoints rather than UTF-16 units", () => {
    expect(captionLength("hello")).toBe(5);
    expect(captionLength("héllo")).toBe(5);
    expect("🚀🚀".length).toBe(4);
    expect(captionLength("🚀🚀")).toBe(2);
    // A ZWJ sequence is one grapheme but five codepoints.
    expect(captionLength("👨‍👩‍👧")).toBe(5);
  });

  it("counts Unicode codepoints consistently", () => {
    expect(captionLength("ünïcode 🚀")).toBe(9);
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

  it("joins title, body, and hashtags with blank lines", () => {
    expect(composeCaption(source)).toBe("post title\n\npost body\n\n#launch #beta");
  });

  it("appends a resolved signature between the body and hashtags", () => {
    expect(
      composeCaption({
        ...source,
        signature: "Follow Alpha Studio on Instagram.",
      }),
    ).toBe("post title\n\npost body\n\nFollow Alpha Studio on Instagram.\n\n#launch #beta");
    expect(composeCaption({ ...source, hashtags: [], signature: "  " })).toBe(
      "post title\n\npost body",
    );
  });

  it("prefers target overrides over the post's own content", () => {
    expect(
      composeCaption({
        ...source,
        defaultText: "post body",
        descriptionOverride: "override body",
        hashtags: [],
        titleOverride: "  override title  ",
      }),
    ).toBe("override title\n\noverride body");
    expect(composeCaption({ ...source, hashtags: [] })).toBe("post title\n\npost body");
  });

  it("keeps a body equal to the title from repeating", () => {
    expect(composeCaption({ ...source, defaultText: "post title", hashtags: [] })).toBe(
      "post title",
    );
  });

  it("omits empty sections", () => {
    expect(
      composeCaption({
        ...source,
        defaultText: "   ",
        hashtags: [],
        title: " ",
      }),
    ).toBe("");
    expect(composeCaption({ ...source, defaultText: null, title: "" })).toBe("#launch #beta");
  });
});

describe("validatePublishInput", () => {
  it("returns no issues for a publishable payload", () => {
    expect(validatePublishInput(capability(), input())).toEqual([]);
  });

  it("accepts a text-only publish when the platform permits zero attachments", () => {
    expect(validatePublishInput(capability(), input({ media: [] }))).toEqual([]);
  });

  it("measures the caption limit in codepoints", () => {
    const emoji = "🚀".repeat(500);
    expect(emoji.length).toBe(1_000);
    expect(validatePublishInput(capability(), input({ caption: emoji }))).toEqual([]);
  });

  it("reports a caption over the limit with the limit and actual length", () => {
    const issue = only(validatePublishInput(capability(), input({ caption: "a".repeat(501) })));
    expect(issue).toMatchObject({
      actual: 501,
      constraint: "provider_caption_limit",
      field: "caption",
      limit: 500,
    });
    expect(issue.message).toContain("500");
  });

  it("skips the caption check when the platform has no limit", () => {
    expect(
      validatePublishInput(
        capability({ max_caption_length: null }),
        input({ caption: "a".repeat(5_000) }),
      ),
    ).toEqual([]);
  });

  it("reports too many hashtags with the limit and actual count", () => {
    expect(
      only(
        validatePublishInput(capability(), input({ hashtags: ["one", "two", "three", "four"] })),
      ),
    ).toMatchObject({
      actual: 4,
      constraint: "provider_hashtag_limit",
      field: "hashtags",
      limit: 3,
    });
  });

  it("reports an attachment kind the platform does not accept", () => {
    expect(
      only(
        validatePublishInput(
          capability({ asset_types: ["image"], max_video_duration_sec: null }),
          input(),
        ),
      ),
    ).toMatchObject({
      constraint: "unsupported_asset_type",
      field: "media[0].contentType",
    });
  });

  it("reports a media type outside the accepted list", () => {
    expect(
      only(
        validatePublishInput(
          capability(),
          input({
            media: [
              video({
                contentType: "video/quicktime",
                url: "https://cdn.example.com/clip.mov?token=1",
              }),
            ],
          }),
        ),
      ),
    ).toMatchObject({
      constraint: "unsupported_media_type",
      field: "media[0].contentType",
    });
  });

  it("accepts a media type carrying parameters and mixed case", () => {
    expect(
      validatePublishInput(
        capability(),
        input({ media: [video({ contentType: "Video/MP4; codecs=avc1" })] }),
      ),
    ).toEqual([]);
  });

  it("reports media over the file size limit with the limit and actual size", () => {
    expect(
      only(validatePublishInput(capability(), input({ media: [video({ fileSize: 1_001 })] }))),
    ).toMatchObject({
      actual: 1_001,
      constraint: "provider_file_size_limit",
      field: "media[0].fileSize",
      limit: 1_000,
    });
  });

  it("reports a video over the duration limit with the limit and actual duration", () => {
    expect(
      only(
        validatePublishInput(
          capability(),
          input({ media: [video({ metadata: { durationSeconds: 61 } })] }),
        ),
      ),
    ).toMatchObject({
      actual: 61,
      constraint: "provider_video_duration_limit",
      field: "media[0].metadata.durationSeconds",
      limit: 60,
    });
  });

  it("reports an unknown video duration when the platform caps duration", () => {
    const issue = only(
      validatePublishInput(capability(), input({ media: [video({ metadata: undefined })] })),
    );
    expect(issue).toMatchObject({
      constraint: "provider_video_duration_limit",
      limit: 60,
    });
    expect(issue.actual).toBeUndefined();
  });

  it("ignores duration for an image attachment", () => {
    expect(validatePublishInput(capability(), input({ media: [image()] }))).toEqual([]);
  });

  it("requires media when the platform sets a minimum attachment count", () => {
    expect(validatePublishInput(capability({ min_media_count: 1 }), input({ media: [] }))).toEqual([
      {
        constraint: "provider_media_required",
        field: "media",
        limit: 1,
        message:
          "threads requires at least 1 attachment; remove the caption-only target or add media",
      },
    ]);
  });

  it("rejects a publication with neither attachments nor anything to say", () => {
    expect(
      only(validatePublishInput(capability(), input({ caption: "  ", hashtags: [], media: [] }))),
    ).toMatchObject({
      constraint: "provider_empty_publish",
      field: "caption",
    });
  });

  it("accepts an ordered multi-attachment set the platform can combine", () => {
    expect(
      validatePublishInput(capability(), input({ media: [image(), video(), image()] })),
    ).toEqual([]);
  });

  it("reports a media type outside the accepted list at its own position", () => {
    expect(
      only(
        validatePublishInput(
          capability(),
          input({ media: [image(), image({ contentType: "image/webp" })] }),
        ),
      ),
    ).toMatchObject({
      constraint: "unsupported_media_type",
      field: "media[1].contentType",
    });
  });

  it("rejects a multi-attachment set containing an unrecognized media type", () => {
    expect(
      validatePublishInput(
        capability(),
        input({ media: [image(), video({ contentType: "audio/mpeg" })] }),
      ).map((issue) => issue.constraint),
    ).toEqual(["unsupported_media_combination", "unsupported_media_type"]);
  });

  it("reports attachment sets over the platform maximum", () => {
    expect(
      only(
        validatePublishInput(
          capability({ max_media_count: 2 }),
          input({ media: [image(), image(), image()] }),
        ),
      ),
    ).toMatchObject({
      actual: 3,
      constraint: "provider_media_count_limit",
      field: "media",
      limit: 2,
    });
  });

  it("rejects combinations the platform cannot publish together", () => {
    expect(
      only(
        validatePublishInput(
          capability({ multi_asset_types: ["image"] }),
          input({ media: [image(), video()] }),
        ),
      ),
    ).toMatchObject({
      constraint: "unsupported_media_combination",
      field: "media",
    });
  });

  it("rejects any multi-attachment set when the platform declares no combinations", () => {
    const noCombinations: Array<PlatformCapability["multi_asset_types"]> = [null, []];
    for (const multi of noCombinations) {
      expect(
        only(
          validatePublishInput(
            capability({ multi_asset_types: multi, max_media_count: 1 }),
            input({ media: [image(), image()] }),
          ).filter((issue) => issue.constraint === "unsupported_media_combination"),
        ),
      ).toMatchObject({ constraint: "unsupported_media_combination" });
    }
  });

  it("requires TikTok creator publish options", () => {
    const tiktok = capability({ platform: "tiktok" });
    expect(only(validatePublishInput(tiktok, input({ providerOptions: undefined })))).toMatchObject(
      {
        constraint: "tiktok_publish_options_required",
        field: "providerOptions.tiktok",
      },
    );
    expect(only(validatePublishInput(tiktok, input({ providerOptions: {} })))).toMatchObject({
      constraint: "tiktok_publish_options_required",
    });
    expect(
      validatePublishInput(tiktok, input({ providerOptions: { tiktok: tiktokOptions } })),
    ).toEqual([]);
  });

  it("does not require publish options for other platforms", () => {
    expect(validatePublishInput(capability(), input({ providerOptions: undefined }))).toEqual([]);
  });

  it("reports every unmet constraint at once", () => {
    const issues = validatePublishInput(
      capability({ platform: "tiktok" }),
      input({
        caption: "a".repeat(501),
        hashtags: ["one", "two", "three", "four"],
        media: [
          video({
            contentType: "video/quicktime",
            fileSize: 1_001,
            metadata: { durationSeconds: 61 },
            url: "https://cdn.example.com/clip.mov?token=1",
          }),
        ],
        providerOptions: undefined,
      }),
    );
    expect(issues.map((issue) => issue.constraint)).toEqual([
      "unsupported_media_type",
      "provider_file_size_limit",
      "provider_video_duration_limit",
      "provider_caption_limit",
      "provider_hashtag_limit",
      "tiktok_publish_options_required",
    ]);
  });

  it("does not mutate its arguments", () => {
    const platformCapability = capability();
    const publishInput = input({ hashtags: ["#bad"] });
    const capabilitySnapshot = structuredClone(platformCapability);
    const inputSnapshot = structuredClone(publishInput);

    validatePublishInput(platformCapability, publishInput);

    expect(platformCapability).toEqual(capabilitySnapshot);
    expect(publishInput).toEqual(inputSnapshot);
  });
});
