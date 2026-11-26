import type { BrandProfile, PostRow } from "./types";
import { comparePublicationStatusGroup } from "@/lib/publication-status";
import { normalizePostStatus } from "./posts-helpers";

export type PostGroupBy = "status" | "profile" | "none";

export interface PostGroup {
  id: string;
  label: string;
  status?: string;
  posts: PostRow[];
}

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
