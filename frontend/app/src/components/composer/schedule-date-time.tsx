import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock, Globe2 } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { cn } from "@meltiply/ui/utils";
import { toLocalDateKey } from "@/components/posts/posts-helpers";
import { useI18n } from "@/lib/i18n";

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, "0"));

/** Reads a local calendar day without UTC conversion or accepting rolled-over dates. */
function localDay(key: string): Date | null {
  const date = new Date(`${key}T12:00:00`);
  return !Number.isNaN(date.getTime()) && toLocalDateKey(date) === key ? date : null;
}

/** Moves by calendar months, clamping month-end days rather than spilling into the next month. */
function shiftMonth(date: Date, offset: number): Date {
  const month = new Date(date.getFullYear(), date.getMonth() + offset, 1, 12);
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  month.setDate(Math.min(date.getDate(), lastDay));
  return month;
}

/**
 * Composer-owned date/time selection, composed from canonical Buttons and Selects.
 * Accepts and emits minute-precision local `YYYY-MM-DDTHH:mm` values; ISO/time-zone
 * conversion and submission validation stay with the composer. Missing dates show
 * a placeholder, and an explicit time edit then uses today. Date changes preserve
 * the chosen time, time changes preserve the date, and browsing never changes either.
 * The Monday-first calendar supports arrows, Home/End, Page Up/Down (Shift for years),
 * Enter/Space selection, and Escape dismissal with focus returned to the date button.
 */
export function ScheduleDateTime({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const dateKey = value.slice(0, 10);
  const selectedDate = useMemo(() => localDay(dateKey), [dateKey]);
  const today = new Date();
  const todayKey = toLocalDateKey(today);
  const [open, setOpen] = useState(false);
  const [focusedKey, setFocusedKey] = useState(() => (selectedDate ? dateKey : todayKey));
  const [month, setMonth] = useState(() => {
    const date = selectedDate ?? today;
    return new Date(date.getFullYear(), date.getMonth(), 1, 12);
  });
  const [previousDateKey, setPreviousDateKey] = useState(dateKey);
  if (dateKey !== previousDateKey) {
    setPreviousDateKey(dateKey);
    const date = selectedDate ?? today;
    setFocusedKey(toLocalDateKey(date));
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1, 12));
  }
  const dateButtonRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLFieldSetElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const labels = useMemo(
    () => ({
      date: new Intl.DateTimeFormat(language, { dateStyle: "medium" }),
      fullDate: new Intl.DateTimeFormat(language, { dateStyle: "full" }),
      month: new Intl.DateTimeFormat(language, { month: "long", year: "numeric" }),
      weekday: new Intl.DateTimeFormat(language, { weekday: "narrow" }),
      fullWeekday: new Intl.DateTimeFormat(language, { weekday: "long" }),
    }),
    [language],
  );
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const weeks = useMemo(() => {
    const offset = (month.getDay() + 6) % 7;
    return Array.from({ length: 6 }, (_, week) =>
      Array.from(
        { length: 7 },
        (_, day) =>
          new Date(month.getFullYear(), month.getMonth(), week * 7 + day - offset + 1, 12),
      ),
    );
  }, [month]);
  const hour = HOURS.includes(value.slice(11, 13)) ? value.slice(11, 13) : "10";
  const minute = MINUTES.includes(value.slice(14, 16)) ? value.slice(14, 16) : "00";

  // Focus only after an explicit calendar action, never on a server/recovery update.
  useLayoutEffect(() => {
    if (!open || pendingFocus.current === null) return;
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-schedule-day="${pendingFocus.current}"]`)
      ?.focus();
    pendingFocus.current = null;
  }, [open, focusedKey, month]);

  // Radix listens for drawer Escape on document capture, before React handlers.
  // Capture at window while this calendar is open, scoped to its actual DOM so
  // portalled Select menus keep their own dismissal and focus restoration.
  useEffect(() => {
    if (!open) return;
    const dismissCalendar = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        !(event.target instanceof Node) ||
        !pickerRef.current?.contains(event.target)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      dateButtonRef.current?.focus();
    };
    window.addEventListener("keydown", dismissCalendar, true);
    return () => window.removeEventListener("keydown", dismissCalendar, true);
  }, [open]);

  /** Commits a local day while preserving time, closes the calendar, and restores its trigger. */
  function chooseDate(date: Date) {
    onChange(`${toLocalDateKey(date)}T${hour}:${minute}`);
    setOpen(false);
    dateButtonRef.current?.focus();
  }

  /** Inspects another month/day without committing a schedule; keyboard moves also transfer focus. */
  function browseDate(date: Date, focus: boolean) {
    const key = toLocalDateKey(date);
    if (focus) pendingFocus.current = key;
    setFocusedKey(key);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1, 12));
  }

  /** Handles calendar navigation only; native day buttons retain Enter/Space activation. */
  function handleCalendarKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const date = localDay(event.target.dataset.scheduleDay ?? "");
    if (!date) return;
    const weekday = (date.getDay() + 6) % 7;
    switch (event.key) {
      case "ArrowLeft":
        date.setDate(date.getDate() - 1);
        break;
      case "ArrowRight":
        date.setDate(date.getDate() + 1);
        break;
      case "ArrowUp":
        date.setDate(date.getDate() - 7);
        break;
      case "ArrowDown":
        date.setDate(date.getDate() + 7);
        break;
      case "Home":
        date.setDate(date.getDate() - weekday);
        break;
      case "End":
        date.setDate(date.getDate() + 6 - weekday);
        break;
      case "PageUp":
      case "PageDown": {
        const offset = (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1);
        event.preventDefault();
        browseDate(shiftMonth(date, offset), true);
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    browseDate(date, true);
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-3" aria-label={t("Date & time")} ref={pickerRef}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span
            id={`${id}-date-label`}
            className="text-(length:--font-size-micro) font-medium text-ink-3"
          >
            {t("Date")}
          </span>
          <Button
            ref={dateButtonRef}
            type="button"
            variant="outline"
            className="h-9 w-full min-w-0 justify-start gap-2 font-normal"
            aria-labelledby={`${id}-date-label ${id}-date-value`}
            aria-expanded={open}
            aria-controls={`${id}-calendar`}
            onClick={() => {
              if (!open) pendingFocus.current = focusedKey;
              setOpen(!open);
            }}
          >
            <CalendarDays className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
            <span id={`${id}-date-value`} className="truncate">
              {selectedDate ? labels.date.format(selectedDate) : t("Choose date")}
            </span>
            <ChevronDown
              className={cn(
                "ml-auto size-3.5 shrink-0 text-ink-3 transition-transform",
                open && "rotate-180",
              )}
              aria-hidden="true"
            />
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-(length:--font-size-micro) font-medium text-ink-3">
            <Clock className="size-3" aria-hidden="true" />
            {t("Time (24-hour)")}
          </span>
          <div className="flex items-center gap-1.5">
            <Select
              value={hour}
              onValueChange={(next) =>
                onChange(`${selectedDate ? dateKey : todayKey}T${next}:${minute}`)
              }
            >
              <SelectTrigger aria-label={t("Hour")} className="h-9 w-16 tabular-nums">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {HOURS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-ink-3" aria-hidden="true">
              :
            </span>
            <Select
              value={minute}
              onValueChange={(next) =>
                onChange(`${selectedDate ? dateKey : todayKey}T${hour}:${next}`)
              }
            >
              <SelectTrigger aria-label={t("Minute")} className="h-9 w-16 tabular-nums">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {MINUTES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {open && (
        <div id={`${id}-calendar`} className="rounded-control border border-line bg-surface p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p
              id={`${id}-month`}
              aria-live="polite"
              className="text-(length:--font-size-ui) font-semibold text-ink"
            >
              {labels.month.format(month)}
            </p>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => chooseDate(today)}>
                {t("Today")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("Previous month")}
                onClick={() => browseDate(shiftMonth(localDay(focusedKey) ?? month, -1), false)}
              >
                <ChevronLeft className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("Next month")}
                onClick={() => browseDate(shiftMonth(localDay(focusedKey) ?? month, 1), false)}
              >
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div
            ref={gridRef}
            role="grid"
            aria-labelledby={`${id}-month`}
            onKeyDown={handleCalendarKey}
          >
            <div role="row" className="mb-1 grid grid-cols-7 gap-1">
              {weeks[0]!.map((day) => (
                <span
                  key={day.getDay()}
                  role="columnheader"
                  aria-label={labels.fullWeekday.format(day)}
                  className="py-1 text-center text-(length:--font-size-micro) font-medium text-ink-3"
                >
                  {labels.weekday.format(day)}
                </span>
              ))}
            </div>
            {weeks.map((week) => (
              <div key={toLocalDateKey(week[0]!)} role="row" className="grid grid-cols-7 gap-1">
                {week.map((day) => {
                  const key = toLocalDateKey(day);
                  const selected = key === dateKey;
                  const currentMonth = day.getMonth() === month.getMonth();
                  return (
                    <div key={key} role="gridcell" aria-selected={selected}>
                      <Button
                        type="button"
                        variant={selected ? "default" : "ghost"}
                        className={cn(
                          "h-9 w-full p-0 font-normal tabular-nums",
                          !selected && !currentMonth && "text-ink-3",
                          !selected && key === todayKey && "bg-accent-tint text-accent-ink",
                        )}
                        tabIndex={key === focusedKey ? 0 : -1}
                        data-schedule-day={key}
                        aria-label={labels.fullDate.format(day)}
                        aria-current={key === todayKey ? "date" : undefined}
                        onClick={() => chooseDate(day)}
                      >
                        {day.getDate()}
                      </Button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="flex items-center gap-1.5 text-(length:--font-size-micro) text-ink-3">
        <Globe2 className="size-3 shrink-0" aria-hidden="true" />
        {t("Time zone: {zone}", { zone: timeZone })}
      </p>
    </fieldset>
  );
}
