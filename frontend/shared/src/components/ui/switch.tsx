import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@meltiply/ui/utils";

/**
 * Accessible toggle switch component built on `@radix-ui/react-switch`.
 *
 * Renders an interactive sliding switch representing a binary on/off state with
 * full keyboard navigation, ARIA switch semantics, and smooth thumb translation.
 *
 * @param props - Radix switch root properties (e.g. `checked`, `defaultChecked`, `onCheckedChange`, `disabled`),
 *                forwarding element ref and merging custom `className` styling.
 * @returns An accessible switch control with animated sliding thumb.
 *
 * @example
 * ```tsx
 * <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable notifications" />
 * ```
 */
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;
