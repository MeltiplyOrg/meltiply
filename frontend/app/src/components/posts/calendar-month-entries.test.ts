import { describe, expect, it } from "vite-plus/test";

import { monthDayEntries } from "./calendar-month-entries";
import type { PostRow } from "./types";

const row = (id: string, hour: string): PostRow => ({
  id,
  date: `2026-10-23T${hour}:00:00Z`,
  status: "scheduled",
  channels: [],
  brandProfileId: "profile",
});
const slot = (hour: string, postId?: string) => ({
  instant: `2026-10-23T${hour}:00:00Z`,
  time: `${hour}:00`,
  postId,
});

describe("monthDayEntries", () => {
  it("slots and off-plan posts out of order", () => {
    const booked = row("booked", "18");
    const early = row("off-plan-early", "08");
    const late = row("off-plan-late", "11");
    const open = slot("10");

    expect(
      monthDayEntries(
        [slot("18", "booked"), open],
        [booked, late, early],
        new Map([["booked", booked]]),
      ),
    ).toEqual([
      { instant: "2026-10-23T08:00:00Z", row: early },
      { instant: "2026-10-23T10:00:00Z", slot: open },
      { instant: "2026-10-23T11:00:00Z", row: late },
      { instant: "2026-10-23T18:00:00Z", row: booked },
    ]);
  });

  it("a slot booked by a post that is not loaded", () => {
    expect(monthDayEntries([slot("10", "gone")], [], new Map())).toEqual([]);
  });

  it("a day without slots", () => {
    const only = row("only", "09");

    expect(monthDayEntries([], [only], new Map())).toEqual([
      { instant: "2026-10-23T09:00:00Z", row: only },
    ]);
  });

  it("an empty day", () => {
    expect(monthDayEntries([], [], new Map())).toEqual([]);
  });
});
