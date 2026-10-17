import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { normalizePostStatus, resolveRowCaption, toLocalDateKey } from "./posts-helpers";
import type { PostRow, CalendarDayCell } from "./types";

export interface PostCalendarGridViewProps {
  posts: PostRow[];
  calendarMonth: Date;
  calendarDays: CalendarDayCell[];
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  onCellClick: (date: Date) => void;
  /**
   * True while the bulk-selection bar floats above the bottom edge, so the
   * scroll area reserves padding instead of letting the bar cover the last
   * week row. Selection itself lives in the day-detail dialog.
   */
  selectionActive?: boolean;
}

/**
 * Presenter component for Calendar View: renders a monthly 7-column grid whose
 * cells hold one chip per Post row, not per Channel.
 *
 * Rows arrive already folded onto `Post.id`, so a Post whose Channels publish at
 * different times appears once per affected day instead of fragmenting, and two
 * identically composed Posts stay separate chips. Non-published indicators use
 * the semantic accent treatment, while published indicators use green.
 * Each day cell is a ghost `Button` restyled to the cell geometry so opening the
 * day detail stays keyboard- and focus-reachable; month paging icon buttons
 * carry explicit accessible names.
 * Wrapped in `React.memo` to prevent re-renders of the 35+ calendar cell DOM
 * tree unless month, posts, or days change.
 */
export const PostCalendarGridView = React.memo(function PostCalendarGridView({
  posts,
  calendarMonth,
  calendarDays,
  onPrevMonth,
  onNextMonth,
  onToday,
  onCellClick,
  selectionActive = false,
}: PostCalendarGridViewProps) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        "flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1",
        selectionActive && "pb-24",
      )}
    >
      <div className="shrink-0 flex items-center justify-between rounded-card border border-line bg-surface px-4 py-3 shadow-card">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-ink">
            {calendarMonth.toLocaleString("en-US", { month: "long", year: "numeric" })}
          </h2>
          <Button
            variant="outline"
            size="sm"
            onClick={onToday}
            className="h-7 text-xs rounded-control border-line"
          >
            {t("Today")}
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onPrevMonth}
            aria-label={t("Previous month")}
            className="size-8 rounded-control"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onNextMonth}
            aria-label={t("Next month")}
            className="size-8 rounded-control"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="rounded-card border border-line bg-surface overflow-hidden shadow-card">
        <div className="grid grid-cols-7 border-b border-line bg-page text-center text-xs font-semibold text-ink-2 py-2">
          <span>{t("Sun")}</span>
          <span>{t("Mon")}</span>
          <span>{t("Tue")}</span>
          <span>{t("Wed")}</span>
          <span>{t("Thu")}</span>
          <span>{t("Fri")}</span>
          <span>{t("Sat")}</span>
        </div>

        <div className="grid grid-cols-7 auto-rows-fr divide-x divide-y divide-line">
          {calendarDays.map((cell) => {
            const dateKey = toLocalDateKey(cell.date);
            const dayPosts = posts.filter((r) => toLocalDateKey(r.date) === dateKey);
            const isToday = toLocalDateKey(new Date()) === dateKey;

            return (
              <Button
                type="button"
                variant="ghost"
                key={cell.date.toISOString()}
                onClick={() => onCellClick(cell.date)}
                className={cn(
                  "min-h-[110px] h-auto w-full items-stretch justify-between gap-0 whitespace-normal rounded-none p-2 flex flex-col text-left font-normal transition-colors cursor-pointer group hover:bg-hover/70 focus-visible:ring-inset",
                  !cell.isCurrentMonth && "bg-page/40 text-ink-3",
                  isToday && "bg-accent-tint/30",
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      "text-xs font-medium size-6 flex items-center justify-center rounded-full",
                      isToday
                        ? "bg-foreground text-background font-bold"
                        : cell.isCurrentMonth
                          ? "text-ink"
                          : "text-ink-3",
                    )}
                  >
                    {cell.dayNumber}
                  </span>
                  {dayPosts.length > 0 && (
                    <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-full bg-line text-ink-2">
                      {dayPosts.length}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-1 mt-1 flex-1 overflow-hidden">
                  {dayPosts.slice(0, 2).map((row) => {
                    const content = resolveRowCaption(row) || t("Post");
                    const rawStatus = normalizePostStatus(row);
                    const isPub = rawStatus === "published";

                    return (
                      <div
                        key={`${row.id}-${dateKey}`}
                        className={cn(
                          "text-[10.5px] truncate px-1.5 py-0.5 rounded border leading-tight flex items-center gap-1",
                          isPub
                            ? "bg-green-tint text-green border-green/20"
                            : "bg-accent-tint text-accent-ink border-accent/20",
                        )}
                      >
                        <span className="size-1 rounded-full bg-current shrink-0" />
                        <span className="truncate">{content}</span>
                      </div>
                    );
                  })}
                  {dayPosts.length > 2 && (
                    <span className="text-[10px] text-ink-3 font-medium">
                      {t("+{count} more...", { count: dayPosts.length - 2 })}
                    </span>
                  )}
                </div>

                <div className="text-[10px] text-ink-3 opacity-0 group-hover:opacity-100 transition-opacity text-right">
                  {t("Click to expand")}
                </div>
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
