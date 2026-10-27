import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { SlidingHighlight } from "../primitives/sliding-highlight";
import {
  SEGMENTED_INDICATOR,
  SEGMENTED_ITEM,
  SEGMENTED_SELECTED,
  SEGMENTED_TRACK,
} from "../primitives/segmented-chrome";
import { cn } from "@meltiply/ui/utils";

/**
 * Gr8r's compact single-select control, shared by collection views and
 * preferences. It is a native radiogroup: exactly one option is checked, the
 * checked option is the roving tab stop, and Arrow/Home/End both select and move
 * focus, so keyboard use matches a radio group rather than a row of buttons.
 * Selection changes synchronously while the checked pill is one shared
 * `SlidingHighlight` behind the row, so a change slides the fill between segments
 * instead of blinking it from one item to the next. `renderOption` supplies
 * localized labels/icons without duplicating the track or selected treatment.
 *
 * The track is the highlight's container, so it stays `relative`, and the items
 * stay above the pill (`relative z-10`) with their own label color and hover —
 * the pill owns the selected fill.
 *
 * By default the track hugs its options and starts them at the leading edge, so
 * a caller that constrains it (`max-w-full overflow-x-auto` on a phone) scrolls
 * from the first option instead of clipping it into unreachable negative
 * overflow. A caller that sets a width wider than the labels leaves an
 * unselected tail that `fill` shares out instead: every option then takes an
 * equal share of the track and centers its label. Coarse pointers grow every
 * option to the shared 44px minimum and the track grows with them; fine
 * pointers keep the 24px item inside the 28px track.
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
  const selectedIndex = options.indexOf(value);
  const tabStopIndex = selectedIndex === -1 ? 0 : selectedIndex;

  /** Selects the option at `index` through the public callback, then moves focus to its item. */
  const selectAt = (index: number) => {
    const next = options[index];
    const control = trackRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index];
    if (next === undefined || !control) return;
    onChange(next, control);
    control.focus();
  };

  /**
   * Wrapping radio-group keys. Bare Arrow/Home/End keys select and move focus;
   * modified shortcuts (Alt/Ctrl/Meta) are left to the browser and owner, so a
   * browser back/forward or word-navigation gesture keeps its meaning. The event
   * is delegated from the track so items need no handlers of their own; pointer
   * clicks keep native button focus.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (options.length === 0) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const currentIndex = options.indexOf(value);
    const fromIndex = currentIndex === -1 ? tabStopIndex : currentIndex;
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (fromIndex + 1) % options.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (fromIndex - 1 + options.length) % options.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectAt(nextIndex);
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
      className={cn(SEGMENTED_TRACK, className)}
    >
      <SlidingHighlight
        containerRef={trackRef}
        itemSelector='[role="radio"]'
        activeSelector='[role="radio"][aria-checked="true"]'
        axis="x"
        className={SEGMENTED_INDICATOR}
      />
      {options.map((option, index) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStopIndex ? 0 : -1}
            onClick={(event) => onChange(option, event.currentTarget)}
            className={cn(
              SEGMENTED_ITEM,
              fill && "min-w-0 flex-1 justify-center",
              selected && SEGMENTED_SELECTED,
            )}
          >
            {renderOption ? renderOption(option) : option}
          </button>
        );
      })}
    </div>
  );
}
