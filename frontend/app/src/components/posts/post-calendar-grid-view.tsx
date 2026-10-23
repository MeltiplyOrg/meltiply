import React, { useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  FileText,
  Plus,
} from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { Skeleton } from "@meltiply/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { normalizePostStatus, resolveRowCaption, toLocalDateKey } from "./posts-helpers";
import { StatusBadge } from "./status-badge";
import { useSmoothScrollContainer } from "@/components/layout/smooth-scroll";
import type { PostRow, CalendarDayCell } from "./types";
import { CalendarTimeGrid } from "./calendar-time-grid";
import { calendarDateKey, type CalendarPeriod } from "./calendar-dates";

export interface PostCalendarGridViewProps {
  posts: PostRow[];
  /**
   * Renders the month's real dates, weekday heading, and controls with
   * placeholder chips in place of Post chips. The grid's dates come from the
   * displayed month rather than the response, so only the chips are unknown
   * while the calendar query resolves.
   */
  isLoading: boolean;
  calendarMonth: Date;
  calendarDays: CalendarDayCell[];
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  onWeekNavigate: (offset: number) => void;
  onCellClick: (date: Date) => void;
  onScheduleDate: (date: Date) => void;
  onViewDetails: (postId: string) => void;
  canSchedule: boolean;
  /** Reserves space for the shared bulk bar; selection remains in day details. */
  selectionActive?: boolean;
  /** Queue calendars control all three periods in their own timezone; Posts retains its existing Month/Week contract. */
  timeline?: {
    mode: CalendarPeriod;
    onModeChange: (mode: CalendarPeriod) => void;
    onDayNavigate: (offset: number) => void;
    timeZone: string;
    now: Date;
  };
}

/**
 * Placeholder chips per calendar day while the calendar query resolves. The
 * three-day cycle keeps a realistic mix of busy and quiet days without random
 * values, so the grid reads the same on every render.
 */
const PLACEHOLDER_CHIPS = [["chip-1", "chip-2"], ["chip-1"], []] as const;

/**
 * Shared period bar with Today, stepping, a localized heading, and canonical
 * segmented selection. Queue timelines opt into Day; Posts retains Month/Week.
 * Navigation callbacks move the caller's civil query anchor, never Post times.
 */
function CalendarToolbar({
  mode,
  onModeChange,
  label,
  onToday,
  onPrevious,
  onNext,
  allowDay = false,
}: {
  mode: CalendarPeriod;
  onModeChange: (mode: CalendarPeriod) => void;
  label: string;
  onToday: () => void;
  onPrevious: () => void;
  onNext: () => void;
  allowDay?: boolean;
}) {
  const { t } = useI18n();

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 sm:px-6">
      <Button variant="outline" size="sm" onClick={onToday}>
        {t("Today")}
      </Button>
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={
            mode === "month"
              ? t("Previous month")
              : mode === "week"
                ? t("Previous week")
                : t("Previous day")
          }
          onClick={onPrevious}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={
            mode === "month" ? t("Next month") : mode === "week" ? t("Next week") : t("Next day")
          }
          onClick={onNext}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <h2 aria-live="polite" className="mx-1 text-[15px] font-semibold tracking-tight">
        {label}
      </h2>
      <div className="ml-auto">
        <SegmentedControl
          options={allowDay ? (["month", "week", "day"] as const) : (["month", "week"] as const)}
          value={mode}
          onChange={onModeChange}
          label={t("Calendar period")}
          renderOption={(value) =>
            value === "month" ? t("Month") : value === "week" ? t("Week") : t("Day")
          }
        />
      </div>
    </div>
  );
}

/**
 * Gr8r Calendar's flat Month grid and Week columns over real filtered Post rows.
 * Indexes once by local day; a Post appears once per affected day, not per Channel.
 * Post chips open inspection, day numbers/overflow open the selectable day list,
 * and explicit plus controls seed the real composer. No drag-to-reschedule or
 * task-only events are implied. Week navigation keeps the parent's query anchor
 * current, so crossing month/year boundaries fetches the displayed dates.
 * While `isLoading`, the real month heading, dates, and controls stay in place and
 * only the chips become placeholders.
 * Queue callers provide a timezone, a live clock and controlled Month/Week/Day
 * state; their hourly canvas reuses the toolbar and month chips without changing
 * the existing Posts Week layout or its local-time scheduling behavior.
 */
export const PostCalendarGridView = React.memo(function PostCalendarGridView({
  posts,
  isLoading,
  calendarMonth,
  calendarDays,
  onPrevMonth,
  onNextMonth,
  onToday,
  onWeekNavigate,
  onCellClick,
  onScheduleDate,
  onViewDetails,
  canSchedule,
  selectionActive = false,
  timeline,
}: PostCalendarGridViewProps) {
  const { t, tStatus, language } = useI18n();
  const scrollRef = useSmoothScrollContainer();
  const [localMode, setLocalMode] = useState<CalendarPeriod>("month");
  const mode = timeline?.mode ?? localMode;
  const timeZone = timeline?.timeZone;
  const dateLabel = useMemo(
    () => new Intl.DateTimeFormat(language, { dateStyle: "full" }),
    [language],
  );
  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(language, { month: "long", year: "numeric" }),
    [language],
  );
  const shortLabel = useMemo(
    () => new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }),
    [language],
  );
  const weekdayLabel = useMemo(
    () => new Intl.DateTimeFormat(language, { weekday: "short" }),
    [language],
  );
  const timeLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    [language, timeZone],
  );
  const postsByDay = useMemo(() => {
    const grouped = new Map<string, PostRow[]>();
    for (const row of posts) {
      const key = timeZone ? calendarDateKey(row.date, timeZone) : toLocalDateKey(row.date);
      const rows = grouped.get(key);
      if (rows) rows.push(row);
      else grouped.set(key, [row]);
    }
    return grouped;
  }, [posts, timeZone]);
  const weekDays = useMemo(() => {
    const start = new Date(
      calendarMonth.getFullYear(),
      calendarMonth.getMonth(),
      calendarMonth.getDate() - ((calendarMonth.getDay() + 6) % 7),
    );
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      return {
        date,
        dayNumber: date.getDate(),
        isCurrentMonth: date.getMonth() === calendarMonth.getMonth(),
      };
    });
  }, [calendarMonth]);
  const days =
    mode === "month"
      ? calendarDays
      : mode === "day"
        ? [{ date: calendarMonth, dayNumber: calendarMonth.getDate(), isCurrentMonth: true }]
        : weekDays;
  const today = timeline
    ? calendarDateKey(timeline.now, timeline.timeZone)
    : toLocalDateKey(new Date());
  const label =
    mode === "month"
      ? monthLabel.format(calendarMonth)
      : mode === "day"
        ? dateLabel.format(calendarMonth)
        : `${shortLabel.format(weekDays[0]!.date)} – ${shortLabel.format(weekDays[6]!.date)}, ${weekDays[6]!.date.getFullYear()}`;

  return (
    <TooltipProvider>
      <section
        aria-label={t("Publishing calendar")}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface"
      >
        <CalendarToolbar
          mode={mode}
          onModeChange={timeline?.onModeChange ?? setLocalMode}
          label={label}
          onToday={onToday}
          onPrevious={() =>
            mode === "month"
              ? onPrevMonth()
              : mode === "day"
                ? timeline?.onDayNavigate(-1)
                : onWeekNavigate(-1)
          }
          onNext={() =>
            mode === "month"
              ? onNextMonth()
              : mode === "day"
                ? timeline?.onDayNavigate(1)
                : onWeekNavigate(1)
          }
          allowDay={timeline !== undefined}
        />
        {timeline && mode !== "month" ? (
          <CalendarTimeGrid
            key={`${mode}:${toLocalDateKey(days[0]!.date)}:${timeline.timeZone}`}
            days={days}
            posts={posts}
            now={timeline.now}
            timeZone={timeline.timeZone}
            isLoading={isLoading}
            onViewDetails={onViewDetails}
            onDayClick={onCellClick}
          />
        ) : (
          <div
            ref={scrollRef}
            className={cn(
              "min-h-0 flex-1 overflow-auto overscroll-contain",
              selectionActive && "pb-24",
            )}
          >
            <div className="flex min-h-160 min-w-196 flex-1 flex-col">
              {mode === "month" && (
                <div className="grid grid-cols-7 border-b border-line">
                  {weekDays.map((day) => (
                    <div key={day.dayNumber} className="px-2.5 py-2 text-xs font-medium text-ink-3">
                      {weekdayLabel.format(day.date)}
                    </div>
                  ))}
                </div>
              )}
              <div
                className={cn(
                  "grid flex-1 grid-cols-7",
                  mode === "month" ? "auto-rows-[minmax(112px,1fr)]" : "grid-rows-1",
                )}
              >
                {days.map((cell, index) => {
                  const key = toLocalDateKey(cell.date);
                  const dayPosts = postsByDay.get(key) ?? [];
                  const isToday = key === today;
                  const fullDate = dateLabel.format(cell.date);
                  return (
                    <div
                      key={key}
                      role="group"
                      aria-label={fullDate}
                      className={cn(
                        "group/day relative flex min-w-0 flex-col border-b border-r border-line [&:nth-child(7n)]:border-r-0",
                        mode === "month" ? "gap-0.75 p-1.5" : "min-h-0",
                        mode === "month" && !cell.isCurrentMonth && "bg-inset",
                      )}
                    >
                      <div
                        className={cn(
                          "flex items-center gap-1.5",
                          mode === "week" && "border-b border-line p-2.5",
                        )}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("View posts on {date}", { date: fullDate })}
                          aria-current={isToday ? "date" : undefined}
                          onClick={() => onCellClick(cell.date)}
                          className={cn(
                            "tabular-nums",
                            mode === "month"
                              ? "size-5.5 rounded-full text-xs font-medium"
                              : "size-7 text-xl font-semibold tracking-tight",
                            isToday &&
                              (mode === "month"
                                ? "bg-accent text-accent-foreground hover:bg-accent/90"
                                : "text-accent"),
                            !cell.isCurrentMonth && mode === "month" && "text-ink-3",
                          )}
                        >
                          {cell.dayNumber}
                        </Button>
                        {mode === "week" && (
                          <span className="text-xs text-ink-3">
                            {weekdayLabel.format(cell.date)}
                          </span>
                        )}
                        {canSchedule && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  "ml-auto size-6",
                                  mode === "month" &&
                                    "opacity-100 [@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/day:opacity-100 group-focus-within/day:opacity-100 focus-visible:opacity-100",
                                )}
                                aria-label={t("Schedule post on {date}", { date: fullDate })}
                                onClick={() => onScheduleDate(cell.date)}
                              >
                                <Plus className="size-3.25" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{t("Schedule post for this date")}</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      <div
                        className={cn(
                          "flex min-w-0 flex-col",
                          mode === "month" ? "gap-0.75" : "flex-1 gap-1.5 overflow-y-auto p-2",
                        )}
                      >
                        {isLoading ? (
                          <div className="flex min-w-0 flex-col gap-0.75" aria-hidden="true">
                            {PLACEHOLDER_CHIPS[index % PLACEHOLDER_CHIPS.length]!.map((chip) => (
                              <Skeleton key={chip} className="h-5.5 rounded-control" />
                            ))}
                          </div>
                        ) : (
                          (mode === "month" ? dayPosts.slice(0, 3) : dayPosts).map((row) => {
                            const caption = resolveRowCaption(row) || t("Untitled post");
                            const status = normalizePostStatus(row);
                            const published = status === "published";
                            const failed = status === "failed" || status === "needs_reconciliation";
                            const Icon = published
                              ? CircleCheck
                              : failed
                                ? AlertCircle
                                : status === "draft"
                                  ? FileText
                                  : status === "cancelled"
                                    ? CircleX
                                    : Clock;
                            return (
                              <Tooltip key={row.id}>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    onClick={() => onViewDetails(row.id)}
                                    className={cn(
                                      "min-w-0 justify-start text-left font-normal",
                                      mode === "month"
                                        ? "h-5.5 gap-1.25 rounded-control border border-accent/20 bg-accent-tint px-1.5 py-0 text-xs hover:bg-accent-tint/70"
                                        : "h-auto flex-col items-stretch gap-1.25 whitespace-normal rounded-control border border-line bg-surface px-2 py-1.75 hover:border-line-strong",
                                      published &&
                                        mode === "month" &&
                                        "border-green/20 bg-green-tint hover:bg-green-tint/70",
                                      failed &&
                                        mode === "month" &&
                                        "border-red/20 bg-red-tint hover:bg-red-tint/70",
                                    )}
                                  >
                                    <span className="flex min-w-0 items-center gap-1.25">
                                      <Icon
                                        className={cn(
                                          "size-2.75 shrink-0",
                                          published
                                            ? "text-green"
                                            : failed
                                              ? "text-red"
                                              : "text-accent",
                                        )}
                                      />
                                      <span
                                        className={cn(
                                          mode === "month"
                                            ? "truncate"
                                            : "line-clamp-2 text-(length:--font-size-control) font-medium leading-snug",
                                        )}
                                      >
                                        {timeline && (
                                          <time
                                            dateTime={row.date}
                                            className="mr-1 font-medium tabular-nums"
                                          >
                                            {timeLabel.format(new Date(row.date))}
                                          </time>
                                        )}
                                        {caption}
                                      </span>
                                    </span>
                                    {mode === "week" && (
                                      <span className="flex flex-wrap items-center gap-1.5 text-(length:--font-size-micro) text-ink-3">
                                        <StatusBadge status={status} />
                                        <time dateTime={row.date}>
                                          {new Date(row.date).toLocaleTimeString(language, {
                                            hour: "2-digit",
                                            minute: "2-digit",
                                          })}
                                        </time>
                                      </span>
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {caption} · {tStatus(status)}
                                </TooltipContent>
                              </Tooltip>
                            );
                          })
                        )}
                        {!isLoading && mode === "month" && dayPosts.length > 3 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 justify-start px-1.5 text-(length:--font-size-micro) font-normal text-ink-2"
                            onClick={() => onCellClick(cell.date)}
                          >
                            {t("+{count} more", { count: dayPosts.length - 3 })}
                          </Button>
                        )}
                        {!isLoading && mode === "week" && dayPosts.length === 0 && (
                          <p className="p-1 text-xs text-ink-3">{t("No posts")}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </section>
    </TooltipProvider>
  );
});
