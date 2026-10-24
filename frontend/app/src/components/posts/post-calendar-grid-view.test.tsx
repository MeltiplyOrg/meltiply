// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { I18nProvider } from "@/lib/i18n";
import { PostCalendarGridView, type PostCalendarGridViewProps } from "./post-calendar-grid-view";

const date = new Date(2026, 9, 23);
const fullDate = new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(date);

/** Renders one civil day with mixed, deliberately unordered Queue entries using the real calendar surface. */
function renderDay(overrides: Partial<PostCalendarGridViewProps> = {}) {
  const props: PostCalendarGridViewProps = {
    posts: ["18:00", "08:00", "11:00"].map((time) => ({
      id: time,
      date: `2026-10-23T${time}:00Z`,
      status: "scheduled",
      channels: [],
      brandProfileId: "profile",
    })),
    isLoading: false,
    calendarMonth: date,
    calendarDays: [{ date, dayNumber: 23, isCurrentMonth: true }],
    onPrevMonth: () => {},
    onNextMonth: () => {},
    onToday: () => {},
    onWeekNavigate: () => {},
    onCellClick: () => {},
    onScheduleDate: () => {},
    onViewDetails: () => {},
    canSchedule: false,
    timeline: {
      mode: "month",
      onModeChange: () => {},
      timeZone: "UTC",
      now: new Date("2026-10-23T00:00:00Z"),
      slots: new Map([
        [
          "2026-10-23",
          [
            { instant: "2026-10-23T18:00:00Z", time: "18:00", postId: "18:00" },
            { instant: "2026-10-23T10:00:00Z", time: "10:00", postId: undefined },
          ],
        ],
      ]),
    },
    ...overrides,
  };
  return render(
    <I18nProvider>
      <PostCalendarGridView {...props} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("Queue Month entries", () => {
  it("shows the earliest three slots and off-plan Posts in chronological order", () => {
    const { container } = renderDay();
    expect([...container.querySelectorAll("time")].map((time) => time.dateTime)).toEqual([
      "2026-10-23T08:00:00Z",
      "2026-10-23T10:00:00Z",
      "2026-10-23T11:00:00Z",
    ]);
  });

  it("includes filled and unfilled counts in the date button name", () => {
    renderDay();
    expect(
      screen.getByRole("button", {
        name: `View posts on ${fullDate} · 1 filled · 1 unfilled`,
      }),
    ).toBeInTheDocument();
  });

  it.each([
    { isLoading: true },
    { timeline: undefined },
    {
      posts: [],
      timeline: {
        mode: "month" as const,
        onModeChange: () => {},
        timeZone: "UTC",
        now: date,
        slots: new Map(),
      },
    },
  ])("keeps the date-only name without a visible summary: %j", (overrides) => {
    renderDay(overrides);
    expect(screen.getByRole("button", { name: `View posts on ${fullDate}` })).toBeInTheDocument();
  });
});
