import { CalendarDays, LayoutGrid, Table2 } from "lucide-react";
import type { Post } from "@/types";

export const POST_COLLECTION_MODES = ["table", "calendar", "grid"] as const;
export type PostCollectionMode = (typeof POST_COLLECTION_MODES)[number];
export const POST_VIEW_OPTIONS = {
  table: { label: "Table", icon: Table2 },
  calendar: { label: "Calendar", icon: CalendarDays },
  grid: { label: "Grid", icon: LayoutGrid },
} as const;

export function postViewLabel(mode: PostCollectionMode, t: (message: string) => string): string {
  if (mode === "table") return t("Table");
  if (mode === "calendar") return t("Calendar");
  return t("Grid");
}

export interface PostAnalyticsColumn {
  id: keyof NonNullable<Post["analytics"]>;
  label: string;
  name: string;
}

const analyticsLabelMapCache = new WeakMap<
  (message: string) => string,
  ReadonlyMap<PostAnalyticsColumn["id"], string>
>();

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

export function postAnalyticsLabelMap(
  t: (message: string) => string,
): ReadonlyMap<PostAnalyticsColumn["id"], string> {
  let cached = analyticsLabelMapCache.get(t);
  if (!cached) {
    cached = new Map(postAnalyticsColumns(t).map((column) => [column.id, column.name]));
    analyticsLabelMapCache.set(t, cached);
  }
  return cached;
}
