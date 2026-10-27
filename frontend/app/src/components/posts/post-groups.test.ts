import { describe, expect, it } from "vite-plus/test";
import type { PostRow } from "./types";
import { groupPostRows } from "./post-groups";

/**
 * Builds one status-only row, so grouping is exercised over the canonical
 * publication status rather than any view-specific content.
 */
function row(id: string, status: string, brandProfileId = "profile-a"): PostRow {
  return {
    id,
    date: "2026-02-01T10:00:00Z",
    status,
    channels: [],
    brandProfileId,
  };
}

const rows: PostRow[] = [
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
  row("superseded-publishing", "publishing"),
];

describe("groupPostRows", () => {
  it("orders every canonical publication status and coalesces unknown outcomes", () => {
    const groups = groupPostRows(rows, "status", []);
    expect(groups.map(({ id }) => id)).toEqual([
      "draft",
      "scheduled",
      "queued",
      "processing",
      "awaiting_provider",
      "published",
      "failed",
      "needs_reconciliation",
      "cancel_requested",
      "cancelled",
      "unknown",
    ]);
    expect(groups.map(({ posts }) => posts.map(({ id }) => id))).toEqual([
      ["draft-a", "draft-b"],
      ["scheduled"],
      ["queued"],
      ["processing"],
      ["awaiting-provider"],
      ["published-early", "published-late"],
      ["failed"],
      ["needs-reconciliation"],
      ["cancel-requested"],
      ["cancelled"],
      ["unknown", "superseded-publishing"],
    ]);
    expect(groups.flatMap(({ posts }) => posts)).toHaveLength(rows.length);
  });

  it("labels the unknown group for the same neutral badge every surface uses", () => {
    const unknown = groupPostRows(rows, "status", []).find(({ id }) => id === "unknown");

    expect(unknown).toMatchObject({ label: "unknown", status: "unknown" });
  });

  it("retains every row in input order when grouping is disabled", () => {
    const groups = groupPostRows(rows, "none", []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.posts.map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
  });
});
