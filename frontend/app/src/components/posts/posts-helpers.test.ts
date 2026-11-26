import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  filterAndSortPosts,
  formatPostDate,
  normalizePostStatus,
  prunePostSelection,
  resolveCancellableDistributionIds,
  resolveChannelMedia,
  resolveChannelText,
  resolvePostAnalytics,
  resolvePostDisplayDate,
  resolveRowCaption,
  resolveRowPreviewAttachment,
  resolveRowProviders,
  toLocalDateKey,
} from "./posts-helpers";
import type { FilterCriteria, PostDetailItem, PostRow, PostSelectionEntry } from "./types";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type { Distribution, Post, PostAttachment } from "@/types";

const basePost = contractSuccessBody<Post>("getPost");
const baseDistribution = contractSuccessBody<Distribution>("getDistribution");
const publication = baseDistribution.publication!;
const frozenMedia = publication.media[0]!;
const attachment = basePost.attachments[0]!;
const secondAssetId = "00000000-0000-4000-8000-000000000222";
const detachedAssetId = "00000000-0000-4000-8000-000000000555";
const second: PostAttachment = {
  asset_id: secondAssetId,
  position: 1,
  asset: { ...attachment.asset, id: secondAssetId },
};
const twoAttachments: Post = { ...basePost, attachments: [attachment, second] };
const media = (item: PostAttachment, position: number) => ({
  assetId: item.asset_id,
  assetType: item.asset.asset_type,
  attachment: item,
  position,
});

function distribution(status: Distribution["status"], patch: Partial<Distribution> = {}) {
  return { ...baseDistribution, status, ...patch };
}

function channel(patch: Partial<PostDetailItem> = {}): PostDetailItem {
  return {
    id: "channel",
    postId: "post",
    publishDate: "2026-01-01T00:00:00Z",
    status: "published",
    caption: "",
    attachments: [],
    ...patch,
  };
}

function postRow(patch: Partial<PostRow> = {}): PostRow {
  return {
    id: "post",
    date: "2026-01-01T00:00:00Z",
    status: "published",
    channels: [],
    brandProfileId: "profile-a",
    post: { ...basePost, status: "active" },
    ...patch,
  };
}

const outcome = (status: Distribution["status"]) =>
  channel({ status, distribution: distribution(status) });

const draft = postRow({ id: "draft-a", status: "draft", date: "2026-01-06T00:00:00Z" });
const mixed = postRow({
  id: "mixed-b",
  brandProfileId: "profile-b",
  date: "2026-01-05T00:00:00Z",
  channels: [outcome("published"), outcome("failed")],
});
const queued = postRow({
  id: "queued-c",
  status: "scheduled",
  brandProfileId: "profile-c",
  date: "2026-01-04T00:00:00Z",
  channels: [outcome("queued")],
});
const reconciliation = postRow({
  id: "reconciliation-d",
  status: "needs_reconciliation",
  date: "2026-01-03T00:00:00Z",
  channels: [outcome("needs_reconciliation")],
});
const unknown = postRow({
  id: "unknown-e",
  status: "future_provider_status",
  date: "2026-01-02T00:00:00Z",
  channels: [channel({ status: "future_provider_status" })],
});
const cancelRequested = postRow({
  id: "cancel-f",
  status: "cancel_requested",
  date: "2026-01-01T00:00:00Z",
  channels: [outcome("cancel_requested")],
});
const rows = [draft, mixed, queued, reconciliation, unknown, cancelRequested];

const everything: FilterCriteria = {
  statusFilter: [],
  profileFilter: [],
  platformFilter: [],
  searchQuery: "",
  dateFilter: "all",
  sortKey: "date-desc",
};

beforeAll(() => {
  formatPostDate("2026-01-01T00:00:00Z", "Asia/Tokyo", "de");
  filterAndSortPosts(rows, everything);
});

describe("filterAndSortPosts", () => {
  it("no filter, newest first", () => {
    expect(filterAndSortPosts([...rows].reverse(), everything)).toEqual(rows);
  });

  it("oldest first", () => {
    expect(filterAndSortPosts(rows, { ...everything, sortKey: "date-asc" })).toEqual(
      [...rows].reverse(),
    );
  });

  it.each([
    ["the draft status", ["draft"], [draft]],
    ["the failed status", ["failed"], [mixed, reconciliation]],
    ["the scheduled status", ["scheduled"], [queued, cancelRequested]],
    ["the published status", ["published"], [mixed]],
    ["several statuses one post matches twice", ["published", "failed"], [mixed, reconciliation]],
  ] as const)("%s", (_example, statusFilter, expected) => {
    const filters = { ...everything, statusFilter: [...statusFilter] };

    expect(filterAndSortPosts(rows, filters)).toEqual(expected);
  });

  it("two profiles", () => {
    const filters = { ...everything, profileFilter: ["profile-b", "profile-c"] };

    expect(filterAndSortPosts(rows, filters)).toEqual([mixed, queued]);
  });

  it("a status and a profile together", () => {
    const filters: FilterCriteria = {
      ...everything,
      statusFilter: ["scheduled", "failed"],
      profileFilter: ["profile-b"],
    };

    expect(filterAndSortPosts(rows, filters)).toEqual([mixed]);
  });

  it("a platform in capitals for a disconnected Channel", () => {
    const orphaned = postRow({
      channels: [channel({ distribution: distribution("published", { platform: "instagram" }) })],
    });
    const filters = { ...everything, platformFilter: ["Instagram"] };

    expect(filterAndSortPosts([orphaned, unknown], filters)).toEqual([orphaned]);
  });

  it("a padded search of the caption", () => {
    const launch = postRow({ channels: [channel({ caption: "Launch day" })] });
    const filters = { ...everything, searchQuery: "  LAUNCH  " };

    expect(filterAndSortPosts([launch, draft], filters)).toEqual([launch]);
  });

  it("a search of the post ID", () => {
    expect(filterAndSortPosts(rows, { ...everything, searchQuery: "queued-c" })).toEqual([queued]);
  });

  const now = new Date(2026, 0, 15, 12).getTime();
  const at = (offsetMs: number) => postRow({ date: new Date(now + offsetMs).toISOString() });
  const day = 24 * 60 * 60 * 1000;

  it.each([
    ["today: earlier the same day", "today", -60_000, true],
    ["today: the next day", "today", day, false],
    ["next 7 days: exactly now", "next7", 0, true],
    ["next 7 days: exactly seven days out", "next7", 7 * day, true],
    ["next 7 days: just past seven days", "next7", 7 * day + 1, false],
    ["next 7 days: just before now", "next7", -1, false],
    ["past 30 days: exactly thirty days back", "past30", -30 * day, true],
    ["past 30 days: just over thirty days back", "past30", -30 * day - 1, false],
    ["past 30 days: just after now", "past30", 1, false],
  ] as const)("%s", (_example, dateFilter, offset, included) => {
    const row = at(offset);

    expect(filterAndSortPosts([row], { ...everything, dateFilter }, now)).toEqual(
      included ? [row] : [],
    );
  });
});

describe("normalizePostStatus", () => {
  it.each([
    ["the row's own status", postRow({ status: "published" }), "published"],
    [
      "the first Channel when the row has none",
      postRow({ status: "", channels: [channel({ status: "queued" })] }),
      "queued",
    ],
    ["an unrecognized status", postRow({ status: "publishing" }), "unknown"],
    ["no status anywhere", postRow({ status: "", channels: [] }), "unknown"],
  ])("%s", (_example, row, status) => {
    expect(normalizePostStatus(row)).toEqual(status);
  });
});

describe("resolvePostDisplayDate", () => {
  const dated = (...times: [string | null, string | null][]): Post => ({
    ...basePost,
    created_at: "2026-01-01T00:00:00Z",
    status: "active",
    distributions: times.map(([scheduled_at, published_at]) =>
      distribution("scheduled", { scheduled_at, published_at }),
    ),
  });

  it.each([
    [
      "the earliest schedule",
      dated(["2026-03-02T00:00:00Z", null], ["2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"]),
      "2026-03-01T00:00:00Z",
    ],
    [
      "the latest publication when nothing is scheduled",
      dated([null, "2026-02-01T00:00:00Z"], [null, "2026-02-02T00:00:00Z"]),
      "2026-02-02T00:00:00Z",
    ],
    ["no distributions", dated(), "2026-01-01T00:00:00Z"],
    [
      "a draft with a schedule",
      { ...dated(["2026-03-01T00:00:00Z", null]), status: "draft" as const },
      "2026-01-01T00:00:00Z",
    ],
  ])("%s", (_example, post, date) => {
    expect(resolvePostDisplayDate(post)).toEqual(date);
  });
});

describe("formatPostDate", () => {
  it("a German date in a zone ahead of UTC", () => {
    expect(formatPostDate("2026-10-23T12:00:00Z", "Asia/Tokyo", "de")).toEqual(
      "23. Okt. 2026, 09:00 PM",
    );
  });

  it.each([
    ["no value", null],
    ["an empty value", ""],
    ["text that is not a date", "not-a-date"],
  ])("%s", (_example, value) => {
    expect(formatPostDate(value, "UTC", "en")).toEqual(null);
  });
});

describe("resolveChannelMedia", () => {
  it("a claimed Channel whose frozen media includes a detached Asset", () => {
    const frozen = {
      ...publication,
      media: [
        { ...frozenMedia, asset_id: detachedAssetId, position: 0 },
        { ...frozenMedia, asset_id: attachment.asset_id, position: 1 },
      ],
    };
    const facts = {
      assetType: frozenMedia.asset_type,
      contentType: frozenMedia.content_type,
      durationSec: frozenMedia.duration_sec,
      fileSize: frozenMedia.file_size,
      height: frozenMedia.height,
      width: frozenMedia.width,
    };

    expect(
      resolveChannelMedia(basePost, undefined, distribution("published", { publication: frozen })),
    ).toEqual([
      { ...facts, assetId: detachedAssetId, attachment: undefined, position: 0 },
      { ...facts, assetId: attachment.asset_id, attachment, position: 1 },
    ]);
  });

  it("an unclaimed Channel without a selection", () => {
    const unclaimed = distribution("scheduled", { publication: null });

    expect(resolveChannelMedia(twoAttachments, undefined, unclaimed)).toEqual([
      media(attachment, attachment.position),
      media(second, 1),
    ]);
  });

  it("a selection in another order with a missing Asset", () => {
    const target = { attachment_ids: [secondAssetId, detachedAssetId, attachment.asset_id] };

    expect(resolveChannelMedia(twoAttachments, target, undefined)).toEqual([
      media(second, 0),
      media(attachment, 2),
    ]);
  });

  it("an empty selection", () => {
    expect(resolveChannelMedia(twoAttachments, { attachment_ids: [] }, undefined)).toEqual([]);
  });
});

describe("resolveChannelText", () => {
  const post = { ...basePost, default_text: "Post caption" };

  it.each([
    ["a frozen title", {}, { ...publication, title: "Frozen", text: "Body" }, "Frozen"],
    ["a frozen body without a title", {}, { ...publication, title: "", text: "Body" }, "Body"],
    [
      "a frozen publication without any text",
      { description_override: "New copy" },
      { ...publication, title: "", text: "" },
      "",
    ],
    [
      "a title override",
      { title_override: "Title copy", description_override: "Description copy" },
      null,
      "Title copy",
    ],
    [
      "a description override",
      { description_override: "Description copy" },
      null,
      "Description copy",
    ],
    ["no override", {}, null, "Post caption"],
  ])("%s", (_example, overrides, frozen, text) => {
    expect(resolveChannelText(post, overrides, frozen)).toEqual(text);
  });
});

describe("resolveRowCaption", () => {
  const claimed = (title: string, text: string) =>
    channel({
      caption: "Stale copy",
      distribution: distribution("published", { publication: { ...publication, title, text } }),
    });
  const post = { ...basePost, default_text: "Post caption", title: "Post title" };
  const event = channel({
    calendarEvent: {
      brand_profile_id: "profile-a",
      id: "event",
      platform: "instagram",
      platform_account_id: null,
      post_id: "post",
      post_title: "Event title",
      published_at: null,
      scheduled_at: null,
      status: "scheduled",
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  it.each([
    ["a frozen title", postRow({ post, channels: [claimed("Frozen", "Body")] }), "Frozen"],
    ["a frozen publication without text", postRow({ post, channels: [claimed("", "")] }), ""],
    [
      "a pending Channel caption",
      postRow({ post, channels: [channel({ caption: "Pending" })] }),
      "Pending",
    ],
    ["only the Post caption", postRow({ post, channels: [channel()] }), "Post caption"],
    [
      "only the Post title",
      postRow({ post: { ...post, default_text: "" }, channels: [] }),
      "Post title",
    ],
    ["a calendar event title", postRow({ post: undefined, channels: [event] }), "Event title"],
    ["nothing to show", postRow({ post: undefined, channels: [] }), ""],
  ])("%s", (_example, row, caption) => {
    expect(resolveRowCaption(row)).toEqual(caption);
  });
});

describe("resolveRowPreviewAttachment", () => {
  const withPreview = channel({ attachments: [media(second, 1)] });

  it.each([
    ["the first Channel attachment", postRow({ channels: [channel(), withPreview] }), second],
    ["the Post attachment", postRow({ channels: [channel()] }), attachment],
    [
      "a claimed Channel without a live attachment",
      postRow({ channels: [outcome("published"), withPreview] }),
      null,
    ],
    ["no attachments at all", postRow({ post: undefined, channels: [] }), null],
  ])("%s", (_example, row, preview) => {
    expect(resolveRowPreviewAttachment(row)).toEqual(preview);
  });
});

describe("resolveRowProviders", () => {
  it("a connected Channel, a disconnected one and a repeat", () => {
    const connected = channel({
      integration: {
        id: "account",
        name: "Alpha",
        providerIdentifier: "youtube",
      } as NonNullable<PostDetailItem["integration"]>,
    });
    const orphaned = channel({
      distribution: distribution("published", { platform: "instagram" }),
    });

    expect(resolveRowProviders(postRow({ channels: [connected, orphaned, connected] }))).toEqual([
      "youtube",
      "instagram",
    ]);
  });

  it("no Channels", () => {
    expect(resolveRowProviders(postRow())).toEqual([]);
  });
});

describe("resolveCancellableDistributionIds", () => {
  it("a queued, a published and an unclaimed Channel", () => {
    const row = postRow({
      channels: [
        channel({ distribution: distribution("queued", { id: "queued" }) }),
        channel({ distribution: distribution("published", { id: "published" }) }),
        channel({ status: "scheduled" }),
      ],
    });

    expect(resolveCancellableDistributionIds(row)).toEqual(["queued"]);
  });
});

describe("toLocalDateKey", () => {
  it.each([
    ["a local date", new Date(2026, 0, 5, 12), "2026-01-05"],
    ["text that is not a date", "not-a-date", ""],
  ])("%s", (_example, value, key) => {
    expect(toLocalDateKey(value)).toEqual(key);
  });
});

describe("prunePostSelection", () => {
  const entry = (id: string, brandProfileId = "profile-1", isDraft = false) => ({
    id,
    brandProfileId,
    isDraft,
  });
  const selected = (...entries: PostSelectionEntry[]) =>
    new Map(entries.map((item) => [item.id, item]));
  const settled = { dataSettled: true, draftFilter: false };

  it("a selected post that is gone", () => {
    const selection = selected(entry("post-1"), entry("post-2"));
    const known = [{ id: "post-1", brandProfileId: "profile-1" }];

    expect(prunePostSelection(selection, known, settled)).toEqual(selected(entry("post-1")));
  });

  it("data still loading", () => {
    const selection = selected(entry("post-1"));

    expect(prunePostSelection(selection, [], { ...settled, dataSettled: false })).toBe(selection);
  });

  it("an empty selection", () => {
    const selection = selected();

    expect(prunePostSelection(selection, [], settled)).toBe(selection);
  });

  it("a draft-only query that cannot see scheduled posts", () => {
    const selection = selected(entry("scheduled-1"), entry("draft-1", "profile-1", true));

    expect(prunePostSelection(selection, [], { ...settled, draftFilter: true })).toEqual(
      selected(entry("scheduled-1")),
    );
  });

  it("a post that moved to another profile", () => {
    const selection = selected(entry("post-1", "profile-old"));
    const known = [{ id: "post-1", brandProfileId: "profile-new" }];

    expect(prunePostSelection(selection, known, settled)).toEqual(
      selected(entry("post-1", "profile-new")),
    );
  });

  it("nothing changed", () => {
    const selection = selected(entry("post-1"));
    const known = [{ id: "post-1", brandProfileId: "profile-1" }];

    expect(prunePostSelection(selection, known, settled)).toBe(selection);
  });

  it("a known item without a profile", () => {
    const selection = selected(entry("post-1"));
    const known = [{ id: "post-1", brandProfileId: null }];

    expect(prunePostSelection(selection, known, settled)).toEqual(selected());
  });
});

describe("resolvePostAnalytics", () => {
  const measured = {
    likes: 12,
    comments: 0,
    shares: 3,
    saves: null,
    clicks: null,
    views: 900,
    impressions: null,
    reach: null,
  };
  const metrics = [
    { id: "likes", value: 12 },
    { id: "comments", value: 0 },
    { id: "shares", value: 3 },
    { id: "views", value: 900 },
  ];
  const untracked = ["saves", "clicks", "impressions", "reach"];
  const published = channel({ status: "published" });
  const analysed = { ...basePost, analytics: measured, distribution_analytics: [] };

  it("a published Post with measurements", () => {
    const row = postRow({ channels: [published], post: analysed });

    expect(resolvePostAnalytics(row)).toEqual({
      awaiting: false,
      channels: [],
      metrics,
      untracked,
      visible: true,
    });
  });

  it("per-Channel snapshots for a named and an unnamed Channel", () => {
    const named = channel({
      distribution: distribution("published", { id: "dist-youtube" }),
      integration: { name: "Alpha Shorts" } as NonNullable<PostDetailItem["integration"]>,
    });
    const post: Post = {
      ...analysed,
      distribution_analytics: [
        { distribution_id: "dist-youtube", platform: "youtube", analytics: measured },
        { distribution_id: "dist-tiktok", platform: "tiktok", analytics: measured },
      ],
    };

    expect(resolvePostAnalytics(postRow({ channels: [named], post })).channels).toEqual([
      { id: "dist-youtube", platform: "youtube", label: "Alpha Shorts", analytics: measured },
      { id: "dist-tiktok", platform: "tiktok", label: "TikTok", analytics: measured },
    ]);
  });

  it("a published Post awaiting its first sync", () => {
    const row = postRow({
      channels: [published],
      post: { ...analysed, analytics: null },
    });

    expect(resolvePostAnalytics(row)).toEqual({
      awaiting: true,
      channels: [],
      metrics: [],
      untracked: [
        "likes",
        "comments",
        "shares",
        "saves",
        "clicks",
        "views",
        "impressions",
        "reach",
      ],
      visible: true,
    });
  });

  it.each([
    [
      "a scheduled Post with a stale aggregate",
      postRow({ channels: [outcome("scheduled")], post: analysed }),
    ],
    [
      "a calendar row whose Post is not loaded",
      postRow({ channels: [published], post: undefined }),
    ],
  ])("%s", (_example, row) => {
    expect(resolvePostAnalytics(row).visible).toEqual(false);
  });
});
