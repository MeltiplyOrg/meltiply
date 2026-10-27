import type { BrandProfile, PostRow } from "./types";
import { comparePublicationStatusGroup } from "@/lib/publication-status";
import { normalizePostStatus } from "./posts-helpers";

export type PostGroupBy = "status" | "profile" | "none";

export interface PostGroup {
  id: string;
  /** Raw status for localized status groups; profile name otherwise. */
  label: string;
  status?: string;
  posts: PostRow[];
}

/**
 * Groups the already filtered/sorted page without rewriting Post identity or
 * publication state. Unknown outcome statuses coalesce into one neutral
 * `unknown` group after every recognized lifecycle state. Row order inside each
 * group stays exactly as supplied by sorting.
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
    const status = normalizePostStatus(post);
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
  if (groupBy === "status") result.sort((a, b) => comparePublicationStatusGroup(a.id, b.id));
  return result;
}
