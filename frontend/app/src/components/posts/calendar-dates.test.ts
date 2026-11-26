import { CalendarDate } from "@internationalized/date";
import { describe, expect, it } from "vite-plus/test";

import {
  calendarDateKey,
  calendarLabelDate,
  calendarWindow,
  postsOnCalendarDay,
} from "./calendar-dates";
import type { PostRow } from "./types";

const row = (id: string, date: string): PostRow => ({
  id,
  date,
  status: "scheduled",
  channels: [],
  brandProfileId: "profile",
});
const label = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12);

describe("calendarDateKey", () => {
  it.each([
    ["a zone ahead of UTC", "2026-01-01T11:00:00Z", "Pacific/Kiritimati", "2026-01-02"],
    ["a zone behind UTC", "2026-01-01T04:00:00Z", "America/New_York", "2025-12-31"],
  ])("%s", (_example, instant, timeZone, key) => {
    expect(calendarDateKey(instant, timeZone)).toEqual(key);
  });

  it("a Date instead of text", () => {
    expect(calendarDateKey(new Date("2026-07-04T12:00:00Z"), "UTC")).toEqual("2026-07-04");
  });
});

describe("postsOnCalendarDay", () => {
  it("one post on the day in the publishing zone and one before it", () => {
    const rows = [row("next-day", "2026-01-01T11:00:00Z"), row("same-day", "2026-01-01T09:00:00Z")];

    expect(postsOnCalendarDay(rows, label(2026, 1, 2), "Pacific/Kiritimati")).toEqual([
      row("next-day", "2026-01-01T11:00:00Z"),
    ]);
  });

  it("no posts", () => {
    expect(postsOnCalendarDay([], label(2026, 1, 2), "UTC")).toEqual([]);
  });
});

describe("calendarLabelDate", () => {
  it("a civil day", () => {
    expect(calendarLabelDate(new CalendarDate(2026, 3, 8))).toEqual(label(2026, 3, 8));
  });
});

describe("calendarWindow", () => {
  it("a week", () => {
    const anchor = new CalendarDate(2026, 1, 1);
    const day = (month: number, date: number, year = 2026) => ({
      date: label(year, month, date),
      dayNumber: date,
      isCurrentMonth: month === 1,
    });

    expect(calendarWindow(anchor, "week", "Asia/Tokyo")).toEqual({
      days: [
        day(12, 29, 2025),
        day(12, 30, 2025),
        day(12, 31, 2025),
        day(1, 1),
        day(1, 2),
        day(1, 3),
        day(1, 4),
      ],
      start: "2025-12-28T15:00:00.000Z",
      end: "2026-01-04T15:00:00.000Z",
    });
  });

  it.each([
    ["a month of five weeks", 2026, 1, 35, "2025-12-29T00:00:00.000Z", "2026-02-02T00:00:00.000Z"],
    ["a month of six weeks", 2026, 8, 42, "2026-07-27T00:00:00.000Z", "2026-09-07T00:00:00.000Z"],
    ["a month of four weeks", 2027, 2, 35, "2027-02-01T00:00:00.000Z", "2027-03-08T00:00:00.000Z"],
  ])("%s", (_example, year, month, length, start, end) => {
    const window = calendarWindow(new CalendarDate(year, month, 15), "month", "UTC");

    expect({ length: window.days.length, start: window.start, end: window.end }).toEqual({
      length,
      start,
      end,
    });
  });
});
