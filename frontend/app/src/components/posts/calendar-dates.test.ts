import { describe, expect, it } from "vite-plus/test";

import type { CalendarEvent } from "@/types";
import { postsOnCalendarDay } from "./calendar-dates";
import { toCalendarRows } from "./post-row";
import type { PostRow } from "./types";

const row = (id: string, date: string): PostRow => ({
  id,
  date,
  status: "scheduled",
  channels: [],
  brandProfileId: "profile",
});

describe("toCalendarRows", () => {
  it("keeps one row per Post per civil day in the publishing timezone", () => {
    const event = (id: string, scheduledAt: string): CalendarEvent => ({
      brand_profile_id: "profile",
      id,
      platform: "instagram",
      platform_account_id: null,
      post_id: "post",
      post_title: "Post",
      published_at: null,
      scheduled_at: scheduledAt,
      status: "scheduled",
      updated_at: scheduledAt,
    });
    const rows = toCalendarRows(
      [
        event("before-midnight", "2026-01-01T09:00:00Z"),
        event("after-midnight", "2026-01-01T11:00:00Z"),
      ],
      new Map(),
      new Map(),
      "Pacific/Kiritimati",
    );
    expect(rows.map((item) => item.date)).toEqual(["2026-01-01T09:00:00Z", "2026-01-01T11:00:00Z"]);
  });
});

describe("postsOnCalendarDay", () => {
  it("matches the civil day in the publishing timezone rather than the browser's", () => {
    const lateUtc = row("next-day-in-kiritimati", "2026-01-01T11:00:00Z");
    const early = row("same-day-in-kiritimati", "2026-01-01T09:00:00Z");
    expect(
      postsOnCalendarDay([lateUtc, early], new Date(2026, 0, 2), "Pacific/Kiritimati").map(
        (item) => item.id,
      ),
    ).toEqual(["next-day-in-kiritimati"]);
  });
});
