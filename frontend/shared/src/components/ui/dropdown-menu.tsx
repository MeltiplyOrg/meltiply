import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { cn } from "@meltiply/ui/utils";
import { SlidingHighlight } from "../primitives/sliding-highlight";
import { useForwardedRef } from "../primitives/use-forwarded-ref";
import {
  SEGMENTED_INDICATOR,
  SEGMENTED_ITEM,
  SEGMENTED_TRACK,
} from "../primitives/segmented-chrome";

export const DropdownMenu = DropdownMenuPrimitive.Root;

export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export const DropdownMenuRadioGroup = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioGroup>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioGroup> & {
    variant?: "default" | "segment";
  }
>(({ className, children, variant = "default", ...props }, ref) => {
  const [groupRef, setRefs] = useForwardedRef(ref);

  return (
    <DropdownMenuPrimitive.RadioGroup
      ref={setRefs}
      className={cn(variant === "segment" && SEGMENTED_TRACK, className)}
      {...props}
    >
      {variant === "segment" && (
        <SlidingHighlight
          containerRef={groupRef}
          itemSelector="[data-segment-item]"
          activeSelector='[data-segment-item][data-state="checked"]'
          axis="x"
          className={SEGMENTED_INDICATOR}
        />
      )}
      {children}
    </DropdownMenuPrimitive.RadioGroup>
  );
});
DropdownMenuRadioGroup.displayName = DropdownMenuPrimitive.RadioGroup.displayName;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & { highlight?: boolean }
>(({ className, sideOffset = 4, highlight = true, children, ...props }, ref) => {
  const [contentRef, setRefs] = useForwardedRef(ref);

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={setRefs}
        sideOffset={sideOffset}
        data-menu-surface=""
        data-menu-fit-trigger="dropdown"
        data-menu-plain={highlight ? undefined : ""}
        className={cn("relative z-50 select-none", className)}
        {...props}
      >
        {highlight && (
          <SlidingHighlight
            containerRef={contentRef}
            itemSelector="[data-dropdown-item]:not([data-segment-item])"
            deferUntilInteraction
          />
        )}
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    data-dropdown-item
    data-menu-item=""
    className={cn("cursor-default select-none", className)}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    data-dropdown-item
    data-menu-item=""
    className={cn("cursor-default select-none pr-8", className)}
    checked={checked}
    {...props}
  >
    {children}
    <span data-menu-indicator="">
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className="size-4" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

export const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem> & {
    variant?: "default" | "segment";
  }
>(({ className, children, variant = "default", ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    data-dropdown-item
    data-menu-item=""
    data-segment-item={variant === "segment" ? "" : undefined}
    className={cn(
      "cursor-default select-none",
      variant === "segment"
        ? cn(
            SEGMENTED_ITEM,
            "pointer-fine:min-h-6 flex-1 justify-center data-[highlighted]:text-ink data-[state=checked]:text-ink",
          )
        : "pr-8",
      className,
    )}
    {...props}
  >
    {children}
    {variant === "default" && (
      <span data-menu-indicator="">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    )}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>((props, ref) => <DropdownMenuPrimitive.Label ref={ref} data-menu-label="" {...props} />);
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>((props, ref) => <DropdownMenuPrimitive.Separator ref={ref} data-menu-separator="" {...props} />);
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

export function FilterChecklist<Value extends string>({
  value,
  onValueChange,
  options,
  aggregateLabel,
  trigger,
  label,
  className,
}: {
  value: readonly Value[];
  onValueChange: (value: Value[]) => void;
  options: readonly { value: Value; label: React.ReactNode }[];
  aggregateLabel?: string;
  trigger: React.ReactElement;
  label?: string;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={className}
        {...(label ? { "aria-label": label, "aria-labelledby": undefined } : {})}
      >
        {aggregateLabel && (
          <>
            <DropdownMenuCheckboxItem
              checked={value.length === 0}
              onCheckedChange={() => onValueChange([])}
              onSelect={(event) => event.preventDefault()}
            >
              {aggregateLabel}
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
          </>
        )}
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={value.includes(option.value)}
            onCheckedChange={() =>
              onValueChange(
                value.includes(option.value)
                  ? value.filter((selected) => selected !== option.value)
                  : [...value, option.value],
              )
            }
            onSelect={(event) => event.preventDefault()}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
