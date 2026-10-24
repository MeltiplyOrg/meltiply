import { CalendarDateTime, parseTime, toZoned } from "@internationalized/date";
import type { PublishingQueue } from "@/types";
import type { CalendarDayCell } from "./types";
import { toLocalDateKey } from "./posts-helpers";

export interface CalendarSlot {
  instant: string;
  time: string;
  postId: string | undefined;
}

/** Projects validated weekly Queue configuration onto the bounded visible civil days. Like the PostgreSQL allocator, skips DST gaps and takes the later overlap instant. Exact-instant membership fills a slot; off-plan immutable reservations remain separate Posts. This is a display projection, never an allocation guarantee or a mutation. At most 42 days × 168 configured slots are examined. */
export function calendarSlots(
  queue: Pick<PublishingQueue, "timezone" | "slots">,
  days: CalendarDayCell[],
  posts: readonly { id: string; date: string }[],
): Map<string, CalendarSlot[]> {
  const occupied = new Map(posts.map((post) => [new Date(post.date).getTime(), post.id]));
  const byWeekday = new Map<number, { time: string; hour: number; minute: number }[]>();
  for (const slot of queue.slots) {
    const time = parseTime(slot.time);
    const group = byWeekday.get(slot.weekday) ?? [];
    group.push({ time: slot.time, hour: time.hour, minute: time.minute });
    byWeekday.set(slot.weekday, group);
  }
  const result = new Map<string, CalendarSlot[]>();
  for (const { date } of days) {
    const slots: CalendarSlot[] = [];
    for (const slot of byWeekday.get(date.getDay()) ?? []) {
      const civil = new CalendarDateTime(
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
        slot.hour,
        slot.minute,
      );
      const zoned = toZoned(civil, queue.timezone, "later");
      if (
        zoned.year !== civil.year ||
        zoned.month !== civil.month ||
        zoned.day !== civil.day ||
        zoned.hour !== civil.hour ||
        zoned.minute !== civil.minute
      )
        continue;
      const instant = zoned.toDate();
      slots.push({
        instant: instant.toISOString(),
        time: slot.time,
        postId: occupied.get(instant.getTime()),
      });
    }
    slots.sort((a, b) => a.instant.localeCompare(b.instant));
    result.set(toLocalDateKey(date), slots);
  }
  return result;
}
