import { describe, expect, it } from "vite-plus/test";

import { calendarSlots } from "./calendar-slots";

function day(year: number, month: number, date: number) {
  return { date: new Date(year, month - 1, date, 12), dayNumber: date, isCurrentMonth: true };
}

const newYork = { timezone: "America/New_York", slots: [{ weekday: 0, time: "01:30" }] };

describe("calendarSlots", () => {
  it("a slot in the spring-forward gap", () => {
    const queue = { timezone: "America/New_York", slots: [{ weekday: 0, time: "02:30" }] };

    expect(calendarSlots(queue, [day(2026, 3, 8)], [])).toEqual(new Map([["2026-03-08", []]]));
  });

  it.each([
    ["a post at the later repeated hour", "2026-11-01T06:30:00Z", "post"],
    ["a post at the earlier repeated hour", "2026-11-01T05:30:00Z", undefined],
  ])("%s", (_example, date, postId) => {
    const posts = [{ id: "post", date }];

    expect(calendarSlots(newYork, [day(2026, 11, 1)], posts)).toEqual(
      new Map([["2026-11-01", [{ instant: "2026-11-01T06:30:00.000Z", time: "01:30", postId }]]]),
    );
  });

  it("a zone with a fractional offset", () => {
    const queue = { timezone: "Asia/Kathmandu", slots: [{ weekday: 5, time: "00:15" }] };
    const posts = [{ id: "off-plan", date: "2026-10-22T18:45:00Z" }];

    expect(calendarSlots(queue, [day(2026, 10, 23)], posts)).toEqual(
      new Map([
        ["2026-10-23", [{ instant: "2026-10-22T18:30:00.000Z", time: "00:15", postId: undefined }]],
      ]),
    );
  });

  it("two slots listed late first", () => {
    const queue = {
      timezone: "UTC",
      slots: [
        { weekday: 5, time: "18:00" },
        { weekday: 5, time: "09:00" },
      ],
    };

    expect(calendarSlots(queue, [day(2026, 10, 23)], [])).toEqual(
      new Map([
        [
          "2026-10-23",
          [
            { instant: "2026-10-23T09:00:00.000Z", time: "09:00", postId: undefined },
            { instant: "2026-10-23T18:00:00.000Z", time: "18:00", postId: undefined },
          ],
        ],
      ]),
    );
  });

  it("a weekday without slots", () => {
    expect(calendarSlots(newYork, [day(2026, 10, 23)], [])).toEqual(new Map([["2026-10-23", []]]));
  });

  it("no days", () => {
    expect(calendarSlots(newYork, [], [])).toEqual(new Map());
  });
});
