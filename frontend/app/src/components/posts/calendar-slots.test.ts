import { describe, expect, it } from "vite-plus/test";
import { calendarSlots } from "./calendar-slots";

/** Supplies a civil date label, not an instant in the Queue's timezone. */
function day(year: number, month: number, date: number) {
  return { date: new Date(year, month - 1, date, 12), dayNumber: date, isCurrentMonth: true };
}

describe("Queue calendar slots", () => {
  it("skips nonexistent DST slots instead of displaying false availability", () => {
    const slots = calendarSlots(
      { timezone: "America/New_York", slots: [{ weekday: 0, time: "02:30" }] },
      [day(2026, 3, 8)],
      [],
    );
    expect(slots.get("2026-03-08")).toEqual([]);
  });
  it("uses the later repeated hour and matches occupancy by actual instant", () => {
    const slots = calendarSlots(
      { timezone: "America/New_York", slots: [{ weekday: 0, time: "01:30" }] },
      [day(2026, 11, 1)],
      [{ id: "post", date: "2026-11-01T06:30:00Z" }],
    );
    expect(slots.get("2026-11-01")).toEqual([
      { instant: "2026-11-01T06:30:00.000Z", time: "01:30", postId: "post" },
    ]);
  });
  it("does not mark the other repeated-hour instant as occupying the slot", () => {
    const slots = calendarSlots(
      { timezone: "America/New_York", slots: [{ weekday: 0, time: "01:30" }] },
      [day(2026, 11, 1)],
      [{ id: "earlier", date: "2026-11-01T05:30:00Z" }],
    );
    expect(slots.get("2026-11-01")?.[0]?.postId).toBeUndefined();
  });
  it("keeps fractional-offset slots on their civil date and leaves other reservations unchanged", () => {
    const slots = calendarSlots(
      { timezone: "Asia/Kathmandu", slots: [{ weekday: 5, time: "00:15" }] },
      [day(2026, 10, 23)],
      [{ id: "off-plan", date: "2026-10-22T18:45:00Z" }],
    );
    expect(slots.get("2026-10-23")).toEqual([
      { instant: "2026-10-22T18:30:00.000Z", time: "00:15", postId: undefined },
    ]);
  });
});
