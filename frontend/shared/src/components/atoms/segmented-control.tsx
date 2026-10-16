import { Button } from "../ui/button";
import { cn } from "@meltiply/ui/utils";

/**
 * Horizontal multi-segment settings selector with an animated active indicator.
 *
 * Segments are canonical ghost `Button`s inside a `role="group"` track labelled by
 * `label`; the selected segment carries `aria-pressed` instead of tab semantics —
 * the control picks a value (latency, language, theme) rather than switching
 * panels, so every option remains a normal Tab-stop button. An absolute
 * background indicator pill slides smoothly across segments using CSS transforms
 * with cubic-bezier easing based on the active selection index.
 *
 * @template T - String literal union representing selectable segment values
 * @param props.options - Ordered array of distinct selectable option strings
 * @param props.value - Currently selected option value
 * @param props.onChange - Receives the selected value and activated button, allowing anchored effects without retaining events.
 * @param props.label - Accessible name for the segment group (mirrors the row's visible label, e.g. "Network latency").
 * @param props.className - Optional classes to merge into the outer track container
 *
 * @example
 * <SegmentedControl
 *   options={['day', 'week', 'month'] as const}
 *   value={interval}
 *   onChange={setInterval}
 *   label="Time range"
 * />
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T, control: HTMLButtonElement) => void;
  label: string;
  className?: string;
}) {
  const index = options.indexOf(value);
  return (
    <div
      className={cn(
        "relative inline-grid h-8 select-none rounded-full bg-line/60 p-0.5 shadow-inset-field",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
      role="group"
      aria-label={label}
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 rounded-full bg-surface shadow-hairline transition-transform duration-200"
        style={{
          width: `calc((100% - 4px) / ${options.length})`,
          left: 2,
          transform: `translateX(${index * 100}%)`,
          transitionTimingFunction: "var(--ease-pop)",
        }}
      />
      {options.map((opt) => (
        <Button
          key={opt}
          type="button"
          variant="ghost"
          aria-pressed={opt === value}
          onClick={(event) => onChange(opt, event.currentTarget)}
          className={cn(
            "relative z-10 h-auto rounded-full px-3 py-0 text-[13px] font-medium transition-colors duration-150 capitalize hover:bg-transparent",
            opt === value ? "text-ink hover:text-ink" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {opt}
        </Button>
      ))}
    </div>
  );
}
