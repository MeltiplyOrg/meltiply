import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { SlidingHighlight } from "../primitives/sliding-highlight";
import { useForwardedRef } from "../primitives/use-forwarded-ref";
import {
  SEGMENTED_INDICATOR,
  SEGMENTED_ITEM,
  SEGMENTED_TRACK,
} from "../primitives/segmented-chrome";
import { cn } from "@meltiply/ui/utils";

export const Tabs = TabsPrimitive.Root;

type TabsListProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
  variant?: "segment" | "line" | "navigation";
  indicatorClassName?: string;
};
const listStyles = {
  segment: SEGMENTED_TRACK,
  line: "relative flex min-h-10 items-center justify-start gap-6 border-b border-line",
  navigation: "flex flex-col items-stretch gap-1",
};
const indicatorStyles = {
  segment: SEGMENTED_INDICATOR,
  line: "-bottom-px h-0.5 rounded-none border-transparent bg-accent shadow-none",
};

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ variant = "segment", className, indicatorClassName, children, ...props }, ref) => {
  const [listRef, setRefs] = useForwardedRef(ref);

  return (
    <TabsPrimitive.List
      ref={setRefs}
      data-variant={variant}
      className={cn("group/tabs text-ink-2", listStyles[variant], className)}
      {...props}
    >
      {variant !== "navigation" && (
        <SlidingHighlight
          containerRef={listRef}
          itemSelector='[role="tab"]'
          activeSelector='[data-state="active"]'
          axis="x"
          className={cn(indicatorStyles[variant], indicatorClassName)}
        />
      )}
      {children}
    </TabsPrimitive.List>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      SEGMENTED_ITEM,
      "data-[state=active]:text-ink group-data-[variant=line]/tabs:h-10 group-data-[variant=line]/tabs:rounded-none group-data-[variant=line]/tabs:border-b-2 group-data-[variant=line]/tabs:border-transparent group-data-[variant=line]/tabs:px-0 group-data-[variant=navigation]/tabs:h-8 group-data-[variant=navigation]/tabs:justify-start group-data-[variant=navigation]/tabs:data-[state=active]:bg-hover-2",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
