import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@meltiply/ui/utils";

/** Controls an anchored, non-menu form surface; Radix owns focus and dismissal. */
export const Popover = PopoverPrimitive.Root;

/** Anchors the popover to a caller-owned control through the Radix asChild contract. */
export const PopoverTrigger = PopoverPrimitive.Trigger;

/**
 * Portals anchored form content with canonical surface/motion and collision defaults.
 * Callers own labels, width, padding, and form state; nested Radix layers dismiss first.
 * Side offset defaults to 6px and viewport collision padding to 16px.
 */
export const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 16, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      data-menu-surface=""
      className={cn("z-50 max-w-[calc(100vw-2rem)]", className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";
