import { CalendarDays, LayoutGrid, Table2 } from "lucide-react";
import type { Post } from "@/types";

/** Supported Posts collection views; Composer is a workflow, not a collection view. */
export const POST_COLLECTION_MODES = ["table", "calendar", "grid"] as const;
export type PostCollectionMode = (typeof POST_COLLECTION_MODES)[number];
export const POST_VIEW_OPTIONS = {
  table: { label: "Table", icon: Table2 },
  calendar: { label: "Calendar", icon: CalendarDays },
  grid: { label: "Grid", icon: LayoutGrid },
} as const;

/** One measured counter's contract key, short header, and full accessible/menu name. */
export interface PostAnalyticsColumn {
  id: keyof NonNullable<Post["analytics"]>;
  label: string;
  name: string;
}

/**
 * Returns the fixed analytics order with localized short headers and full menu/
 * accessible names. Literal translation calls keep every metric catalog-checked;
 * callers may memoize the descriptors by translator.
 */
export function postAnalyticsColumns(
  t: (message: string) => string,
): readonly PostAnalyticsColumn[] {
  return [
    { id: "likes", label: t("Likes"), name: t("Likes") },
    { id: "comments", label: t("Cmts"), name: t("Comments") },
    { id: "shares", label: t("Shrs"), name: t("Shares") },
    { id: "saves", label: t("Saves"), name: t("Saves") },
    { id: "clicks", label: t("Clicks"), name: t("Clicks") },
    { id: "views", label: t("Views"), name: t("Views") },
    { id: "impressions", label: t("Impr."), name: t("Impressions") },
    { id: "reach", label: t("Reach"), name: t("Reach") },
  ];
}
