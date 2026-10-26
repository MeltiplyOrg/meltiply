import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { SlidingHighlight } from "../primitives/sliding-highlight";
import {
  SEGMENTED_INDICATOR,
  SEGMENTED_ITEM,
  SEGMENTED_TRACK,
} from "../primitives/segmented-chrome";
import { cn } from "@meltiply/ui/utils";

/** Radix owns tab selection, arrow-key navigation, and tab/panel relationships. */
export const Tabs = TabsPrimitive.Root;

type TabsListProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
  variant?: "segment" | "line" | "navigation";
  /**
   * Styling for the sliding selection indicator, merged over the variant's own
   * look (a surface pill for `segment`, an accent underline for `line`). DevBox
   * inverts its strip, so it recolors the pill instead of painting a second fill.
   */
  indicatorClassName?: string;
};
const listStyles = {
  segment: SEGMENTED_TRACK,
  line: "relative flex h-10 items-center justify-start gap-6 border-b border-line",
  navigation: "flex flex-col items-stretch gap-1",
};
const indicatorStyles = {
  segment: SEGMENTED_INDICATOR,
  line: "-bottom-px h-0.5 rounded-none border-transparent bg-accent shadow-none",
};

/**
 * One tab owner supports compact segments, directory underlines, and settings
 * navigation without page CSS. The horizontal variants hand their selection to a
 * shared partial: the highlight travels to the selected trigger instead of each
 * trigger painting the fill in place, so switching sections slides.
 */
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ variant = "segment", className, indicatorClassName, children, ...props }, ref) => {
  const listRef = React.useRef<React.ElementRef<typeof TabsPrimitive.List> | null>(null);
  const setRefs = React.useCallback(
    (node: React.ElementRef<typeof TabsPrimitive.List> | null) => {
      listRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

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

/**
 * Named tab with one focus contract; its containing list selects the shared visual
 * variant. The active label color lives here while the selection's fill and
 * underline belong to the list's sliding indicator, so the two never paint twice.
 */
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
