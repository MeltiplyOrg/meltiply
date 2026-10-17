import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@meltiply/ui/utils";

/** Radix owns tab selection, arrow-key navigation, and tab/panel relationships. */
export const Tabs = TabsPrimitive.Root;

type TabsListProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
  variant?: "segment" | "line" | "navigation";
};
const listStyles = {
  segment: "inline-flex h-8 items-center justify-center gap-0.5 rounded-control bg-hover-2 p-0.5",
  line: "flex h-10 items-center justify-start gap-6 border-b border-line",
  navigation: "flex flex-col items-stretch gap-1",
};

/** One tab owner supports compact segments, directory underlines, and settings navigation without page CSS. */
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ variant = "segment", className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    data-variant={variant}
    className={cn("group/tabs text-ink-2", listStyles[variant], className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

/** Named tab with one focus contract; its containing list selects the shared visual variant. */
export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-3 text-control font-medium outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-btn group-data-[variant=line]/tabs:h-10 group-data-[variant=line]/tabs:rounded-none group-data-[variant=line]/tabs:border-b-2 group-data-[variant=line]/tabs:border-transparent group-data-[variant=line]/tabs:px-0 group-data-[variant=line]/tabs:data-[state=active]:border-accent group-data-[variant=line]/tabs:data-[state=active]:bg-transparent group-data-[variant=line]/tabs:data-[state=active]:shadow-none group-data-[variant=navigation]/tabs:h-8 group-data-[variant=navigation]/tabs:justify-start group-data-[variant=navigation]/tabs:data-[state=active]:bg-hover-2 group-data-[variant=navigation]/tabs:data-[state=active]:shadow-none",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

/** Native tab panel semantics with a shared focus ring; callers own layout and scrolling. */
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
