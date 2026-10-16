import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "@meltiply/ui/utils";

/**
 * Visual or semantic divider between content sections built on Radix Separator.
 *
 * Provides accessible division with configurable orientation (horizontal rule or vertical bar)
 * and ARIA role adjustment via `decorative` (true for purely visual styling, false for semantic landmark).
 *
 * @param orientation - Layout direction: 'horizontal' (1px height, 100% width) or 'vertical' (100% height, 1px width). Defaults to 'horizontal'.
 * @param decorative - When true (default), hides from assistive tech (`role="none"`); when false, exposes `role="separator"`.
 * @param className - Optional CSS utility classes to customize color, margin, or dimensions.
 * @returns Accessible styled separator element.
 *
 * @example
 * ```tsx
 * <Separator />
 * <Separator orientation="vertical" className="h-6" />
 * ```
 */
export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      "shrink-0 bg-border",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className,
    )}
    {...props}
  />
));
Separator.displayName = SeparatorPrimitive.Root.displayName;
