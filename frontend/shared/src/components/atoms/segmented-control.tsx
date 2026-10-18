import { useRef, type ReactNode } from "react";
import { Button } from "../ui/button";
import { SlidingHighlight } from "../primitives/sliding-highlight";
import { cn } from "@meltiply/ui/utils";

/**
 * Gr8r's compact value selector, shared by collection views and preferences.
 * Each option stays a native named button; selection changes synchronously while
 * the selected pill is one shared `SlidingHighlight` behind the row, so a click
 * slides the fill between segments instead of blinking it from one button to the
 * renderOption supplies localized labels/icons without duplicating the
 * track or selected treatment.
 *
 * The track is the highlight's container, so it stays `relative`, and the
 * buttons stay above the pill (`relative z-10`) with their own label color and
 * hover — the pill owns the selected fill.
 *
 * By default the track hugs its options, so a caller that sets a width wider
 * than the labels leaves an unselected tail that `fill` shares out instead:
 * every option then takes an equal share of the track and centers its label.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  renderOption,
  fill = false,
  className,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T, control: HTMLButtonElement) => void;
  label: string;
  renderOption?: (value: T) => ReactNode;
  /**
   * Shares the track's width equally between the options (each centered), so a
   * full-width control has no unselected tail. Labels keep their size and are
   * never truncated; leave off when the track should hug its options.
   */
  fill?: boolean;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={trackRef}
      role="group"
      aria-label={label}
      className={cn(
        "relative inline-flex shrink-0 items-center gap-0.5 rounded-control bg-hover-2 p-0.5",
        className,
      )}
    >
      <SlidingHighlight
        containerRef={trackRef}
        itemSelector="[aria-pressed]"
        activeSelector='[aria-pressed="true"]'
        axis="x"
        className="inset-y-0.5 border-transparent bg-surface shadow-btn"
      />
      {options.map((option) => (
        <Button
          key={option}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={value === option}
          onClick={(event) => onChange(option, event.currentTarget)}
          className={cn(
            "relative z-10 h-6 gap-1 px-2.5 text-xs font-medium",
            fill && "min-w-0 flex-1 justify-center",
            value === option && "text-ink hover:bg-transparent",
          )}
        >
          {renderOption ? renderOption(option) : option}
        </Button>
      ))}
    </div>
  );
}
