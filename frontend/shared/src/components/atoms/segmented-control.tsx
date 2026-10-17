import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { cn } from "@meltiply/ui/utils";

/**
 * Gr8r's compact value selector, shared by collection views and preferences.
 * Each option stays a native named button; selection changes synchronously,
 * without a measured indicator or inline positioning. renderOption supplies
 * localized labels/icons without duplicating the track or selected treatment.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  renderOption,
  className,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T, control: HTMLButtonElement) => void;
  label: string;
  renderOption?: (value: T) => ReactNode;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-control bg-hover-2 p-0.5",
        className,
      )}
    >
      {options.map((option) => (
        <Button
          key={option}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={value === option}
          onClick={(event) => onChange(option, event.currentTarget)}
          className={cn(
            "h-6 gap-1 px-2.5 text-xs font-medium",
            value === option && "bg-surface text-ink shadow-btn hover:bg-surface",
          )}
        >
          {renderOption ? renderOption(option) : option}
        </Button>
      ))}
    </div>
  );
}
