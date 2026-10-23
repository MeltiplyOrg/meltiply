import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fromDate } from "@internationalized/date";
import { Button } from "@meltiply/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@meltiply/ui/tooltip";
import { cn } from "@meltiply/ui/utils";
import { useSmoothScrollContainer } from "@/components/layout/smooth-scroll";
import { useI18n } from "@/lib/i18n";
import { normalizePostStatus, resolveRowCaption, toLocalDateKey } from "./posts-helpers";
import type { CalendarDayCell, PostRow } from "./types";
import { calendarDateKey } from "./calendar-dates";
import type { CalendarSlot } from "./calendar-slots";

interface GridEntry {
  date: string;
  post?: PostRow;
  slot?: CalendarSlot;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Positions instant markers on a 24-hour wall-clock grid; repeated DST hours share a position but retain distinct offset labels and identities. */
function minuteOfDay(instant: Date | string, timeZone: string): number {
  const date = fromDate(typeof instant === "string" ? new Date(instant) : instant, timeZone);
  return date.hour * 60 + date.minute + date.second / 60;
}

/** Partitions overlapping 45-minute visual chips into lanes, preserving every actual instant rather than covering nearby reservations. These are point-in-time publications, not claimed event durations. */
function eventLanes(entries: GridEntry[], timeZone: string) {
  const ends: number[] = [];
  const events = entries
    .map((entry) => ({ ...entry, minute: minuteOfDay(entry.date, timeZone) }))
    .sort((a, b) => a.minute - b.minute || a.date.localeCompare(b.date));
  const placed = events.map((event) => {
    const available = ends.findIndex((end) => end <= event.minute);
    const lane = available < 0 ? ends.length : available;
    ends[lane] = event.minute + 45;
    return { ...event, lane };
  });
  return { placed, lanes: Math.max(1, ends.length) };
}

/** Hourly Week canvas with independent scrolling, sticky dates/time axis, real timestamp chips and a current-time rule only when today is visible. The caller owns the clock and timezone. Initial scroll centers now and today's column (or 08:00/Monday for other weeks), including on narrow screens; subsequent clock ticks never steal scroll or focus. */
export function CalendarTimeGrid({
  days,
  posts,
  now,
  timeZone,
  isLoading,
  onViewDetails,
  slots,
}: {
  days: CalendarDayCell[];
  posts: PostRow[];
  now: Date;
  timeZone: string;
  isLoading: boolean;
  onViewDetails: (postId: string) => void;
  slots: Map<string, CalendarSlot[]>;
}) {
  const { t, tStatus, language } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const smoothRef = useSmoothScrollContainer();
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      viewport.current = node;
      smoothRef(node);
    },
    [smoothRef],
  );
  const today = calendarDateKey(now, timeZone);
  const todayIndex = days.findIndex((day) => toLocalDateKey(day.date) === today);
  const minute = minuteOfDay(now, timeZone);
  const [initialMinute] = useState(() => (todayIndex >= 0 ? minute : 8 * 60));
  const [initialDay] = useState(todayIndex);
  useEffect(() => {
    const node = viewport.current;
    if (node) {
      const canvas = node.querySelector<HTMLElement>("[data-hour-canvas]");
      if (canvas)
        node.scrollTop = Math.max(
          0,
          (initialMinute / 1440) * canvas.offsetHeight - node.clientHeight / 3,
        );
      const day = canvas?.children[initialDay + 1];
      if (canvas && initialDay >= 0 && day && node.scrollWidth > node.clientWidth) {
        node.scrollLeft = Math.max(
          0,
          day.getBoundingClientRect().left -
            canvas.getBoundingClientRect().left -
            (node.clientWidth - day.clientWidth) / 2,
        );
      }
    }
  }, [initialMinute, initialDay]);
  const byDay = useMemo(() => {
    const grouped = new Map<string, PostRow[]>();
    for (const post of posts) {
      const key = calendarDateKey(post.date, timeZone);
      const group = grouped.get(key);
      if (group) group.push(post);
      else grouped.set(key, [post]);
    }
    return grouped;
  }, [posts, timeZone]);
  const placedDays = useMemo(
    () =>
      new Map(
        days.map((day) => {
          const key = toLocalDateKey(day.date);
          const daySlots = slots.get(key) ?? [];
          const entries: GridEntry[] = (byDay.get(key) ?? []).map((post) => ({
            date: post.date,
            post,
            slot: daySlots.find((slot) => slot.postId === post.id),
          }));
          for (const slot of daySlots) if (!slot.postId) entries.push({ date: slot.instant, slot });
          return [key, eventLanes(entries, timeZone)] as const;
        }),
      ),
    [days, byDay, slots, timeZone],
  );
  const formatters = useMemo(
    () => ({
      timeLabel: new Intl.DateTimeFormat(language, {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
      eventTime: new Intl.DateTimeFormat(language, {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "shortOffset",
        hourCycle: "h23",
      }),
      fullDate: new Intl.DateTimeFormat(language, { dateStyle: "full" }),
      weekday: new Intl.DateTimeFormat(language, { weekday: "short" }),
    }),
    [language, timeZone],
  );
  const { timeLabel, eventTime, fullDate, weekday } = formatters;
  return (
    <div
      ref={attach}
      data-lenis-prevent=""
      className="min-h-0 flex-1 overflow-auto overscroll-contain"
      aria-busy={isLoading}
    >
      <div className="min-w-196">
        <div className="sticky top-0 z-30 flex border-b border-line bg-surface">
          <div className="sticky left-0 z-40 w-14 shrink-0 border-r border-line bg-surface" />
          {days.map((day) => {
            const isToday = toLocalDateKey(day.date) === today;
            return (
              <div
                key={day.date.toISOString()}
                className={cn(
                  "flex min-w-0 flex-1 flex-col items-center gap-0.5 border-r border-line py-2 last:border-r-0",
                  isToday && "bg-accent-tint text-accent-ink",
                )}
              >
                <span className="text-xs text-ink-3">{weekday.format(day.date)}</span>
                <time
                  dateTime={toLocalDateKey(day.date)}
                  aria-label={fullDate.format(day.date)}
                  aria-current={isToday ? "date" : undefined}
                  data-calendar-date=""
                  style={
                    {
                      "--calendar-date-name": `calendar-date-${toLocalDateKey(day.date)}`,
                    } as CSSProperties
                  }
                  className="text-xl font-semibold tabular-nums"
                >
                  {day.dayNumber}
                </time>
              </div>
            );
          })}
        </div>
        <div data-hour-canvas="" className="relative flex h-(--calendar-day-height)">
          <div className="sticky left-0 z-10 w-14 shrink-0 border-r border-line bg-surface">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="h-(--calendar-hour-height) border-t border-line px-1 pt-1 text-right text-(length:--font-size-micro) tabular-nums text-ink-3"
              >
                {String(hour).padStart(2, "0")}:00
              </div>
            ))}
          </div>
          {days.map((day) => {
            const key = toLocalDateKey(day.date);
            const { placed, lanes } = placedDays.get(key) ?? { placed: [], lanes: 1 };
            return (
              <div
                key={key}
                role="group"
                aria-label={fullDate.format(day.date)}
                className={cn(
                  "relative min-w-0 flex-1 border-r border-line last:border-r-0",
                  key === today && "bg-accent-tint/20",
                )}
              >
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="pointer-events-none h-(--calendar-hour-height) border-t border-line"
                  >
                    <div className="h-1/2 border-b border-line/40" />
                  </div>
                ))}
                {key === today && (
                  <div
                    data-current-time=""
                    role="img"
                    aria-label={t("Current time: {time}", { time: timeLabel.format(now) })}
                    className="pointer-events-none absolute inset-x-0 top-(--current-time-top) z-20 -translate-y-1/2 border-t border-red text-red"
                    style={{ "--current-time-top": `${(minute / 1440) * 100}%` } as CSSProperties}
                  >
                    <span className="absolute -left-1 -top-1 size-2 rounded-full bg-red" />
                    <time
                      dateTime={now.toISOString()}
                      className="absolute bottom-1 left-1 bg-surface px-1 text-(length:--font-size-micro) font-medium tabular-nums"
                    >
                      {timeLabel.format(now)}
                    </time>
                  </div>
                )}
                {!isLoading &&
                  placed.map(({ post, slot, minute: at, lane }) => {
                    if (!post && slot) {
                      const elapsed = new Date(slot.instant) <= now;
                      return (
                        <div
                          key={slot.instant}
                          data-slot-state="unfilled"
                          aria-label={`${elapsed ? t("Unfilled slot") : t("Open slot")} · ${slot.time}`}
                          className={cn(
                            "absolute top-(--event-top) left-(--event-left) h-12 w-(--event-width) min-w-0 overflow-hidden rounded-control border border-dashed border-line-strong bg-surface px-1.5 py-1 text-xs text-ink-3",
                            elapsed && "opacity-60",
                          )}
                          style={
                            {
                              "--event-top": `min(${(at / 1440) * 100}%, calc(100% - 3rem))`,
                              "--event-left": `calc(${(lane / lanes) * 100}% + var(--spacing) / 2)`,
                              "--event-width": `calc(${100 / lanes}% - var(--spacing))`,
                            } as CSSProperties
                          }
                        >
                          <time dateTime={slot.instant} className="block truncate tabular-nums">
                            {slot.time}
                          </time>
                          <span className="block truncate text-(length:--font-size-micro)">
                            {elapsed ? t("Unfilled slot") : t("Open slot")}
                          </span>
                        </div>
                      );
                    }
                    if (!post) return null;
                    const caption = resolveRowCaption(post) || t("Untitled post");
                    const status = normalizePostStatus(post);
                    const time = eventTime.format(new Date(post.date));
                    return (
                      <Tooltip key={post.id}>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            data-slot-state={slot ? "filled" : undefined}
                            onClick={() => onViewDetails(post.id)}
                            aria-label={`${slot ? `${t("Filled slot")} · ` : ""}${caption} · ${time} · ${tStatus(status)}`}
                            className={cn(
                              "absolute top-(--event-top) left-(--event-left) z-10 h-12 w-(--event-width) min-w-0 flex-col items-start justify-start gap-0.5 overflow-hidden rounded-control border border-accent/20 bg-accent-tint px-1.5 py-1 text-left text-xs hover:bg-hover focus-visible:z-30",
                              status === "published" && "border-green/20 bg-green-tint",
                              (status === "failed" || status === "needs_reconciliation") &&
                                "border-red/20 bg-red-tint",
                            )}
                            style={
                              {
                                "--event-top": `min(${(at / 1440) * 100}%, calc(100% - 3rem))`,
                                "--event-left": `calc(${(lane / lanes) * 100}% + var(--spacing) / 2)`,
                                "--event-width": `calc(${100 / lanes}% - var(--spacing))`,
                              } as CSSProperties
                            }
                          >
                            <span className="w-full truncate font-medium">{caption}</span>
                            <time
                              dateTime={post.date}
                              className="w-full truncate text-(length:--font-size-micro)"
                            >
                              {time} · {tStatus(status)}
                            </time>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {caption} · {time} · {tStatus(status)}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
