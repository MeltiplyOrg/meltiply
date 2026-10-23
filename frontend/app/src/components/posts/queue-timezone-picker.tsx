import { useMemo, useRef, useState } from "react";
import { ListBox, ListBoxItem } from "react-aria-components";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@meltiply/ui/popover";
import { useI18n } from "@/lib/i18n";

const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

/** Ranks normalized IANA names by exact substring, then ordered character gaps. Spaces, slashes and underscores are interchangeable; missing letters are allowed (e.g. "hcm" finds Ho Chi Minh). Returns null for nonmatches, keeping the finite timezone catalog bounded. */
function timezoneScore(zone: string, query: string): number | null {
  const text = zone.toLowerCase().replace(/[^a-z0-9]/g, "");
  const needle = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!needle) return 0;
  const exact = text.indexOf(needle);
  if (exact >= 0) return exact;
  let cursor = 0;
  let gaps = 0;
  for (const character of needle) {
    const next = text.indexOf(character, cursor);
    if (next < 0) return null;
    gaps += next - cursor;
    cursor = next + 1;
  }
  return 100 + gaps;
}

/** Queue-specific searchable IANA selector, composing the canonical Popover/Input/Button with React Aria's keyboard listbox. The finite browser catalog includes UTC and the saved alias so editing never silently renames a valid timezone. Selection commits one identifier and restores the trigger; search does not modify configuration. */
export function QueueTimezonePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (zone: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const zones = useMemo(() => [...new Set([value, ...TIMEZONES])].sort(), [value]);
  const matches = useMemo(
    () =>
      zones
        .flatMap((zone) => {
          const score = timezoneScore(zone, search);
          return score === null ? [] : [{ id: zone, score }];
        })
        .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)),
    [zones, search],
  );
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="text-sm">{t("Queue timezone")}</span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            disabled={disabled}
            aria-label={`${t("Queue timezone")}: ${value}`}
            className="min-w-0 justify-between font-normal"
          >
            <span className="truncate">{value}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)] p-2"
          aria-label={t("Queue timezone")}
        >
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
            <Input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={t("Search timezones…")}
              placeholder={t("Search timezones…")}
              className="pl-8"
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  listRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
                }
              }}
            />
          </div>
          <ListBox
            ref={listRef}
            aria-label={t("Queue timezone")}
            selectionMode="single"
            selectedKeys={[value]}
            items={matches}
            className="max-h-60 overflow-y-auto outline-none"
            data-lenis-prevent=""
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              const zone = keys.values().next().value;
              if (typeof zone === "string" && zones.includes(zone)) {
                onChange(zone);
                setOpen(false);
                setSearch("");
              }
            }}
            renderEmptyState={() => (
              <p className="px-2 py-4 text-sm text-ink-3">{t("No timezones found.")}</p>
            )}
          >
            {(zone) => (
              <ListBoxItem
                id={zone.id}
                textValue={zone.id}
                className="flex min-h-8 cursor-default items-center justify-between gap-2 rounded-control px-2 text-(length:--font-size-control) outline-none data-[focused]:bg-hover pointer-coarse:min-h-11"
              >
                <span>{zone.id.replaceAll("_", " ")}</span>
                {zone.id === value && <Check className="size-3.5 shrink-0 text-accent" />}
              </ListBoxItem>
            )}
          </ListBox>
        </PopoverContent>
      </Popover>
    </div>
  );
}
