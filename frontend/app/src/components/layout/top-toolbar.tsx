import { useEffect, useRef, useState, type ReactNode } from "react";
import { ListFilter, RotateCcw, Search, X } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";

export { TopToolbarButton } from "@/components/primitives/top-toolbar-button";

/** Shared Gr8r collection control row; wrapping preserves mobile access without clipping overlays. */
export function TopToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="toolbar"
      className={cn(
        "relative flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-line px-4 py-2 sm:px-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Controlled compact collection search; the same mounted input survives filter and label updates. */
export function TopToolbarSearch({
  value,
  onChange,
  placeholder,
  id,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  id?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("relative w-full shrink-0 sm:w-50", className)}>
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-ink-3" />
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className="h-control-sm border-line pl-7 pr-7 text-xs"
      />
      {value && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-0.5 top-0.5 size-5.5"
          onClick={() => onChange("")}
          aria-label={t("Clear search")}
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}

/**
 * Shared filter disclosure for Posts and Channels, with light dismissal and
 * Escape/focus restoration. Portalled canonical menu/listbox choices remain
 * inside the interaction, so selecting a filter does not close its parent early.
 */
export function TopToolbarFilters({
  activeCount,
  children,
}: {
  activeCount: number;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        ref.current?.contains(target) ||
        target.closest('[role="menu"], [role="listbox"]')
      )
        return;
      if (ref.current) ref.current.open = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return (
    <details
      ref={ref}
      className="relative"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary className="flex h-control-sm cursor-pointer list-none items-center gap-1.5 rounded-control px-2 text-xs text-ink-2 hover:bg-hover open:bg-hover [&::-webkit-details-marker]:hidden">
        <ListFilter className="size-3.5" />
        {t("Filter")}
        {activeCount > 0 && (
          <span className="rounded-chip bg-accent-tint px-1 text-(length:--font-size-micro) text-accent-ink">
            {activeCount}
          </span>
        )}
      </summary>
      <div
        role="group"
        aria-label={t("Filters")}
        className="absolute left-0 top-full z-30 mt-1.5 grid max-h-[65dvh] w-65 max-w-[calc(100vw-32px)] gap-1.5 overflow-y-auto rounded-card border border-line bg-surface p-3 shadow-overlay"
      >
        {children}
      </div>
    </details>
  );
}

/** Active-filter row stays separate from the dense toolbar, matching the reference chip hierarchy. */
export function TopToolbarFilterChips({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-4 py-2 sm:px-6">
      {children}
    </div>
  );
}

/** Named removable chip centralizes keyboard access, clear icon, and compact treatment. */
export function TopToolbarFilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  const { t } = useI18n();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClear}
      aria-label={t("Clear {label} filter", { label })}
    >
      {label}
      <X className="size-3" />
    </Button>
  );
}

/** Renders the shared reset action only while filters are active. */
export function TopToolbarReset({
  hasActiveFilters,
  onReset,
  title,
  className,
}: {
  hasActiveFilters: boolean;
  onReset: () => void;
  title?: string;
  className?: string;
}) {
  const { t } = useI18n();
  return hasActiveFilters ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={onReset}
      title={title ?? t("Reset filters")}
      className={className}
    >
      <RotateCcw className="size-3" />
      {t("Clear all")}
    </Button>
  ) : null;
}
