import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@meltiply/ui/utils";
import { SlidingHighlight } from "../primitives/sliding-highlight";

/**
 * Root context container for custom select dropdowns built on Radix Select.
 *
 * Manages open/closed state, selected value, focus trapping, and ARIA listbox accessibility.
 * Supports both controlled (`value`, `onValueChange`) and uncontrolled (`defaultValue`) modes.
 *
 * @example
 * ```tsx
 * <Select value={role} onValueChange={setRole}>
 *   <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
 *   <SelectContent>
 *     <SelectItem value="admin">Admin</SelectItem>
 *     <SelectItem value="member">Member</SelectItem>
 *   </SelectContent>
 * </Select>
 * ```
 */
export const Select = SelectPrimitive.Root;

/**
 * Groups related {@link SelectItem} options under an accessible section.
 *
 * Typically paired with {@link SelectLabel} to categorize options within large lists.
 */

/**
 * Renders the active selection value or a fallback placeholder inside {@link SelectTrigger}.
 *
 * Automatically updates text content when a {@link SelectItem} is chosen.
 */
export const SelectValue = SelectPrimitive.Value;

/**
 * Interactive trigger button that toggles the select dropdown menu.
 *
 * Carries the canonical field vocabulary (30px control height, control radius,
 * strong field boundary, 13px text, accent focus ring) so a select sitting
 * beside an {@link import("./input").Input} reads as the same control family.
 * Coarse pointers get a 44px minimum target without changing desktop density.
 *
 * @param className - Optional CSS classes for custom sizing, background, or borders.
 * @param children - Trigger content, usually {@link SelectValue}.
 * @param asChild - Delegates rendering to the child, keeping its own geometry.
 * @param props - Radix Trigger props forwarded to the button element.
 * @param ref - Forwarded ref to the underlying HTML button element.
 * @returns Styled select trigger button.
 */
export const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, asChild, ...props }, ref) => {
  if (asChild) {
    return (
      <SelectPrimitive.Trigger ref={ref} asChild className={className} {...props}>
        {children}
      </SelectPrimitive.Trigger>
    );
  }
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex h-control min-w-0 w-full touch-manipulation items-center justify-between gap-2 whitespace-nowrap rounded-control border border-line-strong bg-field px-2.5 text-[13px] transition-colors duration-150 pointer-coarse:min-h-11 placeholder:text-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 [&>span]:line-clamp-1",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

/**
 * Scroll control button appearing at the top of the select viewport when options overflow upwards.
 *
 * Automatically managed by Radix Select primitive during mouse hover or keyboard scrolling.
 *
 * @param className - Optional CSS classes.
 * @param props - Radix ScrollUpButton props.
 * @param ref - Forwarded ref.
 * @returns Scroll up indicator button.
 */
const SelectScrollUpButton = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronUp className="size-4" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

/**
 * Scroll control button appearing at the bottom of the select viewport when options overflow downwards.
 *
 * Automatically managed by Radix Select primitive during mouse hover or keyboard scrolling.
 *
 * @param className - Optional CSS classes.
 * @param props - Radix ScrollDownButton props.
 * @param ref - Forwarded ref.
 * @returns Scroll down indicator button.
 */
const SelectScrollDownButton = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn("flex cursor-default items-center justify-center py-1", className)}
    {...props}
  >
    <ChevronDown className="size-4" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

/**
 * Floating popover container holding the selectable listbox items.
 *
 * Portalled to `document.body` to avoid parent clipping/overflow issues. The
 * chrome comes from the shared `[data-menu-surface]` vocabulary, so a select
 * list matches the account menu, row actions, and every other floating menu;
 * only the opacity fade animates, keeping clear of Radix's popper transform.
 *
 * @param className - Optional CSS classes for custom dimensions or padding.
 * @param children - Group, Item, Label, and Separator children.
 * @param position - Positioning strategy: 'popper' (default) or 'item-aligned'.
 * @param props - Remaining Radix Content props.
 * @param ref - Forwarded ref to the content container.
 * @returns Portalled select dropdown content.
 */
export const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        data-menu-surface=""
        className={cn(
          "relative z-50 select-none",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          ref={viewportRef}
          className={cn(
            "relative",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]",
          )}
        >
          <SlidingHighlight
            containerRef={viewportRef}
            itemSelector="[data-dropdown-item]"
            deferUntilInteraction
          />
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

/**
 * Non-interactive label heading for grouping items within {@link SelectGroup};
 * styled by the shared `[data-menu-label]` menu vocabulary.
 *
 * @param className - Optional CSS classes.
 * @param props - Radix Label props.
 * @param ref - Forwarded ref.
 * @returns Styled group header label.
 */
const SelectLabel = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label ref={ref} data-menu-label="" className={className} {...props} />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

/**
 * Selectable option row within {@link SelectContent}, styled by the shared
 * `[data-menu-item]` menu vocabulary and finished with a right-aligned accent
 * checkmark when selected.
 *
 * The item text is rendered through `ItemText asChild` onto a `block w-full flex-1` span:
 * Radix `SelectItemText` deliberately discards `className`/`style`, so styling the primitive
 * directly is a silent no-op that leaves it inline-sized. Making the styled span the item text
 * guarantees custom row content (e.g. a name plus right-pinned accessories) occupies the full
 * available flex width instead of collapsing beside the label.
 *
 * @param value - Unique string value assigned to this option.
 * @param disabled - Optional boolean to disable selection of this option.
 * @param className - Optional CSS classes.
 * @param children - Display label or custom JSX rendered inside the option.
 * @param props - Radix Item props.
 * @param ref - Forwarded ref.
 * @returns Styled select item element.
 */
export const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    data-dropdown-item
    data-menu-item=""
    className={cn("cursor-default select-none pr-8", className)}
    {...props}
  >
    <span data-menu-indicator="">
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText asChild>
      <span className="block w-full min-w-0 flex-1">{children}</span>
    </SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

/**
 * Visual separator divider line placed between select options or groups; styled
 * by the shared `[data-menu-separator]` menu vocabulary.
 *
 * @param className - Optional CSS classes.
 * @param props - Radix Separator props.
 * @param ref - Forwarded ref.
 * @returns Styled separator rule.
 */
export const SelectSeparator = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator ref={ref} data-menu-separator="" className={className} {...props} />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

interface FilterSelectOption<Value extends string> {
  value: Value;
  label: React.ReactNode;
}

export interface FilterSelectProps<Value extends string> {
  value: Value;
  onValueChange: (value: Value) => void;
  aggregateOption: FilterSelectOption<Value>;
  options: readonly FilterSelectOption<Value>[];
  trigger: React.ReactElement;
  ariaLabel: string;
  align?: "start" | "center" | "end";
  contentClassName?: string;
}
/**
 * Renders a controlled, single-value filter list with a separated aggregate choice.
 *
 * The aggregate row (for example, "All statuses") remains first and is divided
 * from concrete choices when present. Keeping this composition beside the Select
 * primitives gives every screen the same listbox semantics and visual treatment.
 *
 * @param props - Controlled selection, aggregate and concrete options, and trigger geometry.
 * @returns A semantic Select listbox with a consistent aggregate-row separator.
 */
export function FilterSelect<Value extends string>({
  value,
  onValueChange,
  aggregateOption,
  options,
  trigger,
  ariaLabel,
  align = "start",
  contentClassName,
}: FilterSelectProps<Value>) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger asChild aria-label={ariaLabel}>
        {trigger}
      </SelectTrigger>
      <SelectContent align={align} className={contentClassName} aria-label={ariaLabel}>
        <SelectItem value={aggregateOption.value}>{aggregateOption.label}</SelectItem>
        {options.length > 0 ? <SelectSeparator /> : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
