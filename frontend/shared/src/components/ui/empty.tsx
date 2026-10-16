import * as React from "react";
import { cn } from "@meltiply/ui/utils";

/**
 * Container card for empty state views, placeholders, and zero-data screens.
 *
 * Provides a standardized dashed-border centered layout (`min-h-[280px]`, `rounded-xl`, `border-dashed`)
 * with smooth entrance fade-in animation (`animate-in fade-in-50`) to display missing data states,
 * initial setup prompts, or filtered search result misses.
 *
 * @param className - Optional CSS classes to override dimensions, padding, or borders.
 * @param props - HTML `<div>` attributes forwarded to the root container.
 * @returns Styled empty state container.
 *
 * @example
 * ```tsx
 * <Empty>
 *   <EmptyIcon><FolderOpen className="size-6" /></EmptyIcon>
 *   <EmptyTitle>No posts yet</EmptyTitle>
 *   <EmptyDescription>Create your first scheduled post to get started.</EmptyDescription>
 * </Empty>
 * ```
 */
export function Empty({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-dashed border-border p-8 text-center animate-in fade-in-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Circular icon container badge rendered at the top of an {@link Empty} state.
 *
 * Centers child icons inside a rounded pill with muted background (`bg-muted`) and
 * muted foreground icon color (`text-muted-foreground`) with bottom spacing.
 *
 * @param className - Optional CSS classes to override sizing or colors.
 * @param children - Icon element (e.g. Lucide icon component).
 * @param props - HTML `<div>` attributes forwarded to the badge wrapper.
 * @returns Styled circular icon badge container.
 */
export function EmptyIcon({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground mb-4",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * Primary heading for an {@link Empty} state message.
 *
 * Renders an `<h3>` heading with semibold weight, tight letter tracking, and prominent foreground color.
 *
 * @param className - Optional CSS classes to customize font size, color, or alignment.
 * @param props - HTML `<h3>` heading attributes forwarded to the title element.
 * @returns Styled heading element.
 */
export function EmptyTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-base font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  );
}

/**
 * Explanatory descriptive text within an {@link Empty} state layout.
 *
 * Renders a paragraph constrained to a readable maximum width (`max-w-sm`) with muted text color
 * explaining why no content is visible and suggesting potential next actions.
 *
 * @param className - Optional CSS classes to adjust max-width, text sizing, or spacing.
 * @param props - HTML `<p>` paragraph attributes forwarded to the description element.
 * @returns Styled paragraph element.
 */
export function EmptyDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground mt-1 max-w-sm", className)} {...props} />;
}
