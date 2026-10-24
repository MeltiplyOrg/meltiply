import { useId, useMemo, useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@meltiply/ui/popover";
import { DayPicker, type ClassNames } from "react-day-picker";
import { enUS, es } from "react-day-picker/locale";
import { CalendarDays, ChevronDown, Globe2 } from "lucide-react";
import { Button, buttonVariants } from "@meltiply/ui/button";
import { toLocalDateKey } from "@/components/posts/posts-helpers";
import { useI18n } from "@/lib/i18n";
import { TimeOfDayField } from "@/components/posts/time-of-day-field";

const CALENDAR_CLASSES: Partial<ClassNames> = {
  root: "min-w-0",
  months: "relative",
  month: "flex flex-col gap-1",
  month_caption: "flex h-8 items-center justify-center px-9 pointer-coarse:h-11",
  caption_label: "text-(length:--font-size-control) font-semibold text-ink",
  nav: "absolute inset-x-0 top-0 flex items-center justify-between",
  button_previous: buttonVariants({ variant: "ghost", size: "icon", className: "size-8" }),
  button_next: buttonVariants({ variant: "ghost", size: "icon", className: "size-8" }),
  chevron: "size-3.5 fill-current",
  month_grid: "w-full table-fixed border-collapse",
  weekday: "h-7 text-center text-(length:--font-size-micro) font-normal text-ink-3",
  day: "p-0 text-center [&[aria-selected=true]>button]:bg-primary [&[aria-selected=true]>button]:text-primary-foreground [&[aria-selected=true]>button]:hover:bg-primary/90",
  day_button: buttonVariants({
    variant: "ghost",
    className: "h-8 w-full p-0 font-normal tabular-nums",
  }),
  today:
    "[&:not([aria-selected=true])>button]:bg-accent-tint [&:not([aria-selected=true])>button]:text-accent-ink",
  outside: "text-ink-3 [&:not([aria-selected=true])>button]:text-ink-3",
  hidden: "invisible",
};

/** Reads a local calendar day without UTC conversion or accepting rolled-over dates. */
function localDay(key: string): Date | undefined {
  const date = new Date(`${key}T12:00:00`);
  return !Number.isNaN(date.getTime()) && toLocalDateKey(date) === key ? date : undefined;
}

/**
 * Compact local scheduling row: a Radix date popover with React DayPicker and a
 * React Aria 24-hour segmented time field with an explicit clock-button chooser.
 * Button/input/select owners provide chrome; libraries own positioning, dismissal,
 * calendar navigation, and time editing. Clicking field padding starts at hours;
 * clicking a segment edits that segment, while the clock opens exact hour/minute
 * selects. Chooser selections commit immediately; Done or Escape closes it.
 * Accepts/emits minute-precision `YYYY-MM-DDTHH:mm`; the composer retains ISO
 * conversion and validation. Date changes preserve time, complete time edits
 * preserve the date (or use today when unset), and browsing never commits.
 * Choosing a date closes the popover and restores its trigger. Hydration updates
 * the visible month without stealing focus. The browser's time zone stays visible.
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
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => selectedDate ?? new Date());
  const [previousDateKey, setPreviousDateKey] = useState(dateKey);
  if (dateKey !== previousDateKey) {
    setPreviousDateKey(dateKey);
    setMonth(selectedDate ?? new Date());
  }
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(value.slice(11, 16))
    ? value.slice(11, 16)
    : "10:00";
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const dates = useMemo(
    () => ({
      full: new Intl.DateTimeFormat(language, { dateStyle: "full" }),
      short: new Intl.DateTimeFormat(language, { dateStyle: "medium" }),
    }),
    [language],
  );

  /** Commits a complete HH:mm value without changing the selected local day. */
  function chooseTime(next: string) {
    onChange(`${selectedDate ? dateKey : toLocalDateKey(new Date())}T${next}`);
  }

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" aria-label={t("Date & time")}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_7rem] items-end gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span
            id={`${id}-date-label`}
            className="text-(length:--font-size-micro) font-medium text-ink-3"
          >
            {t("Date")}
          </span>
          <Popover
            open={open}
            onOpenChange={(next) => {
              if (next) setMonth(selectedDate ?? new Date());
              setOpen(next);
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="w-full min-w-0 justify-start gap-2 font-normal"
                aria-labelledby={`${id}-date-label ${id}-date-value`}
              >
                <CalendarDays className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
                <span id={`${id}-date-value`} className="truncate">
                  {selectedDate ? dates.short.format(selectedDate) : t("Choose date")}
                </span>
                <ChevronDown className="ml-auto size-3 shrink-0 text-ink-3" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              aria-label={t("Date")}
              className="z-50 w-70 max-w-[calc(100vw-2rem)] p-2 pointer-coarse:w-82"
            >
              <DayPicker
                mode="single"
                required
                autoFocus
                selected={selectedDate}
                month={month}
                onMonthChange={setMonth}
                onSelect={(day) => {
                  onChange(`${toLocalDateKey(day)}T${time}`);
                  setOpen(false);
                }}
                locale={language === "es" ? es : enUS}
                weekStartsOn={1}
                showOutsideDays
                classNames={CALENDAR_CLASSES}
                labels={{
                  labelPrevious: () => t("Previous month"),
                  labelNext: () => t("Next month"),
                  labelDayButton: (day) => dates.full.format(day),
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
        <TimeOfDayField value={time} onChange={chooseTime} label={t("Time")} />
      </div>
      <p className="flex min-w-0 items-center gap-1.5 text-(length:--font-size-micro) text-ink-3">
        <Globe2 className="size-3 shrink-0" aria-hidden="true" />
        <span className="break-words">{t("Time zone: {zone}", { zone: timeZone })}</span>
      </p>
    </fieldset>
  );
}
