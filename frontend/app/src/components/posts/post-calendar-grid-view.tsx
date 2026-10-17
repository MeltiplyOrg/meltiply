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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { normalizePostStatus, resolveRowCaption, toLocalDateKey } from "./posts-helpers";
import { StatusBadge } from "./status-badge";
import type { PostRow, CalendarDayCell } from "./types";

export interface PostCalendarGridViewProps {
  posts: PostRow[];
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
}

/**
 * Gr8r Calendar's flat Month grid and Week columns over real filtered Post rows.
 * Indexes once by local day; a Post appears once per affected day, not per Channel.
 * Post chips open inspection, day numbers/overflow open the selectable day list,
 * and explicit plus controls seed the real composer. No drag-to-reschedule or
 * task-only events are implied. Week navigation keeps the parent's query anchor
 * current, so crossing month/year boundaries fetches the displayed dates.
 */
export const PostCalendarGridView = React.memo(function PostCalendarGridView({
  posts,
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
}: PostCalendarGridViewProps) {
  const { t, tStatus, language } = useI18n();
  const [mode, setMode] = useState<"month" | "week">("month");
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
  const postsByDay = useMemo(() => {
    const grouped = new Map<string, PostRow[]>();
    for (const row of posts) {
      const key = toLocalDateKey(row.date);
      const rows = grouped.get(key);
      if (rows) rows.push(row);
      else grouped.set(key, [row]);
    }
    return grouped;
  }, [posts]);
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
  const today = toLocalDateKey(new Date());
  const label =
    mode === "month"
      ? monthLabel.format(calendarMonth)
      : `${shortLabel.format(weekDays[0]!.date)} – ${shortLabel.format(weekDays[6]!.date)}, ${weekDays[6]!.date.getFullYear()}`;

  return (
    <TooltipProvider>
      <section
        aria-label={t("Publishing calendar")}
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-auto bg-surface overscroll-contain",
          selectionActive && "pb-24",
        )}
      >
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
              onClick={() => (mode === "month" ? onPrevMonth() : onWeekNavigate(-1))}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={mode === "month" ? t("Next month") : t("Next week")}
              onClick={() => (mode === "month" ? onNextMonth() : onWeekNavigate(1))}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
          <h2 aria-live="polite" className="mx-1 text-[15px] font-semibold tracking-tight">
            {label}
          </h2>
          <div className="ml-auto">
            <SegmentedControl
              options={["month", "week"] as const}
              value={mode}
              onChange={setMode}
              label={t("Calendar period")}
              renderOption={(value) => (value === "month" ? t("Month") : t("Week"))}
            />
          </div>
        </div>
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
            {days.map((cell) => {
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
                            ? "bg-accent text-accent-foreground hover:bg-accent-hover"
                            : "text-accent"),
                        !cell.isCurrentMonth && mode === "month" && "text-ink-3",
                      )}
                    >
                      {cell.dayNumber}
                    </Button>
                    {mode === "week" && (
                      <span className="text-xs text-ink-3">{weekdayLabel.format(cell.date)}</span>
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
                                "opacity-100 sm:opacity-0 sm:group-hover/day:opacity-100 sm:group-focus-within/day:opacity-100 focus-visible:opacity-100",
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
                    {(mode === "month" ? dayPosts.slice(0, 3) : dayPosts).map((row) => {
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
                                  ? "h-5.5 gap-1.25 rounded-[5px] border border-accent/20 bg-accent-tint px-1.5 py-0 text-xs hover:bg-accent-tint/70"
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
                                    published ? "text-green" : failed ? "text-red" : "text-accent",
                                  )}
                                />
                                <span
                                  className={cn(
                                    mode === "month"
                                      ? "truncate"
                                      : "line-clamp-2 text-(length:--font-size-control) font-medium leading-snug",
                                  )}
                                >
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
                    })}
                    {mode === "month" && dayPosts.length > 3 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 justify-start px-1.5 text-(length:--font-size-micro) font-normal text-ink-2"
                        onClick={() => onCellClick(cell.date)}
                      >
                        {t("+{count} more", { count: dayPosts.length - 3 })}
                      </Button>
                    )}
                    {mode === "week" && dayPosts.length === 0 && (
                      <p className="p-1 text-xs text-ink-3">{t("No posts")}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </TooltipProvider>
  );
});
