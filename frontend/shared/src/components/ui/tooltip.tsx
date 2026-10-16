import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@meltiply/ui/utils";

/**
 * Global provider wrapping the application or subtree to manage tooltip delay timing and coordination.
 */
export const TooltipProvider = TooltipPrimitive.Provider;

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
 * Uses the dedicated tooltip ramp in both themes and portals into `document.body`,
 * retaining the shared zoom/fade animation and side-aware positioning.
 *
 * @param props - Radix TooltipContent props with default `sideOffset = 4`, forwarding element ref.
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
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md border border-tooltip-border bg-tooltip-bg px-3 py-1.5 text-xs text-tooltip-fg animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
