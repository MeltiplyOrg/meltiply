import { CalendarDays, LayoutGrid, Table2 } from "lucide-react";

/** Supported Posts collection views; Composer is a workflow, not a collection view. */
export const POST_COLLECTION_MODES = ["table", "calendar", "grid"] as const;
export type PostCollectionMode = (typeof POST_COLLECTION_MODES)[number];
export const POST_VIEW_OPTIONS = {
  table: { label: "Table", icon: Table2 },
  calendar: { label: "Calendar", icon: CalendarDays },
  grid: { label: "Grid", icon: LayoutGrid },
} as const;
