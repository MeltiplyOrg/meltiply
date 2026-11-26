import { describe, expect, it } from "vite-plus/test";

import { facebookOptionsToWire, resolveFacebookPostType } from "../src/facebook/options";
import type { FacebookPublishOptions } from "../src/types";

const experiment = {
  name: "test",
  controlVideoId: "1",
  experimentVideoIds: ["1", "2"],
  optimizationGoal: "COMMENTS",
} as const;
const withExperiment = (patch: object): FacebookPublishOptions => ({
  postType: "ab_test",
  abTest: { ...experiment, experimentVideoIds: ["1", "2"], ...patch },
});
const images = (count: number) => Array.from({ length: count }, () => "image" as const);
const link = "https://a.test";
const card = { link, picture: "https://a.test/p.jpg" };

describe("resolveFacebookPostType", () => {
  it.each([
    ["one video by default", undefined, ["video"], "reel"],
    ["no attachment by default", undefined, [], "feed"],
    ["images by default", {}, images(2), "feed"],
    ["an explicit video", { postType: "video" }, ["video"], "video"],
    ["a Story with one image", { postType: "story" }, images(1), "story"],
    ["a slideshow of three images", { postType: "slideshow" }, images(3), "slideshow"],
    ["a slideshow of seven images", { postType: "slideshow" }, images(7), "slideshow"],
    [
      "a crosspost with a video ID",
      { postType: "crosspost", crosspostedVideoId: "9" },
      [],
      "crosspost",
    ],
    ["a live without attachments", { postType: "live" }, [], "live"],
    ["a complete experiment", withExperiment({}), [], "ab_test"],
    [
      "an experiment of four videos",
      withExperiment({ experimentVideoIds: ["1", "2", "3", "4"] }),
      [],
      "ab_test",
    ],
    ["an experiment of 1800 seconds", withExperiment({ durationSeconds: 1800 }), [], "ab_test"],
    ["an experiment of one week", withExperiment({ durationSeconds: 604_800 }), [], "ab_test"],
    ["a draft feed", { deliveryMode: "draft" }, [], "feed"],
    ["a plain http link", { link: "http://a.test" }, [], "feed"],
    ["two link cards", { link, linkCards: [card, card] }, [], "feed"],
    ["five link cards", { link, linkCards: [card, card, card, card, card] }, [], "feed"],
  ] as const)("%s", (_example, options, kinds, postType) => {
    expect(resolveFacebookPostType(options as FacebookPublishOptions | undefined, kinds)).toEqual(
      postType,
    );
  });

  it.each([
    ["an unknown method", { postType: "poll" as never }, []],
    ["an unrecognized attachment", undefined, [null]],
    ["a feed post with a video among images", undefined, ["image", "video"] as const],
    ["a Reel with an image", { postType: "reel" } as const, images(1)],
    ["a video method with two videos", { postType: "video" } as const, ["video", "video"] as const],
    ["a Story with two attachments", { postType: "story" } as const, images(2)],
    ["a live with an attachment", { postType: "live" } as const, ["video"] as const],
    ["a slideshow of two images", { postType: "slideshow" } as const, images(2)],
    ["a slideshow of eight images", { postType: "slideshow" } as const, images(8)],
    [
      "a slideshow with a video",
      { postType: "slideshow" } as const,
      ["image", "image", "video"] as const,
    ],
    ["a crosspost without a video ID", { postType: "crosspost" } as const, []],
    ["a video ID outside a crosspost", { crosspostedVideoId: "9" }, []],
    ["an experiment outside an A/B test", { abTest: { name: "x" } }, []],
    ["an unknown delivery mode", { deliveryMode: "later" as never }, []],
    ["a draft Story", { postType: "story", deliveryMode: "draft" } as const, images(1)],
    ["an experiment with a blank name", withExperiment({ name: " " }), []],
    ["an experiment name of 201 characters", withExperiment({ name: "n".repeat(201) }), []],
    ["an experiment without a control", withExperiment({ controlVideoId: undefined }), []],
    ["an experiment without a goal", withExperiment({ optimizationGoal: undefined }), []],
    ["an experiment with an unknown goal", withExperiment({ optimizationGoal: "CLICKS" }), []],
    ["an experiment of one video", withExperiment({ experimentVideoIds: ["1"] }), []],
    [
      "an experiment of five videos",
      withExperiment({ experimentVideoIds: ["1", "2", "3", "4", "5"] }),
      [],
    ],
    ["an experiment with a repeated video", withExperiment({ experimentVideoIds: ["1", "1"] }), []],
    ["an experiment with a bad video ID", withExperiment({ experimentVideoIds: ["1", "a/b"] }), []],
    ["a control outside the videos", withExperiment({ controlVideoId: "3" }), []],
    ["an experiment under 1800 seconds", withExperiment({ durationSeconds: 1799 }), []],
    ["an experiment over one week", withExperiment({ durationSeconds: 604_801 }), []],
    ["a fractional experiment duration", withExperiment({ durationSeconds: 1800.5 }), []],
    ["a link with credentials", { link: "https://u:p@a.test" }, []],
    ["a link of another protocol", { link: "ftp://a.test" }, []],
    ["a link of 2049 characters", { link: `https://a.test/${"a".repeat(2034)}` }, []],
    [
      "a card with an http picture",
      { link, linkCards: [card, { link, picture: "http://a.test" }] },
      [],
    ],
    [
      "a card name of 201 characters",
      { link, linkCards: [card, { ...card, name: "n".repeat(201) }] },
      [],
    ],
    [
      "a card description of 5001 characters",
      { link, linkCards: [card, { ...card, description: "d".repeat(5001) }] },
      [],
    ],
    ["a link on an image post", { link }, images(1)],
    ["cards without a link", { linkCards: [card, card] }, []],
    ["one link card", { link, linkCards: [card] }, []],
    ["six link cards", { link, linkCards: [card, card, card, card, card, card] }, []],
  ])("refuses %s", (_example, options, kinds) => {
    expect(resolveFacebookPostType(options, kinds)).toEqual(null);
  });
});

describe("facebookOptionsToWire", () => {
  it("no options", () => {
    expect(facebookOptionsToWire({})).toEqual({});
  });

  it("every option", () => {
    const options: FacebookPublishOptions = {
      postType: "ab_test",
      deliveryMode: "publish",
      link,
      linkCards: [card],
      crosspostedVideoId: "9",
      abTest: { ...experiment, experimentVideoIds: ["1", "2"], durationSeconds: 1800 },
    };

    expect(facebookOptionsToWire(options)).toEqual({
      post_type: "ab_test",
      delivery_mode: "publish",
      link,
      link_cards: [card],
      crossposted_video_id: "9",
      ab_test: {
        name: "test",
        control_video_id: "1",
        experiment_video_ids: ["1", "2"],
        optimization_goal: "COMMENTS",
        duration_seconds: 1800,
      },
    });
  });

  it("an empty experiment draft", () => {
    expect(facebookOptionsToWire({ abTest: {} })).toEqual({ ab_test: {} });
  });
});
