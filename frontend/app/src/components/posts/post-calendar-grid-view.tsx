import React, { useMemo, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { transitionViewEffect } from "@meltiply/ui/effects";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { Skeleton } from "@meltiply/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { usePublishingTimeZone } from "@/context/publishing-timezone.context";
import { normalizePostStatus, resolveRowCaption, toLocalDateKey } from "./posts-helpers";
import { StatusBadge } from "./status-badge";
import { publicationStatusPresentation, PUBLICATION_ICON_TONE } from "./status-presentation";
import { useSmoothScrollContainer } from "@/components/layout/smooth-scroll";
import type { PostRow, CalendarDayCell } from "./types";
import { CalendarTimeGrid } from "./calendar-time-grid";
import { calendarDateKey, type CalendarPeriod } from "./calendar-dates";
import type { CalendarSlot } from "./calendar-slots";

/**
 * Month-chip tint per canonical tone. The tone travels as `data-tone`, so the
 * class list stays statically analyzable by the design-system linter; neutral
 * remains legible without implying a schedule.
 */
const MONTH_CHIP_TONE_CLASS = `
  border-line bg-inset hover:bg-inset/70
  data-[tone=accent]:border-accent/20 data-[tone=accent]:bg-accent-tint data-[tone=accent]:hover:bg-accent-tint/70
  data-[tone=green]:border-green/20 data-[tone=green]:bg-green-tint data-[tone=green]:hover:bg-green-tint/70
  data-[tone=orange]:border-orange/20 data-[tone=orange]:bg-orange-tint data-[tone=orange]:hover:bg-orange-tint/70
  data-[tone=red]:border-red/20 data-[tone=red]:bg-red-tint data-[tone=red]:hover:bg-red-tint/70
`;

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
  /** Queue calendars control Month/Week in their own timezone; Posts retains its existing local-time contract. */
  timeline?: {
    mode: CalendarPeriod;
    onModeChange: (mode: CalendarPeriod) => void;
    timeZone: string;
    now: Date;
    slots: Map<string, CalendarSlot[]>;
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
 * Month/Week selection for Posts and Queue calendars.
 * Navigation callbacks move the caller's civil query anchor, never Post times.
 */
function CalendarToolbar({
  mode,
  onModeChange,
  label,
  onToday,
  onPrevious,
  onNext,
}: {
  mode: CalendarPeriod;
  onModeChange: (mode: CalendarPeriod) => void;
  label: string;
  onToday: () => void;
  onPrevious: () => void;
  onNext: () => void;
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
          aria-label={mode === "month" ? t("Previous month") : t("Previous week")}
          onClick={onPrevious}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={mode === "month" ? t("Next month") : t("Next week")}
          onClick={onNext}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      <h2
        aria-live="polite"
        className="order-last w-full text-(length:--font-size-control) font-semibold tracking-tight sm:order-none sm:mx-1 sm:w-auto"
      >
        {label}
      </h2>
      <div className="ml-auto">
        <SegmentedControl
          options={["month", "week"] as const}
          value={mode}
          onChange={onModeChange}
          label={t("Calendar period")}
          renderOption={(value) => (value === "month" ? t("Month") : t("Week"))}
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
 * Queue callers provide a timezone, a live clock and controlled Month/Week
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
  /** Morphs the named calendar/date snapshots without animating the toolbar or delaying state changes. */
  function changeMode(next: CalendarPeriod) {
    if (next === mode) return;
    const commit = () => flushSync(() => (timeline?.onModeChange ?? setLocalMode)(next));
    if (timeline) transitionViewEffect(commit);
    else commit();
  }
  const publishingTimeZone = usePublishingTimeZone();
  const timeZone = timeline?.timeZone ?? publishingTimeZone;
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
  const days = mode === "month" ? calendarDays : weekDays;
  /** Only the seven days that survive into Week morph; naming all 35–42 Month cells would snapshot the whole grid. */
  const morphKeys = useMemo(
    () => new Set(weekDays.map((day) => toLocalDateKey(day.date))),
    [weekDays],
  );
  const today = timeline
    ? calendarDateKey(timeline.now, timeline.timeZone)
    : toLocalDateKey(new Date());
  const label =
    mode === "month"
      ? monthLabel.format(calendarMonth)
      : `${shortLabel.format(weekDays[0]!.date)} – ${shortLabel.format(weekDays[6]!.date)}, ${weekDays[6]!.date.getFullYear()}`;
  const postById = useMemo(() => new Map(posts.map((row) => [row.id, row])), [posts]);
  /** Dashed unfilled-slot chip; elapsed occurrences stay muted so they cannot read as bookable. */
  function renderSlotChip(slot: CalendarSlot) {
    const elapsed = timeline ? new Date(slot.instant) <= timeline.now : false;
    return (
      <div
        key={slot.instant}
        data-slot-state="unfilled"
        className={cn(
          "flex min-w-0 items-center gap-1 rounded-control border border-dashed border-line-strong px-1 py-0.5 text-(length:--font-size-micro) text-ink-3",
          elapsed && "opacity-60",
        )}
      >
        <time dateTime={slot.instant} className="shrink-0 tabular-nums">
          {slot.time}
        </time>
        <span className="truncate">{elapsed ? t("Unfilled slot") : t("Open slot")}</span>
      </div>
    );
  }
  /** One real Post chip shared by both calendar lists; Month keeps its compact time-prefixed chip. */
  function renderPostChip(row: PostRow) {
    const caption = resolveRowCaption(row) || t("Untitled post");
    const status = normalizePostStatus(row);
    const { tone, Icon } = publicationStatusPresentation(status);
    return (
      <Tooltip key={row.id}>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            data-tone={tone}
            onClick={() => onViewDetails(row.id)}
            className={cn(
              "min-w-0 justify-start text-left font-normal",
              mode === "month"
                ? cn(
                    "h-5.5 gap-1.25 rounded-control border px-1.5 py-0 text-xs",
                    MONTH_CHIP_TONE_CLASS,
                  )
                : "h-auto flex-col items-stretch gap-1.25 whitespace-normal rounded-control border border-line bg-surface px-2 py-1.75 hover:border-line-strong",
            )}
          >
            <span className="flex min-w-0 items-center gap-1.25">
              <Icon className={cn("size-2.75 shrink-0", PUBLICATION_ICON_TONE[tone])} />
              <span
                className={cn(
                  mode === "month"
                    ? "truncate"
                    : "line-clamp-2 text-(length:--font-size-control) font-medium leading-snug",
                )}
              >
                {timeline && (
                  <time dateTime={row.date} className="mr-1 font-medium tabular-nums">
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
  }

  return (
    <TooltipProvider>
      <section
        aria-label={t("Publishing calendar")}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface"
      >
        <CalendarToolbar
          mode={mode}
          onModeChange={changeMode}
          label={label}
          onToday={onToday}
          onPrevious={() => (mode === "month" ? onPrevMonth() : onWeekNavigate(-1))}
          onNext={() => (mode === "month" ? onNextMonth() : onWeekNavigate(1))}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {timeline && mode !== "month" ? (
            <CalendarTimeGrid
              key={`${mode}:${toLocalDateKey(days[0]!.date)}:${timeline.timeZone}`}
              days={days}
              posts={posts}
              now={timeline.now}
              timeZone={timeline.timeZone}
              isLoading={isLoading}
              onViewDetails={onViewDetails}
              slots={timeline.slots}
            />
          ) : (
            <div
              ref={scrollRef}
              className={cn(
                "min-h-0 flex-1 overflow-auto overscroll-contain",
                selectionActive && "pb-24",
              )}
            >
              <div
                className={cn(
                  "flex flex-1 flex-col",
                  timeline ? "min-w-0 sm:min-h-160 sm:min-w-196" : "min-h-160 min-w-196",
                )}
              >
                {mode === "month" && (
                  <div className="grid grid-cols-7 border-b border-line">
                    {weekDays.map((day) => (
                      <div
                        key={day.dayNumber}
                        className="px-2.5 py-2 text-xs font-medium text-ink-3"
                      >
                        {weekdayLabel.format(day.date)}
                      </div>
                    ))}
                  </div>
                )}
                <div
                  className={cn(
                    "grid flex-1 grid-cols-7",
                    mode === "month"
                      ? timeline
                        ? "auto-rows-min sm:auto-rows-[minmax(112px,1fr)]"
                        : "auto-rows-[minmax(112px,1fr)]"
                      : "grid-rows-1",
                  )}
                >
                  {days.map((cell, index) => {
                    const key = toLocalDateKey(cell.date);
                    const dayPosts = postsByDay.get(key) ?? [];
                    const daySlots = timeline?.slots.get(key) ?? [];
                    const emptySlots = daySlots.filter((slot) => !slot.postId);
                    const filledSlots = daySlots.length - emptySlots.length;
                    // Slots and off-plan Posts interleave in time order; filled slots render their real Post chip.
                    const monthEntries =
                      mode === "month" && timeline
                        ? [
                            ...daySlots.flatMap((slot) => {
                              if (!slot.postId)
                                return [{ instant: slot.instant, chip: renderSlotChip(slot) }];
                              const row = postById.get(slot.postId);
                              return row
                                ? [{ instant: slot.instant, chip: renderPostChip(row) }]
                                : [];
                            }),
                            ...dayPosts
                              .filter((row) => !daySlots.some((slot) => slot.postId === row.id))
                              .map((row) => ({ instant: row.date, chip: renderPostChip(row) })),
                          ]
                            .sort((a, b) => Date.parse(a.instant) - Date.parse(b.instant))
                            .map((entry) => entry.chip)
                        : [];
                    const isToday = key === today;
                    const fullDate = dateLabel.format(cell.date);
                    const showMonthSummary =
                      timeline &&
                      mode === "month" &&
                      !isLoading &&
                      (daySlots.length > 0 || dayPosts.length > 0);
                    return (
                      <div
                        key={key}
                        role="group"
                        aria-label={fullDate}
                        className={cn(
                          "group/day relative flex min-w-0 flex-col border-b border-r border-line [&:nth-child(7n)]:border-r-0",
                          mode === "month"
                            ? timeline
                              ? "gap-0.75 p-1 sm:p-1.5"
                              : "gap-0.75 p-1.5"
                            : "min-h-0",
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
                            aria-label={
                              showMonthSummary
                                ? `${t("View posts on {date}", { date: fullDate })} · ${t(
                                    "{filled} filled · {empty} unfilled",
                                    { filled: filledSlots, empty: emptySlots.length },
                                  )}`
                                : t("View posts on {date}", { date: fullDate })
                            }
                            aria-current={isToday ? "date" : undefined}
                            onClick={() => onCellClick(cell.date)}
                            data-calendar-date={timeline && morphKeys.has(key) ? "" : undefined}
                            style={
                              timeline && morphKeys.has(key)
                                ? ({
                                    "--calendar-date-name": `calendar-date-${key}`,
                                  } as CSSProperties)
                                : undefined
                            }
                            className={cn(
                              "tabular-nums",
                              mode === "month"
                                ? timeline
                                  ? "h-auto min-h-16 w-full flex-col gap-1 rounded-control px-0 py-2 text-xs font-medium sm:size-5.5 sm:min-h-0 sm:rounded-full sm:p-0"
                                  : "size-5.5 rounded-full text-xs font-medium"
                                : "size-7 text-xl font-semibold tracking-tight",
                              isToday &&
                                (mode === "month"
                                  ? "bg-accent text-accent-foreground hover:bg-accent/90"
                                  : "text-accent"),
                              !cell.isCurrentMonth && mode === "month" && "text-ink-3",
                            )}
                          >
                            {cell.dayNumber}
                            {showMonthSummary && (
                              <span
                                className="inline-flex items-center gap-1 text-(length:--font-size-micro) sm:hidden"
                                aria-label={t("{filled} filled · {empty} unfilled", {
                                  filled: filledSlots,
                                  empty: emptySlots.length,
                                })}
                              >
                                <span
                                  className="size-1.5 rounded-full bg-current"
                                  aria-hidden="true"
                                />
                                {filledSlots}
                                <span
                                  className="size-1.5 rounded-full border border-current"
                                  aria-hidden="true"
                                />
                                {emptySlots.length}
                              </span>
                            )}
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
                            timeline && mode === "month" && "hidden sm:flex",
                          )}
                        >
                          {timeline && mode === "month" && !isLoading && daySlots.length > 0 && (
                            <p className="px-1 text-(length:--font-size-micro) text-ink-3">
                              {t("{filled} filled · {empty} unfilled", {
                                filled: filledSlots,
                                empty: emptySlots.length,
                              })}
                            </p>
                          )}
                          {isLoading ? (
                            <div className="flex min-w-0 flex-col gap-0.75" aria-hidden="true">
                              {PLACEHOLDER_CHIPS[index % PLACEHOLDER_CHIPS.length]!.map((chip) => (
                                <Skeleton key={chip} className="h-5.5 rounded-control" />
                              ))}
                            </div>
                          ) : mode === "month" && timeline ? (
                            monthEntries.slice(0, 3)
                          ) : (
                            dayPosts.map((row) => renderPostChip(row))
                          )}
                          {!isLoading &&
                            mode === "month" &&
                            (timeline ? monthEntries.length : dayPosts.length) > 3 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 justify-start px-1.5 text-(length:--font-size-micro) font-normal text-ink-2"
                                onClick={() => onCellClick(cell.date)}
                              >
                                {t("+{count} more", {
                                  count: (timeline ? monthEntries.length : dayPosts.length) - 3,
                                })}
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
        </div>
      </section>
    </TooltipProvider>
  );
});
