import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@meltiply/ui/utils";

/** Coordinates Gr8r's 350ms hover hints; keyboard focus and Escape stay owned by Radix. */
export function TooltipProvider({
  delayDuration = 350,
  skipDelayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

/**
 * Root state wrapper managing open/closed lifecycle for an individual tooltip.
 */
export const Tooltip = TooltipPrimitive.Root;

/**
 * Interactive trigger element that opens the associated tooltip on hover or keyboard focus.
 */
export const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Portaled popup content element rendered when the tooltip is active.
 *
 * Ports Gr8r's compact inverse-ink hint: 11px medium text, 5px corners,
 * 5px/7px padding, 6px offset, and a short opacity-only reveal. Radix supplies
 * portal positioning, collision handling, keyboard access, and dismissal.
 * Long operational reasons wrap inside the viewport; reduced motion disables the fade.
 * @returns The portaled tooltip content bubble.
 *
 * @example
 * ```tsx
 * <Tooltip>
 *   <TooltipTrigger asChild><button>Info</button></TooltipTrigger>
 *   <TooltipContent>Detailed hint text</TooltipContent>
 * </Tooltip>
 * ```
 */
export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, side = "bottom", sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      side={side}
      className={cn(
        "pointer-events-none z-200 max-w-[min(320px,calc(100vw-16px))] rounded-(--tooltip-radius) bg-tooltip-bg px-1.75 py-1.25 text-(length:--font-size-micro) font-medium leading-none text-tooltip-fg animate-in fade-in-0 duration-120 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
