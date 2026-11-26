import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { SlidingHighlight } from "../primitives/sliding-highlight";
import {
  SEGMENTED_INDICATOR,
  SEGMENTED_ITEM,
  SEGMENTED_SELECTED,
  SEGMENTED_TRACK,
} from "../primitives/segmented-chrome";
import { cn } from "@meltiply/ui/utils";

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
  fill?: boolean;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const selectedIndex = options.indexOf(value);
  const tabStopIndex = selectedIndex === -1 ? 0 : selectedIndex;

  const selectAt = (index: number) => {
    const next = options[index];
    const control = trackRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index];
    if (next === undefined || !control) return;
    onChange(next, control);
    control.focus();
  };

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
