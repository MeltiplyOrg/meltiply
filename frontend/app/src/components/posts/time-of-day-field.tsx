import { useId, useMemo, useState } from "react";
import { parseTime } from "@internationalized/date";
import { DateInput, DateSegment, I18nProvider, Label, TimeField } from "react-aria-components";
import { Clock } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { inputVariants } from "@meltiply/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@meltiply/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@meltiply/ui/select";
import { useI18n } from "@/lib/i18n";

const HOURS = Array.from({ length: 24 }, (_, value) => String(value).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, value) => String(value).padStart(2, "0"));

/** Canonical app wall-time editor shared by scheduling and recurring slots. Accepts/emits complete 24-hour HH:mm strings without date/timezone conversion. React Aria owns keyboard segments; shared Input, Popover and Select owners provide one styled hour/minute chooser. Disabled controls cannot open the chooser or emit edits; Done/Escape restore the clock trigger. */
export function TimeOfDayField({
  value: time,
  onChange,
  label,
  disabled = false,
  required = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [timeOpen, setTimeOpen] = useState(false);
  const timeValue = useMemo(() => parseTime(time), [time]);
  return (
    <I18nProvider locale={language}>
      <TimeField
        value={timeValue}
        hourCycle={24}
        granularity="minute"
        shouldForceLeadingZeros
        isDisabled={disabled}
        isRequired={required}
        className="flex min-w-0 flex-col gap-1.5"
        onChange={(next) => {
          if (next) onChange(next.toString().slice(0, 5));
        }}
      >
        <Label className="text-(length:--font-size-micro) font-medium text-ink-3">{label}</Label>
        <div className="relative">
          <DateInput
            className={inputVariants({
              className:
                "cursor-text items-center pr-8 tabular-nums focus-within:ring-2 focus-within:ring-ring pointer-coarse:pr-11",
            })}
            onClick={(event) => {
              if (event.target instanceof Element && !event.target.closest('[role="spinbutton"]')) {
                event.preventDefault();
                event.currentTarget.querySelector<HTMLElement>('[data-type="hour"]')?.focus();
              }
            }}
          >
            {(segment) => (
              <DateSegment
                segment={segment}
                className="rounded-sm px-0.5 text-ink outline-none caret-accent data-[type=literal]:px-0 data-[placeholder]:text-ink-3 focus:bg-primary focus:text-primary-foreground"
              />
            )}
          </DateInput>
          <Popover open={timeOpen} onOpenChange={setTimeOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label={t("Choose time")}
                className="absolute right-0.5 top-1/2 size-6 -translate-y-1/2 pointer-coarse:right-0"
              >
                <Clock className="size-3.5 text-ink-3" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              aria-label={t("Choose time")}
              className="z-50 w-56 max-w-[calc(100vw-2rem)] p-3"
            >
              <p className="mb-3 text-(length:--font-size-ui) font-medium text-ink">
                {t("Time (24-hour)")}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label
                    htmlFor={`${id}-hour`}
                    className="text-(length:--font-size-micro) text-ink-3"
                  >
                    {t("Hour")}
                  </label>
                  <Select
                    disabled={disabled}
                    value={time.slice(0, 2)}
                    onValueChange={(hour) => onChange(`${hour}:${time.slice(3, 5)}`)}
                  >
                    <SelectTrigger
                      id={`${id}-hour`}
                      aria-label={t("Hour")}
                      className="tabular-nums"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {HOURS.map((hour) => (
                        <SelectItem key={hour} value={hour}>
                          {hour}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label
                    htmlFor={`${id}-minute`}
                    className="text-(length:--font-size-micro) text-ink-3"
                  >
                    {t("Minute")}
                  </label>
                  <Select
                    disabled={disabled}
                    value={time.slice(3, 5)}
                    onValueChange={(minute) => onChange(`${time.slice(0, 2)}:${minute}`)}
                  >
                    <SelectTrigger
                      id={`${id}-minute`}
                      aria-label={t("Minute")}
                      className="tabular-nums"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {MINUTES.map((minute) => (
                        <SelectItem key={minute} value={minute}>
                          {minute}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="mt-3 w-full"
                onClick={() => setTimeOpen(false)}
              >
                {t("Done")}
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </TimeField>
    </I18nProvider>
  );
}
