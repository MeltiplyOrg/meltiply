import * as React from "react";
import { cn } from "@meltiply/ui/utils";

/**
 * Surface container component with standard border, background token, rounded corners, and shadow.
 *
 * Serves as the root structural wrapper for modular card sections (header, title, content, footer).
 *
 * @param className - Class overrides for custom layout, spacing, or borders.
 * @param props - HTML div attributes forwarded to the container element.
 * @param ref - Forwarded DOM reference to the HTML div element.
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Analytics</CardTitle>
 *     <CardDescription>Overview of monthly metrics</CardDescription>
 *   </CardHeader>
 *   <CardContent>Metric graphs here</CardContent>
 *   <CardFooter>Last updated 5m ago</CardFooter>
 * </Card>
 * ```
 */
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

/**
 * Header container for card components establishing standard padding and vertical stacking.
 *
 * Typically groups `CardTitle` and `CardDescription` with consistent 1.5 gap spacing.
 *
 * @param className - Class overrides for spacing or alignment.
 * @param props - HTML div attributes forwarded to the header container.
 * @param ref - Forwarded DOM reference to the header div element.
 */
export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col gap-1.5 p-6", className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

/**
 * Semantic heading element for card titles with tight letter spacing and font weight.
 *
 * Defaults to an `<h3>` heading tag with reset leading and tracking styles.
 *
 * @param className - Class overrides for typography or text colors.
 * @param props - HTML heading element attributes forwarded to the `<h3>`.
 * @param ref - Forwarded DOM reference to the `<h3>` heading element.
 */
const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

/**
 * Secondary descriptive text element positioned below card titles.
 *
 * Renders small, muted text for supporting context and subheadings.
 *
 * @param className - Class overrides for text sizing or color.
 * @param props - HTML paragraph attributes forwarded to the `<p>` element.
 * @param ref - Forwarded DOM reference to the `<p>` paragraph element.
 */
const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

/**
 * Main body content wrapper for the Card component.
 *
 * Supplies standard horizontal and bottom padding while removing top padding
 * to flow seamlessly underneath `CardHeader`.
 *
 * @param className - Class overrides for internal padding or layout arrangement.
 * @param props - HTML div attributes forwarded to the content wrapper.
 * @param ref - Forwarded DOM reference to the content div element.
 */
export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";

/**
 * Bottom action bar and auxiliary container for cards.
 *
 * Provides flex alignment with standard bottom and horizontal padding
 * suitable for action buttons, timestamps, or pagination controls.
 *
 * @param className - Class overrides for alignment or spacing.
 * @param props - HTML div attributes forwarded to the footer container.
 * @param ref - Forwarded DOM reference to the footer div element.
 */
const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";
