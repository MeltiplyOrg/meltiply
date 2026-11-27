import { describe, expect, it } from "vite-plus/test";

import { parseProviderWireOptions, resolvePublishProviderOptions } from "../src";

describe("parseProviderWireOptions", () => {
  it("rejects non-objects and unknown top-level platforms", () => {
    expect(parseProviderWireOptions(null)).toEqual({
      message: "provider_options must be an object.",
      ok: false,
    });
    expect(parseProviderWireOptions({ unknown: {} })).toEqual({
      message: "The request contains an unknown field.",
      ok: false,
    });
  });

  it("parses valid options across all five platforms", () => {
    const parsed = parseProviderWireOptions({
      facebook: {
        ab_test: {
          control_video_id: "vid-1",
          duration_seconds: 3600,
          experiment_video_ids: ["vid-2", "vid-3"],
          name: "Hook test",
          optimization_goal: "AVG_TIME_WATCHED",
        },
        crossposted_video_id: "cross-1",
        delivery_mode: "draft",
        link: "https://example.com/post",
        link_cards: [
          {
            description: "Summary",
            link: "https://example.com/card",
            name: "Card title",
            picture: "https://example.com/card.jpg",
          },
        ],
        post_type: "reel",
      },
      instagram: {
        content: { alt_text: "Sunset", collaborators: ["alice"] },
        media_options: [{ alt_text: "Slide 1" }],
        post_type: "reel",
        trial_graduation: "manual",
        trial_reel: true,
      },
      threads: {
        reply_control: "everyone",
      },
      tiktok: {
        allow_comment: true,
        allow_duet: false,
        allow_stitch: true,
        auto_add_music: false,
        brand_content: false,
        brand_organic: false,
        disclose_commercial_content: true,
        is_ai_generated: false,
        music_usage_confirmed: true,
        post_mode: "direct",
        privacy_level: "PUBLIC_TO_EVERYONE",
      },
      youtube: {
        made_for_kids: false,
        post_type: "video",
        privacy_status: "unlisted",
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.facebook?.postType).toBe("reel");
    expect(parsed.value.facebook?.deliveryMode).toBe("draft");
    expect(parsed.value.facebook?.abTest?.durationSeconds).toBe(3600);
    expect(parsed.value.facebook?.linkCards).toHaveLength(1);
    expect(parsed.value.instagram?.trialReel).toBe(true);
    expect(parsed.value.instagram?.trialGraduation).toBe("manual");
    expect(parsed.value.threads?.reply_control).toBe("everyone");
    expect(parsed.value.tiktok?.privacyLevel).toBe("PUBLIC_TO_EVERYONE");
    expect(parsed.value.tiktok?.discloseCommercialContent).toBe(true);
    expect(parsed.value.youtube).toEqual({
      madeForKids: false,
      postType: "video",
      privacyStatus: "unlisted",
    });
  });

  it("rejects invalid facebook wire options and ab_test fields", () => {
    expect(parseProviderWireOptions({ facebook: "bad" }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { extra: 1 } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { post_type: 1 } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { post_type: "invalid" } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { delivery_mode: 1 } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { delivery_mode: "later" } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { crossposted_video_id: 1 } }).ok).toBe(false);
    expect(
      parseProviderWireOptions({ facebook: { crossposted_video_id: "x".repeat(256) } }).ok,
    ).toBe(false);
    expect(parseProviderWireOptions({ facebook: { link: 1 } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { link: "x".repeat(2049) } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { link_cards: Array(6).fill({}) } }).ok).toBe(
      false,
    );
    expect(parseProviderWireOptions({ facebook: { link_cards: ["bad"] } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { link_cards: [{ extra: 1 }] } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { link_cards: [{ name: 1 }] } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { link_cards: [{ description: 1 }] } }).ok).toBe(
      false,
    );
    expect(parseProviderWireOptions({ facebook: { link_cards: [{ link: 1 }] } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { link_cards: [{ picture: 1 }] } }).ok).toBe(false);
    expect(
      parseProviderWireOptions({ facebook: { link_cards: [{ link: "x".repeat(2049) }] } }).ok,
    ).toBe(false);
    expect(
      parseProviderWireOptions({ facebook: { link_cards: [{ name: "x".repeat(201) }] } }).ok,
    ).toBe(false);
    expect(parseProviderWireOptions({ facebook: { ab_test: "bad" } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { ab_test: { extra: 1 } } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { ab_test: { name: 1 } } }).ok).toBe(false);
    expect(parseProviderWireOptions({ facebook: { ab_test: { control_video_id: 1 } } }).ok).toBe(
      false,
    );
    expect(
      parseProviderWireOptions({ facebook: { ab_test: { experiment_video_ids: [1] } } }).ok,
    ).toBe(false);
    expect(parseProviderWireOptions({ facebook: { ab_test: { optimization_goal: 1 } } }).ok).toBe(
      false,
    );
    expect(
      parseProviderWireOptions({ facebook: { ab_test: { optimization_goal: "NOPE" } } }).ok,
    ).toBe(false);
    expect(parseProviderWireOptions({ facebook: { ab_test: { duration_seconds: 0 } } }).ok).toBe(
      false,
    );
    expect(
      parseProviderWireOptions({ facebook: { ab_test: { duration_seconds: 604801 } } }).ok,
    ).toBe(false);
  });

  it("rejects invalid instagram, threads, tiktok, and youtube wire options", () => {
    expect(parseProviderWireOptions({ instagram: "bad" }).ok).toBe(false);
    expect(parseProviderWireOptions({ instagram: { extra: 1 } }).ok).toBe(false);
    expect(parseProviderWireOptions({ instagram: { content: "bad" } }).ok).toBe(false);
    expect(parseProviderWireOptions({ instagram: { media_options: "bad" } }).ok).toBe(false);
    expect(parseProviderWireOptions({ instagram: { post_type: "invalid" } }).ok).toBe(false);
    expect(parseProviderWireOptions({ instagram: { trial_reel: "yes" } }).ok).toBe(false);
    expect(parseProviderWireOptions({ instagram: { trial_graduation: "invalid" } }).ok).toBe(false);

    expect(parseProviderWireOptions({ threads: { reply_control: "invalid" } }).ok).toBe(false);

    expect(parseProviderWireOptions({ tiktok: "bad" }).ok).toBe(false);
    expect(parseProviderWireOptions({ tiktok: { extra: 1 } }).ok).toBe(false);
    expect(parseProviderWireOptions({ tiktok: { post_mode: 1 } }).ok).toBe(false);
    expect(parseProviderWireOptions({ tiktok: { post_mode: "draft" } }).ok).toBe(false);
    expect(
      parseProviderWireOptions({
        tiktok: {
          allow_comment: true,
          allow_duet: true,
          allow_stitch: true,
          brand_content: false,
          brand_organic: false,
          is_ai_generated: false,
          music_usage_confirmed: false,
        },
      }).ok,
    ).toBe(false);

    expect(parseProviderWireOptions({ youtube: "bad" }).ok).toBe(false);
    expect(parseProviderWireOptions({ youtube: { extra: 1 } }).ok).toBe(false);
    expect(parseProviderWireOptions({ youtube: { post_type: "short" } }).ok).toBe(false);
    expect(parseProviderWireOptions({ youtube: { privacy_status: "secret" } }).ok).toBe(false);
  });
});

describe("resolvePublishProviderOptions", () => {
  const youtube = { madeForKids: false, privacyStatus: "public" } as const;

  it("leaves channel and content issues that carry details to validatePublishInput", () => {
    expect(resolvePublishProviderOptions({ youtube }, "threads", [])).toEqual({
      ok: true,
      value: { youtube },
    });
    const instagram = { content: { alt_text: "Sunset" } };
    expect(resolvePublishProviderOptions({ instagram }, "instagram", ["video"])).toEqual({
      ok: true,
      value: { instagram },
    });
  });

  it("reports the channel mismatch before the TikTok choices it also lacks", () => {
    expect(resolvePublishProviderOptions({ instagram: {} }, "tiktok", ["video"])).toEqual({
      message: "Instagram provider options require an Instagram account.",
      ok: false,
    });
  });

  it("rejects a placement that does not fit the attachments", () => {
    expect(
      resolvePublishProviderOptions({ instagram: { postType: "reel" } }, "instagram", ["image"]),
    ).toEqual({
      message:
        "The selected Instagram post type or trial Reel does not apply to this attachment set.",
      ok: false,
    });
  });
});
