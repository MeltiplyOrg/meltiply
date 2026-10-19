import type { BrandProfile, PostRow } from "./types";
import { normalizePostStatus } from "./posts-helpers";

export type PostGroupBy = "status" | "profile" | "none";

export interface PostGroup {
  id: string;
  /** Raw status for localized status groups; profile name otherwise. */
  label: string;
  status?: string;
  posts: PostRow[];
}

const STATUS_ORDER: Record<string, number> = {
  draft: 0,
  scheduled: 1,
  queued: 2,
  publishing: 3,
  awaiting_provider: 4,
  published: 5,
  failed: 6,
  needs_reconciliation: 7,
  cancel_requested: 8,
  cancelled: 9,
};

/**
 * Groups the already filtered/sorted page without rewriting Post identity or
 * publication state. Unknown outcome statuses remain visible in their own
 * groups. Row order inside each group stays exactly as supplied by sorting.
 */
export function groupPostRows(
  posts: PostRow[],
  groupBy: PostGroupBy,
  profiles: BrandProfile[],
): PostGroup[] {
  if (groupBy === "none") return [{ id: "all", label: "All posts", posts }];
  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const groups = new Map<string, PostGroup>();
  for (const post of posts) {
    const status = normalizePostStatus(post) || "scheduled";
    const id = groupBy === "status" ? status : post.brandProfileId;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        label: groupBy === "status" ? status : (names.get(id) ?? "Unknown profile"),
        ...(groupBy === "status" ? { status } : {}),
        posts: [],
      };
      groups.set(id, group);
    }
    group.posts.push(post);
  }
  const result = Array.from(groups.values());
  if (groupBy === "status")
    result.sort((a, b) => (STATUS_ORDER[a.id] ?? 10) - (STATUS_ORDER[b.id] ?? 10));
  return result;
}
