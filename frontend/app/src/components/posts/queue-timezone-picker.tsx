import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ListBox, ListBoxItem } from "react-aria-components";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { useI18n } from "@/lib/i18n";

const nonAlphanumericPattern = /[^a-z0-9]/g;

const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

function timezoneScore(zone: string, query: string): number | null {
  const text = zone.toLowerCase().replace(nonAlphanumericPattern, "");
  const needle = query.toLowerCase().replace(nonAlphanumericPattern, "");
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

export function QueueTimezonePicker({
  value,
  onChange,
  onOpenChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (zone: string) => void;
  onOpenChange?: (open: boolean) => void;
  disabled: boolean;
  label?: string;
}) {
  const { t } = useI18n();
  const fieldLabel = label ?? t("Queue timezone");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  const zones = useMemo(() => [...new Set([value, ...TIMEZONES])].sort(), [value]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!list || !selected) return;
      list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [search]);
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
  function close() {
    setOpen(false);
    setSearch("");
    triggerRef.current?.focus();
  }
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="text-sm">{fieldLabel}</span>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        disabled={disabled}
        aria-label={`${fieldLabel}: ${value}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="min-w-0 justify-between font-normal"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="truncate">{value}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" />
      </Button>
      {open && (
        <div
          id={panelId}
          data-menu-surface=""
          data-state="open"
          className="w-full max-h-none overflow-visible p-2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            close();
          }}
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
                if (event.key === "Enter") event.preventDefault();
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                listRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
              }}
            />
          </div>
          <ListBox
            ref={listRef}
            aria-label={fieldLabel}
            selectionMode="single"
            selectedKeys={[value]}
            items={matches}
            className="relative h-60 overflow-y-auto overscroll-contain outline-none"
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              const zone = keys.values().next().value;
              if (typeof zone === "string" && zones.includes(zone)) {
                onChange(zone);
                close();
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
        </div>
      )}
    </div>
  );
}
