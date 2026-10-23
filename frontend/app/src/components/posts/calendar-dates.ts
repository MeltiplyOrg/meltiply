import {
  CalendarDate,
  fromDate,
  startOfMonth,
  startOfWeek,
  getWeeksInMonth,
} from "@internationalized/date";
import type { CalendarDayCell } from "./types";

export type CalendarPeriod = "month" | "week" | "day";

/** Buckets an actual instant by the display timezone, never by the browser's calendar date. */
export function calendarDateKey(instant: Date | string, timeZone: string): string {
  const date = fromDate(typeof instant === "string" ? new Date(instant) : instant, timeZone);
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** Converts a civil day to a browser-local noon solely for existing date-label/grid interfaces; never use it as a scheduling instant. */
export function calendarLabelDate(day: CalendarDate): Date {
  return new Date(day.year, day.month - 1, day.day, 12);
}

/** Builds Monday-first visible days and a half-open UTC query window from the Queue's civil timezone. Midnight conversion uses the existing date library, preserving 23/25-hour DST days rather than adding fixed milliseconds. Month includes adjacent dates and at least five rows. */
export function calendarWindow(anchor: CalendarDate, period: CalendarPeriod, timeZone: string) {
  const start =
    period === "month"
      ? startOfWeek(startOfMonth(anchor), "en-GB")
      : period === "week"
        ? startOfWeek(anchor, "en-GB")
        : anchor;
  const count =
    period === "month"
      ? Math.max(5, getWeeksInMonth(anchor, "en-GB")) * 7
      : period === "week"
        ? 7
        : 1;
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
