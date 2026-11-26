import { describe, expect, it } from "vite-plus/test";

import { contractSuccessBody } from "@/test/contract-fixtures";
import type { CalendarEvent, Distribution, Post } from "@/types";
import { toCalendarRows, toPostRow } from "./post-row";
import { resolveRowCaption } from "./posts-helpers";

const basePost = contractSuccessBody<Post>("getPost");
const baseDistribution = contractSuccessBody<Distribution>("getDistribution");

function event(id: string, scheduledAt: string): CalendarEvent {
  return {
    brand_profile_id: "profile",
    id,
    platform: "instagram",
    platform_account_id: null,
    post_id: "post",
    post_title: "Launch note",
    published_at: null,
    scheduled_at: scheduledAt,
    status: "scheduled",
    updated_at: scheduledAt,
  };
}

describe("toPostRow", () => {
  it("projects an unclaimed Channel's resolved caption and ordered attachments", () => {
    const post: Post = {
      ...basePost,
      targets: [
        {
          ...basePost.targets[0]!,
          platform_account_id: "unclaimed",
          title_override: "Channel copy",
          description_override: null,
          attachment_ids: [basePost.attachments[0]!.asset_id],
        },
      ],
      distributions: [],
    };

    const row = toPostRow(post, new Map());

    expect(row.channels).toHaveLength(1);
    expect(row.channels[0]!.caption).toBe("Channel copy");
    expect(row.channels[0]!.attachments.map((item) => item.assetId)).toEqual([
      basePost.attachments[0]!.asset_id,
    ]);
    expect(resolveRowCaption(row)).toBe("Channel copy");
  });

  it("keeps a claimed Channel's frozen caption and media after Post edits", () => {
    const publication: NonNullable<Distribution["publication"]> = {
      ...baseDistribution.publication!,
      title: "Frozen title",
      text: "Frozen body",
      media: [{ ...baseDistribution.publication!.media[0]!, asset_id: "frozen-asset" }],
    };
    const post: Post = {
      ...basePost,
      default_text: "Edited caption",
      targets: [],
      distributions: [{ ...baseDistribution, publication, platform_account_id: "claimed" }],
    };

    const row = toPostRow(post, new Map());

    expect(row.channels[0]!.caption).toBe("Frozen title");
    expect(row.channels[0]!.attachments.map((item) => item.assetId)).toEqual(["frozen-asset"]);
    expect(resolveRowCaption(row)).toBe("Frozen title");
  });
});

describe("toCalendarRows", () => {
  it("shows the Calendar event title for a row whose Post is not loaded", () => {
    const rows = toCalendarRows(
      [event("only", "2026-01-01T09:00:00Z")],
      new Map(),
      new Map(),
      "UTC",
    );

    expect(rows).toHaveLength(1);
    expect(resolveRowCaption(rows[0]!)).toBe("Launch note");
  });
});
