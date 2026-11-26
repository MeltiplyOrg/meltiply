import { codePointLength } from "@meltiply/domain";

import type { Post } from "@/types";

export function publishModeAction(
  mode: "draft" | "queue" | "schedule" | "now",
  postId: string | null,
  t: (message: string) => string,
): string {
  if (mode === "draft") return postId === null ? t("Save Draft") : t("Save");
  if (mode === "schedule") return t("Schedule Post");
  if (mode === "queue") return t("Add to Queue");
  return t("Publish Now");
}

export function clampCaption(text: string, limit: number | null): string {
  if (limit === null || codePointLength(text) <= limit) return text;
  return [...text].slice(0, limit).join("");
}

export function attachmentOverridesFromPost(post: Post): Record<string, string[]> {
  const overrides: Record<string, string[]> = {};
  for (const target of post.targets) {
    if (target.attachment_ids !== null)
      overrides[target.platform_account_id] = [...target.attachment_ids];
  }
  return overrides;
}
