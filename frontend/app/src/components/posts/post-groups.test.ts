import { describe, expect, it } from "vite-plus/test";
import type { PostRow } from "./types";
import { groupPostRows } from "./post-groups";

const rows: PostRow[] = [
  {
    id: "published-early",
    date: "2026-02-01T10:00:00Z",
    status: "published",
    channels: [],
    brandProfileId: "profile-a",
  },
  {
    id: "draft-a",
    date: "2026-02-01T09:00:00Z",
    status: "draft",
    channels: [],
    brandProfileId: "profile-a",
  },
  {
    id: "unknown",
    date: "2026-02-01T11:00:00Z",
    status: "awaiting_provider",
    channels: [],
    brandProfileId: "missing-profile",
  },
  {
    id: "published-late",
    date: "2026-02-01T12:00:00Z",
    status: "published",
    channels: [],
    brandProfileId: "profile-a",
  },
  {
    id: "draft-b",
    date: "2026-02-01T13:00:00Z",
    status: "draft",
    channels: [],
    brandProfileId: "profile-b",
  },
];

describe("groupPostRows", () => {
  it("keeps unknown publication outcomes and sorted row order within ordered status groups", () => {
    const groups = groupPostRows(rows, "status", []);
    expect(groups.map(({ id }) => id)).toEqual(["draft", "published", "awaiting_provider"]);
    expect(groups.map(({ posts }) => posts.map(({ id }) => id))).toEqual([
      ["draft-a", "draft-b"],
      ["published-early", "published-late"],
      ["unknown"],
    ]);
    expect(groups.flatMap(({ posts }) => posts)).toHaveLength(rows.length);
  });

  it("retains every row in input order when grouping is disabled", () => {
    const groups = groupPostRows(rows, "none", []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.posts.map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
  });
});
