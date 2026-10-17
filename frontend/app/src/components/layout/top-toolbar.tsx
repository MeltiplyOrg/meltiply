import { useEffect, useRef, useState, type ReactNode } from "react";
import { ListFilter, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Button } from "@meltiply/ui/button";
import { Input } from "@meltiply/ui/input";
import { cn } from "@meltiply/ui/utils";
import { useI18n } from "@/lib/i18n";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@meltiply/ui/tooltip";

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

/** A supported equality filter; the route owns its real value, selector, and reset behavior. */
export interface CollectionFilterField {
  id: string;
  label: string;
  active: boolean;
  control: ReactNode;
  onClear: () => void;
}

/**
 * Ports Gr8r's field-row builder, Add filter chips, per-row removal, and Clear all
 * into the existing real equality filters. Added rows do not apply a filter until
 * their value changes. Route state owns the predicate; this component never
 * invents backend operators. Escape restores focus and nested menus stay open.
 */
export function TopToolbarFilters({
  activeCount,
  fields,
  onClearAll,
}: {
  activeCount: number;
  fields: readonly CollectionFilterField[];
  onClearAll: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDetailsElement>(null);
  const pendingFocusField = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [addedFields, setAddedFields] = useState<ReadonlySet<string>>(new Set());
  const visibleFields = fields.filter((field) => field.active || addedFields.has(field.id));
  const availableFields = fields.filter((field) => !field.active && !addedFields.has(field.id));
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
    <TooltipProvider>
      <details
        ref={ref}
        className="group/filter relative"
        onToggle={(event) => setOpen(event.currentTarget.open)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}
      >
        <summary className="flex h-control-sm cursor-pointer list-none items-center gap-1.5 rounded-control px-2 text-xs text-ink-2 hover:bg-hover group-open/filter:bg-hover [&::-webkit-details-marker]:hidden">
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
          data-menu-surface=""
          className="absolute left-0 top-full z-30 mt-1 max-h-none w-140 max-w-[calc(100vw-32px)] overflow-hidden"
        >
          <div className="flex min-h-8 items-center justify-between px-2 py-1">
            <h2 data-menu-label="" className="flex-1">
              {t("Filter by")}
            </h2>
            {visibleFields.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAddedFields(new Set());
                  onClearAll();
                  ref.current?.querySelector("summary")?.focus();
                }}
              >
                {t("Clear all")}
              </Button>
            )}
          </div>
          <div className="max-h-[55dvh] space-y-1.5 overflow-y-auto px-2 pb-1.5 pt-0.5">
            {visibleFields.length === 0 ? (
              <p className="pb-1 text-xs leading-relaxed text-ink-3">
                {t("No filters applied. Add a filter to narrow this collection.")}
              </p>
            ) : (
              visibleFields.map((field, index) => (
                <div
                  key={field.id}
                  ref={(element) => {
                    if (element && pendingFocusField.current === field.id) {
                      element.querySelector<HTMLButtonElement>("button, input, select")?.focus();
                      pendingFocusField.current = null;
                    }
                  }}
                  className="grid grid-cols-[36px_minmax(0,1fr)_26px] items-center gap-1.5 sm:grid-cols-[44px_112px_24px_minmax(0,1fr)_26px]"
                >
                  <span className="text-right text-(length:--font-size-micro) text-ink-3">
                    {index === 0 ? t("Where") : t("and")}
                  </span>
                  <span className="hidden h-control-sm items-center truncate rounded-chip border border-line bg-field px-2 text-xs sm:flex">
                    {field.label}
                  </span>
                  <span className="hidden text-center text-xs text-ink-3 sm:block">{t("is")}</span>
                  <div className="min-w-0">
                    <span className="mb-1 block text-(length:--font-size-micro) text-ink-3 sm:hidden">
                      {field.label}
                    </span>
                    {field.control}
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6.5"
                        aria-label={t("Remove {label} filter", { label: field.label })}
                        onClick={() => {
                          field.onClear();
                          setAddedFields((previous) => {
                            const next = new Set(previous);
                            next.delete(field.id);
                            return next;
                          });
                          ref.current?.querySelector("summary")?.focus();
                        }}
                      >
                        <Trash2 className="size-3.25" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("Remove filter")}</TooltipContent>
                  </Tooltip>
                </div>
              ))
            )}
          </div>
          {availableFields.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 border-t border-line px-2 pb-1.5 pt-2">
              <span className="mr-1 text-(length:--font-size-micro) text-ink-3">
                {t("Add filter:")}
              </span>
              {availableFields.map((field) => (
                <Button
                  key={field.id}
                  variant="outline"
                  size="sm"
                  className="h-5 rounded-chip px-1.5 text-(length:--font-size-micro) font-normal shadow-none"
                  aria-label={t("Add {label} filter", { label: field.label })}
                  onClick={() => {
                    pendingFocusField.current = field.id;
                    setAddedFields((previous) => new Set(previous).add(field.id));
                  }}
                >
                  {field.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </details>
    </TooltipProvider>
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
