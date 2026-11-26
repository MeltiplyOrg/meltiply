import { beforeAll, describe, expect, it } from "vite-plus/test";

import { toCalendarRows, toPostRow } from "./post-row";
import type { ChannelIntegration } from "@/api/types";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type { CalendarEvent, Distribution, Post, PostTarget } from "@/types";

const basePost = contractSuccessBody<Post>("getPost");
const baseDistribution = contractSuccessBody<Distribution>("getDistribution");
const attachment = basePost.attachments[0]!;

const post: Post = {
  ...basePost,
  brand_profile_id: "profile",
  created_at: "2026-01-01T00:00:00Z",
  default_text: "Post caption",
  distributions: [],
  id: "post",
  status: "active",
  targets: [],
};
const target: PostTarget = {
  ...basePost.targets[0]!,
  attachment_ids: [],
  description_override: null,
  platform_account_id: "account",
  title_override: "Channel copy",
};
const distribution: Distribution = {
  ...baseDistribution,
  created_at: "2026-01-02T00:00:00Z",
  description_override: null,
  failure: null,
  id: "distribution",
  platform_account_id: "account",
  publication: null,
  published_at: null,
  scheduled_at: "2026-01-03T00:00:00Z",
  status: "queued",
  title_override: null,
};
const integration = { id: "account", name: "Alpha" } as ChannelIntegration;

const channel = {
  id: "distribution",
  postId: "post",
  publishDate: "2026-01-03T00:00:00Z",
  status: "queued",
  errorMessage: null,
  integration: undefined,
  caption: "Post caption",
  attachments: [{ assetId: attachment.asset_id, assetType: "image", attachment, position: 0 }],
  distribution,
  target: undefined,
};
const row = {
  id: "post",
  brandProfileId: "profile",
};

beforeAll(() => {
  toCalendarRows([event("warm")], new Map(), new Map(), "Pacific/Kiritimati");
  toPostRow(post, new Map());
});

describe("toPostRow", () => {
  it("an unclaimed target with its own copy and no media", () => {
    const source = { ...post, targets: [target] };

    expect(toPostRow(source, new Map([["account", integration]]))).toEqual({
      ...row,
      date: "2026-01-01T00:00:00Z",
      status: "scheduled",
      post: source,
      channels: [
        {
          id: "target:account",
          postId: "post",
          publishDate: "2026-01-01T00:00:00Z",
          status: "scheduled",
          errorMessage: null,
          integration,
          caption: "Channel copy",
          attachments: [],
          distribution: undefined,
          target,
        },
      ],
    });
  });

  it("a distribution without a target", () => {
    const source = { ...post, distributions: [distribution] };

    expect(toPostRow(source, new Map())).toEqual({
      ...row,
      date: "2026-01-03T00:00:00Z",
      status: "queued",
      post: source,
      channels: [channel],
    });
  });

  it("a target listed twice with one distribution", () => {
    const source = { ...post, targets: [target, target], distributions: [distribution] };

    expect(toPostRow(source, new Map()).channels).toEqual([
      { ...channel, attachments: [], target },
    ]);
  });

  it("a claimed Channel with frozen copy and media", () => {
    const publication = {
      ...baseDistribution.publication!,
      title: "Frozen title",
      media: [{ ...baseDistribution.publication!.media[0]!, asset_id: "frozen-asset" }],
    };
    const source = { ...post, distributions: [{ ...distribution, publication }] };

    const [claimed] = toPostRow(source, new Map()).channels;

    expect([claimed!.caption, claimed!.attachments.map((item) => item.assetId)]).toEqual([
      "Frozen title",
      ["frozen-asset"],
    ]);
  });

  it.each([
    ["a published distribution", null, "2026-01-04T00:00:00Z", "2026-01-04T00:00:00Z"],
    ["a distribution with no times", null, null, "2026-01-02T00:00:00Z"],
  ])("%s", (_example, scheduled_at, published_at, publishDate) => {
    const source = { ...post, distributions: [{ ...distribution, scheduled_at, published_at }] };

    expect(toPostRow(source, new Map()).channels[0]!.publishDate).toEqual(publishDate);
  });

  it("a failed distribution", () => {
    const failure = { ...baseDistribution.failure!, message: "Provider said no" };
    const source = { ...post, distributions: [{ ...distribution, failure }] };

    expect(toPostRow(source, new Map()).channels[0]!.errorMessage).toEqual("Provider said no");
  });

  it("a draft Post", () => {
    const source = { ...post, status: "draft" as const, targets: [target] };

    const draft = toPostRow(source, new Map());

    expect([draft.status, draft.channels[0]!.status]).toEqual(["draft", "draft"]);
  });
});

function event(id: string, patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    brand_profile_id: "profile",
    id,
    platform: "instagram",
    platform_account_id: "account",
    post_id: "post",
    post_title: "Launch note",
    published_at: null,
    scheduled_at: "2026-01-01T09:00:00Z",
    status: "scheduled",
    updated_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

const eventRow = (source: CalendarEvent, date: string) => ({
  ...row,
  date,
  status: "scheduled",
  channels: [
    {
      id: source.id,
      postId: "post",
      publishDate: date,
      status: "scheduled",
      integration: undefined,
      caption: "",
      attachments: [],
      calendarEvent: source,
    },
  ],
});

describe("toCalendarRows", () => {
  it("an event whose Post is not loaded", () => {
    const source = event("only");

    expect(toCalendarRows([source], new Map(), new Map(), "UTC")).toEqual([
      eventRow(source, "2026-01-01T09:00:00Z"),
    ]);
  });

  it("two events of one Post on one civil day", () => {
    const first = event("first");
    const second = event("second", { scheduled_at: "2026-01-01T09:30:00Z" });

    expect(toCalendarRows([first, second], new Map(), new Map(), "UTC")).toEqual([
      eventRow(first, "2026-01-01T09:00:00Z"),
    ]);
  });

  it("two events on either side of midnight in the publishing zone", () => {
    const before = event("before");
    const after = event("after", { scheduled_at: "2026-01-01T11:00:00Z" });

    expect(toCalendarRows([before, after], new Map(), new Map(), "Pacific/Kiritimati")).toEqual([
      eventRow(before, "2026-01-01T09:00:00Z"),
      eventRow(after, "2026-01-01T11:00:00Z"),
    ]);
  });

  it.each([
    ["a published event", { published_at: "2026-01-02T00:00:00Z" }, "2026-01-02T00:00:00Z"],
    ["an event with no schedule or publication", {}, "2026-01-01T00:00:00Z"],
  ])("%s", (_example, patch, date) => {
    const source = event("only", { scheduled_at: null, ...patch });

    expect(toCalendarRows([source], new Map(), new Map(), "UTC")).toEqual([eventRow(source, date)]);
  });

  it("an event whose Post is loaded", () => {
    const source = { ...post, distributions: [distribution] };

    expect(toCalendarRows([event("only")], new Map([["post", source]]), new Map(), "UTC")).toEqual([
      {
        ...row,
        date: "2026-01-01T09:00:00Z",
        status: "queued",
        post: source,
        channels: [channel],
      },
    ]);
  });

  it("no events", () => {
    expect(toCalendarRows([], new Map(), new Map(), "UTC")).toEqual([]);
  });
});
