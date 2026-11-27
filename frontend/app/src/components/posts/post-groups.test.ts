import { describe, expect, it } from "vite-plus/test";

import { groupPostRows } from "./post-groups";
import type { BrandProfile, PostRow } from "./types";

function row(id: string, status: string, brandProfileId = "profile-a"): PostRow {
  return { id, date: "2026-02-01T10:00:00Z", status, channels: [], brandProfileId };
}

const profiles = [{ id: "profile-a", name: "Alpha" }] as BrandProfile[];

const group = (status: string, ...posts: PostRow[]) => ({
  id: status,
  label: status,
  status,
  posts,
});

describe("groupPostRows", () => {
  it("every status, in input order within each group", () => {
    const rows = [
      row("published-early", "published"),
      row("draft-a", "draft"),
      row("unknown", "future_provider_status"),
      row("processing", "processing"),
      row("published-late", "published"),
      row("draft-b", "draft", "profile-b"),
      row("needs-reconciliation", "needs_reconciliation"),
      row("queued", "queued"),
      row("failed", "failed"),
      row("awaiting-provider", "awaiting_provider"),
      row("scheduled", "scheduled"),
      row("cancel-requested", "cancel_requested"),
      row("cancelled", "cancelled"),
      row("superseded", "publishing"),
    ];

    expect(groupPostRows(rows, "status", [])).toEqual([
      group("draft", rows[1]!, rows[5]!),
      group("scheduled", rows[10]!),
      group("queued", rows[7]!),
      group("processing", rows[3]!),
      group("awaiting_provider", rows[9]!),
      group("published", rows[0]!, rows[4]!),
      group("failed", rows[8]!),
      group("needs_reconciliation", rows[6]!),
      group("cancel_requested", rows[11]!),
      group("cancelled", rows[12]!),
      group("unknown", rows[2]!, rows[13]!),
    ]);
  });

  it("profiles in first-seen order, one of them unlisted", () => {
    const rows = [row("b", "draft", "profile-b"), row("a", "draft")];

    expect(groupPostRows(rows, "profile", profiles)).toEqual([
      { id: "profile-b", label: "Unknown profile", posts: [rows[0]] },
      { id: "profile-a", label: "Alpha", posts: [rows[1]] },
    ]);
  });

  it("grouping turned off", () => {
    const rows = [row("published", "published"), row("draft", "draft")];

    expect(groupPostRows(rows, "none", [])).toEqual([
      { id: "all", label: "All posts", posts: rows },
    ]);
  });

  it("no posts grouped by status", () => {
    expect(groupPostRows([], "status", [])).toEqual([]);
  });
});
