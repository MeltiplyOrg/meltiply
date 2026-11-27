import type { CalendarSlot } from "./calendar-slots";
import type { PostRow } from "./types";

export type MonthDayEntry = { instant: string } & (
  | { row: PostRow; slot?: undefined }
  | { slot: CalendarSlot; row?: undefined }
);

export function monthDayEntries(
  daySlots: readonly CalendarSlot[],
  dayPosts: readonly PostRow[],
  postById: ReadonlyMap<string, PostRow>,
): MonthDayEntry[] {
  return [
    ...daySlots.flatMap((slot): MonthDayEntry[] => {
      if (!slot.postId) return [{ instant: slot.instant, slot }];
      const row = postById.get(slot.postId);
      return row ? [{ instant: slot.instant, row }] : [];
    }),
    ...dayPosts
      .filter((row) => !daySlots.some((slot) => slot.postId === row.id))
      .map((row) => ({ instant: row.date, row })),
  ].sort((a, b) => Date.parse(a.instant) - Date.parse(b.instant));
}
