import { useEffect, useMemo, useState } from "react";
import { CalendarDate, fromDate, toCalendarDate } from "@internationalized/date";
import { flushSync } from "react-dom";
import { transitionViewEffect } from "@meltiply/ui/effects";
import { Link } from "react-router";
import { Clock, Globe2 } from "lucide-react";
import { Alert } from "@meltiply/ui/alert";
import { Button } from "@meltiply/ui/button";
import {
  CenterDialog,
  CenterDialogContent,
  CenterDialogHeader,
  CenterDialogTitle,
  CenterDialogDescription,
  CenterDialogFooter,
} from "@meltiply/ui/center-dialog";
import { useWorkspace } from "@/context/workspace.context";
import { useSessionScope } from "@/hooks/use-session-scope";
import { useQueueCalendarPosts } from "@/lib/queries";
import { useI18n } from "@/lib/i18n";
import { userFacingErrorMessage } from "@/lib/frontend-errors";
import type { Post, PublishingQueue } from "@/types";
import { PostCalendarGridView } from "./post-calendar-grid-view";
import { calendarLabelDate, calendarWindow, type CalendarPeriod } from "./calendar-dates";
import { toPostRow } from "./post-row";
import { calendarSlots } from "./calendar-slots";

/** Live Queue calendar: bounded, fully paged immutable assignments in the Queue's timezone, independent Channel outcomes and safe removal. A Queue identity key resets its civil anchor and selection. The 30-second clock also refreshes immediately after tab focus/visibility changes, never changing reservation times. */
export function QueueCalendar({
  queue,
  onRemove,
}: {
  queue: PublishingQueue;
  onRemove: (post: Post) => void;
}) {
  const { t, tStatus, language } = useI18n();
  const { integrations, canWriteContent } = useWorkspace();
  const scope = useSessionScope();
  const [now, setNow] = useState(() => new Date());
  const [anchor, setAnchor] = useState(() => toCalendarDate(fromDate(new Date(), queue.timezone)));
  const [period, setPeriod] = useState<CalendarPeriod>("week");
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => setNow(new Date());
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const range = useMemo(
    () => calendarWindow(anchor, period, queue.timezone),
    [anchor, period, queue.timezone],
  );
  const query = useQueueCalendarPosts(scope, {
    queue_id: queue.id,
    brand_profile_id: queue.brand_profile_id,
    queue_assigned_from: range.start,
    queue_assigned_before: range.end,
  });
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);
  const posts = useMemo(
    () =>
      (query.data?.pages.flatMap((page) => page.posts) ?? []).sort((a, b) =>
        (a.queue_membership?.assigned_at ?? "").localeCompare(
          b.queue_membership?.assigned_at ?? "",
        ),
      ),
    [query.data],
  );
  const rows = useMemo(() => {
    const byId = new Map(integrations.map((integration) => [integration.id, integration]));
    return posts.flatMap((post) =>
      post.queue_membership
        ? [{ ...toPostRow(post, byId), date: post.queue_membership.assigned_at }]
        : [],
    );
  }, [posts, integrations]);
  const slots = useMemo(() => calendarSlots(queue, range.days, rows), [queue, range.days, rows]);
  const loading = query.isPending || (hasNextPage && !isFetchNextPageError);
  const next = loading
    ? undefined
    : posts.find(
        (post) =>
          post.queue_membership &&
          new Date(post.queue_membership.assigned_at) > now &&
          post.distributions.some((outcome) =>
            ["scheduled", "queued", "processing", "awaiting_provider"].includes(outcome.status),
          ),
      );
  const inspected = posts.find((post) => post.id === inspectedId);
  const dateLabel = new Intl.DateTimeFormat(language, {
    timeZone: queue.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  /** Changes the civil anchor without adding fixed milliseconds across DST; month arithmetic clamps to the destination month. */
  function navigate(offset: number, unit: "days" | "months") {
    setAnchor((day) => day.add({ [unit]: offset }));
  }
  /** Month-date activation opens the containing Week without scheduling or moving work. */
  function inspectWeek(date: Date) {
    transitionViewEffect(() =>
      flushSync(() => {
        setAnchor(new CalendarDate(date.getFullYear(), date.getMonth() + 1, date.getDate()));
        setPeriod("week");
      }),
    );
  }
  return (
    <section
      aria-label={t("Queue Posts")}
      className="flex min-h-120 min-w-0 flex-1 flex-col lg:min-h-0"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 sm:px-6">
        <h2 className="hidden min-w-0 break-words text-sm font-semibold lg:block">{queue.name}</h2>
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
          <Globe2 className="size-3.5" />
          {queue.timezone}
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-ink-2">
          <Clock className="size-3.5 text-red" />
          <time dateTime={now.toISOString()}>
            {new Intl.DateTimeFormat(language, {
              timeZone: queue.timezone,
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            }).format(now)}
          </time>
        </span>
        <div className="min-w-0 basis-full text-xs text-ink-3" role="status">
          {loading ? (
            t("Loading Posts…")
          ) : next ? (
            <Button
              variant="ghost"
              className="h-auto min-w-0 max-w-full justify-start gap-1 px-0 py-0 text-left text-xs font-normal"
              onClick={() => setInspectedId(next.id)}
            >
              <span className="shrink-0 text-ink-3">{t("Next in this view")} ·</span>
              <span className="truncate">{next.title || next.default_text || t("Media Post")}</span>
              <time className="shrink-0 tabular-nums" dateTime={next.queue_membership!.assigned_at}>
                · {dateLabel.format(new Date(next.queue_membership!.assigned_at))}
              </time>
            </Button>
          ) : (
            t("No upcoming Posts in this view.")
          )}
        </div>
      </div>
      {query.error && (
        <Alert variant="destructive" className="shrink-0 rounded-none">
          {userFacingErrorMessage(query.error, language)}{" "}
          <Button
            variant="ghost"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t("Refresh")}
          </Button>
        </Alert>
      )}
      <PostCalendarGridView
        posts={query.error ? [] : rows}
        isLoading={loading || Boolean(query.error)}
        calendarMonth={calendarLabelDate(anchor)}
        calendarDays={range.days}
        onPrevMonth={() => navigate(-1, "months")}
        onNextMonth={() => navigate(1, "months")}
        onToday={() => setAnchor(toCalendarDate(fromDate(new Date(), queue.timezone)))}
        onWeekNavigate={(offset) => navigate(offset * 7, "days")}
        onCellClick={inspectWeek}
        onScheduleDate={inspectWeek}
        onViewDetails={setInspectedId}
        canSchedule={false}
        timeline={{
          mode: period,
          onModeChange: setPeriod,
          timeZone: queue.timezone,
          now,
          slots,
        }}
      />
      <CenterDialog
        open={inspected !== undefined}
        onOpenChange={(open) => {
          if (!open) setInspectedId(null);
        }}
      >
        <CenterDialogContent>
          <CenterDialogHeader>
            <CenterDialogTitle>{t("Queue Post")}</CenterDialogTitle>
            <CenterDialogDescription>
              {queue.name} · {queue.timezone}
            </CenterDialogDescription>
          </CenterDialogHeader>
          {inspected && (
            <>
              <p className="whitespace-pre-wrap break-words text-sm">
                {inspected.title || inspected.default_text || t("Media Post")}
              </p>
              <time
                className="text-sm tabular-nums"
                dateTime={inspected.queue_membership!.assigned_at}
              >
                {dateLabel.format(new Date(inspected.queue_membership!.assigned_at))}
              </time>
              <ul className="space-y-1 text-xs text-ink-2">
                {inspected.distributions.map((outcome) => (
                  <li key={outcome.id}>
                    {outcome.platform}: {tStatus(outcome.status)}
                  </li>
                ))}
              </ul>
              <CenterDialogFooter>
                <Button asChild variant="outline">
                  <Link to={`/posts?editPostId=${inspected.id}`}>{t("Open Post")}</Link>
                </Button>
                {canWriteContent &&
                  inspected.distributions.every((outcome) =>
                    ["scheduled", "queued", "cancelled"].includes(outcome.status),
                  ) && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setInspectedId(null);
                        onRemove(inspected);
                      }}
                    >
                      {t("Remove from Queue")}
                    </Button>
                  )}
              </CenterDialogFooter>
            </>
          )}
        </CenterDialogContent>
      </CenterDialog>
    </section>
  );
}
