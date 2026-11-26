import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@meltiply/ui/utils";
import { SlidingHighlight } from "../primitives/sliding-highlight";

export const Select = SelectPrimitive.Root;

export const SelectValue = SelectPrimitive.Value;

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

const scrollButtonClass = "flex cursor-default items-center justify-center py-1";

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
        data-menu-fit-trigger="select"
        className={cn(
          "relative z-50 select-none",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className={scrollButtonClass}>
          <ChevronUp className="size-4" />
        </SelectPrimitive.ScrollUpButton>
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
        <SelectPrimitive.ScrollDownButton className={scrollButtonClass}>
          <ChevronDown className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

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

export const SelectSeparator = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>((props, ref) => <SelectPrimitive.Separator ref={ref} data-menu-separator="" {...props} />);
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
  disabled?: boolean;
}

export function FilterSelect<Value extends string>({
  value,
  onValueChange,
  aggregateOption,
  options,
  trigger,
  ariaLabel,
  align = "start",
  contentClassName,
  disabled = false,
}: FilterSelectProps<Value>) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
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
