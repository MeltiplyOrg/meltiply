// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { I18nProvider } from "@/lib/i18n";
import { PostCalendarGridView, type PostCalendarGridViewProps } from "./post-calendar-grid-view";
import type { PostRow } from "./types";

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

/** One status probe Post on the rendered day, independent of the Queue slot fixtures. */
function statusPost(status: string): PostRow {
  return {
    id: `status-${status}`,
    date: new Date(2026, 9, 23, 8).toISOString(),
    status,
    channels: [
      {
        id: `status-${status}-channel`,
        postId: `status-${status}`,
        publishDate: new Date(2026, 9, 23, 8).toISOString(),
        status,
        content: [{ content: "Status probe" }],
        attachments: [],
      },
    ],
    brandProfileId: "profile",
  };
}

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

describe("Calendar chip publication status", () => {
  it.each([
    { status: "published", tone: "green", icon: "text-green" },
    { status: "failed", tone: "red", icon: "text-red" },
    { status: "needs_reconciliation", tone: "orange", icon: "text-orange" },
    { status: "cancel_requested", tone: "orange", icon: "text-orange" },
    { status: "scheduled", tone: "accent", icon: "text-accent" },
    { status: "queued", tone: "accent", icon: "text-accent" },
    { status: "processing", tone: "accent", icon: "text-accent" },
    { status: "awaiting_provider", tone: "accent", icon: "text-accent" },
    { status: "draft", tone: "neutral", icon: "text-ink-3" },
    { status: "cancelled", tone: "neutral", icon: "text-ink-3" },
    { status: "future_provider_status", tone: "neutral", icon: "text-ink-3" },
  ] as const)("renders $status with its canonical month tone", ({ status, tone, icon }) => {
    renderDay({ posts: [statusPost(status)], timeline: undefined });
    const button = screen.getByRole("button", { name: "Status probe" });
    const iconElement = button.querySelector("svg");
    if (!iconElement) throw new Error("Calendar chip is missing its status icon");

    expect(button).toHaveAttribute("data-tone", tone);
    expect(iconElement).toHaveClass(icon);
  });

  it("keeps Reconciliation caution distinct from a red failure on the month grid", () => {
    renderDay({ posts: [statusPost("needs_reconciliation")], timeline: undefined });
    const button = screen.getByRole("button", { name: "Status probe" });

    expect(button).toHaveAttribute("data-tone", "orange");
    expect(button).not.toHaveAttribute("data-tone", "red");
  });

  it("locates a status chip by its shared caption while rendering the canonical week badge", () => {
    renderDay({
      posts: [statusPost("future_provider_status")],
      timeline: {
        mode: "week",
        onModeChange: () => {},
        timeZone: "UTC",
        now: new Date("2026-10-23T00:00:00Z"),
        slots: new Map(),
      },
    });
    const button = screen.getByRole("button", { name: /Status probe/ });

    expect(button).toHaveClass("bg-surface");
    expect(button.querySelector("svg")).toHaveClass("text-ink-3");
    expect(screen.getByText(/Unknown/)).toBeInTheDocument();
  });

  it("keeps Reconciliation orange in the Week time canvas, never red", () => {
    renderDay({
      posts: [statusPost("needs_reconciliation")],
      timeline: {
        mode: "week",
        onModeChange: () => {},
        timeZone: "UTC",
        now: new Date("2026-10-23T00:00:00Z"),
        slots: new Map(),
      },
    });
    const button = screen.getByRole("button", { name: /Status probe/ });

    expect(button).toHaveAttribute("data-tone", "orange");
    expect(button).not.toHaveAttribute("data-tone", "red");
  });
});
