import { CalendarDays, LayoutGrid, List, SquareKanban, Table2 } from "lucide-react";

/** Canonical collection shortcuts shared by the toolbar and sidebar; Composer is a workflow, not a collection view. */
export const POST_COLLECTION_MODES = ["list", "board", "table", "grid", "calendar"] as const;
export type PostCollectionMode = (typeof POST_COLLECTION_MODES)[number];
export const POST_VIEW_OPTIONS = {
  list: { label: "List", icon: List },
  board: { label: "Board", icon: SquareKanban },
  table: { label: "Table", icon: Table2 },
  grid: { label: "Grid", icon: LayoutGrid },
  calendar: { label: "Calendar", icon: CalendarDays },
} as const;
