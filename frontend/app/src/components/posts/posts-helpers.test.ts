import { describe, expect, it } from "vite-plus/test";

import {
  prunePostSelection,
  resolveChannelMedia,
  resolveChannelText,
  resolveRowCaption,
} from "./posts-helpers";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type { Distribution, Post, PostAttachment } from "@/types";
import type { PostDetailItem, PostRow, PostSelectionEntry } from "./types";

const basePost = contractSuccessBody<Post>("getPost");
const baseDistribution = contractSuccessBody<Distribution>("getDistribution");
const published = baseDistribution.publication!;
const liveAttachment = basePost.attachments[0]!;
const detachedAssetId = "00000000-0000-4000-8000-000000000555";

/**
 * Builds a PostAttachment whose Asset reuses the getPost fixture shape under a
 * different id/position, so tests can model Posts carrying more than one asset.
 */
function attachmentOf(assetId: string, position: number): PostAttachment {
  return {
    asset_id: assetId,
    position,
    asset: { ...liveAttachment.asset, id: assetId },
  };
}

/** Minimal claimed-channel entry: only `distribution` and its media matter here. */
function channelItem(overrides: Partial<PostDetailItem>): PostDetailItem {
  return {
    id: baseDistribution.id,
    postId: basePost.id,
    publishDate: baseDistribution.created_at,
    status: "published",
    content: [],
    attachments: [],
    ...overrides,
  };
}

/** Minimal row over the getPost fixture; callers override channels/post. */
function postRow(overrides: Partial<PostRow>): PostRow {
  return {
    id: basePost.id,
    date: basePost.created_at,
    status: "published",
    channels: [],
    brandProfileId: basePost.brand_profile_id,
    post: basePost,
    ...overrides,
  };
}

describe("resolveChannelMedia", () => {
  it("keeps the frozen publication order of a claimed Channel after Post edits", () => {
    // Claim froze [detached@0, live@1]; the edited Post still holds only the
    // live asset at position 0, so live order would rank it first.
    const distribution: Distribution = {
      ...baseDistribution,
      publication: {
        ...published,
        media: [
          {
            asset_id: detachedAssetId,
            position: 0,
            asset_type: "image",
            content_type: "image/png",
            file_size: 1024,
            width: 640,
            height: 640,
            duration_sec: null,
          },
          { ...published.media[0]!, position: 1 },
        ],
      },
    };
    const editedPost: Post = { ...basePost, default_text: "Edited caption" };

    const media = resolveChannelMedia(editedPost, basePost.targets[0], distribution);

    expect(media.map((item) => item.assetId)).toEqual([detachedAssetId, liveAttachment.asset_id]);
    expect(media.map((item) => item.position)).toEqual([0, 1]);
    expect(media[0]!.attachment).toBeUndefined();
    expect(media[1]!.attachment?.asset_id).toBe(liveAttachment.asset_id);
  });

  it("keeps frozen facts for a media item whose Asset was detached from the Post", () => {
    const distribution: Distribution = {
      ...baseDistribution,
      publication: {
        ...published,
        media: [
          {
            asset_id: detachedAssetId,
            position: 0,
            asset_type: "video",
            content_type: "video/mp4",
            file_size: 2048,
            width: 1080,
            height: 1920,
            duration_sec: 12.5,
          },
        ],
      },
    };

    const media = resolveChannelMedia(basePost, undefined, distribution);

    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      assetId: detachedAssetId,
      assetType: "video",
      attachment: undefined,
      contentType: "video/mp4",
      fileSize: 2048,
      width: 1080,
      height: 1920,
      durationSec: 12.5,
      position: 0,
    });
  });

  it("inherits the Post order for an unclaimed target and honors its selection", () => {
    const second = attachmentOf("00000000-0000-4000-8000-000000000222", 1);
    const post: Post = { ...basePost, attachments: [liveAttachment, second] };

    // Inherit: no target, and a claimed-less outcome resolves live too.
    const inherited = resolveChannelMedia(post, undefined, {
      ...baseDistribution,
      publication: null,
    });
    expect(inherited.map((item) => item.assetId)).toEqual([
      liveAttachment.asset_id,
      second.asset_id,
    ]);
    expect(inherited.every((item) => item.attachment)).toBe(true);

    // Narrow + reorder: the target's attachment_ids define membership and order.
    const narrowed = resolveChannelMedia(
      post,
      { attachment_ids: [second.asset_id, liveAttachment.asset_id] },
      undefined,
    );
    expect(narrowed.map((item) => item.assetId)).toEqual([
      second.asset_id,
      liveAttachment.asset_id,
    ]);
    expect(narrowed.map((item) => item.position)).toEqual([0, 1]);

    expect(resolveChannelMedia(post, { attachment_ids: [] }, undefined)).toEqual([]);
  });
});

describe("resolveChannelText", () => {
  it("keeps the frozen caption of a claimed Channel after Post edits", () => {
    const editedPost: Post = { ...basePost, default_text: "Edited caption" };
    expect(resolveChannelText(editedPost, {}, published)).toBe(published.title);
    expect(resolveChannelText(editedPost, {}, published)).not.toBe("Edited caption");
  });

  it("returns empty for a frozen media-only publication instead of edited Post text", () => {
    const mediaOnly = { ...published, title: "", text: "" };
    const editedPost: Post = { ...basePost, default_text: "Edited caption" };
    expect(resolveChannelText(editedPost, { description_override: "New copy" }, mediaOnly)).toBe(
      "",
    );
  });

  it("resolves overrides then the Post default for unclaimed Channels", () => {
    expect(resolveChannelText(basePost, { title_override: "Channel copy" }, null)).toBe(
      "Channel copy",
    );
    expect(resolveChannelText(basePost, {}, undefined)).toBe(basePost.default_text);
  });
});

describe("resolveRowCaption", () => {
  it("prefers a claimed Channel's frozen caption over the edited Post", () => {
    const row = postRow({
      post: { ...basePost, default_text: "Edited caption" },
      channels: [
        channelItem({
          distribution: baseDistribution,
          content: [{ content: "Stale pending copy" }],
        }),
      ],
    });
    expect(resolveRowCaption(row)).toBe(published.title);
  });

  it("does not fall back to edited Post text for a frozen media-only publication", () => {
    const row = postRow({
      post: { ...basePost, default_text: "Edited caption", title: "Edited label" },
      channels: [
        channelItem({
          distribution: {
            ...baseDistribution,
            publication: { ...published, title: "", text: "" },
          },
          content: [{ content: "Edited caption" }],
        }),
      ],
    });
    expect(resolveRowCaption(row)).toBe("");
  });
});

describe("prunePostSelection", () => {
  const entry = (
    id: string,
    brandProfileId = "profile-1",
    isDraft = false,
  ): PostSelectionEntry => ({
    id,
    brandProfileId,
    isDraft,
  });

  it("drops selected posts absent from settled loaded data", () => {
    const selection = new Map([
      ["post-1", entry("post-1")],
      ["post-2", entry("post-2")],
    ]);
    const pruned = prunePostSelection(selection, [{ id: "post-1", brandProfileId: "profile-1" }], {
      dataSettled: true,
      draftFilter: false,
    });
    expect([...pruned.keys()]).toEqual(["post-1"]);
  });

  it("retains failures and pending entries while queries are mid-flight", () => {
    const selection = new Map([["post-1", entry("post-1")]]);
    // An empty `known` list simulates a refetch snapshot: nothing may be pruned off it.
    const pruned = prunePostSelection(selection, [], {
      dataSettled: false,
      draftFilter: false,
    });
    expect(pruned).toBe(selection);
    expect(pruned.has("post-1")).toBe(true);
  });

  it("retains non-draft entries when the draft-only query cannot prove removal", () => {
    const selection = new Map([
      ["scheduled-1", entry("scheduled-1")],
      ["draft-1", entry("draft-1", "profile-1", true)],
    ]);
    const pruned = prunePostSelection(selection, [], {
      dataSettled: true,
      draftFilter: true,
    });
    expect([...pruned.keys()]).toEqual(["scheduled-1"]);
  });

  it("refreshes the owning profile snapshot from loaded data", () => {
    const selection = new Map([["post-1", entry("post-1", "profile-old")]]);
    const pruned = prunePostSelection(
      selection,
      [{ id: "post-1", brandProfileId: "profile-new" }],
      {
        dataSettled: true,
        draftFilter: false,
      },
    );
    expect(pruned.get("post-1")?.brandProfileId).toBe("profile-new");
  });

  it("returns the same map identity when nothing changed", () => {
    const selection = new Map([["post-1", entry("post-1")]]);
    const pruned = prunePostSelection(selection, [{ id: "post-1", brandProfileId: "profile-1" }], {
      dataSettled: true,
      draftFilter: false,
    });
    expect(pruned).toBe(selection);
  });
});
