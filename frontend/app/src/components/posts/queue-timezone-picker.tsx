import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ListBox, ListBoxItem } from "react-aria-components";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { useI18n } from "@/lib/i18n";

const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

/** Ranks normalized IANA names by exact substring, then ordered character gaps. Spaces, slashes and underscores are interchangeable; missing letters are allowed (e.g. "ktm" finds Asia/Katmandu). Returns null for nonmatches, keeping the finite timezone catalog bounded. */
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

/**
 * Searchable IANA timezone selector for Queue configuration. The panel renders
 * inline rather than in a portal: a portalled list inside a modal dialog has its
 * wheel events cancelled by the dialog's scroll lock, so it could not scroll.
 * Composes the shared menu surface, Input, Button and React Aria's keyboard
 * listbox; the finite browser catalog includes UTC plus any saved alias so
 * editing never silently renames a valid timezone. Search never commits;
 * choosing an identifier closes the panel and restores the trigger.
 */
export function QueueTimezonePicker({
  value,
  onChange,
  onOpenChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (zone: string) => void;
  /** Lets the owning dialog keep Escape scoped to the panel while it is open. */
  onOpenChange?: (open: boolean) => void;
  disabled: boolean;
  /** Field label; defaults to the Queue configuration label. */
  label?: string;
}) {
  const { t } = useI18n();
  const fieldLabel = label ?? t("Queue timezone");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  // The owning dialog needs the panel's layer state so Escape closes one layer
  // at a time; report unmount as closed so the dialog never stays locked open.
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  const zones = useMemo(() => [...new Set([value, ...TIMEZONES])].sort(), [value]);
  // Opening lands on the saved zone instead of the top of a 400-row catalog;
  // typing a new query restarts from the best match.
  useEffect(() => {
    if (!open) return;
    // Layout is not final in the commit that mounts the panel, so reveal the
    // saved zone on the next frame instead of measuring a zero-height list.
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!list || !selected) return;
      // The list is the offset parent, so this is scroll-independent.
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
  /** Closes the panel, clears the query, and returns focus to the trigger that owns it. */
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
                // Typing a query must never submit the Queue form; Enter selects
                // only once focus is on an option inside the listbox.
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
