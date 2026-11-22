import {
  CalendarDate,
  fromDate,
  startOfMonth,
  startOfWeek,
  getWeeksInMonth,
} from "@internationalized/date";
import { toLocalDateKey } from "./posts-helpers";
import type { CalendarDayCell, PostRow } from "./types";

export type CalendarPeriod = "month" | "week";

export function calendarDateKey(instant: Date | string, timeZone: string): string {
  const date = fromDate(typeof instant === "string" ? new Date(instant) : instant, timeZone);
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function postsOnCalendarDay(
  rows: readonly PostRow[],
  day: Date,
  timeZone: string,
): PostRow[] {
  const dayKey = toLocalDateKey(day);
  return rows.filter((row) => calendarDateKey(row.date, timeZone) === dayKey);
}

export function calendarLabelDate(day: CalendarDate): Date {
  return new Date(day.year, day.month - 1, day.day, 12);
}

export function calendarWindow(anchor: CalendarDate, period: CalendarPeriod, timeZone: string) {
  const start = startOfWeek(period === "month" ? startOfMonth(anchor) : anchor, "en-GB");
  const count = period === "month" ? Math.max(5, getWeeksInMonth(anchor, "en-GB")) * 7 : 7;
  const days: CalendarDayCell[] = Array.from({ length: count }, (_, index) => {
    const day = start.add({ days: index });
    return {
      date: calendarLabelDate(day),
      dayNumber: day.day,
      isCurrentMonth: day.month === anchor.month,
    };
  });
  return {
    days,
    start: start.toDate(timeZone).toISOString(),
    end: start.add({ days: count }).toDate(timeZone).toISOString(),
  };
}
